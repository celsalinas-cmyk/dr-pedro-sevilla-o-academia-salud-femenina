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
      assert.equal(body.inquiry.contact_basis, 'inbound_user_message');
      assert.equal(body.inquiry.outbound_contact_allowed, true);
      assert.equal(body.event.event_type, 'inquiry_created');
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

    // Filter by channel=tiktok (prospect with handle only, no phone/email)
    const tiktokRes = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/inquiries?channel=tiktok',
      headers: authHeaders(academicAuth, false),
    });
    assert.equal(tiktokRes.statusCode, 200);
    const tiktokItems = JSON.parse(tiktokRes.body).inquiries;
    assert.equal(tiktokItems.length, 1);
    assert.equal(tiktokItems[0].contact_name, 'Lucía Vargas');
    assert.equal(tiktokItems[0].contact_handle, '@lucia_vargas_tt');
    assert.equal(tiktokItems[0].phone, null);
    assert.equal(tiktokItems[0].email_normalized, null);
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

  await t.test('3. Privacy, Guided Commercial Observations & Contactability (Codex Finding #5 — P2)', async () => {
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

    // 3b. Codex Exact Synthetic Clinical Reproduction on POST:
    // "Tengo sangrado vaginal y dolor pélvico desde hace tres días" -> 422 CLINICAL_DATA_PROHIBITED
    const codexSyntheticPostRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/inquiries',
      headers: authHeaders(academicAuth),
      payload: {
        channel: 'whatsapp',
        contact_name: 'Reproducción Sintética Codex',
        phone: '+59170088112',
        interested_sku: 'endometriosis',
        next_action: 'Enviar link del checkout',
        notes: 'Tengo sangrado vaginal y dolor pélvico desde hace tres días',
        idempotency_key: crypto.randomUUID(),
      },
    });
    assert.equal(codexSyntheticPostRes.statusCode, 422);
    assert.equal(JSON.parse(codexSyntheticPostRes.body).error, 'CLINICAL_DATA_PROHIBITED');

    // 3c. Create a valid inquiry and verify PATCH also blocks the exact synthetic clinical text and unguided free text
    const validInqRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/inquiries',
      headers: authHeaders(academicAuth),
      payload: {
        channel: 'instagram',
        contact_name: 'Elena Vargas',
        contact_handle: '@elena.vargas',
        interested_sku: 'sop',
        observation_category: 'course_info_requested',
        notes: 'Solicita temario del curso y horarios de acceso',
        next_action: 'Responder DM con link al catálogo web',
        idempotency_key: crypto.randomUUID(),
      },
    });
    assert.equal(validInqRes.statusCode, 201);
    const validInqId = JSON.parse(validInqRes.body).inquiry.id;

    const codexSyntheticPatchRes = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/inquiries/${validInqId}`,
      headers: authHeaders(academicAuth),
      payload: {
        notes: 'Tengo sangrado vaginal y dolor pélvico desde hace tres días',
        idempotency_key: crypto.randomUUID(),
      },
    });
    assert.equal(codexSyntheticPatchRes.statusCode, 422);
    assert.equal(JSON.parse(codexSyntheticPatchRes.body).error, 'CLINICAL_DATA_PROHIBITED');

    // Unguided arbitrary free text without commercial intent -> 422 UNGUIDED_COMMERCIAL_NOTE_REJECTED
    const unguidedFreeTextRes = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/inquiries/${validInqId}`,
      headers: authHeaders(academicAuth),
      payload: {
        notes: 'Ayer estuvo caminando por la plaza central durante varias horas',
        idempotency_key: crypto.randomUUID(),
      },
    });
    assert.equal(unguidedFreeTextRes.statusCode, 422);
    assert.equal(JSON.parse(unguidedFreeTextRes.body).error, 'UNGUIDED_COMMERCIAL_NOTE_REJECTED');

    // 3d. Contact basis & outbound contact authorization controls
    // Cannot claim explicit_opt_in without contact_basis_evidence
    const fakeOptInRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/inquiries',
      headers: authHeaders(academicAuth),
      payload: {
        channel: 'whatsapp',
        contact_name: 'OptIn Sin Evidencia',
        phone: '+59170088199',
        interested_sku: 'sop',
        contact_basis: 'explicit_opt_in',
        next_action: 'Enviar información del curso',
        idempotency_key: crypto.randomUUID(),
      },
    });
    assert.equal(fakeOptInRes.statusCode, 422);
    assert.equal(JSON.parse(fakeOptInRes.body).error, 'CONTACT_BASIS_EVIDENCE_REQUIRED');

    // Register prospect with contact_basis='no_outbound_permission' -> outbound_contact_allowed is false
    const noOutboundInqRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/inquiries',
      headers: authHeaders(academicAuth),
      payload: {
        channel: 'tiktok',
        contact_name: 'Prospecto Sin Permiso Saliente',
        contact_handle: '@no_outbound_tt',
        interested_sku: 'aprende-mujer',
        contact_basis: 'no_outbound_permission',
        observation_category: 'do_not_contact_requested',
        followup_status: 'do_not_contact',
        notes: 'Solicita baja y no contactar por mensaje directo',
        idempotency_key: crypto.randomUUID(),
      },
    });
    assert.equal(noOutboundInqRes.statusCode, 201);
    const noOutboundInq = JSON.parse(noOutboundInqRes.body).inquiry;
    assert.equal(noOutboundInq.contact_basis, 'no_outbound_permission');
    assert.equal(noOutboundInq.outbound_contact_allowed, false);
    assert.equal(noOutboundInq.followup_status, 'do_not_contact');

    // Attempting to transition a no-outbound inquiry to 'checkout_link_sent' or 'contacted' is blocked with 409 OUTBOUND_CONTACT_PROHIBITED
    const illegalOutboundPatchRes = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/inquiries/${noOutboundInq.id}`,
      headers: authHeaders(academicAuth),
      payload: {
        followup_status: 'checkout_link_sent',
        idempotency_key: crypto.randomUUID(),
      },
    });
    assert.equal(illegalOutboundPatchRes.statusCode, 409);
    assert.equal(JSON.parse(illegalOutboundPatchRes.body).error, 'OUTBOUND_CONTACT_PROHIBITED');

    // 3e. Missing all contact channels (no phone, email, or contact_handle) -> 422 CONTACT_METHOD_REQUIRED
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

  await t.test('4. Complete Idempotency Hashes on POST and PATCH: Notes, last_interaction_at, and Omitted vs Explicit null (Codex Finding #2 — P2)', async () => {
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
      notes: 'Consulta inicial por precio del Pack Mujer Informada',
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

    // Codex Reproduction #1: Same idempotency_key on POST but mutated `notes` -> MUST return 409 IDEMPOTENCY_PAYLOAD_MISMATCH
    const mismatchNotesCreate = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/inquiries',
      headers: authHeaders(academicAuth),
      payload: {
        ...createPayload,
        notes: 'Consulta diferente sobre horarios de acceso en Moodle',
      },
    });
    assert.equal(mismatchNotesCreate.statusCode, 409);
    assert.equal(JSON.parse(mismatchNotesCreate.body).error, 'IDEMPOTENCY_PAYLOAD_MISMATCH');

    // PATCH idempotency check including last_interaction_at
    const patchKey1 = crypto.randomUUID();
    const patchPayload1 = {
      followup_status: 'contacted',
      last_interaction_at: '2026-11-14T15:00:00.000Z',
      next_action: 'Esperar confirmación para enviar link de checkout',
      next_action_at: '2026-11-16T15:00:00.000Z',
      notes: 'Se respondió mensaje directo con precios vigentes',
      idempotency_key: patchKey1,
    };

    const firstPatch = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/inquiries/${inquiryId}`,
      headers: authHeaders(academicAuth),
      payload: patchPayload1,
    });
    assert.equal(firstPatch.statusCode, 200);
    assert.equal(JSON.parse(firstPatch.body).isIdempotentReplay, false);

    const replayPatch = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/inquiries/${inquiryId}`,
      headers: authHeaders(academicAuth),
      payload: patchPayload1,
    });
    assert.equal(replayPatch.statusCode, 200);
    assert.equal(JSON.parse(replayPatch.body).isIdempotentReplay, true);

    // Codex Reproduction #2: Same idempotency_key on PATCH but different `last_interaction_at` -> MUST return 409 IDEMPOTENCY_PAYLOAD_MISMATCH
    const mismatchLastInteractionPatch = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/inquiries/${inquiryId}`,
      headers: authHeaders(academicAuth),
      payload: {
        ...patchPayload1,
        last_interaction_at: '2026-11-14T18:30:00.000Z',
      },
    });
    assert.equal(mismatchLastInteractionPatch.statusCode, 409);
    assert.equal(JSON.parse(mismatchLastInteractionPatch.body).error, 'IDEMPOTENCY_PAYLOAD_MISMATCH');

    // Codex Reproduction #3: Distinguish field omitted vs explicit `null` in PATCH hash
    const patchKeyOmittedVsNull = crypto.randomUUID();
    const omittedFieldPatch = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/inquiries/${inquiryId}`,
      headers: authHeaders(academicAuth),
      payload: {
        followup_status: 'checkout_link_sent',
        // next_action_at is OMITTED here (preserves '2026-11-16T15:00:00.000Z')
        idempotency_key: patchKeyOmittedVsNull,
      },
    });
    assert.equal(omittedFieldPatch.statusCode, 200);
    assert.ok(JSON.parse(omittedFieldPatch.body).inquiry.next_action_at !== null);

    // Reusing patchKeyOmittedVsNull with explicit `next_action_at: null` (which means clear) MUST return 409 IDEMPOTENCY_PAYLOAD_MISMATCH
    const explicitNullMismatchPatch = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/inquiries/${inquiryId}`,
      headers: authHeaders(academicAuth),
      payload: {
        followup_status: 'checkout_link_sent',
        next_action_at: null,
        idempotency_key: patchKeyOmittedVsNull,
      },
    });
    assert.equal(explicitNullMismatchPatch.statusCode, 409);
    assert.equal(JSON.parse(explicitNullMismatchPatch.body).error, 'IDEMPOTENCY_PAYLOAD_MISMATCH');
  });

  await t.test('5. Concurrent POST Race Condition: 8 Identical Calls Yield 1 Created (201) and 7 Replays (200) Without 500 Errors (Codex Finding #3 — P2)', async () => {
    const raceKey = crypto.randomUUID();
    const racePayload = {
      channel: 'whatsapp',
      contact_name: 'Gabriela Torrez Concurrente',
      phone: '+59172233445',
      interested_sku: 'endometriosis',
      assigned_operator_id: 'op_academic_crm',
      followup_status: 'new_inquiry',
      next_action: 'Enviar información de curso y enlace de inscripción',
      notes: 'Consulta concurrente recibida por WhatsApp',
      idempotency_key: raceKey,
    };

    const responses = await Promise.all(
      Array.from({ length: 8 }, () =>
        app.inject({
          method: 'POST',
          url: '/api/v1/admin/inquiries',
          headers: authHeaders(academicAuth),
          payload: racePayload,
        })
      )
    );

    const statusCodes = responses.map((r) => r.statusCode);
    assert.ok(!statusCodes.includes(500), `Must never return HTTP 500 under concurrency: ${statusCodes}`);

    const created = responses.filter((r) => r.statusCode === 201);
    const replayed = responses.filter((r) => r.statusCode === 200);
    assert.equal(created.length, 1, 'Exactly 1 request must return 201 Created');
    assert.equal(replayed.length, 7, 'Exactly 7 requests must return 200 OK idempotent replay');

    const createdId = JSON.parse(created[0].body).inquiry.id;
    for (const rep of replayed) {
      const body = JSON.parse(rep.body);
      assert.equal(body.isIdempotentReplay, true);
      assert.equal(body.inquiry.id, createdId);
    }

    // Verify no duplicate or orphaned rows in social_inquiries or social_inquiry_events
    const inqCountRes = await db.query(
      `SELECT count(*) FROM social_inquiries WHERE academy_id = 'dr-sevilla' AND idempotency_key = $1`,
      [raceKey]
    );
    assert.equal(parseInt(inqCountRes.rows[0].count, 10), 1);

    const evCountRes = await db.query(
      `SELECT count(*) FROM social_inquiry_events WHERE academy_id = 'dr-sevilla' AND inquiry_id = $1`,
      [createdId]
    );
    assert.equal(parseInt(evCountRes.rows[0].count, 10), 1);

    // Concurrent race where one call uses an incompatible payload with the same idempotency_key -> 409
    const conflictRaceKey = crypto.randomUUID();
    const mixedResponses = await Promise.all([
      app.inject({
        method: 'POST',
        url: '/api/v1/admin/inquiries',
        headers: authHeaders(academicAuth),
        payload: { ...racePayload, idempotency_key: conflictRaceKey },
      }),
      app.inject({
        method: 'POST',
        url: '/api/v1/admin/inquiries',
        headers: authHeaders(academicAuth),
        payload: { ...racePayload, interested_sku: 'sop', idempotency_key: conflictRaceKey },
      }),
    ]);

    const mixedCodes = mixedResponses.map((r) => r.statusCode).sort();
    assert.deepEqual(mixedCodes, [201, 409]);
  });

  await t.test('6. Order Linkage Protection (No Silent Overwrite A→B), Ambiguous Candidates & End-to-End Funnel (Codex Findings #1 P1 & #4 P2)', async () => {
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

    // Step 2: Prospect creates Order A in checkout (mistakenly single course 'sop')
    const checkoutOrderARes = await app.inject({
      method: 'POST',
      url: '/api/v1/checkout',
      payload: {
        sku: 'sop',
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
    assert.equal(checkoutOrderARes.statusCode, 201);
    const orderANumber = JSON.parse(checkoutOrderARes.body).order_number;

    // With 1 matching order, suggested_order_match is populated unambiguously and order_match_ambiguous is false
    const listSingleMatchRes = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/inquiries?channel=whatsapp`,
      headers: authHeaders(academicAuth, false),
    });
    const inqSingleMatch = JSON.parse(listSingleMatchRes.body).inquiries.find((i) => i.id === inquiryId);
    assert.equal(inqSingleMatch.linked_order_id, null);
    assert.equal(inqSingleMatch.order_match_ambiguous, false);
    assert.equal(inqSingleMatch.order_match_candidates.length, 1);
    assert.equal(inqSingleMatch.order_match_candidates[0].matched_by, 'email_and_phone');
    assert.equal(inqSingleMatch.suggested_order_match.order_number, orderANumber);
    const orderAId = inqSingleMatch.suggested_order_match.order_id;

    // Step 3: Prospect creates a second Order B ('mujer-informada-4') with the same email/phone
    const checkoutOrderBRes = await app.inject({
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
    assert.equal(checkoutOrderBRes.statusCode, 201);
    const orderBNumber = JSON.parse(checkoutOrderBRes.body).order_number;

    // Codex Finding #4: With 2 candidate orders, order_match_ambiguous MUST be true,
    // both candidates are returned in order_match_candidates, and suggested_order_match MUST be null!
    const listAmbiguousRes = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/inquiries?channel=whatsapp`,
      headers: authHeaders(academicAuth, false),
    });
    const inqAmbiguous = JSON.parse(listAmbiguousRes.body).inquiries.find((i) => i.id === inquiryId);
    assert.equal(inqAmbiguous.linked_order_id, null);
    assert.equal(inqAmbiguous.order_match_ambiguous, true);
    assert.equal(inqAmbiguous.order_match_candidates.length, 2);
    assert.equal(
      inqAmbiguous.suggested_order_match,
      null,
      'Must NOT present a single unequivocal suggested_order_match when multiple orders match'
    );

    const orderBId = inqAmbiguous.order_match_candidates.find((c) => c.order_number === orderBNumber).order_id;

    // Step 4: Operator initially links Order A
    const linkOrderARes = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/inquiries/${inquiryId}`,
      headers: authHeaders(academicAuth),
      payload: {
        linked_order_id: orderAId,
        followup_status: 'order_created',
        next_action: 'Enviar QR bancario y verificar abono con finanzas',
        notes: 'Pedido vinculado manualmente tras confirmación de la interesada',
        idempotency_key: crypto.randomUUID(),
      },
    });
    assert.equal(linkOrderARes.statusCode, 200);
    assert.equal(JSON.parse(linkOrderARes.body).inquiry.linked_order_id, orderAId);
    assert.equal(JSON.parse(linkOrderARes.body).event.event_type, 'order_linked');

    // Once linked, GET /api/v1/admin/inquiries never suggests or infers candidate orders
    const listAfterLinkRes = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/inquiries?channel=whatsapp`,
      headers: authHeaders(academicAuth, false),
    });
    const inqAfterLink = JSON.parse(listAfterLinkRes.body).inquiries.find((i) => i.id === inquiryId);
    assert.equal(inqAfterLink.linked_order_id, orderAId);
    assert.equal(inqAfterLink.suggested_order_match, null);
    assert.equal(inqAfterLink.order_match_candidates.length, 0);
    assert.equal(inqAfterLink.order_match_ambiguous, false);

    // Step 5 (Codex Finding #1 — P1): Ordinary PATCH attempting to replace linked_order_id=A with B MUST be rejected with 409 ORDER_ALREADY_LINKED
    const silentOverwriteRes = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/inquiries/${inquiryId}`,
      headers: authHeaders(academicAuth),
      payload: {
        linked_order_id: orderBId,
        idempotency_key: crypto.randomUUID(),
      },
    });
    assert.equal(silentOverwriteRes.statusCode, 409);
    assert.equal(JSON.parse(silentOverwriteRes.body).error, 'ORDER_ALREADY_LINKED');

    // Attempting to unlink (linked_order_id: null) is also rejected with 409 ORDER_ALREADY_LINKED
    const unlinkAttemptRes = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/inquiries/${inquiryId}`,
      headers: authHeaders(academicAuth),
      payload: {
        linked_order_id: null,
        idempotency_key: crypto.randomUUID(),
      },
    });
    assert.equal(unlinkAttemptRes.statusCode, 409);
    assert.equal(JSON.parse(unlinkAttemptRes.body).error, 'ORDER_ALREADY_LINKED');

    // Explicit relink with wrong expected_linked_order_id -> 409 EXPECTED_LINKED_ORDER_MISMATCH
    const wrongExpectedRelinkRes = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/inquiries/${inquiryId}`,
      headers: authHeaders(academicAuth),
      payload: {
        linked_order_id: orderBId,
        confirm_order_relink: true,
        expected_linked_order_id: crypto.randomUUID(),
        relink_reason: 'Corrección de pedido vinculado por cambio al Pack Mujer Informada',
        idempotency_key: crypto.randomUUID(),
      },
    });
    assert.equal(wrongExpectedRelinkRes.statusCode, 409);
    assert.equal(JSON.parse(wrongExpectedRelinkRes.body).error, 'EXPECTED_LINKED_ORDER_MISMATCH');

    // Explicit exceptional relink with expected_linked_order_id=orderAId, confirm_order_relink=true, and relink_reason -> 200 OK + order_relinked event
    const explicitRelinkRes = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/inquiries/${inquiryId}`,
      headers: authHeaders(adminAuth),
      payload: {
        linked_order_id: orderBId,
        confirm_order_relink: true,
        expected_linked_order_id: orderAId,
        relink_reason: 'Interesada reemplazó pedido individual por Pack Mujer Informada antes de pagar',
        idempotency_key: crypto.randomUUID(),
      },
    });
    assert.equal(explicitRelinkRes.statusCode, 200, `Explicit relink failed: ${explicitRelinkRes.body}`);
    const relinkedBody = JSON.parse(explicitRelinkRes.body);
    assert.equal(relinkedBody.inquiry.linked_order_id, orderBId);
    assert.equal(relinkedBody.inquiry.order_linked_by_operator_id, 'op_admin_crm');
    assert.equal(relinkedBody.event.event_type, 'order_relinked');
    assert.equal(relinkedBody.event.metadata.previous_linked_order_id, orderAId);
    assert.equal(relinkedBody.event.metadata.new_linked_order_id, orderBId);

    // Step 6: Cannot set followup_status='paid_verified' while Order B is still 'pending_payment' -> 409 ORDER_NOT_PAID_VERIFIED
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

    // Step 7: Finance verifier confirms bank payment on Order B
    const verifyPayRes = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/orders/${orderBId}/verify-payment`,
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

    // Step 8: Academic operator updates inquiry status to paid_verified, then completes Moodle enrollment and updates inquiry to enrolled
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

    const startEnrollRes = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/orders/${orderBId}/start-enrollment`,
      headers: authHeaders(academicAuth),
      payload: {
        reason: 'Iniciando alta manual en Moodle para Carolina Méndez',
        idempotency_key: crypto.randomUUID(),
      },
    });
    assert.equal(startEnrollRes.statusCode, 200);

    const confirmEnrollRes = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/orders/${orderBId}/confirm-enrollment`,
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
    assert.equal(confirmEnrollRes.statusCode, 200);

    const inquiryEnrolledRes = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/inquiries/${inquiryId}`,
      headers: authHeaders(academicAuth),
      payload: {
        followup_status: 'enrolled',
        observation_category: 'moodle_enrollment_completed',
        next_action: 'Seguimiento completado — alumna matriculada en Moodle',
        next_action_at: null,
        idempotency_key: crypto.randomUUID(),
      },
    });
    assert.equal(inquiryEnrolledRes.statusCode, 200);
    const enrolledInquiry = JSON.parse(inquiryEnrolledRes.body).inquiry;
    assert.equal(enrolledInquiry.followup_status, 'enrolled');
    assert.equal(enrolledInquiry.linked_order_id, orderBId);
  });

  await t.test('7. Priority Queue Ordering: Unattended new_inquiry First, Overdue/Upcoming next_action_at Next, NULLs and Closed Last (Codex Finding #6 — P2)', async () => {
    // Use a dedicated operator filter ('op_admin_crm') to test deterministic queue ordering across 6 date/status scenarios
    const scenarios = [
      {
        label: 'closed_recent',
        contact_name: 'Cerrada Reciente',
        phone: '+59175500001',
        followup_status: 'closed_no_conversion',
        next_action: 'Archivar seguimiento de curso sin respuesta',
        next_action_at: '2026-11-10T08:00:00.000Z',
      },
      {
        label: 'contacted_null_date',
        contact_name: 'Contactada Sin Fecha',
        phone: '+59175500002',
        followup_status: 'contacted',
        next_action: 'Esperar respuesta sobre curso de interés',
        next_action_at: null,
      },
      {
        label: 'checkout_upcoming_tomorrow',
        contact_name: 'Checkout Próximo Mañana',
        phone: '+59175500003',
        followup_status: 'checkout_link_sent',
        next_action: 'Confirmar si completó pedido en checkout',
        next_action_at: '2026-11-16T10:00:00.000Z',
      },
      {
        label: 'contacted_overdue_yesterday',
        contact_name: 'Contactada Vencida Ayer',
        phone: '+59175500004',
        followup_status: 'contacted',
        next_action: 'Responder duda pendiente sobre pago por QR',
        next_action_at: '2026-11-13T09:00:00.000Z',
      },
      {
        label: 'new_null_date',
        contact_name: 'Nueva Sin Fecha',
        phone: '+59175500005',
        followup_status: 'new_inquiry',
        next_action: 'Responder primer mensaje de WhatsApp sobre curso',
        next_action_at: null,
      },
      {
        label: 'new_overdue',
        contact_name: 'Nueva Urgente Vencida',
        phone: '+59175500006',
        followup_status: 'new_inquiry',
        next_action: 'Responder consulta urgente de inscripción al curso',
        next_action_at: '2026-11-14T07:00:00.000Z',
      },
    ];

    for (const sc of scenarios) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/inquiries',
        headers: authHeaders(adminAuth),
        payload: {
          channel: 'whatsapp',
          contact_name: sc.contact_name,
          phone: sc.phone,
          interested_sku: 'vaginosis',
          assigned_operator_id: 'op_admin_crm',
          followup_status: sc.followup_status,
          next_action: sc.next_action,
          ...(sc.next_action_at !== null ? { next_action_at: sc.next_action_at } : {}),
          idempotency_key: crypto.randomUUID(),
        },
      });
      assert.equal(res.statusCode, 201);
    }

    const queueRes = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/inquiries?assigned_operator_id=op_admin_crm',
      headers: authHeaders(adminAuth, false),
    });
    assert.equal(queueRes.statusCode, 200);
    const orderedNames = JSON.parse(queueRes.body).inquiries.map((i) => i.contact_name);

    assert.deepEqual(orderedNames, [
      'Nueva Urgente Vencida',      // 1. new_inquiry with earliest next_action_at
      'Nueva Sin Fecha',            // 2. new_inquiry with NULL next_action_at
      'Contactada Vencida Ayer',    // 3. active follow-up with overdue next_action_at (2026-11-13)
      'Checkout Próximo Mañana',    // 4. active follow-up with upcoming next_action_at (2026-11-16)
      'Contactada Sin Fecha',       // 5. active follow-up with NULL next_action_at
      'Cerrada Reciente',           // 6. closed_no_conversion always at the end
    ]);
  });

  await t.test('8. Multi-Academy Extensibility & Strict Isolation: dr-sevilla (Primary Tenant) vs techpro (Future Academy)', async () => {
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

    // 8a. TechPro can register its own social inquiries with its own course SKU (even using the same email as a dr-sevilla buyer to test tenant boundary on order matching!)
    const tpCreateRes = await techproApp.inject({
      method: 'POST',
      url: '/api/v1/admin/inquiries',
      headers: authHeaders(techproAuth),
      payload: {
        channel: 'tiktok',
        contact_name: 'Mateo Silva',
        contact_handle: '@mateo.dev',
        email: 'carolina.mendez@ejemplo.com',
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

    // 8b. dr-sevilla operator CANNOT register an inquiry with a techpro SKU -> 404 PRODUCT_NOT_FOUND
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

    // 8c. dr-sevilla operator CANNOT assign an inquiry to a techpro operator -> 422 INVALID_ASSIGNED_OPERATOR
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

    // 8d. dr-sevilla GET /api/v1/admin/inquiries never leaks techpro inquiries, and techpro never sees dr-sevilla order candidates even for the same email
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
    assert.equal(
      techproItems[0].order_match_candidates.length,
      0,
      'Must never suggest orders from dr-sevilla to techpro even when email matches'
    );
    assert.equal(techproItems[0].suggested_order_match, null);

    // 8e. dr-sevilla operator CANNOT PATCH a techpro inquiry -> 404 INQUIRY_NOT_FOUND
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

    // 8f. techpro operator CANNOT link a dr-sevilla order to a techpro inquiry -> 404 ORDER_NOT_FOUND
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
