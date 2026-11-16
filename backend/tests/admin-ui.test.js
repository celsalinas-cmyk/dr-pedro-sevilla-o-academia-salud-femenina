import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import http from 'http';
import net from 'net';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { createTestDatabase } from './setup-db.js';
import { buildApp } from '../src/server.js';
import { ADMIN_ROLES } from '../src/services/admin-auth.service.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.join(__dirname, '../../');

const TEST_OPERATORS = [
  {
    operator_id: 'op_academic_01',
    display_name: 'Carla Operadora Académica',
    role: ADMIN_ROLES.ACADEMIC_OPERATOR,
    password: 'AcademicPassword#2026!',
  },
  {
    operator_id: 'op_finance_01',
    display_name: 'Marco Verificador Financiero',
    role: ADMIN_ROLES.FINANCE_VERIFIER,
    password: 'FinancePassword#2026!',
  },
  {
    operator_id: 'op_admin_01',
    display_name: 'Dr. Pedro Administrador',
    role: ADMIN_ROLES.ACADEMY_ADMIN,
    password: 'AdminPassword#2026!',
  },
];

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
    srv.on('error', reject);
  });
}

function findChromeExecutable() {
  const candidates = [
    process.env.CHROME_BIN,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

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
          header[0] = 0x81;
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
            `Browser evaluation error: ${res.exceptionDetails.text} - ${JSON.stringify(
              res.exceptionDetails.exception || {}
            )}`
          );
        }
        return res.result?.value;
      }

      function close() {
        socket.destroy();
      }

      resolve({ send, evaluate, close });
    });

    req.end();
  });
}

test('Gate 2-A3-B2 (BL-05) — Commercial Inbox UI & Operational Workflows Suite', async (t) => {
  const adminHtmlPath = path.join(rootDir, 'admin.html');
  const adminCssPath = path.join(rootDir, 'css/admin.css');
  const adminJsPath = path.join(rootDir, 'js/admin.js');

  await t.test('1. Static Assets & HTML Semantic Structure Verification', () => {
    assert.ok(fs.existsSync(adminHtmlPath), 'admin.html must exist at repository root');
    assert.ok(fs.existsSync(adminCssPath), 'css/admin.css must exist');
    assert.ok(fs.existsSync(adminJsPath), 'js/admin.js must exist');

    const html = fs.readFileSync(adminHtmlPath, 'utf8');
    assert.ok(html.includes('role="tablist"'), 'admin.html must implement accessible tablist');
    assert.ok(html.includes('id="panelInquiries"'), 'admin.html must contain panelInquiries for mini CRM');
    assert.ok(html.includes('id="panelOrders"'), 'admin.html must contain panelOrders for orders & enrollments');
    assert.ok(html.includes('id="newInquiryModal"'), 'admin.html must contain modal to create inquiries');
    assert.ok(html.includes('id="manageInquiryModal"'), 'admin.html must contain modal to manage inquiries');
    assert.ok(html.includes('id="outboundForbiddenAlert"'), 'admin.html must have outbound contact alert banner');
    assert.ok(html.includes('id="verifyPaymentModal"'), 'admin.html must contain modal to verify payment');
    assert.ok(html.includes('id="enrollmentModal"'), 'admin.html must contain modal to register Moodle enrollment');

    const js = fs.readFileSync(adminJsPath, 'utf8');
    assert.ok(js.includes('/api/v1/admin/session/login'), 'js/admin.js must call login endpoint');
    assert.ok(js.includes('/api/v1/admin/inquiries'), 'js/admin.js must call inquiries endpoint');
    assert.ok(js.includes('/api/v1/admin/orders'), 'js/admin.js must call orders endpoint');
    assert.ok(js.includes('x-csrf-token'), 'js/admin.js must include x-csrf-token header on mutating requests');
    assert.ok(js.includes('outbound_contact_allowed'), 'js/admin.js must enforce outbound_contact_allowed guardrails');
    assert.ok(!js.includes('innerHTML'), 'js/admin.js must never use innerHTML to guarantee display security and prevent XSS');
  });

  await t.test('2. Real Headless Browser (Chrome CDP) E2E Verification of All BL-05 Controls', async (subT) => {
    const chromeBin = findChromeExecutable();
    assert.ok(chromeBin, 'Chrome or Chromium executable must be available for real browser E2E testing');

    let apiOrigin = '';
    // 1. Setup Static Frontend Server first to obtain frontendOrigin for CORS
    const frontendServer = http.createServer((req, res) => {
      try {
        const parsedUrl = new URL(req.url, 'http://127.0.0.1');
        let filePath = parsedUrl.pathname === '/' ? '/admin.html' : parsedUrl.pathname;
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
        };

        let content = fs.readFileSync(fullPath);
        if (ext === '.html') {
          let htmlStr = content.toString('utf8');
          // Inject API base URL for testing
          htmlStr = htmlStr.replace(
            '</head>',
            `<script>window.NOVARUM_API_BASE = "${apiOrigin}";</script></head>`
          );
          content = Buffer.from(htmlStr, 'utf8');
        }

        res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
        res.end(content);
      } catch (err) {
        res.writeHead(500);
        res.end(String(err));
      }
    });

    await new Promise((resolve) => frontendServer.listen(0, '127.0.0.1', resolve));
    const frontendPort = frontendServer.address().port;
    const frontendOrigin = `http://127.0.0.1:${frontendPort}`;

    const testDb = await createTestDatabase();
    const app = await buildApp(testDb, {
      rateLimitMax: 500,
      allowedOrigins: [frontendOrigin, 'http://127.0.0.1:3000', 'http://127.0.0.1:8080'],
    });
    await app.adminAuthService.bootstrapOperators(TEST_OPERATORS);

    // Setup an initial sample order in dr-sevilla
    const orderRes = await app.inject({
      method: 'POST',
      url: '/api/v1/checkout',
      payload: {
        sku: 'mujer-informada-4',
        name: 'Gabriela Montero',
        email: 'gabriela.montero@ejemplo.com',
        phone: '+59171234567',
        terms_accepted: true,
        idempotency_key: crypto.randomUUID(),
      },
    });
    assert.equal(orderRes.statusCode, 201);
    const sampleOrder = JSON.parse(orderRes.body);

    // Setup API HTTP server
    const apiServer = http.createServer(async (req, res) => {
      try {
        const parsedUrl = new URL(req.url, 'http://127.0.0.1');
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const rawBody = Buffer.concat(chunks).toString('utf8');

        const injectRes = await app.inject({
          method: req.method,
          url: parsedUrl.pathname + parsedUrl.search,
          headers: {
            ...req.headers,
            host: `127.0.0.1:${apiServer.address().port}`,
          },
          payload: rawBody || undefined,
        });

        res.writeHead(injectRes.statusCode, injectRes.headers);
        res.end(injectRes.body);
      } catch (err) {
        res.writeHead(500);
        res.end(String(err));
      }
    });

    await new Promise((resolve) => apiServer.listen(0, '127.0.0.1', resolve));
    const apiPort = apiServer.address().port;
    apiOrigin = `http://127.0.0.1:${apiPort}`;

    // Launch Chrome CDP with robust multi-mode Linux/macOS support
    const initialUrl = `${frontendOrigin}/admin.html`;
    let chromeProc = null;
    let userDataDir = null;
    let cdp = null;

    try {
      let pageWsUrl = null;
      const headlessModes = ['--headless=new', '--headless=new', '--headless'];

      for (let attempt = 0; attempt < headlessModes.length && !cdp; attempt++) {
        const headlessFlag = headlessModes[attempt];
        const debugPort = await getFreePort();
        userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'novarum-chrome-admin-'));

        chromeProc = spawn(
          chromeBin,
          [
            headlessFlag,
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
            '--password-store=basic',
            '--use-mock-keychain',
            '--dbus-stub',
            '--disable-features=dbus,OptimizationHints,MediaRouter,Translate',
            '--remote-allow-origins=*',
            `--remote-debugging-port=${debugPort}`,
            `--user-data-dir=${userDataDir}`,
            initialUrl,
          ],
          {
            stdio: 'ignore',
            detached: true,
            env: {
              ...process.env,
              DBUS_SESSION_BUS_ADDRESS: '/dev/null',
            },
          }
        );
        chromeProc.unref();

        let devtoolsReadyPolls = 0;
        let createdTargetAttempted = false;

        for (let i = 0; i < 150 && !pageWsUrl; i++) {
          if (chromeProc.exitCode !== null) {
            break;
          }
          try {
            const listRes = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
            if (listRes.ok) {
              devtoolsReadyPolls += 1;
              const targets = await listRes.json();

              let pageTarget = targets.find(
                (tgt) =>
                  tgt.type === 'page' &&
                  typeof tgt.url === 'string' &&
                  tgt.url.includes('admin.html') &&
                  tgt.webSocketDebuggerUrl
              );

              if (!pageTarget && devtoolsReadyPolls >= 10) {
                pageTarget = targets.find((tgt) => tgt.type === 'page' && tgt.webSocketDebuggerUrl);
              }

              if (!pageTarget && devtoolsReadyPolls >= 10 && !createdTargetAttempted) {
                createdTargetAttempted = true;
                try {
                  const newRes = await fetch(
                    `http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(initialUrl)}`,
                    { method: 'PUT' }
                  );
                  if (newRes.ok) {
                    const created = await newRes.json();
                    if (created && created.webSocketDebuggerUrl) {
                      pageTarget = created;
                    }
                  }
                } catch (_) {}

                if (!pageTarget) {
                  try {
                    const verRes = await fetch(`http://127.0.0.1:${debugPort}/json/version`);
                    if (verRes.ok) {
                      const verInfo = await verRes.json();
                      if (verInfo && verInfo.webSocketDebuggerUrl) {
                        const browserCdp = await connectCdpWebSocket(verInfo.webSocketDebuggerUrl);
                        await browserCdp.send('Target.createTarget', { url: initialUrl });
                        browserCdp.close();
                      }
                    }
                  } catch (_) {}
                }
              }

              if (pageTarget && pageTarget.webSocketDebuggerUrl) {
                pageWsUrl = pageTarget.webSocketDebuggerUrl;
                break;
              }
            }
          } catch (_) {}
          await new Promise((r) => setTimeout(r, 100));
        }

        if (pageWsUrl) {
          try {
            cdp = await connectCdpWebSocket(pageWsUrl);
            await cdp.send('Page.enable');
            await cdp.send('Runtime.enable');

            const currentHref = await cdp.evaluate('window.location.href');
            if (!currentHref || !currentHref.includes('admin.html')) {
              const navResult = await cdp.send('Page.navigate', { url: initialUrl });
              if (navResult && navResult.errorText) {
                throw new Error(`CDP Page.navigate error: ${navResult.errorText}`);
              }
            }

            for (let i = 0; i < 60; i++) {
              try {
                const ready = await cdp.evaluate(
                  'Boolean(window.location.href.includes("admin.html") && window.NovarumAdmin && document.readyState === "complete")'
                );
                if (ready) break;
              } catch (_) {}
              await new Promise((r) => setTimeout(r, 100));
            }
          } catch (_) {
            if (cdp) {
              cdp.close();
              cdp = null;
            }
            pageWsUrl = null;
          }
        }

        if (!cdp) {
          try {
            process.kill(-chromeProc.pid, 'SIGKILL');
          } catch (_) {}
          try {
            chromeProc.kill('SIGKILL');
          } catch (_) {}
          try {
            fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
          } catch (_) {}
          chromeProc = null;
          userDataDir = null;
        }
      }

      assert.ok(pageWsUrl && cdp, 'Headless Chrome must have an active page target for admin.html');

      // 1. Title verification
      const title = await cdp.evaluate('document.title');
      assert.ok(title.includes('NOVARUM'), `Page title must include NOVARUM, got: ${title}`);

      // 2. Initial state: Login card visible, Workspace hidden
      const isLoginVisible = await cdp.evaluate('!document.getElementById("loginView").hidden');
      const isWorkspaceHidden = await cdp.evaluate('document.getElementById("appWorkspace").hidden');
      assert.equal(isLoginVisible, true, 'loginView must be visible initially');
      assert.equal(isWorkspaceHidden, true, 'appWorkspace must be hidden initially');

      // 3. Perform Login with Dr. Pedro Administrador (academy_admin has full permissions)
      await cdp.evaluate(`
        document.getElementById("loginOperatorId").value = "op_admin_01";
        document.getElementById("loginPassword").value = "AdminPassword#2026!";
        document.getElementById("loginForm").dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
      `);
      await new Promise((r) => setTimeout(r, 800));

      const isWorkspaceNowVisible = await cdp.evaluate('!document.getElementById("appWorkspace").hidden');
      assert.equal(isWorkspaceNowVisible, true, 'appWorkspace must become visible after login');

      const opName = await cdp.evaluate('document.getElementById("operatorDisplayName").textContent');
      assert.equal(opName, 'Dr. Pedro Administrador', 'Operator name must match authenticated user');

      // 4. Test Guardrail on New Inquiry: Block clinical data
      await cdp.evaluate('document.getElementById("openNewInquiryModalBtn").click()');
      await new Promise((r) => setTimeout(r, 300));

      await cdp.evaluate(`
        document.getElementById("newInquiryName").value = "Paciente Test";
        document.getElementById("newInquiryPhone").value = "+59170099881";
        document.getElementById("newInquiryNotes").value = "Paciente reporta sangrado y dolor pélvico";
        document.getElementById("newInquiryForm").dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
      `);
      await new Promise((r) => setTimeout(r, 300));

      const clinicalError = await cdp.evaluate('document.getElementById("newInquiryError").textContent');
      assert.ok(
        clinicalError.includes('Restricción de Privacidad') || clinicalError.includes('clínicos'),
        `Clinical text must be blocked, got: ${clinicalError}`
      );

      // 5. Submit valid commercial inquiry
      await cdp.evaluate(`
        document.getElementById("newInquiryName").value = "Laura Morales";
        document.getElementById("newInquiryPhone").value = "+59170099882";
        document.getElementById("newInquiryEmail").value = "laura.morales@ejemplo.com";
        document.getElementById("newInquiryChannel").value = "whatsapp";
        document.getElementById("newInquirySku").value = "mujer-informada-4";
        document.getElementById("newInquiryCategory").value = "pricing_and_pack_comparison";
        document.getElementById("newInquiryNotes").value = "Consulta sobre precio del pack completo y facilidades de pago QR";
        document.getElementById("newInquiryForm").dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
      `);
      await new Promise((r) => setTimeout(r, 800));

      // Inquiry should now appear in the table
      const tableRowsCount = await cdp.evaluate('document.querySelectorAll("#inquiriesTableBody tr").length');
      assert.ok(tableRowsCount >= 1, 'Inquiries table must render the created inquiry');

      // 6. Test Outbound Contact Restriction & Candidate Match
      // Register inquiry with outbound_contact_allowed=false
      await cdp.evaluate('document.getElementById("openNewInquiryModalBtn").click()');
      await new Promise((r) => setTimeout(r, 300));

      await cdp.evaluate(`
        document.getElementById("newInquiryName").value = "Gabriela Montero";
        document.getElementById("newInquiryPhone").value = "+59171234567";
        document.getElementById("newInquiryEmail").value = "gabriela.montero@ejemplo.com";
        document.getElementById("newInquiryChannel").value = "tiktok";
        document.getElementById("newInquirySku").value = "mujer-informada-4";
        document.getElementById("newInquiryBasis").value = "no_outbound_permission";
        document.getElementById("newInquiryOutbound").checked = false;
        document.getElementById("newInquiryCategory").value = "course_info_requested";
        document.getElementById("newInquiryNotes").value = "Solicita información pero pide no recibir llamadas comerciales";
        document.getElementById("newInquiryForm").dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
      `);
      await new Promise((r) => setTimeout(r, 800));

      // Open manage modal for Gabriela Montero (who matches sampleOrder)
      await cdp.evaluate(`
        const btns = Array.from(document.querySelectorAll("#inquiriesTableBody .btn-row-action"));
        const btn = btns.find(b => b.textContent.includes("Gestionar"));
        if (btn) btn.click();
      `);
      await new Promise((r) => setTimeout(r, 400));

      // Outbound alert banner must be visible and contacted status disabled
      const isOutboundAlertVisible = await cdp.evaluate(
        '!document.getElementById("outboundForbiddenAlert").hidden'
      );
      assert.equal(isOutboundAlertVisible, true, 'outboundForbiddenAlert must be visible for inquiry without outbound consent');

      const isContactedOptDisabled = await cdp.evaluate(
        'document.getElementById("optStatusContacted").disabled'
      );
      assert.equal(isContactedOptDisabled, true, 'contacted option must be disabled when outbound_contact_allowed is false');

      // Verify suggested candidate from sampleOrder is shown
      const candidateCardsCount = await cdp.evaluate(
        'document.querySelectorAll("#candidatesListContainer .candidate-card").length'
      );
      assert.ok(candidateCardsCount >= 1, 'Candidate order match card must be rendered in manage modal');

      // Verify contract mapping: order number, product title, and formatted amount without undefined or NaN
      const candidateText = await cdp.evaluate(
        'document.querySelector("#candidatesListContainer .candidate-card .candidate-info").textContent'
      );
      assert.ok(!candidateText.includes('undefined'), `Candidate display must not contain 'undefined', got: ${candidateText}`);
      assert.ok(!candidateText.includes('NaN'), `Candidate display must not contain 'NaN', got: ${candidateText}`);
      assert.ok(candidateText.includes('Pedido #'), `Candidate display must show order number, got: ${candidateText}`);
      assert.ok(candidateText.includes('199.00'), `Candidate display must show formatted currency amount (199.00), got: ${candidateText}`);
      assert.ok(candidateText.includes('Coincide por'), `Candidate display must explain match reason, got: ${candidateText}`);

      // Click link button to link candidate order
      await cdp.evaluate(`
        const linkBtn = document.querySelector("#candidatesListContainer .candidate-card button");
        if (linkBtn) linkBtn.click();
      `);
      await new Promise((r) => setTimeout(r, 800));

      // 7. Tab 2: Orders & Manual Enrollment Workflow
      await cdp.evaluate('document.getElementById("tabOrders").click()');
      await new Promise((r) => setTimeout(r, 800));

      const isOrdersPanelActive = await cdp.evaluate(
        'document.getElementById("panelOrders").classList.contains("active")'
      );
      assert.equal(isOrdersPanelActive, true, 'panelOrders must be active');

      const ordersRowsCount = await cdp.evaluate('document.querySelectorAll("#ordersTableBody tr").length');
      assert.ok(ordersRowsCount >= 1, 'Orders table must display sample order');

      // Test QR coordination modal
      await cdp.evaluate(`
        const qrBtn = Array.from(document.querySelectorAll("#ordersTableBody .btn-row-action")).find(b => b.textContent.includes("Enviar QR"));
        if (qrBtn) qrBtn.click();
      `);
      await new Promise((r) => setTimeout(r, 400));

      await cdp.evaluate(`
        document.getElementById("coordinationEventType").value = "qr_sent";
        document.getElementById("coordinationNotes").value = "QR enviado por WhatsApp oficial";
        document.getElementById("coordinationForm").dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
      `);
      await new Promise((r) => setTimeout(r, 800));

      // Test Verify Payment Modal
      await cdp.evaluate(`
        const payBtn = Array.from(document.querySelectorAll("#ordersTableBody .btn-row-action")).find(b => b.textContent.includes("Verificar Pago"));
        if (payBtn) payBtn.click();
      `);
      await new Promise((r) => setTimeout(r, 400));

      await cdp.evaluate(`
        document.getElementById("verifyBankRef").value = "BNB-UI-TEST-2026-99";
        document.getElementById("verifyBankName").value = "BNB";
        document.getElementById("verifyNotes").value = "Abono verificado en extracto BNB";
        document.getElementById("verifyPaymentForm").dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
      `);
      await new Promise((r) => setTimeout(r, 1000));

      // Verify safe orders table rendering: ensure all cells are free of undefined/NaN
      const orderCells = await cdp.evaluate(`
        Array.from(document.querySelectorAll("#ordersTableBody tr td")).map(td => td.textContent)
      `);
      assert.ok(orderCells.length > 0, 'Orders table must render table cells');
      assert.ok(orderCells.every((t) => !t.includes('undefined') && !t.includes('NaN')), 'Orders table cells must never contain undefined or NaN');

      // Status should now be 'Pago Verificado' and action button becomes 'Iniciar Matrícula' / 'Matricular Moodle'
      const enrollBtnExists = await cdp.evaluate(`
        Boolean(Array.from(document.querySelectorAll("#ordersTableBody .btn-row-action")).find(b => b.textContent.includes("Iniciar Matrícula") || b.textContent.includes("Matricular Moodle")))
      `);
      assert.equal(enrollBtnExists, true, 'Matricular Moodle action must appear after payment verification');

      // Test Enrollment: Start enrollment first
      await cdp.evaluate(`
        const enrollBtn = Array.from(document.querySelectorAll("#ordersTableBody .btn-row-action")).find(b => b.textContent.includes("Iniciar Matrícula") || b.textContent.includes("Matricular Moodle"));
        if (enrollBtn) enrollBtn.click();
      `);
      await new Promise((r) => setTimeout(r, 400));

      await cdp.evaluate(`
        document.getElementById("enrollmentActionType").value = "start";
        document.getElementById("enrollmentNotes").value = "Iniciando enrolamiento en Moodle";
        document.getElementById("enrollmentForm").dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
      `);
      await new Promise((r) => setTimeout(r, 800));

      // Test Enrollment Confirmation
      await cdp.evaluate(`
        const enrollBtn2 = Array.from(document.querySelectorAll("#ordersTableBody .btn-row-action")).find(b => b.textContent.includes("Confirmar Moodle") || b.textContent.includes("Matricular Moodle"));
        if (enrollBtn2) enrollBtn2.click();
      `);
      await new Promise((r) => setTimeout(r, 400));

      await cdp.evaluate(`
        document.getElementById("enrollmentActionType").value = "confirm";
        document.getElementById("enrollmentNotes").value = "Usuario enrolado en cloud.novarum.com.bo";
        document.getElementById("enrollmentForm").dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
      `);
      await new Promise((r) => setTimeout(r, 1000));

      const isOrderFulfilled = await cdp.evaluate(`
        Boolean(Array.from(document.querySelectorAll("#ordersTableBody td")).find(td => td.textContent.includes("Matriculado en Moodle")))
      `);
      assert.equal(isOrderFulfilled, true, 'Order must transition to fulfilled in UI');

      // 8. Mobile 360px Viewport Overflow Test
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: 360,
        height: 640,
        deviceScaleFactor: 2,
        mobile: true,
      });
      await new Promise((r) => setTimeout(r, 300));

      const hasHorizontalOverflow = await cdp.evaluate(
        'document.documentElement.scrollWidth > document.documentElement.clientWidth'
      );
      assert.equal(hasHorizontalOverflow, false, 'admin.html must have zero horizontal overflow on mobile 360px');

      // 9. Contract Compatibility & XSS-Safe DOM Rendering Unit Checks
      const contractCheck = await cdp.evaluate(`
        (() => {
          // 1. Candidate match with real backend response schema: total_amount_minor, sku, no product_title
          const testInquiry1 = {
            id: 'inq-test-contract-1',
            linked_order_id: null,
            order_match_ambiguous: false,
            order_match_candidates: [
              {
                order_id: 'ord-uuid-001',
                order_number: 'NOV-2026-7788',
                status: 'pending_payment',
                total_amount_minor: 19900,
                currency: 'BOB',
                sku: 'mujer-informada-4',
                matched_by: 'email_and_phone',
              },
              {
                order_id: 'ord-uuid-002',
                order_number: 'NOV-2026-9900',
                status: 'pending_payment',
                total_amount_minor: 8900,
                currency: 'BOB',
                sku: 'endometriosis',
                matched_by: 'email',
              }
            ],
          };

          window.NovarumAdmin.renderOrderLinkageSection(testInquiry1);
          const cards = Array.from(document.querySelectorAll("#candidatesListContainer .candidate-card"));
          const text1 = cards[0]?.querySelector(".candidate-info")?.textContent || '';
          const text2 = cards[1]?.querySelector(".candidate-info")?.textContent || '';

          // 2. Candidate match with potential XSS payloads
          const testInquiryXss = {
            id: 'inq-test-xss',
            linked_order_id: null,
            order_match_ambiguous: false,
            order_match_candidates: [
              {
                order_id: 'ord-uuid-xss',
                order_number: '<script id="cand-xss-script">alert(1)</script>',
                status: 'pending_payment',
                total_amount_minor: 4500,
                currency: '<b id="cand-xss-cur">BOB</b>',
                sku: 'vaginosis',
                matched_by: '<img id="cand-xss-img" src=x onerror=alert(2)>',
              }
            ],
          };

          window.NovarumAdmin.renderOrderLinkageSection(testInquiryXss);
          const xssScriptExists = Boolean(document.getElementById("cand-xss-script"));
          const xssImgExists = Boolean(document.getElementById("cand-xss-img"));
          const xssCurExists = Boolean(document.getElementById("cand-xss-cur"));
          const xssText = document.querySelector("#candidatesListContainer .candidate-card .candidate-info")?.textContent || '';

          return {
            text1,
            text2,
            xssScriptExists,
            xssImgExists,
            xssCurExists,
            xssText,
          };
        })()
      `);

      assert.ok(!contractCheck.text1.includes('undefined') && !contractCheck.text1.includes('NaN'), 'Candidate 1 must not contain undefined or NaN');
      assert.ok(contractCheck.text1.includes('NOV-2026-7788'), 'Candidate 1 must display order number');
      assert.ok(contractCheck.text1.includes('Mujer Informada'), 'Candidate 1 must display resolved product title from SKU');
      assert.ok(contractCheck.text1.includes('199.00'), 'Candidate 1 must format total_amount_minor (19900 -> 199.00)');
      assert.ok(contractCheck.text1.includes('email y teléfono'), 'Candidate 1 must display formatted matched_by label');

      assert.ok(!contractCheck.text2.includes('undefined') && !contractCheck.text2.includes('NaN'), 'Candidate 2 must not contain undefined or NaN');
      assert.ok(contractCheck.text2.includes('NOV-2026-9900'), 'Candidate 2 must display order number');
      assert.ok(contractCheck.text2.includes('Endometriosis'), 'Candidate 2 must display resolved product title from SKU');
      assert.ok(contractCheck.text2.includes('89.00'), 'Candidate 2 must format total_amount_minor (8900 -> 89.00)');

      assert.equal(contractCheck.xssScriptExists, false, 'Candidate rendering must never execute or inject <script> tags');
      assert.equal(contractCheck.xssImgExists, false, 'Candidate rendering must never inject <img> tags');
      assert.equal(contractCheck.xssCurExists, false, 'Candidate rendering must never inject <b> tags');
      assert.ok(contractCheck.xssText.includes('<script'), 'Malicious payloads must be safely escaped as plain text content');

      // 10. Logout Test
      await cdp.evaluate('document.getElementById("logoutBtn").click()');
      await new Promise((r) => setTimeout(r, 600));

      const isLoginViewBack = await cdp.evaluate('!document.getElementById("loginView").hidden');
      assert.equal(isLoginViewBack, true, 'loginView must be restored after logout');
    } finally {
      if (cdp) cdp.close();
      if (chromeProc) {
        try {
          process.kill(-chromeProc.pid, 'SIGKILL');
        } catch (_) {}
        try {
          chromeProc.kill('SIGKILL');
        } catch (_) {}
      }
      if (userDataDir) {
        try {
          fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
        } catch (_) {}
      }
      await new Promise((r) => frontendServer.close(r));
      await new Promise((r) => apiServer.close(r));
      await app.close();
      await testDb.close();
    }
  });
});
