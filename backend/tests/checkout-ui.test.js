import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import http from 'http';
import net from 'net';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { createTestDatabase } from './setup-db.js';
import { buildApp } from '../src/server.js';
import { config } from '../src/config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.join(__dirname, '../../');

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
    srv.on('error', reject);
  });
}

/**
 * Finds the installed Chrome/Chromium executable across macOS and Linux (Ubuntu CI).
 */
function findChromeExecutable() {
  const candidates = [
    process.env.CHROME_BIN,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Minimal RFC 6455 WebSocket client built on Node's native `http` module for CDP.
 * Zero external dependencies and no experimental CLI flags required.
 */
function connectCdpWebSocket(wsUrl) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(wsUrl);
    const key = crypto.randomBytes(16).toString('base64');

    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': '13',
      },
    });

    req.on('error', reject);

    req.on('upgrade', (res, socket) => {
      let buffer = Buffer.alloc(0);
      const pending = new Map();
      let nextId = 1;

      function sendFrame(text) {
        const payload = Buffer.from(text, 'utf8');
        const mask = crypto.randomBytes(4);
        let header;
        if (payload.length < 126) {
          header = Buffer.alloc(2);
          header[0] = 0x81; // FIN + text frame
          header[1] = 0x80 | payload.length;
        } else if (payload.length < 65536) {
          header = Buffer.alloc(4);
          header[0] = 0x81;
          header[1] = 0x80 | 126;
          header.writeUInt16BE(payload.length, 2);
        } else {
          header = Buffer.alloc(10);
          header[0] = 0x81;
          header[1] = 0x80 | 127;
          header.writeBigUInt64BE(BigInt(payload.length), 2);
        }
        const masked = Buffer.alloc(payload.length);
        for (let i = 0; i < payload.length; i++) {
          masked[i] = payload[i] ^ mask[i % 4];
        }
        socket.write(Buffer.concat([header, mask, masked]));
      }

      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 2) {
          const secondByte = buffer[1];
          const isMasked = (secondByte & 0x80) !== 0;
          let payloadLen = secondByte & 0x7f;
          let offset = 2;

          if (payloadLen === 126) {
            if (buffer.length < 4) return;
            payloadLen = buffer.readUInt16BE(2);
            offset = 4;
          } else if (payloadLen === 127) {
            if (buffer.length < 10) return;
            payloadLen = Number(buffer.readBigUInt64BE(2));
            offset = 10;
          }

          const maskBytes = isMasked ? 4 : 0;
          if (buffer.length < offset + maskBytes + payloadLen) return;

          const opcode = buffer[0] & 0x0f;
          let payload = buffer.subarray(offset + maskBytes, offset + maskBytes + payloadLen);
          if (isMasked) {
            const mask = buffer.subarray(offset, offset + 4);
            const unmasked = Buffer.alloc(payloadLen);
            for (let i = 0; i < payloadLen; i++) {
              unmasked[i] = payload[i] ^ mask[i % 4];
            }
            payload = unmasked;
          }
          buffer = buffer.subarray(offset + maskBytes + payloadLen);

          if (opcode === 0x01) {
            const msg = JSON.parse(payload.toString('utf8'));
            if (msg.id && pending.has(msg.id)) {
              const { resolve: resCmd, reject: rejCmd } = pending.get(msg.id);
              pending.delete(msg.id);
              if (msg.error) {
                rejCmd(new Error(msg.error.message || JSON.stringify(msg.error)));
              } else {
                resCmd(msg.result);
              }
            }
          }
        }
      });

      function send(method, params = {}) {
        const id = nextId++;
        return new Promise((resCmd, rejCmd) => {
          const timer = setTimeout(() => {
            pending.delete(id);
            rejCmd(new Error(`CDP command timed out after 15s: ${method}`));
          }, 15000);
          pending.set(id, {
            resolve: (val) => {
              clearTimeout(timer);
              resCmd(val);
            },
            reject: (err) => {
              clearTimeout(timer);
              rejCmd(err);
            },
          });
          sendFrame(JSON.stringify({ id, method, params }));
        });
      }

      async function evaluate(expression) {
        const res = await send('Runtime.evaluate', {
          expression,
          awaitPromise: true,
          returnByValue: true,
        });
        if (res.exceptionDetails) {
          throw new Error(
            `Browser evaluation error: ${res.exceptionDetails.text} ${res.exceptionDetails.exception?.description || ''}`
          );
        }
        return res.result ? res.result.value : undefined;
      }

      function close() {
        try {
          socket.destroy();
        } catch (_) {}
      }

      resolve({ send, evaluate, close });
    });

    req.end();
  });
}

test('Checkout UI & Commercial Flow Suite (Gate 2-A2 QA — Codex Hardened)', async (t) => {
  let testDb;
  let app;
  let htmlContent;
  let jsContent;
  let cssContent;

  t.before(async () => {
    testDb = await createTestDatabase();
    app = await buildApp(testDb, { rateLimitMax: 100 });
    htmlContent = fs.readFileSync(path.join(rootDir, 'index.html'), 'utf8');
    jsContent = fs.readFileSync(path.join(rootDir, 'js/checkout.js'), 'utf8');
    cssContent = fs.readFileSync(path.join(rootDir, 'css/styles.css'), 'utf8');
  });

  t.after(async () => {
    if (app) await app.close();
    if (testDb) await testDb.close();
  });

  await t.test('1. Catalog Non-Regression, 5 Connected Purchase Buttons & Explicit API Config in HTML', () => {
    const requiredSkus = ['mujer-informada-4', 'endometriosis', 'vaginosis', 'sop', 'aprende-mujer'];

    for (const sku of requiredSkus) {
      assert.ok(htmlContent.includes(`data-sku="${sku}"`), `HTML must contain an active button for official SKU: ${sku}`);
      assert.ok(htmlContent.includes('data-action="open-checkout"'), 'Purchase buttons must have data-action="open-checkout"');
    }

    assert.ok(!htmlContent.includes('btn-bundle btn-staging-disabled'), 'Bundle purchase button must be active for checkout test');
    assert.ok(htmlContent.includes('id="checkout-modal"'), 'Checkout modal container must exist');
    assert.ok(htmlContent.includes('role="dialog"'), 'Modal must have role="dialog"');
    assert.ok(htmlContent.includes('aria-modal="true"'), 'Modal must have aria-modal="true"');
    assert.ok(htmlContent.includes('id="novarum-runtime-config"'), 'HTML must configure window.NOVARUM_API_BASE before loading checkout.js');
    assert.ok(htmlContent.includes('window.NOVARUM_API_BASE'), 'HTML must explicitly define window.NOVARUM_API_BASE');

    // Verify payment coordination button is disabled by default in HTML
    assert.match(
      htmlContent,
      /<button[^>]*id="btn-whatsapp-payment"[^>]*disabled[^>]*aria-disabled="true"/,
      'Payment coordination button must be disabled and aria-disabled="true" by default in staging'
    );
  });

  await t.test('2. Accessible Form Fields, Error Associations & Staging Legal Summary in HTML', () => {
    assert.ok(htmlContent.includes('id="checkout-name"'), 'Must have full name input');
    assert.ok(htmlContent.includes('aria-describedby="name-helper name-error"'), 'Name input must reference helper and error via aria-describedby');
    assert.ok(htmlContent.includes('aria-describedby="email-helper email-error"'), 'Email input must reference helper and error via aria-describedby');
    assert.ok(htmlContent.includes('aria-describedby="phone-helper phone-error"'), 'Phone input must reference helper and error via aria-describedby');
    assert.ok(htmlContent.includes('aria-describedby="terms-staging-note terms-error"'), 'Terms checkbox must reference note and error via aria-describedby');

    assert.ok(htmlContent.includes('id="consent-terms"'), 'Must have separate terms & privacy consent checkbox');
    assert.ok(htmlContent.includes('id="consent-marketing"'), 'Must have separate marketing consent checkbox');
    assert.ok(htmlContent.includes('id="btn-toggle-legal-terms"'), 'Must include viewable legal summary trigger in staging');
    assert.ok(htmlContent.includes('id="checkout-legal-summary"'), 'Must include legal summary container in staging');
    assert.ok(htmlContent.includes('id="btn-new-intent"'), 'Must include explicit button to start a new purchase intent');
  });

  await t.test('3. Individual Course Purchases: Each of the 4 courses registers at Bs 79 (7900 minor)', async () => {
    const singleSkus = ['endometriosis', 'vaginosis', 'sop', 'aprende-mujer'];

    for (const sku of singleSkus) {
      const idempotencyKey = crypto.randomUUID();
      const payload = {
        sku,
        name: `Estudiante ${sku}`,
        email: `estudiante_${sku}@ejemplo.com`,
        phone: '+59178456338',
        terms_accepted: true,
        marketing_opt_in: false,
        privacy_version: 'v1.0',
        idempotency_key: idempotencyKey,
        utm: { source: 'instagram', campaign: 'salud_femenina' },
      };

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/checkout',
        payload,
      });

      assert.equal(res.statusCode, 201, `Checkout for SKU ${sku} must return HTTP 201`);
      const data = JSON.parse(res.body);

      assert.match(data.order_number, /^DPS-\d{8}-\d+$/);
      assert.equal(data.total_amount_minor, 7900);
      assert.equal(data.currency, 'BOB');
      assert.equal(data.status, 'pending_payment');
      assert.match(data.opaque_token, /^[a-f0-9]{64}$/);
    }
  });

  await t.test('4. Bundle Purchase: Complete pack (mujer-informada-4) registers at Bs 199 (19900 minor)', async () => {
    const idempotencyKey = crypto.randomUUID();
    const payload = {
      sku: 'mujer-informada-4',
      name: 'Sofia Alarcon',
      email: 'sofia.pack@ejemplo.com',
      phone: '+59170011223',
      terms_accepted: true,
      marketing_opt_in: true,
      privacy_version: 'v1.0',
      idempotency_key: idempotencyKey,
      utm: { source: 'tiktok', medium: 'reels', campaign: 'sop_lanzamiento' },
    };

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/checkout',
      payload,
    });

    assert.equal(res.statusCode, 201);
    const data = JSON.parse(res.body);

    assert.equal(data.total_amount_minor, 19900);
    assert.equal(data.currency, 'BOB');
    assert.equal(data.status, 'pending_payment');
    assert.match(data.opaque_token, /^[a-f0-9]{64}$/);
    assert.match(data.order_number, /^DPS-\d{8}-\d+$/);
  });

  await t.test('5. Static Guardrails: Zero innerHTML, Zero DPS-XXXXX fallback, Zero auto-regen on 409', () => {
    assert.ok(!jsContent.includes('innerHTML'), 'js/checkout.js must never use innerHTML');
    assert.ok(!jsContent.includes('DPS-XXXXX'), 'js/checkout.js must not contain fake order number fallback DPS-XXXXX');
    assert.ok(
      jsContent.includes('ALLOWED_ORDER_STATUSES'),
      'js/checkout.js must strictly whitelist backend contract statuses'
    );
    assert.ok(!jsContent.includes("'confirmed'"), 'js/checkout.js must not reference non-contract status confirmed');
  });

  await t.test('6. Real Headless Browser (Chrome CDP) End-to-End Verification of All 9 Codex Controls', async (subT) => {
    const chromeBin = findChromeExecutable();
    assert.ok(chromeBin, 'Chrome or Chromium executable must be available for real browser E2E testing');

    // Control flags for simulating network/server edge cases on the real HTTP proxy server
    let dropNextCheckoutResponseAfterPersist = false;
    let delayCheckoutMs = 0;
    let overrideCheckoutResponse = null;
    let overrideStatusResponse = null;
    let checkoutRequestCount = 0;

    // Create a local HTTP server that serves static assets AND proxies /api/v1/* to Fastify `app`
    const server = http.createServer(async (req, res) => {
      try {
        const parsedUrl = new URL(req.url, 'http://127.0.0.1');

        // Handle API routes via Fastify inject (with CORS headers and fault-injection hooks)
        if (parsedUrl.pathname.startsWith('/api/') || parsedUrl.pathname === '/health') {
          const chunks = [];
          for await (const chunk of req) {
            chunks.push(chunk);
          }
          const rawBody = Buffer.concat(chunks).toString('utf8');

          if (parsedUrl.pathname === '/api/v1/checkout' && req.method === 'POST') {
            checkoutRequestCount += 1;

            if (delayCheckoutMs > 0) {
              await new Promise((r) => setTimeout(r, delayCheckoutMs));
            }

            if (overrideCheckoutResponse) {
              const custom = overrideCheckoutResponse;
              overrideCheckoutResponse = null;
              res.writeHead(custom.statusCode, {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': req.headers.origin || '*',
              });
              res.end(JSON.stringify(custom.body));
              return;
            }
          }

          if (parsedUrl.pathname.endsWith('/status') && req.method === 'GET' && overrideStatusResponse) {
            const custom = overrideStatusResponse;
            overrideStatusResponse = null;
            res.writeHead(custom.statusCode, {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': req.headers.origin || '*',
            });
            res.end(JSON.stringify(custom.body));
            return;
          }

          const injectRes = await app.inject({
            method: req.method,
            url: parsedUrl.pathname + parsedUrl.search,
            headers: {
              ...req.headers,
              host: '127.0.0.1',
            },
            payload: rawBody || undefined,
          });

          // Simulate lost/dropped network response AFTER order was persisted in PostgreSQL/pg-mem
          if (dropNextCheckoutResponseAfterPersist && parsedUrl.pathname === '/api/v1/checkout' && req.method === 'POST') {
            dropNextCheckoutResponseAfterPersist = false;
            res.writeHead(200, {
              'Content-Type': 'application/json',
              'Transfer-Encoding': 'chunked',
              Connection: 'close',
            });
            res.write('4\r\n{"or');
            req.socket.destroy();
            return;
          }

          const responseHeaders = { ...injectRes.headers };
          if (req.headers.origin) {
            responseHeaders['access-control-allow-origin'] = req.headers.origin;
          }
          res.writeHead(injectRes.statusCode, responseHeaders);
          res.end(injectRes.body);
          return;
        }

        // Serve static frontend files
        let filePath = parsedUrl.pathname === '/' ? '/index.html' : parsedUrl.pathname;
        const safePath = path.normalize(filePath).replace(/^(\.\.(\/|\\|$))+/, '');
        const fullPath = path.join(rootDir, safePath);

        if (!fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) {
          res.writeHead(404);
          res.end('Not found');
          return;
        }

        const ext = path.extname(fullPath).toLowerCase();
        const mimeTypes = {
          '.html': 'text/html; charset=utf-8',
          '.css': 'text/css; charset=utf-8',
          '.js': 'application/javascript; charset=utf-8',
          '.jpg': 'image/jpeg',
          '.png': 'image/png',
          '.svg': 'image/svg+xml',
        };

        let content = fs.readFileSync(fullPath);
        // Inject the live test server URL into index.html's runtime config so initial load points to our test server
        if (safePath === '/index.html' || safePath === 'index.html') {
          const addr = server.address();
          const testOrigin = `http://127.0.0.1:${addr.port}`;
          content = Buffer.from(
            content
              .toString('utf8')
              .replace(/<link[^>]*fonts\.googleapis\.com[^>]*>/g, '')
              .replace(/<link[^>]*fonts\.gstatic\.com[^>]*>/g, '')
              .replace('https://api.academia.drpedrosevilla.com', testOrigin),
            'utf8'
          );
        }

        res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
        res.end(content);
      } catch (err) {
        res.writeHead(500);
        res.end(String(err));
      }
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const serverPort = server.address().port;
    const baseUrl = `http://127.0.0.1:${serverPort}`;
    if (!config.allowedOrigins.includes(baseUrl)) {
      config.allowedOrigins.push(baseUrl);
    }

    // Launch Headless Chrome with stdio: 'ignore' so Linux crashpad daemons never hold pipes open
    const debugPort = await getFreePort();
    const userDataDir = fs.mkdtempSync('/tmp/novarum-chrome-e2e-');
    const chromeProc = spawn(
      chromeBin,
      [
        '--headless=new',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--disable-crash-reporter',
        '--disable-breakpad',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--disable-background-networking',
        `--remote-debugging-port=${debugPort}`,
        `--user-data-dir=${userDataDir}`,
        `${baseUrl}/index.html?utm_source=tiktok&utm_campaign=gate2_e2e`,
      ],
      { stdio: 'ignore', detached: true }
    );
    chromeProc.unref();

    let pageWsUrl = null;
    for (let i = 0; i < 80 && !pageWsUrl; i++) {
      try {
        const listRes = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
        if (listRes.ok) {
          const targets = await listRes.json();
          const pageTarget = targets.find((tgt) => tgt.type === 'page' && tgt.url.includes('index.html'));
          if (pageTarget && pageTarget.webSocketDebuggerUrl) {
            pageWsUrl = pageTarget.webSocketDebuggerUrl;
            break;
          }
        }
      } catch (_) {}
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(pageWsUrl, 'Headless Chrome must have an active page target for index.html');

    const cdp = await connectCdpWebSocket(pageWsUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    // Wait until window.NovarumCheckout is initialized in page
    for (let i = 0; i < 40; i++) {
      const ready = await cdp.evaluate('Boolean(window.NovarumCheckout && document.readyState === "complete")');
      if (ready) break;
      await new Promise((r) => setTimeout(r, 100));
    }

    try {
      // -----------------------------------------------------------------------
      // E2E 6.1: Accessibility, Focus Trap, Inert Background & Focus Return
      // -----------------------------------------------------------------------
      await subT.test('6.1 Browser Accessibility: inert background, Tab/Shift+Tab trap, ARIA invalid & focus return', async () => {
        await cdp. send('Emulation.setDeviceMetricsOverride', {
          width: 1280,
          height: 800,
          deviceScaleFactor: 1,
          mobile: false,
        });

        // Focus and click the Endometriosis catalog button
        await cdp.evaluate(`
          const btn = document.querySelector('[data-action="open-checkout"][data-sku="endometriosis"]');
          btn.focus();
          btn.click();
        `);
        await new Promise((r) => setTimeout(r, 50));

        const modalA11yState = await cdp.evaluate(`({
          backdropHidden: document.getElementById('checkout-modal-backdrop').hidden,
          headerInert: document.getElementById('header').hasAttribute('inert'),
          headerAriaHidden: document.getElementById('header').getAttribute('aria-hidden'),
          mainInert: document.getElementById('main-content').hasAttribute('inert'),
          mainAriaHidden: document.getElementById('main-content').getAttribute('aria-hidden'),
          footerInert: document.getElementById('footer').hasAttribute('inert'),
          activeInsideModal: document.getElementById('checkout-modal').contains(document.activeElement),
        })`);

        assert.equal(modalA11yState.backdropHidden, false);
        assert.equal(modalA11yState.headerInert, true, 'Header must be inert while modal is open');
        assert.equal(modalA11yState.headerAriaHidden, 'true', 'Header must have aria-hidden="true" while modal is open');
        assert.equal(modalA11yState.mainInert, true, 'Main content must be inert while modal is open');
        assert.equal(modalA11yState.mainAriaHidden, 'true', 'Main content must have aria-hidden="true" while modal is open');
        assert.equal(modalA11yState.footerInert, true, 'Footer must be inert while modal is open');
        assert.equal(modalA11yState.activeInsideModal, true, 'Focus must move inside the modal upon opening');

        // Test invalid form submission sets aria-invalid="true" and reveals error messages
        await cdp.evaluate(`
          document.getElementById('checkout-name').value = '';
          document.getElementById('checkout-email').value = 'bad-email';
          document.getElementById('consent-terms').checked = false;
          window.NovarumCheckout.submitCheckout();
        `);

        const validationAriaState = await cdp.evaluate(`({
          nameAriaInvalid: document.getElementById('checkout-name').getAttribute('aria-invalid'),
          nameErrorHidden: document.getElementById('name-error').hidden,
          emailAriaInvalid: document.getElementById('checkout-email').getAttribute('aria-invalid'),
          emailErrorHidden: document.getElementById('email-error').hidden,
          termsAriaInvalid: document.getElementById('consent-terms').getAttribute('aria-invalid'),
          termsErrorHidden: document.getElementById('terms-error').hidden,
          focusedId: document.activeElement ? document.activeElement.id : null,
        })`);

        assert.equal(validationAriaState.nameAriaInvalid, 'true');
        assert.equal(validationAriaState.nameErrorHidden, false);
        assert.equal(validationAriaState.emailAriaInvalid, 'true');
        assert.equal(validationAriaState.emailErrorHidden, false);
        assert.equal(validationAriaState.termsAriaInvalid, 'true');
        assert.equal(validationAriaState.termsErrorHidden, false);
        assert.equal(validationAriaState.focusedId, 'checkout-name', 'First invalid input must receive focus');

        // Test Tab wrap from last focusable element to first focusable element inside modal
        const tabWrapResult = await cdp.evaluate(`(() => {
          const modal = document.getElementById('checkout-modal');
          const closeBtn = document.getElementById('btn-close-checkout');
          const submitBtn = document.getElementById('btn-submit-order');

          // Focus last focusable element (submitBtn) and dispatch Tab
          submitBtn.focus();
          const tabForward = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: false, bubbles: true, cancelable: true });
          document.dispatchEvent(tabForward);
          const afterForwardId = document.activeElement.id;

          // Now on first focusable element (closeBtn), dispatch Shift+Tab
          const tabBackward = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true });
          document.dispatchEvent(tabBackward);
          const afterBackwardId = document.activeElement.id;

          return { afterForwardId, afterBackwardId };
        })()`);

        assert.equal(tabWrapResult.afterForwardId, 'btn-close-checkout', 'Tab on last element must wrap to close button');
        assert.equal(tabWrapResult.afterBackwardId, 'btn-submit-order', 'Shift+Tab on first element must wrap to submit button');

        // Test Escape closes modal, removes inert/aria-hidden, and restores focus to triggering catalog button
        const escCloseResult = await cdp.evaluate(`(() => {
          const escEvent = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
          document.dispatchEvent(escEvent);
          return {
            backdropHidden: document.getElementById('checkout-modal-backdrop').hidden,
            mainInert: document.getElementById('main-content').hasAttribute('inert'),
            mainAriaHidden: document.getElementById('main-content').getAttribute('aria-hidden'),
            activeSkuAttr: document.activeElement ? document.activeElement.getAttribute('data-sku') : null,
          };
        })()`);

        assert.equal(escCloseResult.backdropHidden, true, 'Escape must close modal');
        assert.equal(escCloseResult.mainInert, false, 'Main content must not be inert after modal closes');
        assert.equal(escCloseResult.mainAriaHidden, null, 'Main content aria-hidden must be removed after modal closes');
        assert.equal(escCloseResult.activeSkuAttr, 'endometriosis', 'Focus must return to the triggering catalog button');
      });

      // -----------------------------------------------------------------------
      // E2E 6.2: Explicit & Validated API Base Configuration (P1 #4)
      // -----------------------------------------------------------------------
      await subT.test('6.2 Browser API Config Guard: blocks missing/empty/invalid NOVARUM_API_BASE without network requests', async () => {
        const beforeCount = checkoutRequestCount;

        const invalidConfigCheck = await cdp.evaluate(`(async () => {
          const originalBase = window.NOVARUM_API_BASE;

          // Case A: empty string ''
          window.NOVARUM_API_BASE = '';
          const resolvedEmpty = window.NovarumCheckout.resolveValidApiBase();
          window.NovarumCheckout.openCheckout('sop');
          document.getElementById('checkout-name').value = 'Valeria Mendoza';
          document.getElementById('checkout-email').value = 'valeria@ejemplo.com';
          document.getElementById('consent-terms').checked = true;
          await window.NovarumCheckout.submitCheckout();
          const alertHiddenEmpty = document.getElementById('checkout-error-alert').hidden;
          const alertTitleEmpty = document.getElementById('alert-title').textContent;

          // Case B: malformed URL
          window.NOVARUM_API_BASE = 'not-a-valid-http-origin';
          const resolvedMalformed = window.NovarumCheckout.resolveValidApiBase();

          // Restore valid API base
          window.NOVARUM_API_BASE = originalBase;
          const resolvedRestored = window.NovarumCheckout.resolveValidApiBase();
          window.NovarumCheckout.closeCheckout();

          return {
            resolvedEmpty,
            alertHiddenEmpty,
            alertTitleEmpty,
            resolvedMalformed,
            resolvedRestored,
          };
        })()`);

        assert.equal(invalidConfigCheck.resolvedEmpty, null, 'Empty string NOVARUM_API_BASE must resolve to null');
        assert.equal(invalidConfigCheck.alertHiddenEmpty, false, 'Error alert must be displayed when API base is missing');
        assert.match(invalidConfigCheck.alertTitleEmpty, /Servicio comercial no configurado/);
        assert.equal(invalidConfigCheck.resolvedMalformed, null, 'Malformed URL must resolve to null');
        assert.equal(invalidConfigCheck.resolvedRestored, baseUrl, 'Valid baseUrl must resolve cleanly');
        assert.equal(checkoutRequestCount, beforeCount, 'Zero network requests may be sent when API config is missing/invalid');

        // Verify CORS enforcement on backend for allowed vs disallowed Origin
        const allowedCorsRes = await app.inject({
          method: 'OPTIONS',
          url: '/api/v1/checkout',
          headers: {
            Origin: 'https://drpedrosevilla.com',
            'Access-Control-Request-Method': 'POST',
          },
        });
        assert.equal(allowedCorsRes.headers['access-control-allow-origin'], 'https://drpedrosevilla.com');

        const blockedCorsRes = await app.inject({
          method: 'OPTIONS',
          url: '/api/v1/checkout',
          headers: {
            Origin: 'https://evil-untrusted-origin.example.com',
            'Access-Control-Request-Method': 'POST',
          },
        });
        assert.equal(blockedCorsRes.headers['access-control-allow-origin'], undefined);
      });

      // -----------------------------------------------------------------------
      // E2E 6.3: Persisted Order + Lost Response + Edit Attempt -> Never Creates 2 Orders (P1 #1)
      // -----------------------------------------------------------------------
      await subT.test('6.3 Browser Immutable Intent: persisted order + lost response + DOM edit attempt -> 1 order total', async () => {
        const testEmail = 'valeria.lost.response@ejemplo.com';

        // 1. Open checkout for endometriosis, fill valid data, and submit.
        // Simulate lost response AFTER server commits the order in DB.
        const afterDropState = await cdp.evaluate(`(async () => {
          window.NovarumCheckout.openCheckout('endometriosis');
          document.getElementById('checkout-name').value = 'Valeria Mendoza';
          document.getElementById('checkout-email').value = '${testEmail}';
          document.getElementById('checkout-phone').value = '+59170099887';
          document.getElementById('consent-terms').checked = true;

          const initialKey = window.NovarumCheckout.getIdempotencyKey();

          const origFetch = window.fetch.bind(window);
          window.fetch = async (...args) => {
            const response = await origFetch(...args);
            // Restore original fetch and throw network error after server persisted the order
            window.fetch = origFetch;
            throw new TypeError('Failed to fetch: connection lost after server commit');
          };

          await window.NovarumCheckout.submitCheckout();

          return {
            initialKey,
            keyAfterDrop: window.NovarumCheckout.getIdempotencyKey(),
            alertHidden: document.getElementById('checkout-error-alert').hidden,
            lockedBannerHidden: document.getElementById('checkout-intent-locked-banner').hidden,
            nameDisabled: document.getElementById('checkout-name').disabled,
            skuSelectDisabled: document.getElementById('checkout-sku-select').disabled,
            snapshot: window.NovarumCheckout.getIntentSnapshot(),
          };
        })()`);

        assert.equal(afterDropState.alertHidden, false, 'Network error alert must appear when response is lost');
        assert.equal(afterDropState.lockedBannerHidden, false, 'Locked intent banner must be visible');
        assert.equal(afterDropState.nameDisabled, true, 'Form inputs must be locked during retry recovery');
        assert.equal(afterDropState.skuSelectDisabled, true, 'SKU selector must be locked during retry recovery');
        assert.equal(afterDropState.keyAfterDrop, afterDropState.initialKey, 'Idempotency key must remain unchanged');
        assert.equal(afterDropState.snapshot.sku, 'endometriosis');

        // Verify order was indeed persisted in DB by the first request
        const dbCheck1 = await testDb.query(
          `SELECT o.order_number, o.total_amount_minor FROM orders o
           JOIN leads l ON l.id = o.lead_id AND l.academy_id = o.academy_id
           WHERE l.email_normalized = $1`,
          [testEmail]
        );
        assert.equal(dbCheck1.rows.length, 1, 'First request persisted exactly 1 order before connection drop');

        // 2. Attempt to tamper with DOM fields and SKU before clicking Retry
        const afterRetryState = await cdp.evaluate(`(async () => {
          // Attempt to mutate DOM values and SKU while intent is locked
          document.getElementById('checkout-name').value = 'Nombre Modificado';
          document.getElementById('checkout-email').value = 'otro.correo@ejemplo.com';
          document.getElementById('checkout-sku-select').value = 'mujer-informada-4';
          const setProductAllowed = window.NovarumCheckout.setProduct('mujer-informada-4');

          // Click Retry button
          document.getElementById('btn-retry-checkout').click();
          // Wait for retry fetch to complete
          for (let i = 0; i < 30; i++) {
            if (!document.getElementById('checkout-confirmation-container').hidden) break;
            await new Promise((r) => setTimeout(r, 30));
          }

          return {
            setProductAllowed,
            confirmationHidden: document.getElementById('checkout-confirmation-container').hidden,
            confirmedOrderNumber: document.getElementById('confirmed-order-number').textContent,
            confirmedProductTitle: document.getElementById('confirmed-product-title').textContent,
            confirmedTotalAmount: document.getElementById('confirmed-total-amount').textContent,
          };
        })()`);

        assert.equal(afterRetryState.setProductAllowed, false, 'setProduct must reject SKU changes while intent is frozen');
        assert.equal(afterRetryState.confirmationHidden, false, 'Retry must recover the persisted order and show confirmation');
        assert.equal(afterRetryState.confirmedOrderNumber, dbCheck1.rows[0].order_number, 'Must display exact persisted order number');
        assert.equal(afterRetryState.confirmedProductTitle, 'Curso: Endometriosis (Del Dolor a la Comprensión)');
        assert.equal(afterRetryState.confirmedTotalAmount, 'Bs 79.00 BOB');

        // Verify DB still has strictly 1 order (never created a 2nd order!)
        const dbCheck2 = await testDb.query(
          `SELECT COUNT(*)::int AS cnt FROM orders o
           JOIN leads l ON l.id = o.lead_id AND l.academy_id = o.academy_id
           WHERE l.email_normalized = $1`,
          [testEmail]
        );
        assert.equal(dbCheck2.rows[0].cnt, 1, 'Database must contain strictly 1 order after retry');
      });

      // -----------------------------------------------------------------------
      // E2E 6.4: HTTP 409 Conflict Does NOT Auto-Regenerate Key; Explicit Action Required (P1 #1)
      // -----------------------------------------------------------------------
      await subT.test('6.4 Browser HTTP 409 Handling: preserves idempotency key on 409 until explicit new intent action', async () => {
        // First create an order on the backend with a known UUID
        const conflictingKey = crypto.randomUUID();
        await app.inject({
          method: 'POST',
          url: '/api/v1/checkout',
          payload: {
            sku: 'sop',
            name: 'Cliente Original',
            email: 'original409@ejemplo.com',
            terms_accepted: true,
            idempotency_key: conflictingKey,
          },
        });

        // In browser, open checkout for vaginosis and inject the conflicting key
        const conflictState = await cdp.evaluate(`(async () => {
          window.NovarumCheckout.openCheckout('vaginosis');
          window.NovarumCheckout.setIdempotencyKey('${conflictingKey}');
          document.getElementById('checkout-name').value = 'Cliente Conflicto';
          document.getElementById('checkout-email').value = 'conflicto409@ejemplo.com';
          document.getElementById('consent-terms').checked = true;

          await window.NovarumCheckout.submitCheckout();

          return {
            keyAfter409: window.NovarumCheckout.getIdempotencyKey(),
            alertHidden: document.getElementById('checkout-error-alert').hidden,
            alertTitle: document.getElementById('alert-title').textContent,
            retryHidden: document.getElementById('btn-retry-checkout').hidden,
            newIntentHidden: document.getElementById('btn-new-intent').hidden,
          };
        })()`);

        assert.equal(
          conflictState.keyAfter409,
          conflictingKey,
          'Idempotency key MUST NOT be auto-regenerated on HTTP 409'
        );
        assert.equal(conflictState.alertHidden, false);
        assert.match(conflictState.alertTitle, /409/);
        assert.equal(conflictState.retryHidden, true, 'Retry button is hidden on 409 payload mismatch');
        assert.equal(conflictState.newIntentHidden, false, 'Explicit New Intent button must be shown on 409');

        // Now user explicitly clicks #btn-new-intent
        const explicitResolutionState = await cdp.evaluate(`(async () => {
          document.getElementById('btn-new-intent').click();
          const newKey = window.NovarumCheckout.getIdempotencyKey();
          const snapshotAfterReset = window.NovarumCheckout.getIntentSnapshot();
          const nameDisabledAfterReset = document.getElementById('checkout-name').disabled;

          await window.NovarumCheckout.submitCheckout();

          return {
            newKey,
            snapshotAfterReset,
            nameDisabledAfterReset,
            confirmationHidden: document.getElementById('checkout-confirmation-container').hidden,
            confirmedProductTitle: document.getElementById('confirmed-product-title').textContent,
          };
        })()`);

        assert.notEqual(explicitResolutionState.newKey, conflictingKey, 'Explicit click on New Intent must generate a new UUID');
        assert.equal(explicitResolutionState.snapshotAfterReset, null);
        assert.equal(explicitResolutionState.nameDisabledAfterReset, false);
        assert.equal(explicitResolutionState.confirmationHidden, false, 'New intent submission must succeed');
        assert.equal(explicitResolutionState.confirmedProductTitle, 'Curso: Vaginosis Bacteriana (Reconocimiento y Cuidados)');
      });

      // -----------------------------------------------------------------------
      // E2E 6.5: SKU Confirmation Consistency & Late Response Discard (P1 #2)
      // -----------------------------------------------------------------------
      await subT.test('6.5 Browser Race Protection: SOP submitted + switch attempt never renders Pack with Bs 79; late responses discarded', async () => {
        delayCheckoutMs = 150;

        const raceResult = await cdp.evaluate(`(async () => {
          window.NovarumCheckout.openCheckout('sop');
          document.getElementById('checkout-name').value = 'Mariana Quispe';
          document.getElementById('checkout-email').value = 'mariana.race@ejemplo.com';
          document.getElementById('consent-terms').checked = true;

          // Start submission (in-flight for 150ms)
          const submitPromise = window.NovarumCheckout.submitCheckout();
          await new Promise((r) => setTimeout(r, 30));

          // Attempt to switch SKU to pack while in-flight
          const selectDisabledDuringFlight = document.getElementById('checkout-sku-select').disabled;
          const switchedDuringFlight = window.NovarumCheckout.setProduct('mujer-informada-4');

          await submitPromise;

          return {
            selectDisabledDuringFlight,
            switchedDuringFlight,
            confirmedProductTitle: document.getElementById('confirmed-product-title').textContent,
            confirmedTotalAmount: document.getElementById('confirmed-total-amount').textContent,
          };
        })()`);

        delayCheckoutMs = 0;

        assert.equal(raceResult.selectDisabledDuringFlight, true, 'SKU selector must be disabled during submission');
        assert.equal(raceResult.switchedDuringFlight, false, 'setProduct must be blocked while request is in flight');
        assert.equal(
          raceResult.confirmedProductTitle,
          'Curso: Síndrome de Ovario Poliquístico (SOP)',
          'Confirmation must strictly match the submitted SKU (SOP)'
        );
        assert.equal(raceResult.confirmedTotalAmount, 'Bs 79.00 BOB', 'Amount must strictly match SOP Bs 79.00');

        // Now test late response discard when modal is closed and reopened for another product
        delayCheckoutMs = 180;
        const staleDiscardResult = await cdp.evaluate(`(async () => {
          window.NovarumCheckout.openCheckout('aprende-mujer');
          document.getElementById('checkout-name').value = 'Carla Tardía';
          document.getElementById('checkout-email').value = 'carla.tardia@ejemplo.com';
          document.getElementById('consent-terms').checked = true;

          const slowPromise = window.NovarumCheckout.submitCheckout();
          await new Promise((r) => setTimeout(r, 40));

          // User closes modal and opens Pack before slow request finishes
          window.NovarumCheckout.closeCheckout();
          window.NovarumCheckout.openCheckout('mujer-informada-4');

          await slowPromise;
          await new Promise((r) => setTimeout(r, 200));

          return {
            formHidden: document.getElementById('checkout-form-container').hidden,
            confirmationHidden: document.getElementById('checkout-confirmation-container').hidden,
            currentProductTitle: document.getElementById('checkout-product-title').textContent,
          };
        })()`);
        delayCheckoutMs = 0;

        assert.equal(staleDiscardResult.formHidden, false, 'New modal session must stay on form view');
        assert.equal(staleDiscardResult.confirmationHidden, true, 'Late response from previous attempt must be discarded');
        assert.equal(staleDiscardResult.currentProductTitle, 'Pack Completo: Mujer Informada (4 Cursos)');
      });

      // -----------------------------------------------------------------------
      // E2E 6.6: Strict 200/201 Response Validation & Safe Status Rendering (P2 #5 & #7)
      // -----------------------------------------------------------------------
      await subT.test('6.6 Browser Strict Response Validation: rejects HTTP 200 {} and XSS status strings', async () => {
        // Inject an empty 200 {} response from server
        overrideCheckoutResponse = { statusCode: 200, body: {} };

        const malformedResult = await cdp.evaluate(`(async () => {
          window.NovarumCheckout.openCheckout('sop');
          document.getElementById('checkout-name').value = 'Laura Valida';
          document.getElementById('checkout-email').value = 'laura.valida@ejemplo.com';
          document.getElementById('consent-terms').checked = true;

          await window.NovarumCheckout.submitCheckout();

          return {
            confirmationHidden: document.getElementById('checkout-confirmation-container').hidden,
            alertHidden: document.getElementById('checkout-error-alert').hidden,
            alertTitle: document.getElementById('alert-title').textContent,
            modalText: document.getElementById('checkout-modal').textContent,
          };
        })()`);

        assert.equal(malformedResult.confirmationHidden, true, 'Confirmation must NEVER be shown for HTTP 200 {}');
        assert.equal(malformedResult.alertHidden, false, 'Error alert must be shown for invalid server response');
        assert.match(malformedResult.alertTitle, /Respuesta inválida del servidor/);
        assert.ok(!malformedResult.modalText.includes('DPS-XXXXX'), 'Must never render DPS-XXXXX');
        assert.ok(!malformedResult.modalText.includes('NaN'), 'Must never render NaN');

        // Now complete the order with a valid response (clicking Retry uses the same frozen intent!)
        const recoveredValid = await cdp.evaluate(`(async () => {
          await window.NovarumCheckout.submitCheckout();
          return {
            confirmationHidden: document.getElementById('checkout-confirmation-container').hidden,
            paymentBtnDisabled: document.getElementById('btn-whatsapp-payment').disabled,
            paymentBtnAriaDisabled: document.getElementById('btn-whatsapp-payment').getAttribute('aria-disabled'),
          };
        })()`);

        assert.equal(recoveredValid.confirmationHidden, false);
        assert.equal(recoveredValid.paymentBtnDisabled, true, 'Payment coordination button must remain disabled in staging');
        assert.equal(recoveredValid.paymentBtnAriaDisabled, 'true');

        // Test checkOrderStatus with an unapproved / XSS status string -> must reject and never inject HTML
        overrideStatusResponse = {
          statusCode: 200,
          body: {
            order_number: 'DPS-20261103-1099',
            status: '<img id="xss-probe" src=x onerror=alert(1)>',
            total_amount_minor: 7900,
            currency: 'BOB',
          },
        };

        const xssStatusCheck = await cdp.evaluate(`(async () => {
          await window.NovarumCheckout.checkOrderStatus();
          return {
            xssElementExists: Boolean(document.getElementById('xss-probe')),
            feedbackClass: document.getElementById('status-lookup-feedback').className,
            feedbackText: document.getElementById('status-lookup-feedback').textContent,
          };
        })()`);

        assert.equal(xssStatusCheck.xssElementExists, false, 'Must never parse status via innerHTML');
        assert.match(xssStatusCheck.feedbackClass, /status-error/, 'Unapproved status must be rejected as error');

        // Now test checkOrderStatus with real backend status endpoint
        const validStatusCheck = await cdp.evaluate(`(async () => {
          await window.NovarumCheckout.checkOrderStatus();
          return {
            feedbackClass: document.getElementById('status-lookup-feedback').className,
            feedbackText: document.getElementById('status-lookup-feedback').textContent,
          };
        })()`);

        assert.match(validStatusCheck.feedbackClass, /status-success/);
        assert.match(validStatusCheck.feedbackText, /Estado Verificado: Pendiente de Pago/);
      });

      // -----------------------------------------------------------------------
      // E2E 6.7: Responsive 360px Mobile Viewport Verification (P2 #9)
      // -----------------------------------------------------------------------
      await subT.test('6.7 Browser Mobile 360px Viewport: zero horizontal overflow in catalog and checkout modal', async () => {
        await cdp.send('Emulation.setDeviceMetricsOverride', {
          width: 360,
          height: 800,
          deviceScaleFactor: 2,
          mobile: true,
        });

        const mobileCheck = await cdp.evaluate(`(() => {
          window.NovarumCheckout.openCheckout('mujer-informada-4');
          document.getElementById('btn-toggle-legal-terms').click();
          const scrollWidth = document.documentElement.scrollWidth;
          const clientWidth = document.documentElement.clientWidth;
          const modalRect = document.getElementById('checkout-modal').getBoundingClientRect();
          const legalHidden = document.getElementById('checkout-legal-summary').hidden;
          window.NovarumCheckout.closeCheckout();
          return { scrollWidth, clientWidth, modalRight: modalRect.right, modalLeft: modalRect.left, legalHidden };
        })()`);

        assert.equal(mobileCheck.legalHidden, false, 'Legal summary disclosure must toggle open cleanly');
        assert.ok(
          mobileCheck.scrollWidth <= 360,
          `Page scrollWidth (${mobileCheck.scrollWidth}) must not exceed 360px mobile viewport`
        );
        assert.ok(mobileCheck.modalLeft >= 0 && mobileCheck.modalRight <= 360, 'Modal must fit strictly within 360px viewport');
      });
    } finally {
      cdp.close();
      try {
        process.kill(-chromeProc.pid, 'SIGKILL');
      } catch (_) {}
      try {
        chromeProc.kill('SIGKILL');
      } catch (_) {}
      if (typeof server.closeAllConnections === 'function') {
        server.closeAllConnections();
      }
      await new Promise((resolve) => server.close(resolve));
      try {
        fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      } catch (_) {}
    }
  });
});
