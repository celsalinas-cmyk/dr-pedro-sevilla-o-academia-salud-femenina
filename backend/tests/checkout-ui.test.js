import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { createTestDatabase } from './setup-db.js';
import { buildApp } from '../src/server.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.join(__dirname, '../../');

test('Checkout UI & Commercial Flow Suite (Gate 2-A2 QA)', async (t) => {
  let testDb;
  let app;
  let htmlContent;
  let jsContent;
  let cssContent;

  t.before(async () => {
    testDb = await createTestDatabase();
    app = await buildApp(testDb, { rateLimitMax: 20 });
    htmlContent = fs.readFileSync(path.join(rootDir, 'index.html'), 'utf8');
    jsContent = fs.readFileSync(path.join(rootDir, 'js/checkout.js'), 'utf8');
    cssContent = fs.readFileSync(path.join(rootDir, 'css/styles.css'), 'utf8');
  });

  t.after(async () => {
    if (app) await app.close();
    if (testDb) await testDb.close();
  });

  await t.test('1. Catalog Non-Regression & 5 Connected Purchase Buttons in HTML', () => {
    const requiredSkus = [
      'mujer-informada-4',
      'endometriosis',
      'vaginosis',
      'sop',
      'aprende-mujer'
    ];

    for (const sku of requiredSkus) {
      assert.ok(
        htmlContent.includes(`data-sku="${sku}"`),
        `HTML must contain an active button for official SKU: ${sku}`
      );
      assert.ok(
        htmlContent.includes(`data-action="open-checkout"`),
        'Purchase buttons must have data-action="open-checkout"'
      );
    }

    // Ensure staging disabled class is removed from the active purchase buttons
    assert.ok(
      !htmlContent.includes('btn-bundle btn-staging-disabled'),
      'Bundle purchase button must no longer be disabled in staging'
    );
    assert.ok(
      htmlContent.includes('btn-open-checkout'),
      'Buttons must have btn-open-checkout class'
    );

    // Verify modal exists in DOM
    assert.ok(htmlContent.includes('id="checkout-modal"'), 'Checkout modal container must exist');
    assert.ok(htmlContent.includes('role="dialog"'), 'Modal must have role="dialog"');
    assert.ok(htmlContent.includes('aria-modal="true"'), 'Modal must have aria-modal="true"');
    assert.ok(htmlContent.includes('src="js/checkout.js"'), 'index.html must load js/checkout.js');
  });

  await t.test('2. Form Fields & Separated Consents Definition', () => {
    // Inputs
    assert.ok(htmlContent.includes('id="checkout-name"'), 'Must have full name input');
    assert.ok(htmlContent.includes('id="checkout-email"'), 'Must have email input');
    assert.ok(htmlContent.includes('id="checkout-phone"'), 'Must have optional phone input');

    // Consents
    assert.ok(htmlContent.includes('id="consent-terms"'), 'Must have separate terms & privacy consent checkbox');
    assert.ok(htmlContent.includes('id="consent-marketing"'), 'Must have separate marketing consent checkbox');
    assert.ok(htmlContent.includes('v1.0'), 'Terms consent must reference privacy version v1.0');

    // Confirmation container
    assert.ok(htmlContent.includes('id="checkout-confirmation-container"'), 'Must have confirmation view container');
    assert.ok(htmlContent.includes('id="confirmed-order-number"'), 'Must have order number display');
    assert.ok(htmlContent.includes('id="btn-check-order-status"'), 'Must have order status check button');
  });

  await t.test('3. Individual Course Purchases: Each of the 4 courses registers correctly at Bs 79', async () => {
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
        utm: { source: 'instagram', campaign: 'salud_femenina' }
      };

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/checkout',
        payload
      });

      assert.equal(res.statusCode, 201, `Checkout for SKU ${sku} must return HTTP 201`);
      const data = JSON.parse(res.body);

      assert.ok(data.order_number.startsWith('DPS-'), 'Order number must have DPS- prefix');
      assert.equal(data.total_amount_minor, 7900, 'Individual course price must be 7900 minor units (Bs 79.00)');
      assert.equal(data.currency, 'BOB', 'Currency must be BOB');
      assert.equal(data.status, 'pending_payment', 'Initial status must be pending_payment');
      assert.ok(data.opaque_token, 'Response must include opaque_token');
    }
  });

  await t.test('4. Bundle Purchase: Complete pack (mujer-informada-4) registers at Bs 199', async () => {
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
      utm: { source: 'tiktok', medium: 'reels', campaign: 'sop_lanzamiento' }
    };

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/checkout',
      payload
    });

    assert.equal(res.statusCode, 201);
    const data = JSON.parse(res.body);

    assert.equal(data.total_amount_minor, 19900, 'Bundle price must be 19900 minor units (Bs 199.00)');
    assert.equal(data.currency, 'BOB');
    assert.equal(data.status, 'pending_payment');
    assert.ok(data.opaque_token);
    assert.ok(data.order_number);
  });

  await t.test('5. Rapid Double-Click & Retry: Same Idempotency Key returns HTTP 200 without duplicate orders', async () => {
    const idempotencyKey = crypto.randomUUID();
    const payload = {
      sku: 'sop',
      name: 'Elena Morales',
      email: 'elena.idempotent@ejemplo.com',
      terms_accepted: true,
      privacy_version: 'v1.0',
      idempotency_key: idempotencyKey
    };

    // First request
    const res1 = await app.inject({
      method: 'POST',
      url: '/api/v1/checkout',
      payload
    });
    assert.equal(res1.statusCode, 201);
    const order1 = JSON.parse(res1.body);

    // Rapid second click with identical payload (simulating user retry or network replay)
    const res2 = await app.inject({
      method: 'POST',
      url: '/api/v1/checkout',
      payload
    });
    assert.equal(res2.statusCode, 200, 'Replay with identical idempotency key must return HTTP 200 OK');
    const order2 = JSON.parse(res2.body);

    // Must be the exact same order
    assert.equal(order1.order_number, order2.order_number);
    assert.equal(order1.opaque_token, order2.opaque_token);
    assert.equal(order1.total_amount_minor, order2.total_amount_minor);
  });

  await t.test('6. Input Validations: Rejects invalid names, emails, phones, and missing consent', async () => {
    // Missing required consent
    const resNoTerms = await app.inject({
      method: 'POST',
      url: '/api/v1/checkout',
      payload: {
        sku: 'sop',
        name: 'Camila Rojas',
        email: 'camila@ejemplo.com',
        terms_accepted: false,
        idempotency_key: crypto.randomUUID()
      }
    });
    assert.equal(resNoTerms.statusCode, 422);

    // Invalid email format
    const resBadEmail = await app.inject({
      method: 'POST',
      url: '/api/v1/checkout',
      payload: {
        sku: 'sop',
        name: 'Camila Rojas',
        email: 'not-an-email',
        terms_accepted: true,
        idempotency_key: crypto.randomUUID()
      }
    });
    assert.equal(resBadEmail.statusCode, 422);

    // Invalid phone characters
    const resBadPhone = await app.inject({
      method: 'POST',
      url: '/api/v1/checkout',
      payload: {
        sku: 'sop',
        name: 'Camila Rojas',
        email: 'camila2@ejemplo.com',
        phone: 'invalid-phone-letters',
        terms_accepted: true,
        idempotency_key: crypto.randomUUID()
      }
    });
    assert.equal(resBadPhone.statusCode, 422);
  });

  await t.test('7. Conflicting Payload on Reused Key returns HTTP 409', async () => {
    const key = crypto.randomUUID();
    const payloadA = {
      sku: 'endometriosis',
      name: 'Patricia Soliz',
      email: 'patricia@ejemplo.com',
      terms_accepted: true,
      idempotency_key: key
    };

    const resA = await app.inject({
      method: 'POST',
      url: '/api/v1/checkout',
      payload: payloadA
    });
    assert.equal(resA.statusCode, 201);

    // Second request reuses same key but changes SKU (conflict)
    const payloadB = {
      ...payloadA,
      sku: 'vaginosis'
    };

    const resB = await app.inject({
      method: 'POST',
      url: '/api/v1/checkout',
      payload: payloadB
    });
    assert.equal(resB.statusCode, 409, 'Reusing key with different SKU must return HTTP 409 Conflict');
  });

  await t.test('8. Order Status Query: Public check via opaque_token returns status with Zero PII', async () => {
    const payload = {
      sku: 'vaginosis',
      name: 'Luciana Paz',
      email: 'luciana@ejemplo.com',
      phone: '+59171234567',
      terms_accepted: true,
      idempotency_key: crypto.randomUUID()
    };

    const checkoutRes = await app.inject({
      method: 'POST',
      url: '/api/v1/checkout',
      payload
    });
    const { opaque_token, order_number } = JSON.parse(checkoutRes.body);

    // Query status endpoint
    const statusRes = await app.inject({
      method: 'GET',
      url: `/api/v1/orders/${opaque_token}/status`
    });

    assert.equal(statusRes.statusCode, 200);
    const statusData = JSON.parse(statusRes.body);

    assert.equal(statusData.order_number, order_number);
    assert.equal(statusData.status, 'pending_payment');
    assert.equal(statusData.total_amount_minor, 7900);
    assert.equal(statusData.currency, 'BOB');

    // Strict Zero PII assertion: no customer name, email, or phone in public status response
    assert.equal(statusData.email, undefined, 'Must not expose email');
    assert.equal(statusData.name, undefined, 'Must not expose name');
    assert.equal(statusData.phone, undefined, 'Must not expose phone');
    assert.equal(statusData.lead_id, undefined, 'Must not expose internal lead_id');
  });

  await t.test('9. JavaScript Client Structure & Logic Verification', () => {
    // Check key methods in checkout.js
    assert.ok(jsContent.includes('PRODUCTS'), 'checkout.js must define catalog PRODUCTS');
    assert.ok(jsContent.includes('getSanitizedUtm'), 'checkout.js must parse and sanitize UTMs');
    assert.ok(jsContent.includes('generateUUID'), 'checkout.js must generate UUID idempotency keys');
    assert.ok(jsContent.includes('openCheckout'), 'checkout.js must export openCheckout handler');
    assert.ok(jsContent.includes('closeCheckout'), 'checkout.js must export closeCheckout handler');
    assert.ok(jsContent.includes('submitCheckout'), 'checkout.js must handle checkout submission');
    assert.ok(jsContent.includes('checkOrderStatus'), 'checkout.js must support real-time order status check');
    assert.ok(jsContent.includes('handleCheckoutSuccess'), 'checkout.js must handle confirmation transition');
  });

  await t.test('10. CSS Responsive & Accessibility Rules Defined', () => {
    assert.ok(cssContent.includes('.checkout-backdrop'), 'CSS must define .checkout-backdrop');
    assert.ok(cssContent.includes('.checkout-modal'), 'CSS must define .checkout-modal');
    assert.ok(cssContent.includes('.checkout-alert'), 'CSS must define .checkout-alert');
    assert.ok(cssContent.includes('.btn-spinner'), 'CSS must define .btn-spinner for loading state');
    assert.ok(cssContent.includes('.confirmation-card'), 'CSS must define .confirmation-card');
    assert.ok(cssContent.includes('@media (max-width: 640px)'), 'CSS must include mobile breakpoint rules');
  });
});
