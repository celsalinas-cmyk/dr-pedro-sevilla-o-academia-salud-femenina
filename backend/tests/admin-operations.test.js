import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { createTestDatabase } from './setup-db.js';
import { buildApp } from '../src/server.js';
import { ADMIN_ROLES } from '../src/services/admin-auth.service.js';

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

async function createSampleOrder(app, sku = 'mujer-informada-4', emailSuffix = crypto.randomUUID().slice(0, 8)) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/checkout',
    payload: {
      sku,
      name: 'Natalia Castro',
      email: `compradora_${emailSuffix}@ejemplo.com`,
      phone: '+59170099887',
      terms_accepted: true,
      idempotency_key: crypto.randomUUID(),
    },
  });
  assert.equal(res.statusCode, 201);
  return JSON.parse(res.body);
}

async function loginOperator(app, operatorId, password) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/admin/session/login',
    payload: { operator_id: operatorId, password },
  });
  assert.equal(res.statusCode, 200);
  const setCookie = res.headers['set-cookie'];
  assert.ok(setCookie, 'Set-Cookie header must be returned on login');
  const cookiePair = setCookie.split(';')[0];
  const body = JSON.parse(res.body);
  return {
    cookie: cookiePair,
    csrfToken: body.csrf_token,
    session: body.session,
    rawSetCookie: setCookie,
  };
}

test('Gate 2-A3-A1 — Assisted Commercial Operations, Reconciliation & RBAC Suite', async (t) => {
  let testDb;
  let app;

  t.beforeEach(async () => {
    testDb = await createTestDatabase();
    app = await buildApp(testDb, {
      rateLimitMax: 200,
      allowedOrigins: ['https://academiamujersana.com', 'http://localhost:3000'],
    });
    await app.adminAuthService.bootstrapOperators(TEST_OPERATORS);
  });

  t.afterEach(async () => {
    if (app) await app.close();
    if (testDb) await testDb.close();
  });

  await t.test('1. Authentication, Session Expiration, Revocation, Cookie Attributes & CSRF Protection', async () => {
    // 1a. Unauthenticated request is rejected with 401
    const unauthRes = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/orders',
    });
    assert.equal(unauthRes.statusCode, 401);
    assert.equal(JSON.parse(unauthRes.body).error, 'ADMIN_AUTH_REQUIRED');

    // 1b. Wrong password and unknown operator return 401
    const badLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/session/login',
      payload: { operator_id: 'op_admin_01', password: 'WrongPassword123!' },
    });
    assert.equal(badLogin.statusCode, 401);
    assert.equal(JSON.parse(badLogin.body).error, 'INVALID_ADMIN_CREDENTIALS');

    // 1c. Valid login returns HttpOnly, Secure, SameSite=Strict cookie + CSRF token
    const adminAuth = await loginOperator(app, 'op_admin_01', 'AdminPassword#2026!');
    assert.ok(adminAuth.rawSetCookie.includes('HttpOnly'));
    assert.ok(adminAuth.rawSetCookie.includes('Secure'));
    assert.ok(adminAuth.rawSetCookie.includes('SameSite=Strict'));
    assert.ok(adminAuth.rawSetCookie.includes('Path=/api/v1/admin'));
    assert.equal(adminAuth.session.operator_id, 'op_admin_01');
    assert.equal(adminAuth.session.role, 'academy_admin');

    // 1d. Missing or invalid CSRF token on POST mutation returns 403
    const order = await createSampleOrder(app, 'endometriosis');
    const detailList = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/orders',
      headers: { cookie: adminAuth.cookie },
    });
    const orderId = JSON.parse(detailList.body).orders[0].id;

    const noCsrfRes = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/orders/${orderId}/coordination`,
      headers: { cookie: adminAuth.cookie },
      payload: {
        event_type: 'qr_sent',
        channel: 'whatsapp_manual',
        notes: 'QR enviado manualmente a la compradora',
        idempotency_key: crypto.randomUUID(),
      },
    });
    assert.equal(noCsrfRes.statusCode, 403);
    assert.equal(JSON.parse(noCsrfRes.body).error, 'CSRF_TOKEN_INVALID');

    // 1e. Disallowed Origin on POST mutation returns 403
    const badOriginRes = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/orders/${orderId}/coordination`,
      headers: {
        cookie: adminAuth.cookie,
        'x-csrf-token': adminAuth.csrfToken,
        origin: 'https://evil-attacker.example.com',
      },
      payload: {
        event_type: 'qr_sent',
        channel: 'whatsapp_manual',
        notes: 'QR enviado manualmente',
        idempotency_key: crypto.randomUUID(),
      },
    });
    assert.equal(badOriginRes.statusCode, 403);

    // 1f. Logout immediately revokes session (401 SESSION_REVOKED on reuse)
    const logoutRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/session/logout',
      headers: {
        cookie: adminAuth.cookie,
        'x-csrf-token': adminAuth.csrfToken,
      },
    });
    assert.equal(logoutRes.statusCode, 200);

    const afterLogoutRes = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/orders',
      headers: { cookie: adminAuth.cookie },
    });
    assert.equal(afterLogoutRes.statusCode, 401);
    assert.equal(JSON.parse(afterLogoutRes.body).error, 'SESSION_REVOKED');

    // 1g. Expired session returns 401 SESSION_EXPIRED
    const expiredSession = await app.adminAuthService.login(
      { operator_id: 'op_academic_01', password: 'AcademicPassword#2026!' },
      { now: new Date(Date.now() - 10 * 3600 * 1000), ttlMs: 1000 }
    );
    const expiredRes = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/orders',
      headers: { authorization: `Bearer ${expiredSession.rawToken}` },
    });
    assert.equal(expiredRes.statusCode, 401);
    assert.equal(JSON.parse(expiredRes.body).error, 'SESSION_EXPIRED');

    // 1h. Emergency operator session revocation invalidates active sessions immediately
    const finAuth = await loginOperator(app, 'op_finance_01', 'FinancePassword#2026!');
    await app.adminAuthService.revokeOperatorSessions('op_finance_01', 'security_rotation');
    const revokedFinRes = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/orders',
      headers: { cookie: finAuth.cookie },
    });
    assert.equal(revokedFinRes.statusCode, 401);
    assert.equal(JSON.parse(revokedFinRes.body).error, 'SESSION_REVOKED');
  });

  await t.test('2. 3-Role RBAC Matrix & Anti-Spoofing Protection (403)', async () => {
    const academicAuth = await loginOperator(app, 'op_academic_01', 'AcademicPassword#2026!');
    const financeAuth = await loginOperator(app, 'op_finance_01', 'FinancePassword#2026!');
    const adminAuth = await loginOperator(app, 'op_admin_01', 'AdminPassword#2026!');

    await createSampleOrder(app, 'endometriosis');
    const listRes = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/orders',
      headers: { cookie: academicAuth.cookie },
    });
    const orderId = JSON.parse(listRes.body).orders[0].id;

    // 2a. Spoofing operator_id, role, or academy_id in body or query is rejected with 403 OPERATOR_SPOOFING_FORBIDDEN
    const spoofBodyRes = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/orders/${orderId}/coordination`,
      headers: {
        cookie: academicAuth.cookie,
        'x-csrf-token': academicAuth.csrfToken,
      },
      payload: {
        operator_id: 'op_admin_01',
        event_type: 'qr_sent',
        channel: 'whatsapp_manual',
        notes: 'Intento de suplantar operator_id',
        idempotency_key: crypto.randomUUID(),
      },
    });
    assert.equal(spoofBodyRes.statusCode, 403);
    assert.equal(JSON.parse(spoofBodyRes.body).error, 'OPERATOR_SPOOFING_FORBIDDEN');

    const spoofQueryRes = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/orders?academy_id=other-academy',
      headers: { cookie: academicAuth.cookie },
    });
    assert.equal(spoofQueryRes.statusCode, 403);
    assert.equal(JSON.parse(spoofQueryRes.body).error, 'OPERATOR_SPOOFING_FORBIDDEN');

    // 2b. academic_operator is forbidden (403) from verify-payment
    const academicVerifyRes = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/orders/${orderId}/verify-payment`,
      headers: {
        cookie: academicAuth.cookie,
        'x-csrf-token': academicAuth.csrfToken,
      },
      payload: { idempotency_key: crypto.randomUUID() },
    });
    assert.equal(academicVerifyRes.statusCode, 403, 'academic_operator must receive 403 on verify-payment');
    assert.equal(JSON.parse(academicVerifyRes.body).error, 'INSUFFICIENT_ROLE_PERMISSIONS');

    // 2c. finance_verifier is forbidden (403) from start-enrollment and confirm-enrollment
    for (const endpoint of ['start-enrollment', 'confirm-enrollment']) {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/admin/orders/${orderId}/${endpoint}`,
        headers: {
          cookie: financeAuth.cookie,
          'x-csrf-token': financeAuth.csrfToken,
        },
        payload: { idempotency_key: crypto.randomUUID() },
      });
      assert.equal(res.statusCode, 403, `finance_verifier must receive 403 on ${endpoint}`);
      assert.equal(JSON.parse(res.body).error, 'INSUFFICIENT_ROLE_PERMISSIONS');
    }

    // 2d. Postponed advanced financial exception endpoints are not exposed in the MVP HTTP surface (404)
    for (const postponedEndpoint of ['verify-late-payment', 'reallocate-reconciliation', 'reverse']) {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/admin/orders/${orderId}/${postponedEndpoint}`,
        headers: {
          cookie: financeAuth.cookie,
          'x-csrf-token': financeAuth.csrfToken,
        },
        payload: { idempotency_key: crypto.randomUUID() },
      });
      assert.equal(res.statusCode, 404, `Postponed endpoint ${postponedEndpoint} must return 404 in simplified MVP`);
    }
  });

  await t.test('3. Coordination Events (QR & Receipt) Never Verify Payment or Unlock Moodle Enrollment', async () => {
    const academicAuth = await loginOperator(app, 'op_academic_01', 'AcademicPassword#2026!');
    await createSampleOrder(app, 'vaginosis');

    const listRes = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/orders',
      headers: { cookie: academicAuth.cookie },
    });
    const orderId = JSON.parse(listRes.body).orders[0].id;

    // 3a. Record qr_sent and receipt_received
    const coordKey = crypto.randomUUID();
    const qrRes = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/orders/${orderId}/coordination`,
      headers: {
        cookie: academicAuth.cookie,
        'x-csrf-token': academicAuth.csrfToken,
      },
      payload: {
        event_type: 'qr_sent',
        channel: 'whatsapp_manual',
        external_reference: 'QR-MANUAL-BNB-001',
        notes: 'QR bancario manual enviado por WhatsApp',
        idempotency_key: coordKey,
      },
    });
    assert.equal(qrRes.statusCode, 201);
    assert.equal(JSON.parse(qrRes.body).order.status, 'pending_payment');
    assert.equal(JSON.parse(qrRes.body).event.operator_id, 'op_academic_01');

    // Idempotent replay of same coordination event returns 200
    const qrReplay = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/orders/${orderId}/coordination`,
      headers: {
        cookie: academicAuth.cookie,
        'x-csrf-token': academicAuth.csrfToken,
      },
      payload: {
        event_type: 'qr_sent',
        channel: 'whatsapp_manual',
        external_reference: 'QR-MANUAL-BNB-001',
        notes: 'QR bancario manual enviado por WhatsApp',
        idempotency_key: coordKey,
      },
    });
    assert.equal(qrReplay.statusCode, 200);
    assert.equal(JSON.parse(qrReplay.body).isIdempotentReplay, true);

    const receiptRes = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/orders/${orderId}/coordination`,
      headers: {
        cookie: academicAuth.cookie,
        'x-csrf-token': academicAuth.csrfToken,
      },
      payload: {
        event_type: 'receipt_received',
        channel: 'whatsapp_manual',
        external_reference: 'CAPTURA-CLIENTE-99',
        notes: 'Compradora envió captura de pantalla; pendiente extracto bancario',
        idempotency_key: crypto.randomUUID(),
      },
    });
    assert.equal(receiptRes.statusCode, 201);
    assert.equal(JSON.parse(receiptRes.body).order.status, 'pending_payment');

    // 3b. Attempting start-enrollment or confirm-enrollment while still in pending_payment is rejected with 409
    const prematureStart = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/orders/${orderId}/start-enrollment`,
      headers: {
        cookie: academicAuth.cookie,
        'x-csrf-token': academicAuth.csrfToken,
      },
      payload: {
        reason: 'Trying to enroll before bank verification',
        idempotency_key: crypto.randomUUID(),
      },
    });
    assert.equal(prematureStart.statusCode, 409);
    assert.equal(JSON.parse(prematureStart.body).error, 'ENROLLMENT_REQUIRES_PAID_VERIFIED');

    const prematureConfirm = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/orders/${orderId}/confirm-enrollment`,
      headers: {
        cookie: academicAuth.cookie,
        'x-csrf-token': academicAuth.csrfToken,
      },
      payload: {
        moodle_user_identifier: 'alumna@ejemplo.com',
        moodle_courses_enrolled: ['vaginosis'],
        access_confirmed: true,
        reason: 'Trying to confirm without paid_verified',
        idempotency_key: crypto.randomUUID(),
      },
    });
    assert.equal(prematureConfirm.statusCode, 409);
    assert.equal(JSON.parse(prematureConfirm.body).error, 'CONFIRM_ENROLLMENT_REQUIRES_ENROLLMENT_PENDING');
  });

  await t.test('4. Bank Verification Controls: Amount/Currency Validation, Standard Bank Reference & Postponed manual_resolution Guard', async () => {
    const financeAuth = await loginOperator(app, 'op_finance_01', 'FinancePassword#2026!');
    const adminAuth = await loginOperator(app, 'op_admin_01', 'AdminPassword#2026!');

    await createSampleOrder(app, 'sop');
    const listRes = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/orders',
      headers: { cookie: financeAuth.cookie },
    });
    const orderId = JSON.parse(listRes.body).orders[0].id;

    // 4a. Amount mismatch returns 422 AMOUNT_OR_CURRENCY_MISMATCH
    const mismatchRes = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/orders/${orderId}/verify-payment`,
      headers: {
        cookie: financeAuth.cookie,
        'x-csrf-token': financeAuth.csrfToken,
      },
      payload: {
        reconciliation_mode: 'standard_reference',
        bank_reference: 'BNB-20261105-7771',
        reconciliation_evidence: 'Extracto BNB abono parcial por error',
        recipient_account_id: 'BNB-DR-SEVILLA-BOB-01',
        recipient_account_verified: true,
        effective_transaction_verified: true,
        verified_amount_minor: 5000, // Order is 7900
        verified_currency: 'BOB',
        bank_credit_at: new Date().toISOString(),
        reason: 'Intento de conciliar monto distinto',
        idempotency_key: crypto.randomUUID(),
      },
    });
    assert.equal(mismatchRes.statusCode, 422);
    assert.equal(JSON.parse(mismatchRes.body).error, 'AMOUNT_OR_CURRENCY_MISMATCH');

    // 4b. Postponed manual_resolution mode is rejected with 422 VALIDATION_ERROR in simplified MVP
    const manualAttempt = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/orders/${orderId}/verify-payment`,
      headers: {
        cookie: adminAuth.cookie,
        'x-csrf-token': adminAuth.csrfToken,
      },
      payload: {
        reconciliation_mode: 'manual_resolution',
        bank_reference: null,
        reconciliation_evidence: 'Abono interbancario ACH sin glosa visible en extracto BNB línea 44',
        recipient_account_id: 'BNB-DR-SEVILLA-BOB-01',
        recipient_account_verified: true,
        effective_transaction_verified: true,
        verified_amount_minor: 7900,
        verified_currency: 'BOB',
        bank_credit_at: new Date().toISOString(),
        reason: 'Conciliación sin referencia estándar pospuesta en MVP',
        idempotency_key: crypto.randomUUID(),
      },
    });
    assert.equal(manualAttempt.statusCode, 422);
    assert.equal(JSON.parse(manualAttempt.body).error, 'VALIDATION_ERROR');

    // 4c. Standard bank reference verification succeeds (200) and transitions order to paid_verified
    const validStandardVerify = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/orders/${orderId}/verify-payment`,
      headers: {
        cookie: financeAuth.cookie,
        'x-csrf-token': financeAuth.csrfToken,
      },
      payload: {
        reconciliation_mode: 'standard_reference',
        bank_reference: 'BNB-20261105-7771',
        reconciliation_evidence: 'Abono QR verificado en extracto BNB línea 44 de fecha 05/11',
        recipient_account_id: 'BNB-DR-SEVILLA-BOB-01',
        recipient_account_verified: true,
        effective_transaction_verified: true,
        verified_amount_minor: 7900,
        verified_currency: 'BOB',
        bank_credit_at: new Date().toISOString(),
        reason: 'Confirmación humana de pago verificado en extracto bancario',
        idempotency_key: crypto.randomUUID(),
      },
    });
    assert.equal(validStandardVerify.statusCode, 200);
    const verifiedBody = JSON.parse(validStandardVerify.body);
    assert.equal(verifiedBody.order.status, 'paid_verified');
    assert.equal(verifiedBody.reconciliation.reconciliation_mode, 'standard_reference');
    assert.equal(verifiedBody.reconciliation.bank_reference, 'BNB-20261105-7771');
    assert.equal(verifiedBody.reconciliation.settlement_status, 'applied');
  });

  await t.test('5. Expired Order Protection: Rejects Ordinary Verify on Expired Order (409)', async () => {
    const financeAuth = await loginOperator(app, 'op_finance_01', 'FinancePassword#2026!');
    const adminAuth = await loginOperator(app, 'op_admin_01', 'AdminPassword#2026!');

    await createSampleOrder(app, 'aprende-mujer');
    const listRes = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/orders',
      headers: { cookie: financeAuth.cookie },
    });
    const orderId = JSON.parse(listRes.body).orders[0].id;

    // Force order expiration in DB
    await testDb.query(
      `UPDATE orders SET status = 'expired', expires_at = NOW() - INTERVAL '2 hours' WHERE id = $1`,
      [orderId]
    );

    // Ordinary verify-payment on expired order is rejected with 409 ORDER_EXPIRED_REQUIRES_LATE_PAYMENT_AUTH
    const ordinaryOnExpired = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/orders/${orderId}/verify-payment`,
      headers: {
        cookie: adminAuth.cookie,
        'x-csrf-token': adminAuth.csrfToken,
      },
      payload: {
        reconciliation_mode: 'standard_reference',
        bank_reference: 'BNB-LATE-0001',
        reconciliation_evidence: 'Abono recibido tras vencimiento de 72h',
        recipient_account_id: 'BNB-DR-SEVILLA-BOB-01',
        recipient_account_verified: true,
        effective_transaction_verified: true,
        verified_amount_minor: 7900,
        verified_currency: 'BOB',
        bank_credit_at: new Date().toISOString(),
        reason: 'Intentando usar verify-payment ordinario sobre pedido expirado',
        idempotency_key: crypto.randomUUID(),
      },
    });
    assert.equal(ordinaryOnExpired.statusCode, 409);
    assert.equal(JSON.parse(ordinaryOnExpired.body).error, 'ORDER_EXPIRED_REQUIRES_LATE_PAYMENT_AUTH');
  });

  await t.test('6. Deposit Identity & Historical Reservation Protection: Prevents Duplicate Bank Reference Across All Settlement States (409)', async () => {
    const financeAuth = await loginOperator(app, 'op_finance_01', 'FinancePassword#2026!');
    const adminAuth = await loginOperator(app, 'op_admin_01', 'AdminPassword#2026!');

    await createSampleOrder(app, 'mujer-informada-4', 'orderA');
    await createSampleOrder(app, 'mujer-informada-4', 'orderB');

    const listRes = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/orders',
      headers: { cookie: adminAuth.cookie },
    });
    const orders = JSON.parse(listRes.body).orders;
    const orderA = orders.find((o) => o.lead_email.includes('ordera'));
    const orderB = orders.find((o) => o.lead_email.includes('orderb'));
    assert.ok(orderA && orderB, 'Both Order A and Order B must exist');

    const sharedBankRef = 'BNB-QR-20261105-884120';

    // Step 1: Order A receives deposit R1 via verify-payment -> paid_verified
    const verifyARes = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/orders/${orderA.id}/verify-payment`,
      headers: {
        cookie: financeAuth.cookie,
        'x-csrf-token': financeAuth.csrfToken,
      },
      payload: {
        reconciliation_mode: 'standard_reference',
        bank_reference: sharedBankRef,
        reconciliation_evidence: 'Extracto BNB movimiento #884120 Bs 199.00',
        recipient_account_id: 'BNB-DR-SEVILLA-BOB-01',
        recipient_account_verified: true,
        effective_transaction_verified: true,
        verified_amount_minor: 19900,
        verified_currency: 'BOB',
        bank_credit_at: new Date().toISOString(),
        reason: 'Conciliación inicial del Pedido A',
        idempotency_key: crypto.randomUUID(),
      },
    });
    assert.equal(verifyARes.statusCode, 200);
    const verifyABody = JSON.parse(verifyARes.body);
    const originalReconciliationId = verifyABody.reconciliation.id;
    assert.equal(verifyABody.reconciliation.settlement_status, 'applied');

    // Step 2: Order B attempts to reuse the applied bank_reference via verify-payment -> 409 DUPLICATE_BANK_REFERENCE
    const reuseAppliedOnB = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/orders/${orderB.id}/verify-payment`,
      headers: {
        cookie: financeAuth.cookie,
        'x-csrf-token': financeAuth.csrfToken,
      },
      payload: {
        reconciliation_mode: 'standard_reference',
        bank_reference: sharedBankRef,
        reconciliation_evidence: 'Intento de duplicar referencia ya aplicada en Pedido A',
        recipient_account_id: 'BNB-DR-SEVILLA-BOB-01',
        recipient_account_verified: true,
        effective_transaction_verified: true,
        verified_amount_minor: 19900,
        verified_currency: 'BOB',
        bank_credit_at: new Date().toISOString(),
        reason: 'Intento de reutilización de referencia aplicada',
        idempotency_key: crypto.randomUUID(),
      },
    });
    assert.equal(reuseAppliedOnB.statusCode, 409);
    assert.equal(JSON.parse(reuseAppliedOnB.body).error, 'DUPLICATE_BANK_REFERENCE');

    // Step 3: Even if historical reconciliation is in 'reversed_mistaken_match', verify-payment on Order B still rejects reuse with 409
    const adminSession = {
      academyId: 'dr-sevilla',
      operatorId: 'op_admin_01',
      role: 'academy_admin',
    };
    await app.adminOperationsService.reverseOrderState(adminSession, orderA.id, {
      target_status: 'pending_payment',
      corrected_event_id: verifyABody.event.id,
      reason: 'Registro histórico de reversión preservado en capa de datos',
      idempotency_key: crypto.randomUUID(),
    });

    const reuseReversedOnB = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/orders/${orderB.id}/verify-payment`,
      headers: {
        cookie: financeAuth.cookie,
        'x-csrf-token': financeAuth.csrfToken,
      },
      payload: {
        reconciliation_mode: 'standard_reference',
        bank_reference: sharedBankRef,
        reconciliation_evidence: 'Intentando reutilizar referencia histórica revertida en Pedido B',
        recipient_account_id: 'BNB-DR-SEVILLA-BOB-01',
        recipient_account_verified: true,
        effective_transaction_verified: true,
        verified_amount_minor: 19900,
        verified_currency: 'BOB',
        bank_credit_at: new Date().toISOString(),
        reason: 'Reutilización ordinaria bloqueada por reserva permanente',
        idempotency_key: crypto.randomUUID(),
      },
    });
    assert.equal(reuseReversedOnB.statusCode, 409);
    assert.equal(JSON.parse(reuseReversedOnB.body).error, 'DUPLICATE_BANK_REFERENCE');

    const dbRecCount = await testDb.query(
      `SELECT count(*) FROM payment_reconciliations WHERE id = $1 AND bank_reference = $2`,
      [originalReconciliationId, sharedBankRef]
    );
    assert.equal(parseInt(dbRecCount.rows[0].count, 10), 1, 'Deposit identity and historical record remain intact');
  });

  await t.test('7. Refunded/Annulled Deposit Reservation: Permanently Blocks Reuse in verify-payment (409)', async () => {
    const adminAuth = await loginOperator(app, 'op_admin_01', 'AdminPassword#2026!');

    await createSampleOrder(app, 'endometriosis', 'annulA');
    await createSampleOrder(app, 'endometriosis', 'annulB');

    const listRes = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/orders',
      headers: { cookie: adminAuth.cookie },
    });
    const orders = JSON.parse(listRes.body).orders;
    const orderA = orders.find((o) => o.lead_email.includes('annula'));
    const orderB = orders.find((o) => o.lead_email.includes('annulb'));

    const verifyRes = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/orders/${orderA.id}/verify-payment`,
      headers: {
        cookie: adminAuth.cookie,
        'x-csrf-token': adminAuth.csrfToken,
      },
      payload: {
        reconciliation_mode: 'standard_reference',
        bank_reference: 'BNB-REFUND-99001',
        reconciliation_evidence: 'Abono BNB #99001 Bs 79.00',
        recipient_account_id: 'BNB-DR-SEVILLA-BOB-01',
        recipient_account_verified: true,
        effective_transaction_verified: true,
        verified_amount_minor: 7900,
        verified_currency: 'BOB',
        bank_credit_at: new Date().toISOString(),
        reason: 'Conciliación inicial antes de devolución',
        idempotency_key: crypto.randomUUID(),
      },
    });
    const verifyBody = JSON.parse(verifyRes.body);

    const adminSession = {
      academyId: 'dr-sevilla',
      operatorId: 'op_admin_01',
      role: 'academy_admin',
    };
    await app.adminOperationsService.reverseOrderState(adminSession, orderA.id, {
      target_status: 'cancelled',
      corrected_event_id: verifyBody.event.id,
      reversal_compensation_ref: 'DEV-BNB-2026-551',
      reason: 'Devolución bancaria ejecutada a solicitud de la compradora',
      idempotency_key: crypto.randomUUID(),
    });

    // Attempting to reuse a refunded_or_annulled bank_reference on Order B via verify-payment must fail with 409
    const reuseRefundedRes = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/orders/${orderB.id}/verify-payment`,
      headers: {
        cookie: adminAuth.cookie,
        'x-csrf-token': adminAuth.csrfToken,
      },
      payload: {
        reconciliation_mode: 'standard_reference',
        bank_reference: 'BNB-REFUND-99001',
        reconciliation_evidence: 'Intento de reutilizar referencia anulada',
        recipient_account_id: 'BNB-DR-SEVILLA-BOB-01',
        recipient_account_verified: true,
        effective_transaction_verified: true,
        verified_amount_minor: 7900,
        verified_currency: 'BOB',
        bank_credit_at: new Date().toISOString(),
        reason: 'Intento inválido de reutilizar un abono ya devuelto',
        idempotency_key: crypto.randomUUID(),
      },
    });
    assert.equal(reuseRefundedRes.statusCode, 409);
    assert.equal(JSON.parse(reuseRefundedRes.body).error, 'DUPLICATE_BANK_REFERENCE');
  });

  await t.test('8. Manual Moodle Enrollment: Pack Requires All 4 Verified Courses & Marks Provisional Terms', async () => {
    const academicAuth = await loginOperator(app, 'op_academic_01', 'AcademicPassword#2026!');
    const financeAuth = await loginOperator(app, 'op_finance_01', 'FinancePassword#2026!');

    await createSampleOrder(app, 'mujer-informada-4', 'packMoodle');
    const listRes = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/orders',
      headers: { cookie: financeAuth.cookie },
    });
    const order = JSON.parse(listRes.body).orders[0];
    assert.deepEqual(order.provisional_moodle_courses, [
      'endometriosis',
      'vaginosis',
      'sop',
      'aprende-mujer',
    ]);
    assert.equal(order.provisional_access_days, 180);

    // Verify bank payment first
    const verifyRes = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/orders/${order.id}/verify-payment`,
      headers: {
        cookie: financeAuth.cookie,
        'x-csrf-token': financeAuth.csrfToken,
      },
      payload: {
        reconciliation_mode: 'standard_reference',
        bank_reference: 'BNB-PACK-44001',
        reconciliation_evidence: 'Extracto BNB abono pack completo Bs 199.00',
        recipient_account_id: 'BNB-DR-SEVILLA-BOB-01',
        recipient_account_verified: true,
        effective_transaction_verified: true,
        verified_amount_minor: 19900,
        verified_currency: 'BOB',
        bank_credit_at: new Date().toISOString(),
        reason: 'Abono verificado para pack de 4 cursos',
        idempotency_key: crypto.randomUUID(),
      },
    });
    assert.equal(verifyRes.statusCode, 200);

    // Start manual enrollment (paid_verified -> enrollment_pending)
    const startRes = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/orders/${order.id}/start-enrollment`,
      headers: {
        cookie: academicAuth.cookie,
        'x-csrf-token': academicAuth.csrfToken,
      },
      payload: {
        reason: 'Iniciando alta manual en Moodle de los 4 cursos del pack',
        idempotency_key: crypto.randomUUID(),
      },
    });
    assert.equal(startRes.statusCode, 200);
    assert.equal(JSON.parse(startRes.body).order.status, 'enrollment_pending');

    // Attempt confirm-enrollment with only 3 of the 4 courses -> 422 INCOMPLETE_MOODLE_COURSES_ENROLLED
    const partialConfirm = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/orders/${order.id}/confirm-enrollment`,
      headers: {
        cookie: academicAuth.cookie,
        'x-csrf-token': academicAuth.csrfToken,
      },
      payload: {
        moodle_user_identifier: 'pack_alumna@ejemplo.com',
        moodle_courses_enrolled: ['endometriosis', 'vaginosis', 'sop'], // missing aprende-mujer!
        access_confirmed: true,
        reason: 'Alta parcial de solo 3 cursos',
        idempotency_key: crypto.randomUUID(),
      },
    });
    assert.equal(partialConfirm.statusCode, 422);
    assert.equal(JSON.parse(partialConfirm.body).error, 'INCOMPLETE_MOODLE_COURSES_ENROLLED');

    // Confirm enrollment with all 4 required courses -> 200 fulfilled
    const fullConfirm = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/orders/${order.id}/confirm-enrollment`,
      headers: {
        cookie: academicAuth.cookie,
        'x-csrf-token': academicAuth.csrfToken,
      },
      payload: {
        moodle_user_identifier: 'pack_alumna@ejemplo.com',
        moodle_courses_enrolled: ['endometriosis', 'vaginosis', 'sop', 'aprende-mujer'],
        access_confirmed: true,
        reason: 'Las 4 matrículas del Pack Mujer Informada verificadas en Moodle',
        idempotency_key: crypto.randomUUID(),
      },
    });
    assert.equal(fullConfirm.statusCode, 200);
    const fullBody = JSON.parse(fullConfirm.body);
    assert.equal(fullBody.order.status, 'fulfilled');
    assert.equal(fullBody.event.metadata.verified_enrollments_count, 4);
    assert.equal(
      fullBody.event.metadata.commercial_ratification_status,
      'provisional_functional_identifiers_pending_ratification'
    );
  });

  await t.test('9. Multi-Academy Isolation in Admin Queries & Mutations', async () => {
    const adminAuth = await loginOperator(app, 'op_admin_01', 'AdminPassword#2026!');

    // Insert a second academy and an order belonging to 'other-academy'
    await testDb.query(`
      INSERT INTO academies (id, slug, legal_name, default_currency, status)
      VALUES ('other-academy', 'other-academy', 'Otra Academia', 'BOB', 'active');

      INSERT INTO products (academy_id, sku, title, is_active)
      VALUES ('other-academy', 'other-sku', 'Curso Otra Academia', TRUE);
    `);
    const otherLeadId = crypto.randomUUID();
    const otherOrderId = crypto.randomUUID();
    await testDb.query(
      `INSERT INTO leads (id, academy_id, email_normalized, name)
       VALUES ($1, 'other-academy', 'other@ejemplo.com', 'Other Buyer')`,
      [otherLeadId]
    );
    await testDb.query(
      `INSERT INTO orders (id, academy_id, order_number, opaque_token, lead_id, total_amount_minor, status, idempotency_key, payload_hash, expires_at, token_expires_at)
       VALUES ($1, 'other-academy', 'OTH-2026-0001', 'tok_other_12345678901234567890123456789012', $2, 9900, 'pending_payment', $3, 'hash', NOW() + INTERVAL '3 days', NOW() + INTERVAL '30 days')`,
      [otherOrderId, otherLeadId, crypto.randomUUID()]
    );
    await testDb.query(
      `INSERT INTO order_items (id, academy_id, order_id, sku, unit_amount_minor, quantity)
       VALUES ($1, 'other-academy', $2, 'other-sku', 9900, 1)`,
      [crypto.randomUUID(), otherOrderId]
    );

    // Operator of 'dr-sevilla' must NOT see 'other-academy' orders in list
    const listRes = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/orders',
      headers: { cookie: adminAuth.cookie },
    });
    const orders = JSON.parse(listRes.body).orders;
    assert.equal(orders.some((o) => o.id === otherOrderId), false);

    // Attempting to fetch detail or mutate 'other-academy' order returns 404 ORDER_NOT_FOUND
    const detailOther = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/orders/${otherOrderId}`,
      headers: { cookie: adminAuth.cookie },
    });
    assert.equal(detailOther.statusCode, 404);
  });

  await t.test('10. Cancel Unpaid vs Paid Order Controls & Transactional Rollback on Injected Failure', async () => {
    const adminAuth = await loginOperator(app, 'op_admin_01', 'AdminPassword#2026!');

    await createSampleOrder(app, 'endometriosis', 'cancelUnpaid');
    await createSampleOrder(app, 'endometriosis', 'cancelPaid');

    const listRes = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/orders',
      headers: { cookie: adminAuth.cookie },
    });
    const orders = JSON.parse(listRes.body).orders;
    const unpaidOrder = orders.find((o) => o.lead_email.includes('cancelunpaid'));
    const paidOrder = orders.find((o) => o.lead_email.includes('cancelpaid'));

    // 10a. Unpaid order can be cancelled cleanly
    const cancelUnpaidRes = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/orders/${unpaidOrder.id}/cancel`,
      headers: {
        cookie: adminAuth.cookie,
        'x-csrf-token': adminAuth.csrfToken,
      },
      payload: {
        reason: 'Compradora desistió antes de realizar el pago',
        idempotency_key: crypto.randomUUID(),
      },
    });
    assert.equal(cancelUnpaidRes.statusCode, 200);
    assert.equal(JSON.parse(cancelUnpaidRes.body).order.status, 'cancelled');

    // 10b. Inject failure before commit on verifyPayment: must roll back reconciliation, order status, and events
    const adminSession = {
      academyId: 'dr-sevilla',
      operatorId: 'op_admin_01',
      role: 'academy_admin',
    };
    const rollbackRef = 'BNB-RB-777888';

    await assert.rejects(
      async () => {
        await app.adminOperationsService.verifyPayment(
          adminSession,
          paidOrder.id,
          {
            reconciliation_mode: 'standard_reference',
            bank_reference: rollbackRef,
            reconciliation_evidence: 'Extracto BNB abono prueba rollback',
            recipient_account_id: 'BNB-DR-SEVILLA-BOB-01',
            recipient_account_verified: true,
            effective_transaction_verified: true,
            verified_amount_minor: 7900,
            verified_currency: 'BOB',
            bank_credit_at: new Date().toISOString(),
            reason: 'Prueba de rollback atómico',
            idempotency_key: crypto.randomUUID(),
          },
          { injectFailureBeforeCommit: true }
        );
      },
      (err) => {
        assert.equal(err.message, 'INJECTED_TRANSACTION_FAILURE_BEFORE_COMMIT');
        return true;
      }
    );

    const checkRecAfterRollback = await testDb.query(
      `SELECT count(*) FROM payment_reconciliations WHERE bank_reference = $1`,
      [rollbackRef]
    );
    assert.equal(parseInt(checkRecAfterRollback.rows[0].count, 10), 0, 'Rolled back reconciliation must not exist');

    // Now verify paidOrder normally ( rollbackRef was NOT reserved because transaction rolled back!)
    const verifyPaidRes = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/orders/${paidOrder.id}/verify-payment`,
      headers: {
        cookie: adminAuth.cookie,
        'x-csrf-token': adminAuth.csrfToken,
      },
      payload: {
        reconciliation_mode: 'standard_reference',
        bank_reference: rollbackRef,
        reconciliation_evidence: 'Extracto BNB abono tras rollback exitoso',
        recipient_account_id: 'BNB-DR-SEVILLA-BOB-01',
        recipient_account_verified: true,
        effective_transaction_verified: true,
        verified_amount_minor: 7900,
        verified_currency: 'BOB',
        bank_credit_at: new Date().toISOString(),
        reason: 'Conciliación exitosa tras comprobar rollback',
        idempotency_key: crypto.randomUUID(),
      },
    });
    assert.equal(verifyPaidRes.statusCode, 200);

    // 10c. Attempting ordinary /cancel on paid_verified order is rejected with 409 PAID_ORDER_REQUIRES_ADMIN_REVERSAL
    const cancelPaidRes = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/orders/${paidOrder.id}/cancel`,
      headers: {
        cookie: adminAuth.cookie,
        'x-csrf-token': adminAuth.csrfToken,
      },
      payload: {
        reason: 'Intento de cancelar pedido pagado sin reversión formal',
        idempotency_key: crypto.randomUUID(),
      },
    });
    assert.equal(cancelPaidRes.statusCode, 409);
    assert.equal(JSON.parse(cancelPaidRes.body).error, 'PAID_ORDER_REQUIRES_ADMIN_REVERSAL');
  });
});
