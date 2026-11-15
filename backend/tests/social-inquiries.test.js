import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { createTestDatabase } from './setup-db.js';
import { buildApp } from '../src/server.js';

const TEST_ORIGIN = 'http://localhost:8080';

async function loginAs(app, operatorId, password) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/admin/session/login',
    payload: { operator_id: operatorId, password },
  });
  assert.equal(res.statusCode, 200, `Login failed for ${operatorId}: ${res.body}`);
  const setCookie = res.headers['set-cookie'];
  const cookieHeader = Array.isArray(setCookie) ? setCookie[0].split(';')[0] : setCookie.split(';')[0];
  const body = JSON.parse(res.body);
  return {
    cookie: cookieHeader,
    csrfToken: body.csrf_token,
    session: body.session,
  };
}

function authHeaders(auth, includeCsrf = true, origin = TEST_ORIGIN) {
  const headers = {
    cookie: auth.cookie,
  };
  if (origin) {
    headers.origin = origin;
  }
  if (includeCsrf && auth.csrfToken) {
    headers['x-csrf-token'] = auth.csrfToken;
  }
  return headers;
}

test('Gate 2-A3-B1 — Mini CRM Social Inquiries & Follow-up Suite', async (t) => {
  let db;
  let app;
  let academicAuth;
  let financeAuth;
  let adminAuth;

  t.before(async () => {
    db = await createTestDatabase();
    app = await buildApp(db, {
      academyId: 'dr-sevilla',
      allowedOrigins: [TEST_ORIGIN],
      rateLimitMax: 500,
    });

    await app.adminAuthService.bootstrapOperators([
      {
        operator_id: 'op_academic_crm',
        display_name: 'María — Atención Redes',
        role: 'academic_operator',
        password: 'AcademicPassword#2026!',
      },
      {
        operator_id: 'op_finance_crm',
        display_name: 'Carlos — Verificador Pagos',
        role: 'finance_verifier',
        password: 'FinancePassword#2026!',
      },
      {
        operator_id: 'op_admin_crm',
        display_name: 'Dra. Elena — Coordinadora General',
        role: 'academy_admin',
        password: 'AdminPassword#2026!',
      },
    ]);

    academicAuth = await loginAs(app, 'op_academic_crm', 'AcademicPassword#2026!');
    financeAuth = await loginAs(app, 'op_finance_crm', 'FinancePassword#2026!');
    adminAuth = await loginAs(app, 'op_admin_crm', 'AdminPassword#2026!');
  });

  t.after(async () => {
    await app.close();
    await db.close();
  });

  await t.test('1. Omnichannel Registration & Filtering: WhatsApp, Instagram, TikTok, Facebook, and Web with course, responsible, status, and next action', async () => {
    const channels = [
      {
        channel: 'whatsapp',
        contact_name: 'Valeria Suárez',
        phone: '+59170011001',
        interested_sku: 'endometriosis',
        followup_status: 'new_inquiry',
        next_action: 'Responder consulta de horarios y enviar enlace al checkout',
      },
      {
        channel: 'instagram',
        contact_name: 'Andrea Molina',
        contact_handle: '@andrea.molina.bo',
        interested_sku: 'sop',
        followup_status: 'contacted',
        next_action: 'Confirmar si prefiere curso individual o Pack Mujer Informada',
      },
      {
        channel: 'tiktok',
        contact_name: 'Lucía Vargas',
        contact_handle: '@lucia_vargas_tt',
        phone: '+59170011003',
        interested_sku: 'mujer-informada-4',
        followup_status: 'checkout_link_sent',
        next_action: 'Dar seguimiento al envío de enlace de inscripción mañana',
      },
      {
        channel: 'facebook',
        contact_name: 'Patricia Gómez',
        email: 'patricia.gomez@ejemplo.com',
        interested_sku: 'vaginosis',
        followup_status: 'contacted',
        next_action: 'Enviar guía informativa de modalidad online en plataforma Moodle',
      },
      {
        channel: 'web',
        contact_name: 'Fernanda Ríos',
        email: 'fernanda.rios@ejemplo.com',
        phone: '+59170011005',
        interested_sku: 'aprende-mujer',
        followup_status: 'new_inquiry',
        next_action: 'Contactar por WhatsApp para resolver dudas sobre acceso de 180 días',
      },
    ];

    const createdIds = [];
    for (const item of channels) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/inquiries',
        headers: authHeaders(academicAuth),
        payload: {
          ...item,
          assigned_operator_id: 'op_academic_crm',
          next_action_at: '2026-11-15T14:00:00.000Z',
          notes: `Prospecto captado desde canal ${item.channel}`,
          idempotency_key: crypto.randomUUID(),
        },
      });
      assert.equal(res.statusCode, 201, `Failed creating inquiry for channel ${item.channel}: ${res.body}`);
      const body = JSON.parse(res.body);
      assert.equal(body.inquiry.academy_id, 'dr-sevilla');
      assert.equal(body.inquiry.channel, item.channel);
      assert.equal(body.inquiry.interested_sku, item.interested_sku);
      assert.equal(body.inquiry.assigned_operator_id, 'op_academic_crm');
      assert.equal(body.inquiry.followup_status, item.followup_status);
      assert.equal(body.inquiry.next_action, item.next_action);
      assert.equal(body.event.event_type, 'inquiry_created');
      createdIds.push(body.inquiry.id);
    }

    // List all inquiries for dr-sevilla
    const listAllRes = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/inquiries',
      headers: authHeaders(academicAuth, false),
    });
    assert.equal(listAllRes.statusCode, 200);
    const listAllBody = JSON.parse(listAllRes.body);
    assert.equal(listAllBody.academy_id, 'dr-sevilla');
    assert.equal(listAllBody.inquiries.length, 5);

    // Filter by channel=tiktok
    const tiktokRes = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/inquiries?channel=tiktok',
      headers: authHeaders(academicAuth, false),
    });
    assert.equal(tiktokRes.statusCode, 200);
    const tiktokItems = JSON.parse(tiktokRes.body).inquiries;
    assert.equal(tiktokItems.length, 1);
    assert.equal(tiktokItems[0].contact_name, 'Lucía Vargas');
    assert.equal(tiktokItems[0].interested_sku, 'mujer-informada-4');

    // Filter by followup_status=new_inquiry and interested_sku=endometriosis
    const filteredRes = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/inquiries?followup_status=new_inquiry&interested_sku=endometriosis',
      headers: authHeaders(academicAuth, false),
    });
    assert.equal(filteredRes.statusCode, 200);
    const filteredItems = JSON.parse(filteredRes.body).inquiries;
    assert.equal(filteredItems.length, 1);
    assert.equal(filteredItems[0].contact_name, 'Valeria Suárez');
  });

  await t.test('2. Permissions, RBAC, CSRF, and Anti-Spoofing Controls', async () => {
    // 2a. Unauthenticated request is rejected with 401
    const unauthRes = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/inquiries',
    });
    assert.equal(unauthRes.statusCode, 401);

    // 2b. Missing CSRF token on mutating POST is rejected with 403
    const noCsrfRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/inquiries',
      headers: authHeaders(academicAuth, false),
      payload: {
        channel: 'whatsapp',
        contact_name: 'Sin CSRF',
        phone: '+59170099111',
        interested_sku: 'endometriosis',
        next_action: 'Llamar para información',
        idempotency_key: crypto.randomUUID(),
      },
    });
    assert.equal(noCsrfRes.statusCode, 403);
    assert.equal(JSON.parse(noCsrfRes.body).error, 'CSRF_TOKEN_INVALID');

    // 2c. Operator spoofing via body or header is rejected with 403 OPERATOR_SPOOFING_FORBIDDEN
    const spoofBodyRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/inquiries',
      headers: authHeaders(academicAuth),
      payload: {
        operator_id: 'op_admin_crm',
        channel: 'whatsapp',
        contact_name: 'Intento Spoofing',
        phone: '+59170099112',
        interested_sku: 'endometriosis',
        next_action: 'Llamar para información',
        idempotency_key: crypto.randomUUID(),
      },
    });
    assert.equal(spoofBodyRes.statusCode, 403);
    assert.equal(JSON.parse(spoofBodyRes.body).error, 'OPERATOR_SPOOFING_FORBIDDEN');

    // 2d. RBAC: finance_verifier can read GET /api/v1/admin/inquiries (200) but cannot POST or PATCH (403 INSUFFICIENT_ROLE_PERMISSIONS)
    const finGetRes = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/inquiries',
      headers: authHeaders(financeAuth, false),
    });
    assert.equal(finGetRes.statusCode, 200);

    const finPostRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/inquiries',
      headers: authHeaders(financeAuth),
      payload: {
        channel: 'instagram',
        contact_name: 'Intento Finanzas',
        contact_handle: '@fin_attempt',
        interested_sku: 'sop',
        next_action: 'No permitido para rol finanzas',
        idempotency_key: crypto.randomUUID(),
      },
    });
    assert.equal(finPostRes.statusCode, 403);
    assert.equal(JSON.parse(finPostRes.body).error, 'INSUFFICIENT_ROLE_PERMISSIONS');
  });

  await t.test('3. Privacy & Data Minimization: Rejects Sensitive/Unknown Fields and Clinical/Diagnostic Content', async () => {
    // 3a. Unknown or medical/clinical fields in payload -> 422 UNSUPPORTED_OR_SENSITIVE_FIELD
    const sensitiveFieldRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/inquiries',
      headers: authHeaders(academicAuth),
      payload: {
        channel: 'whatsapp',
        contact_name: 'Prospecto Confidencial',
        phone: '+59170088111',
        interested_sku: 'endometriosis',
        next_action: 'Enviar link de inscripción',
        clinical_history: 'Antecedentes quirúrgicos',
        idempotency_key: crypto.randomUUID(),
      },
    });
    assert.equal(sensitiveFieldRes.statusCode, 422);
    assert.equal(JSON.parse(sensitiveFieldRes.body).error, 'UNSUPPORTED_OR_SENSITIVE_FIELD');

    // 3b. Clinical or medical diagnostic text smuggled into notes or next_action -> 422 CLINICAL_DATA_PROHIBITED
    const clinicalNotesRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/inquiries',
      headers: authHeaders(academicAuth),
      payload: {
        channel: 'whatsapp',
        contact_name: 'Prospecto con Nota Clínica',
        phone: '+59170088112',
        interested_sku: 'endometriosis',
        next_action: 'Enviar link del checkout',
        notes: 'Presenta diagnóstico médico previo y solicita receta médica para dolor',
        idempotency_key: crypto.randomUUID(),
      },
    });
    assert.equal(clinicalNotesRes.statusCode, 422);
    assert.equal(JSON.parse(clinicalNotesRes.body).error, 'CLINICAL_DATA_PROHIBITED');

    // 3c. Missing all contact channels (no phone, email, or contact_handle) -> 422 CONTACT_METHOD_REQUIRED
    const noContactRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/inquiries',
      headers: authHeaders(academicAuth),
      payload: {
        channel: 'instagram',
        contact_name: 'Sin Datos Contacto',
        interested_sku: 'sop',
        next_action: 'Solicitar contacto',
        idempotency_key: crypto.randomUUID(),
      },
    });
    assert.equal(noContactRes.statusCode, 422);
    assert.equal(JSON.parse(noContactRes.body).error, 'CONTACT_METHOD_REQUIRED');
  });

  await t.test('4. Idempotency Controls on POST and PATCH: 200 Replay vs 409 Payload Mismatch', async () => {
    const createKey = crypto.randomUUID();
    const createPayload = {
      channel: 'instagram',
      contact_name: 'Mariana Paz',
      contact_handle: '@mariana.paz',
      phone: '+59171122334',
      interested_sku: 'mujer-informada-4',
      assigned_operator_id: 'op_academic_crm',
      followup_status: 'new_inquiry',
      next_action: 'Responder DM con temario del Pack Mujer Informada',
      idempotency_key: createKey,
    };

    // First POST -> 201 Created
    const firstCreate = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/inquiries',
      headers: authHeaders(academicAuth),
      payload: createPayload,
    });
    assert.equal(firstCreate.statusCode, 201);
    const createdBody = JSON.parse(firstCreate.body);
    assert.equal(createdBody.isIdempotentReplay, false);
    const inquiryId = createdBody.inquiry.id;

    // Second POST with identical key and payload -> 200 OK idempotent replay
    const replayCreate = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/inquiries',
      headers: authHeaders(academicAuth),
      payload: createPayload,
    });
    assert.equal(replayCreate.statusCode, 200);
    const replayBody = JSON.parse(replayCreate.body);
    assert.equal(replayBody.isIdempotentReplay, true);
    assert.equal(replayBody.inquiry.id, inquiryId);

    // Third POST with same key but mutated SKU -> 409 IDEMPOTENCY_PAYLOAD_MISMATCH
    const mismatchCreate = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/inquiries',
      headers: authHeaders(academicAuth),
      payload: {
        ...createPayload,
        interested_sku: 'vaginosis',
      },
    });
    assert.equal(mismatchCreate.statusCode, 409);
    assert.equal(JSON.parse(mismatchCreate.body).error, 'IDEMPOTENCY_PAYLOAD_MISMATCH');

    // PATCH idempotency check
    const patchKey = crypto.randomUUID();
    const patchPayload = {
      followup_status: 'contacted',
      next_action: 'Esperar confirmación para enviar link de checkout',
      notes: 'Se respondió mensaje directo con precios vigentes',
      idempotency_key: patchKey,
    };

    const firstPatch = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/inquiries/${inquiryId}`,
      headers: authHeaders(academicAuth),
      payload: patchPayload,
    });
    assert.equal(firstPatch.statusCode, 200);
    assert.equal(JSON.parse(firstPatch.body).isIdempotentReplay, false);

    const replayPatch = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/inquiries/${inquiryId}`,
      headers: authHeaders(academicAuth),
      payload: patchPayload,
    });
    assert.equal(replayPatch.statusCode, 200);
    assert.equal(JSON.parse(replayPatch.body).isIdempotentReplay, true);

    const mismatchPatch = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/inquiries/${inquiryId}`,
      headers: authHeaders(academicAuth),
      payload: {
        ...patchPayload,
        followup_status: 'closed_no_conversion',
      },
    });
    assert.equal(mismatchPatch.statusCode, 409);
    assert.equal(JSON.parse(mismatchPatch.body).error, 'IDEMPOTENCY_PAYLOAD_MISMATCH');
  });

  await t.test('5. Safe Operator-Confirmed Order Linkage & End-to-End Social Conversion Funnel', async () => {
    // Step 1: Operator registers WhatsApp prospect interested in Pack Mujer Informada
    const prospectPhone = '+59174455667';
    const prospectEmail = 'carolina.mendez@ejemplo.com';

    const createInqRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/inquiries',
      headers: authHeaders(academicAuth),
      payload: {
        channel: 'whatsapp',
        contact_name: 'Carolina Méndez',
        phone: prospectPhone,
        email: prospectEmail,
        interested_sku: 'mujer-informada-4',
        assigned_operator_id: 'op_academic_crm',
        followup_status: 'checkout_link_sent',
        next_action: 'Confirmar registro de pedido en el checkout web',
        idempotency_key: crypto.randomUUID(),
      },
    });
    assert.equal(createInqRes.statusCode, 201);
    const inquiryId = JSON.parse(createInqRes.body).inquiry.id;

    // Cannot set followup_status='order_created' without linked_order_id -> 409 ORDER_LINK_REQUIRED_FOR_STATUS
    const prematureStatusRes = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/inquiries/${inquiryId}`,
      headers: authHeaders(academicAuth),
      payload: {
        followup_status: 'order_created',
        idempotency_key: crypto.randomUUID(),
      },
    });
    assert.equal(prematureStatusRes.statusCode, 409);
    assert.equal(JSON.parse(prematureStatusRes.body).error, 'ORDER_LINK_REQUIRED_FOR_STATUS');

    // Step 2: Prospect completes checkout on the website
    const checkoutRes = await app.inject({
      method: 'POST',
      url: '/api/v1/checkout',
      payload: {
        sku: 'mujer-informada-4',
        name: 'Carolina Méndez',
        email: prospectEmail,
        phone: prospectPhone,
        terms_accepted: true,
        marketing_opt_in: true,
        privacy_version: 'v1.0',
        idempotency_key: crypto.randomUUID(),
        utm: { source: 'whatsapp', medium: 'social', campaign: 'pack_abril' },
      },
    });
    assert.equal(checkoutRes.statusCode, 201);
    const checkoutOrder = JSON.parse(checkoutRes.body);

    // Step 3: Operator lists inquiries -> sees suggested_order_match automatically correlated by phone/email, but linked_order_id is still null until confirmed
    const listWithSuggestionRes = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/inquiries?channel=whatsapp`,
      headers: authHeaders(academicAuth, false),
    });
    assert.equal(listWithSuggestionRes.statusCode, 200);
    const inquiryWithSuggestion = JSON.parse(listWithSuggestionRes.body).inquiries.find((i) => i.id === inquiryId);
    assert.ok(inquiryWithSuggestion, 'Inquiry must be present in list');
    assert.equal(inquiryWithSuggestion.linked_order_id, null);
    assert.ok(inquiryWithSuggestion.suggested_order_match, 'Must suggest matching order by email/phone');
    assert.equal(inquiryWithSuggestion.suggested_order_match.order_number, checkoutOrder.order_number);

    const suggestedOrderId = inquiryWithSuggestion.suggested_order_match.order_id;

    // Step 4: Operator confirms order linkage via PATCH
    const linkRes = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/inquiries/${inquiryId}`,
      headers: authHeaders(academicAuth),
      payload: {
        linked_order_id: suggestedOrderId,
        followup_status: 'order_created',
        next_action: 'Enviar QR bancario y verificar abono con finanzas',
        notes: 'Pedido vinculado manualmente tras confirmación de la interesada',
        idempotency_key: crypto.randomUUID(),
      },
    });
    assert.equal(linkRes.statusCode, 200);
    const linkedBody = JSON.parse(linkRes.body);
    assert.equal(linkedBody.inquiry.linked_order_id, suggestedOrderId);
    assert.equal(linkedBody.inquiry.order_linked_by_operator_id, 'op_academic_crm');
    assert.equal(linkedBody.inquiry.followup_status, 'order_created');
    assert.equal(linkedBody.event.event_type, 'order_linked');

    // Step 5: Cannot set followup_status='paid_verified' while order is still 'pending_payment' -> 409 ORDER_NOT_PAID_VERIFIED
    const prematurePaidRes = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/inquiries/${inquiryId}`,
      headers: authHeaders(academicAuth),
      payload: {
        followup_status: 'paid_verified',
        idempotency_key: crypto.randomUUID(),
      },
    });
    assert.equal(prematurePaidRes.statusCode, 409);
    assert.equal(JSON.parse(prematurePaidRes.body).error, 'ORDER_NOT_PAID_VERIFIED');

    // Step 6: Finance verifier confirms bank payment on the order
    const verifyPayRes = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/orders/${suggestedOrderId}/verify-payment`,
      headers: authHeaders(financeAuth),
      payload: {
        reconciliation_mode: 'standard_reference',
        bank_reference: 'BNB-CRM-2026-0001',
        reconciliation_evidence: 'Abono verificado en extracto BNB por Bs 199.00',
        recipient_account_id: 'BNB-DR-SEVILLA-BOB-01',
        recipient_account_verified: true,
        effective_transaction_verified: true,
        verified_amount_minor: 19900,
        verified_currency: 'BOB',
        bank_credit_at: new Date().toISOString(),
        reason: 'Pago confirmado para prospecto de WhatsApp Carolina Méndez',
        idempotency_key: crypto.randomUUID(),
      },
    });
    assert.equal(verifyPayRes.statusCode, 200);

    // Step 7: Academic operator updates inquiry status to paid_verified, then completes Moodle enrollment and updates inquiry to enrolled
    const inquiryPaidRes = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/inquiries/${inquiryId}`,
      headers: authHeaders(academicAuth),
      payload: {
        followup_status: 'paid_verified',
        next_action: 'Habilitar matrícula manual en Moodle para los 4 cursos',
        idempotency_key: crypto.randomUUID(),
      },
    });
    assert.equal(inquiryPaidRes.statusCode, 200);
    assert.equal(JSON.parse(inquiryPaidRes.body).inquiry.followup_status, 'paid_verified');

    // Complete enrollment on order (start-enrollment -> confirm-enrollment)
    const startEnrollRes = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/orders/${suggestedOrderId}/start-enrollment`,
      headers: authHeaders(academicAuth),
      payload: {
        reason: 'Iniciando alta manual en Moodle para Carolina Méndez',
        idempotency_key: crypto.randomUUID(),
      },
    });
    assert.equal(startEnrollRes.statusCode, 200);

    const confirmEnrollRes = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/orders/${suggestedOrderId}/confirm-enrollment`,
      headers: authHeaders(academicAuth),
      payload: {
        moodle_user_identifier: 'moodle_user_4491',
        access_confirmed: true,
        moodle_courses_enrolled: [
          'endometriosis',
          'vaginosis',
          'sop',
          'aprende-mujer',
        ],
        reason: 'Matrícula Moodle completada y credenciales enviadas a Carolina Méndez',
        idempotency_key: crypto.randomUUID(),
      },
    });
    assert.equal(confirmEnrollRes.statusCode, 200, `Confirm enrollment failed: ${confirmEnrollRes.body}`);

    // Mark inquiry as enrolled
    const inquiryEnrolledRes = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/inquiries/${inquiryId}`,
      headers: authHeaders(academicAuth),
      payload: {
        followup_status: 'enrolled',
        next_action: 'Seguimiento completado — alumna matriculada en Moodle',
        next_action_at: null,
        idempotency_key: crypto.randomUUID(),
      },
    });
    assert.equal(inquiryEnrolledRes.statusCode, 200);
    const enrolledInquiry = JSON.parse(inquiryEnrolledRes.body).inquiry;
    assert.equal(enrolledInquiry.followup_status, 'enrolled');
    assert.equal(enrolledInquiry.linked_order_id, suggestedOrderId);
  });

  await t.test('6. Multi-Academy Extensibility & Strict Isolation: dr-sevilla (Primary Tenant) vs techpro (Future Academy)', async () => {
    // Seed second academy 'techpro' in the shared database
    await db.query(`
      INSERT INTO academies (id, slug, legal_name, default_currency, status, billing_entity)
      VALUES ('techpro', 'techpro-academy', 'TechPro Academy', 'USD', 'active', 'TechPro Learning LLC');

      INSERT INTO products (academy_id, sku, title, description, is_active, access_duration_days)
      VALUES ('techpro', 'fullstack-ai-bootcamp', 'Bootcamp: Fullstack & AI Engineering', 'Programa intensivo de ingeniería', TRUE, 365);

      INSERT INTO prices (id, academy_id, sku, currency, amount_minor, is_current)
      VALUES ('${crypto.randomUUID()}', 'techpro', 'fullstack-ai-bootcamp', 'USD', 29900, TRUE);
    `);

    const techproApp = await buildApp(db, {
      academyId: 'techpro',
      allowedOrigins: [TEST_ORIGIN],
      rateLimitMax: 500,
    });

    await techproApp.adminAuthService.bootstrapOperators([
      {
        operator_id: 'op_techpro_admin',
        display_name: 'Diego — TechPro Admissions',
        role: 'academy_admin',
        password: 'TechProPassword#2026!',
      },
    ]);

    const techproAuth = await loginAs(techproApp, 'op_techpro_admin', 'TechProPassword#2026!');

    // 6a. TechPro can register its own social inquiries with its own course SKU
    const tpCreateRes = await techproApp.inject({
      method: 'POST',
      url: '/api/v1/admin/inquiries',
      headers: authHeaders(techproAuth),
      payload: {
        channel: 'tiktok',
        contact_name: 'Mateo Silva',
        contact_handle: '@mateo.dev',
        email: 'mateo.silva@techpro.io',
        interested_sku: 'fullstack-ai-bootcamp',
        assigned_operator_id: 'op_techpro_admin',
        followup_status: 'new_inquiry',
        next_action: 'Enviar syllabus del Bootcamp Fullstack & AI',
        idempotency_key: crypto.randomUUID(),
      },
    });
    assert.equal(tpCreateRes.statusCode, 201);
    const tpInquiry = JSON.parse(tpCreateRes.body).inquiry;
    assert.equal(tpInquiry.academy_id, 'techpro');
    assert.equal(tpInquiry.interested_sku, 'fullstack-ai-bootcamp');

    // 6b. dr-sevilla operator CANNOT register an inquiry with a techpro SKU -> 404 PRODUCT_NOT_FOUND
    const crossSkuRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/inquiries',
      headers: authHeaders(academicAuth),
      payload: {
        channel: 'whatsapp',
        contact_name: 'Intento Cross SKU',
        phone: '+59179900111',
        interested_sku: 'fullstack-ai-bootcamp',
        next_action: 'No debe permitir curso de otra academia',
        idempotency_key: crypto.randomUUID(),
      },
    });
    assert.equal(crossSkuRes.statusCode, 404);
    assert.equal(JSON.parse(crossSkuRes.body).error, 'PRODUCT_NOT_FOUND');

    // 6c. dr-sevilla operator CANNOT assign an inquiry to a techpro operator -> 422 INVALID_ASSIGNED_OPERATOR
    const crossOpRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/inquiries',
      headers: authHeaders(academicAuth),
      payload: {
        channel: 'whatsapp',
        contact_name: 'Intento Cross Operator',
        phone: '+59179900112',
        interested_sku: 'endometriosis',
        assigned_operator_id: 'op_techpro_admin',
        next_action: 'No debe permitir operador de otra academia',
        idempotency_key: crypto.randomUUID(),
      },
    });
    assert.equal(crossOpRes.statusCode, 422);
    assert.equal(JSON.parse(crossOpRes.body).error, 'INVALID_ASSIGNED_OPERATOR');

    // 6d. dr-sevilla GET /api/v1/admin/inquiries never leaks techpro inquiries, and vice-versa
    const sevillaListRes = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/inquiries',
      headers: authHeaders(academicAuth, false),
    });
    const sevillaItems = JSON.parse(sevillaListRes.body).inquiries;
    assert.ok(sevillaItems.every((i) => i.academy_id === 'dr-sevilla'));
    assert.ok(!sevillaItems.some((i) => i.id === tpInquiry.id));

    const techproListRes = await techproApp.inject({
      method: 'GET',
      url: '/api/v1/admin/inquiries',
      headers: authHeaders(techproAuth, false),
    });
    const techproItems = JSON.parse(techproListRes.body).inquiries;
    assert.equal(techproItems.length, 1);
    assert.equal(techproItems[0].id, tpInquiry.id);
    assert.equal(techproItems[0].academy_id, 'techpro');

    // 6e. dr-sevilla operator CANNOT PATCH a techpro inquiry -> 404 INQUIRY_NOT_FOUND
    const crossPatchRes = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/inquiries/${tpInquiry.id}`,
      headers: authHeaders(academicAuth),
      payload: {
        followup_status: 'closed_no_conversion',
        idempotency_key: crypto.randomUUID(),
      },
    });
    assert.equal(crossPatchRes.statusCode, 404);
    assert.equal(JSON.parse(crossPatchRes.body).error, 'INQUIRY_NOT_FOUND');

    // 6f. techpro operator CANNOT link a dr-sevilla order to a techpro inquiry -> 404 ORDER_NOT_FOUND
    const sevillaOrdersRes = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/orders',
      headers: authHeaders(academicAuth, false),
    });
    const sevillaOrdersBody = JSON.parse(sevillaOrdersRes.body);
    const sevillaOrderId = sevillaOrdersBody.orders[0].id;

    const crossOrderLinkRes = await techproApp.inject({
      method: 'PATCH',
      url: `/api/v1/admin/inquiries/${tpInquiry.id}`,
      headers: authHeaders(techproAuth),
      payload: {
        linked_order_id: sevillaOrderId,
        idempotency_key: crypto.randomUUID(),
      },
    });
    assert.equal(crossOrderLinkRes.statusCode, 404);
    assert.equal(JSON.parse(crossOrderLinkRes.body).error, 'ORDER_NOT_FOUND');

    await techproApp.close();
  });
});
