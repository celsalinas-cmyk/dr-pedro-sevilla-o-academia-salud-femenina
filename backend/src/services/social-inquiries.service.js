import crypto from 'crypto';

export const ALLOWED_SOCIAL_CHANNELS = new Set([
  'whatsapp',
  'instagram',
  'tiktok',
  'facebook',
  'web',
]);

export const ALLOWED_FOLLOWUP_STATUSES = new Set([
  'new_inquiry',
  'contacted',
  'checkout_link_sent',
  'order_created',
  'paid_verified',
  'enrolled',
  'closed_no_conversion',
  'do_not_contact',
]);

export const ALLOWED_CONTACT_BASES = new Set([
  'inbound_user_message',
  'explicit_opt_in',
  'checkout_form_submission',
  'no_outbound_permission',
  'opt_out_revoked',
]);

export const ALLOWED_OBSERVATION_CATEGORIES = new Set([
  'course_info_requested',
  'pricing_and_pack_comparison',
  'payment_method_qr_inquiry',
  'checkout_link_dispatched',
  'awaiting_prospect_reply',
  'order_created_in_checkout',
  'payment_verification_pending',
  'moodle_enrollment_completed',
  'no_response_or_postponed',
  'do_not_contact_requested',
]);

const ALLOWED_CREATE_FIELDS = new Set([
  'channel',
  'interested_sku',
  'contact_name',
  'contact_handle',
  'email',
  'phone',
  'contact_basis',
  'contact_basis_evidence',
  'outbound_contact_allowed',
  'observation_category',
  'utm',
  'assigned_operator_id',
  'followup_status',
  'last_interaction_at',
  'next_action',
  'next_action_at',
  'linked_order_id',
  'notes',
  'idempotency_key',
]);

const ALLOWED_UPDATE_FIELDS = new Set([
  'interested_sku',
  'contact_name',
  'contact_handle',
  'email',
  'phone',
  'contact_basis',
  'contact_basis_evidence',
  'outbound_contact_allowed',
  'observation_category',
  'assigned_operator_id',
  'followup_status',
  'last_interaction_at',
  'next_action',
  'next_action_at',
  'linked_order_id',
  'expected_linked_order_id',
  'confirm_order_relink',
  'relink_reason',
  'notes',
  'idempotency_key',
]);

const OMITTED_SENTINEL = '__FIELD_OMITTED__';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NAME_REGEX = /^[a-zA-ZáéíóúÁÉÍÓÚñÑüÜ\s'-]+$/;
const EMAIL_REGEX = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
const PHONE_REGEX = /^\+?[0-9\s-]{6,25}$/;
const HANDLE_REGEX = /^@?[a-zA-Z0-9._-]{2,64}$/;
const UTM_REGEX = /^[a-zA-Z0-9_-]{1,100}$/;

/**
 * Privacy & Minimization Controls:
 * 1. Blocklist of clinical, symptom, anatomical, diagnostic, or patient-complaint terms.
 * 2. Positive commercial allowlist requirement: notes and next_action in the Mini CRM are
 *    restricted to concise, guided commercial follow-up observations (never free-form clinical narratives).
 */
const PROHIBITED_CLINICAL_OR_SYMPTOM_REGEX =
  /\b(diagn[oó]stico|diagnosticad[oa]|s[ií]ntoma|s[ií]ntomas|receta|historia cl[ií]nica|historial m[eé]dico|tratamiento|medicaci[oó]n|medicamento|pastilla|antib[ií]otico|biopsia|ecograf[ií]a|ultrasonido|laboratorio|paciente|sangrado|hemorragia|dolor|duele|p[eé]lvico|pelvis|vaginal|flujo|ardor|picaz[oó]n|infecci[oó]n|quiste|mioma|[uú]tero|ovario|menstruaci[oó]n|menstrual|embarazo|aborto|cirug[ií]a|operaci[oó]n|quir[uú]rgic[oa]|m[eé]dico|doctora|cl[ií]nica|hospital|enfermedad|hormona|hormonal|fiebre|inflamaci[oó]n|lesi[oó]n|consulta m[eé]dica|sufro de|padezco)\b/i;

const GUIDED_COMMERCIAL_INTENT_REGEX =
  /\b(curso|cursos|pack|precio|precios|tarifa|costo|checkout|enlace|link|inscripci[oó]n|inscribir|pedido|orden|pago|pagos|abono|qr|banco|bancario|finanzas|moodle|matr[ií]cula|matriculad[oa]|alumna|alumno|acceso|temario|modalidad|horario|horarios|informaci[oó]n|informativ[oa]|cat[aá]logo|prospecto|interesad[oa]|canal|whatsapp|instagram|tiktok|facebook|web|dm|mensaje|contactar|contacto|llamar|responder|seguimiento|confirmar|confirmaci[oó]n|esperar|credenciales|syllabus|bootcamp|duda|dudas|academia|operador|baja|no contactar)\b/i;

function assertValidUuid(value, fieldName) {
  if (!value || typeof value !== 'string' || !UUID_REGEX.test(value.trim())) {
    const err = new Error(`Field '${fieldName}' must be a valid UUID v4.`);
    err.statusCode = 422;
    err.code = 'VALIDATION_ERROR';
    throw err;
  }
  return value.trim().toLowerCase();
}

function assertNoClinicalContent(text, fieldName) {
  if (typeof text === 'string' && PROHIBITED_CLINICAL_OR_SYMPTOM_REGEX.test(text)) {
    const err = new Error(
      `Field '${fieldName}' contains prohibited clinical, symptom, or medical terminology. The Mini CRM only permits guided commercial follow-up observations.`
    );
    err.statusCode = 422;
    err.code = 'CLINICAL_DATA_PROHIBITED';
    throw err;
  }
}

function validateGuidedCommercialText(
  text,
  fieldName,
  { minLength = 3, maxLength = 180, requireCommercialIntent = true } = {}
) {
  if (typeof text !== 'string') {
    const err = new Error(`${fieldName} must be a string.`);
    err.statusCode = 422;
    err.code = 'VALIDATION_ERROR';
    throw err;
  }
  const trimmed = text.trim();
  if (trimmed.length < minLength || trimmed.length > maxLength) {
    const err = new Error(`${fieldName} must be between ${minLength} and ${maxLength} characters.`);
    err.statusCode = 422;
    err.code = 'VALIDATION_ERROR';
    throw err;
  }
  assertNoClinicalContent(trimmed, fieldName);

  if (requireCommercialIntent && !GUIDED_COMMERCIAL_INTENT_REGEX.test(trimmed)) {
    const err = new Error(
      `Field '${fieldName}' must be a guided commercial or administrative observation (free-form non-commercial narratives are prohibited).`
    );
    err.statusCode = 422;
    err.code = 'UNGUIDED_COMMERCIAL_NOTE_REJECTED';
    throw err;
  }
  return trimmed;
}

function assertAllowedFields(input, allowedSet) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    const err = new Error('Payload must be a valid JSON object.');
    err.statusCode = 422;
    err.code = 'VALIDATION_ERROR';
    throw err;
  }

  for (const key of Object.keys(input)) {
    if (!allowedSet.has(key)) {
      const err = new Error(
        `Field '${key}' is not permitted in the Mini CRM. Only commercial contact and follow-up attributes are allowed.`
      );
      err.statusCode = 422;
      err.code = 'UNSUPPORTED_OR_SENSITIVE_FIELD';
      throw err;
    }
  }
}

function computeHash(parts) {
  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key) && obj[key] !== undefined;
}

export class SocialInquiriesService {
  constructor(dbPool, defaultAcademyId = 'dr-sevilla') {
    this.db = dbPool;
    this.defaultAcademyId = defaultAcademyId;
  }

  /**
   * Validates and normalizes contact fields (contact_name, email, phone, contact_handle).
   */
  validateContactFields({ contact_name, email, phone, contact_handle }, { requireAtLeastOneContact = true } = {}) {
    let normalizedName = null;
    if (contact_name !== undefined) {
      if (typeof contact_name !== 'string') {
        const err = new Error('contact_name must be a string.');
        err.statusCode = 422;
        err.code = 'VALIDATION_ERROR';
        throw err;
      }
      const trimmedName = contact_name.trim();
      if (trimmedName.length < 2 || trimmedName.length > 128 || !NAME_REGEX.test(trimmedName)) {
        const err = new Error('contact_name must be 2-128 letters and spaces.');
        err.statusCode = 422;
        err.code = 'VALIDATION_ERROR';
        throw err;
      }
      assertNoClinicalContent(trimmedName, 'contact_name');
      normalizedName = trimmedName;
    }

    let normalizedEmail = null;
    if (email !== undefined && email !== null && email !== '') {
      if (typeof email !== 'string' || email.trim().length > 255 || !EMAIL_REGEX.test(email.trim())) {
        const err = new Error('Invalid email format.');
        err.statusCode = 422;
        err.code = 'VALIDATION_ERROR';
        throw err;
      }
      normalizedEmail = email.trim().toLowerCase();
    }

    let normalizedPhone = null;
    if (phone !== undefined && phone !== null && phone !== '') {
      if (typeof phone !== 'string' || !PHONE_REGEX.test(phone.trim())) {
        const err = new Error('Invalid phone format (6-25 digits).');
        err.statusCode = 422;
        err.code = 'VALIDATION_ERROR';
        throw err;
      }
      normalizedPhone = phone.trim();
    }

    let normalizedHandle = null;
    if (contact_handle !== undefined && contact_handle !== null && contact_handle !== '') {
      if (typeof contact_handle !== 'string' || !HANDLE_REGEX.test(contact_handle.trim())) {
        const err = new Error('Invalid contact_handle format.');
        err.statusCode = 422;
        err.code = 'VALIDATION_ERROR';
        throw err;
      }
      normalizedHandle = contact_handle.trim();
    }

    if (requireAtLeastOneContact && !normalizedEmail && !normalizedPhone && !normalizedHandle) {
      const err = new Error(
        'At least one consented contact channel (email, phone, or contact_handle) is required.'
      );
      err.statusCode = 422;
      err.code = 'CONTACT_METHOD_REQUIRED';
      throw err;
    }

    return {
      contactName: normalizedName,
      emailNormalized: normalizedEmail,
      phone: normalizedPhone,
      contactHandle: normalizedHandle,
    };
  }

  /**
   * Validates and resolves contact basis, evidence, observation category, and outbound permission.
   * Never fabricates explicit_opt_in; blocks outbound follow-up states when outbound_contact_allowed is false.
   */
  resolveContactConsentAndCategory({
    contactBasis,
    contactBasisEvidence,
    outboundContactAllowed,
    observationCategory,
    followupStatus,
  }) {
    if (!ALLOWED_CONTACT_BASES.has(contactBasis)) {
      const err = new Error(`Invalid contact_basis '${contactBasis}'.`);
      err.statusCode = 422;
      err.code = 'VALIDATION_ERROR';
      throw err;
    }

    if (!ALLOWED_OBSERVATION_CATEGORIES.has(observationCategory)) {
      const err = new Error(`Invalid observation_category '${observationCategory}'.`);
      err.statusCode = 422;
      err.code = 'VALIDATION_ERROR';
      throw err;
    }

    let normalizedEvidence = null;
    if (contactBasisEvidence !== undefined && contactBasisEvidence !== null && contactBasisEvidence !== '') {
      normalizedEvidence = validateGuidedCommercialText(contactBasisEvidence, 'contact_basis_evidence', {
        minLength: 5,
        maxLength: 180,
        requireCommercialIntent: false,
      });
    }

    // Never allow fabricating explicit_opt_in without explicit documented evidence
    if (contactBasis === 'explicit_opt_in' && !normalizedEvidence) {
      const err = new Error(
        "contact_basis 'explicit_opt_in' requires contact_basis_evidence documenting how consent was obtained."
      );
      err.statusCode = 422;
      err.code = 'CONTACT_BASIS_EVIDENCE_REQUIRED';
      throw err;
    }

    const requiresNoOutbound =
      contactBasis === 'no_outbound_permission' ||
      contactBasis === 'opt_out_revoked' ||
      followupStatus === 'do_not_contact' ||
      observationCategory === 'do_not_contact_requested';

    if (requiresNoOutbound && outboundContactAllowed === true) {
      const err = new Error(
        'outbound_contact_allowed cannot be true when contact_basis or status prohibits outbound contact.'
      );
      err.statusCode = 422;
      err.code = 'OUTBOUND_CONTACT_NOT_AUTHORIZED';
      throw err;
    }

    const resolvedOutboundAllowed = requiresNoOutbound
      ? false
      : outboundContactAllowed !== undefined
        ? Boolean(outboundContactAllowed)
        : true;

    if (
      !resolvedOutboundAllowed &&
      (followupStatus === 'contacted' || followupStatus === 'checkout_link_sent')
    ) {
      const err = new Error(
        `Cannot transition to outbound follow-up status '${followupStatus}' when outbound_contact_allowed is false.`
      );
      err.statusCode = 409;
      err.code = 'OUTBOUND_CONTACT_PROHIBITED';
      throw err;
    }

    return {
      contactBasis,
      contactBasisEvidence: normalizedEvidence,
      outboundContactAllowed: resolvedOutboundAllowed,
      observationCategory,
    };
  }

  /**
   * Validates optional UTM attribution parameters.
   */
  validateUtm(utm) {
    if (utm === undefined || utm === null) {
      return { source: null, medium: null, campaign: null };
    }
    if (typeof utm !== 'object' || Array.isArray(utm)) {
      const err = new Error('utm must be a JSON object.');
      err.statusCode = 422;
      err.code = 'VALIDATION_ERROR';
      throw err;
    }

    const allowedUtmKeys = new Set(['source', 'medium', 'campaign']);
    for (const k of Object.keys(utm)) {
      if (!allowedUtmKeys.has(k)) {
        const err = new Error(`Unsupported UTM parameter '${k}'.`);
        err.statusCode = 422;
        err.code = 'VALIDATION_ERROR';
        throw err;
      }
      const val = utm[k];
      if (val !== undefined && val !== null && val !== '') {
        if (typeof val !== 'string' || !UTM_REGEX.test(val.trim())) {
          const err = new Error(`Invalid UTM value for '${k}'.`);
          err.statusCode = 422;
          err.code = 'VALIDATION_ERROR';
          throw err;
        }
      }
    }

    return {
      source: utm.source ? utm.source.trim() : null,
      medium: utm.medium ? utm.medium.trim() : null,
      campaign: utm.campaign ? utm.campaign.trim() : null,
    };
  }

  /**
   * Verifies that interested_sku is an active product belonging to the same academy_id.
   */
  async assertValidAcademyProduct(client, academyId, sku) {
    if (!sku || typeof sku !== 'string' || sku.trim() === '') {
      const err = new Error('interested_sku is required.');
      err.statusCode = 422;
      err.code = 'VALIDATION_ERROR';
      throw err;
    }
    const cleanSku = sku.trim();
    const prodRes = await client.query(
      `SELECT sku, title FROM products WHERE academy_id = $1 AND sku = $2 AND is_active = TRUE`,
      [academyId, cleanSku]
    );
    if (prodRes.rows.length === 0) {
      const err = new Error(`Course SKU '${cleanSku}' is not active or does not belong to academy '${academyId}'.`);
      err.statusCode = 404;
      err.code = 'PRODUCT_NOT_FOUND';
      throw err;
    }
    return prodRes.rows[0];
  }

  /**
   * Verifies that assigned_operator_id exists and is active within the same academy_id.
   */
  async assertValidAssignedOperator(client, academyId, operatorId) {
    if (operatorId === undefined || operatorId === null || operatorId === '') {
      return null;
    }
    if (typeof operatorId !== 'string' || operatorId.trim().length > 64) {
      const err = new Error('Invalid assigned_operator_id.');
      err.statusCode = 422;
      err.code = 'INVALID_ASSIGNED_OPERATOR';
      throw err;
    }
    const cleanOpId = operatorId.trim();
    const opRes = await client.query(
      `SELECT operator_id, display_name, role, is_active
       FROM admin_operators
       WHERE academy_id = $1 AND operator_id = $2 AND is_active = TRUE`,
      [academyId, cleanOpId]
    );
    if (opRes.rows.length === 0) {
      const err = new Error(`Assigned operator '${cleanOpId}' is not active in academy '${academyId}'.`);
      err.statusCode = 422;
      err.code = 'INVALID_ASSIGNED_OPERATOR';
      throw err;
    }
    return opRes.rows[0];
  }

  /**
   * Verifies that linked_order_id belongs to the same academy_id and enforces status coherence.
   */
  async verifyAndResolveOrderLink(client, academyId, linkedOrderId, requestedFollowupStatus) {
    if (linkedOrderId === undefined || linkedOrderId === null || linkedOrderId === '') {
      if (requestedFollowupStatus === 'order_created') {
        const err = new Error("followup_status 'order_created' requires a confirmed linked_order_id.");
        err.statusCode = 409;
        err.code = 'ORDER_LINK_REQUIRED_FOR_STATUS';
        throw err;
      }
      if (requestedFollowupStatus === 'paid_verified') {
        const err = new Error("followup_status 'paid_verified' requires a linked order in paid_verified status.");
        err.statusCode = 409;
        err.code = 'ORDER_LINK_REQUIRED_FOR_STATUS';
        throw err;
      }
      if (requestedFollowupStatus === 'enrolled') {
        const err = new Error("followup_status 'enrolled' requires a linked order in fulfilled status.");
        err.statusCode = 409;
        err.code = 'ORDER_LINK_REQUIRED_FOR_STATUS';
        throw err;
      }
      return { order: null, resolvedStatus: requestedFollowupStatus };
    }

    const validOrderId = assertValidUuid(linkedOrderId, 'linked_order_id');
    const orderRes = await client.query(
      `SELECT o.id, o.academy_id, o.order_number, o.status, o.total_amount_minor, o.currency,
              oi.sku
       FROM orders o
       JOIN order_items oi ON oi.academy_id = o.academy_id AND oi.order_id = o.id
       WHERE o.academy_id = $1 AND o.id = $2`,
      [academyId, validOrderId]
    );

    if (orderRes.rows.length === 0) {
      const err = new Error(`Order '${validOrderId}' was not found in academy '${academyId}'.`);
      err.statusCode = 404;
      err.code = 'ORDER_NOT_FOUND';
      throw err;
    }

    const order = orderRes.rows[0];

    if (
      (order.status === 'cancelled' || order.status === 'expired') &&
      (requestedFollowupStatus === 'order_created' ||
        requestedFollowupStatus === 'paid_verified' ||
        requestedFollowupStatus === 'enrolled')
    ) {
      const err = new Error(
        `Cannot link order in status '${order.status}' with active conversion status '${requestedFollowupStatus}'.`
      );
      err.statusCode = 409;
      err.code = 'ORDER_STATUS_INCOMPATIBLE_WITH_FOLLOWUP';
      throw err;
    }

    if (
      requestedFollowupStatus === 'paid_verified' &&
      order.status !== 'paid_verified' &&
      order.status !== 'enrollment_pending' &&
      order.status !== 'fulfilled'
    ) {
      const err = new Error(
        `Cannot set followup_status to 'paid_verified' because linked order '${order.order_number}' is in status '${order.status}'.`
      );
      err.statusCode = 409;
      err.code = 'ORDER_NOT_PAID_VERIFIED';
      throw err;
    }

    if (requestedFollowupStatus === 'enrolled' && order.status !== 'fulfilled') {
      const err = new Error(
        `Cannot set followup_status to 'enrolled' because linked order '${order.order_number}' is in status '${order.status}' (must be 'fulfilled').`
      );
      err.statusCode = 409;
      err.code = 'ORDER_NOT_FULFILLED';
      throw err;
    }

    // If the inquiry was in a pre-order state ('new_inquiry', 'contacted', 'checkout_link_sent'),
    // synchronize followup_status with the linked order's verified progression
    let resolvedStatus = requestedFollowupStatus;
    if (
      resolvedStatus === 'new_inquiry' ||
      resolvedStatus === 'contacted' ||
      resolvedStatus === 'checkout_link_sent' ||
      resolvedStatus === 'order_created'
    ) {
      if (order.status === 'fulfilled') {
        resolvedStatus = 'enrolled';
      } else if (order.status === 'paid_verified' || order.status === 'enrollment_pending') {
        resolvedStatus = 'paid_verified';
      } else if (order.status === 'pending_payment') {
        resolvedStatus = 'order_created';
      }
    }

    return { order, resolvedStatus };
  }

  /**
   * GET /api/v1/admin/inquiries
   * Lists social inquiries scoped strictly by session.academyId with priority queue ordering:
   * 1. Unattended new_inquiry first
   * 2. Active follow-ups ordered by overdue/upcoming next_action_at ASC (NULLS after scheduled)
   * 3. Enrolled
   * 4. Closed / do_not_contact last
   * Also surfaces bounded order match candidates with matched_by and order_match_ambiguous flag.
   */
  async listInquiries(session, filters = {}) {
    const academyId = session.academyId || this.defaultAcademyId;
    const params = [academyId];
    const clauses = ['si.academy_id = $1'];

    if (filters.followup_status !== undefined && filters.followup_status !== '') {
      if (!ALLOWED_FOLLOWUP_STATUSES.has(filters.followup_status)) {
        const err = new Error(`Invalid followup_status filter: '${filters.followup_status}'.`);
        err.statusCode = 422;
        err.code = 'VALIDATION_ERROR';
        throw err;
      }
      params.push(filters.followup_status);
      clauses.push(`si.followup_status = $${params.length}`);
    }

    if (filters.channel !== undefined && filters.channel !== '') {
      if (!ALLOWED_SOCIAL_CHANNELS.has(filters.channel)) {
        const err = new Error(`Invalid channel filter: '${filters.channel}'.`);
        err.statusCode = 422;
        err.code = 'VALIDATION_ERROR';
        throw err;
      }
      params.push(filters.channel);
      clauses.push(`si.channel = $${params.length}`);
    }

    if (filters.interested_sku !== undefined && filters.interested_sku !== '') {
      params.push(String(filters.interested_sku).trim());
      clauses.push(`si.interested_sku = $${params.length}`);
    }

    if (filters.assigned_operator_id !== undefined && filters.assigned_operator_id !== '') {
      params.push(String(filters.assigned_operator_id).trim());
      clauses.push(`si.assigned_operator_id = $${params.length}`);
    }

    const whereSql = clauses.join(' AND ');

    const res = await this.db.query(
      `SELECT si.*,
              p.title AS product_title,
              op.display_name AS assigned_operator_name,
              o.order_number AS linked_order_number,
              o.status AS linked_order_status,
              o.total_amount_minor AS linked_order_amount_minor,
              o.currency AS linked_order_currency
       FROM social_inquiries si
       JOIN products p ON p.academy_id = si.academy_id AND p.sku = si.interested_sku
       LEFT JOIN admin_operators op ON op.academy_id = si.academy_id AND op.operator_id = si.assigned_operator_id
       LEFT JOIN orders o ON o.academy_id = si.academy_id AND o.id = si.linked_order_id
       WHERE ${whereSql}
       ORDER BY
         CASE
           WHEN si.followup_status = 'new_inquiry' THEN 0
           WHEN si.followup_status IN ('contacted', 'checkout_link_sent', 'order_created', 'paid_verified') THEN 1
           WHEN si.followup_status = 'enrolled' THEN 2
           ELSE 3
         END ASC,
         CASE
           WHEN si.next_action_at IS NULL THEN 1
           ELSE 0
         END ASC,
         si.next_action_at ASC,
         si.created_at DESC,
         si.id ASC`,
      params
    );

    const inquiries = [];
    for (const row of res.rows) {
      let orderMatchCandidates = [];
      let orderMatchAmbiguous = false;
      let suggestedOrderMatch = null;

      // Only look up candidate orders if the inquiry is NOT already linked to an order
      if (!row.linked_order_id && (row.email_normalized || row.phone)) {
        const matchParams = [academyId];
        const matchConds = [];
        if (row.email_normalized) {
          matchParams.push(row.email_normalized);
          matchConds.push(`l.email_normalized = $${matchParams.length}`);
        }
        if (row.phone) {
          matchParams.push(row.phone);
          matchConds.push(`l.phone = $${matchParams.length}`);
        }
        const sugRes = await this.db.query(
          `SELECT o.id AS order_id, o.order_number, o.status, o.total_amount_minor, o.currency,
                  o.created_at, oi.sku, l.email_normalized AS lead_email, l.phone AS lead_phone
           FROM orders o
           JOIN leads l ON l.academy_id = o.academy_id AND l.id = o.lead_id
           JOIN order_items oi ON oi.academy_id = o.academy_id AND oi.order_id = o.id
           WHERE o.academy_id = $1 AND (${matchConds.join(' OR ')})
           ORDER BY o.created_at DESC
           LIMIT 5`,
          matchParams
        );

        orderMatchCandidates = sugRes.rows.map((cand) => {
          const matchedEmail = Boolean(row.email_normalized && cand.lead_email === row.email_normalized);
          const matchedPhone = Boolean(row.phone && cand.lead_phone === row.phone);
          const matchedBy =
            matchedEmail && matchedPhone
              ? 'email_and_phone'
              : matchedEmail
                ? 'email'
                : 'phone';
          return {
            order_id: cand.order_id,
            order_number: cand.order_number,
            status: cand.status,
            total_amount_minor: cand.total_amount_minor,
            currency: cand.currency,
            sku: cand.sku,
            created_at: cand.created_at,
            matched_by: matchedBy,
          };
        });

        orderMatchAmbiguous = orderMatchCandidates.length > 1;
        // Only surface suggested_order_match when there is a single unambiguous candidate
        suggestedOrderMatch = orderMatchCandidates.length === 1 ? orderMatchCandidates[0] : null;
      }

      inquiries.push({
        id: row.id,
        academy_id: row.academy_id,
        channel: row.channel,
        interested_sku: row.interested_sku,
        product_title: row.product_title,
        contact_name: row.contact_name,
        contact_handle: row.contact_handle,
        email_normalized: row.email_normalized,
        phone: row.phone,
        contact_basis: row.contact_basis,
        contact_basis_evidence: row.contact_basis_evidence,
        outbound_contact_allowed: row.outbound_contact_allowed,
        observation_category: row.observation_category,
        notes: row.notes,
        utm_source: row.utm_source,
        utm_medium: row.utm_medium,
        utm_campaign: row.utm_campaign,
        assigned_operator_id: row.assigned_operator_id,
        assigned_operator_name: row.assigned_operator_name || null,
        followup_status: row.followup_status,
        last_interaction_at: row.last_interaction_at,
        next_action: row.next_action,
        next_action_at: row.next_action_at,
        linked_order_id: row.linked_order_id,
        order_linked_by_operator_id: row.order_linked_by_operator_id,
        order_linked_at: row.order_linked_at,
        linked_order: row.linked_order_id
          ? {
              id: row.linked_order_id,
              order_number: row.linked_order_number,
              status: row.linked_order_status,
              total_amount_minor: row.linked_order_amount_minor,
              currency: row.linked_order_currency,
            }
          : null,
        suggested_order_match: suggestedOrderMatch,
        order_match_candidates: orderMatchCandidates,
        order_match_ambiguous: orderMatchAmbiguous,
        created_by_operator_id: row.created_by_operator_id,
        updated_by_operator_id: row.updated_by_operator_id,
        created_at: row.created_at,
        updated_at: row.updated_at,
      });
    }

    return {
      academy_id: academyId,
      inquiries,
    };
  }

  /**
   * POST /api/v1/admin/inquiries
   * Registers a new omnichannel social inquiry with strict validation, guided commercial notes,
   * contact basis tracking, concurrency-safe idempotency, and complete payload hashing.
   */
  async createInquiry(session, input = {}, opts = {}) {
    assertAllowedFields(input, ALLOWED_CREATE_FIELDS);

    const idempotencyKey = assertValidUuid(input.idempotency_key, 'idempotency_key');
    const academyId = session.academyId || this.defaultAcademyId;

    const channel = typeof input.channel === 'string' ? input.channel.trim().toLowerCase() : '';
    if (!ALLOWED_SOCIAL_CHANNELS.has(channel)) {
      const err = new Error(
        "channel must be one of: 'whatsapp', 'instagram', 'tiktok', 'facebook', 'web'."
      );
      err.statusCode = 422;
      err.code = 'VALIDATION_ERROR';
      throw err;
    }

    const followupStatus = input.followup_status ? String(input.followup_status).trim() : 'new_inquiry';
    if (!ALLOWED_FOLLOWUP_STATUSES.has(followupStatus)) {
      const err = new Error(`Invalid followup_status '${followupStatus}'.`);
      err.statusCode = 422;
      err.code = 'VALIDATION_ERROR';
      throw err;
    }

    if (!input.contact_name) {
      const err = new Error('contact_name is required.');
      err.statusCode = 422;
      err.code = 'VALIDATION_ERROR';
      throw err;
    }

    const contact = this.validateContactFields(
      {
        contact_name: input.contact_name,
        email: input.email,
        phone: input.phone,
        contact_handle: input.contact_handle,
      },
      { requireAtLeastOneContact: true }
    );

    const rawContactBasis = hasOwn(input, 'contact_basis')
      ? String(input.contact_basis ?? '').trim()
      : 'inbound_user_message';
    const rawObservationCategory = hasOwn(input, 'observation_category')
      ? String(input.observation_category ?? '').trim()
      : 'course_info_requested';

    const consentInfo = this.resolveContactConsentAndCategory({
      contactBasis: rawContactBasis,
      contactBasisEvidence: input.contact_basis_evidence,
      outboundContactAllowed: input.outbound_contact_allowed,
      observationCategory: rawObservationCategory,
      followupStatus,
    });

    const utm = this.validateUtm(input.utm);

    let nextAction = null;
    if (input.next_action !== undefined && input.next_action !== null && input.next_action !== '') {
      nextAction = validateGuidedCommercialText(input.next_action, 'next_action', {
        minLength: 3,
        maxLength: 180,
        requireCommercialIntent: true,
      });
    }

    let nextActionAt = null;
    if (input.next_action_at !== undefined && input.next_action_at !== null && input.next_action_at !== '') {
      const parsedDate = new Date(input.next_action_at);
      if (Number.isNaN(parsedDate.getTime())) {
        const err = new Error('next_action_at must be a valid ISO timestamp.');
        err.statusCode = 422;
        err.code = 'VALIDATION_ERROR';
        throw err;
      }
      nextActionAt = parsedDate;
    }

    let lastInteractionAt = null;
    if (
      input.last_interaction_at !== undefined &&
      input.last_interaction_at !== null &&
      input.last_interaction_at !== ''
    ) {
      const parsedInteraction = new Date(input.last_interaction_at);
      if (Number.isNaN(parsedInteraction.getTime())) {
        const err = new Error('last_interaction_at must be a valid ISO timestamp.');
        err.statusCode = 422;
        err.code = 'VALIDATION_ERROR';
        throw err;
      }
      lastInteractionAt = parsedInteraction;
    }

    let notes = null;
    if (input.notes !== undefined && input.notes !== null && input.notes !== '') {
      notes = validateGuidedCommercialText(input.notes, 'notes', {
        minLength: 3,
        maxLength: 180,
        requireCommercialIntent: true,
      });
    }

    const normalizedSkuInput = typeof input.interested_sku === 'string' ? input.interested_sku.trim() : '';
    const normalizedAssignedOpInput =
      input.assigned_operator_id !== undefined &&
      input.assigned_operator_id !== null &&
      input.assigned_operator_id !== ''
        ? String(input.assigned_operator_id).trim()
        : null;
    const normalizedLinkedOrderInput =
      input.linked_order_id !== undefined && input.linked_order_id !== null && input.linked_order_id !== ''
        ? assertValidUuid(input.linked_order_id, 'linked_order_id')
        : null;

    // Complete idempotency hash: includes notes, observation_category, contact_basis, last_interaction_at,
    // and distinguishes omitted fields from explicit null.
    const payloadHash = computeHash([
      academyId,
      channel,
      normalizedSkuInput,
      contact.contactName,
      hasOwn(input, 'contact_handle') ? contact.contactHandle : OMITTED_SENTINEL,
      hasOwn(input, 'email') ? contact.emailNormalized : OMITTED_SENTINEL,
      hasOwn(input, 'phone') ? contact.phone : OMITTED_SENTINEL,
      hasOwn(input, 'contact_basis') ? consentInfo.contactBasis : OMITTED_SENTINEL,
      hasOwn(input, 'contact_basis_evidence') ? consentInfo.contactBasisEvidence : OMITTED_SENTINEL,
      hasOwn(input, 'outbound_contact_allowed') ? consentInfo.outboundContactAllowed : OMITTED_SENTINEL,
      hasOwn(input, 'observation_category') ? consentInfo.observationCategory : OMITTED_SENTINEL,
      hasOwn(input, 'notes') ? notes : OMITTED_SENTINEL,
      hasOwn(input, 'utm') ? [utm.source, utm.medium, utm.campaign] : OMITTED_SENTINEL,
      hasOwn(input, 'assigned_operator_id') ? normalizedAssignedOpInput : OMITTED_SENTINEL,
      hasOwn(input, 'followup_status') ? followupStatus : OMITTED_SENTINEL,
      hasOwn(input, 'last_interaction_at')
        ? lastInteractionAt
          ? lastInteractionAt.toISOString()
          : null
        : OMITTED_SENTINEL,
      hasOwn(input, 'next_action') ? nextAction : OMITTED_SENTINEL,
      hasOwn(input, 'next_action_at')
        ? nextActionAt
          ? nextActionAt.toISOString()
          : null
        : OMITTED_SENTINEL,
      hasOwn(input, 'linked_order_id') ? normalizedLinkedOrderInput : OMITTED_SENTINEL,
    ]);

    const client = await this.db.getClient();
    try {
      await client.query('BEGIN');

      // 1. Check idempotency key for this academy
      const existingRes = await client.query(
        `SELECT * FROM social_inquiries WHERE academy_id = $1 AND idempotency_key = $2`,
        [academyId, idempotencyKey]
      );

      if (existingRes.rows.length > 0) {
        const existing = existingRes.rows[0];
        if (existing.payload_hash === payloadHash) {
          await client.query('COMMIT');
          return {
            isIdempotentReplay: true,
            statusCode: 200,
            inquiry: existing,
          };
        }
        await client.query('ROLLBACK');
        const err = new Error('idempotency_key was already used with different inquiry parameters.');
        err.statusCode = 409;
        err.code = 'IDEMPOTENCY_PAYLOAD_MISMATCH';
        throw err;
      }

      // 2. Validate product SKU and assigned operator within academy_id
      const product = await this.assertValidAcademyProduct(client, academyId, input.interested_sku);
      const assignedOperator = await this.assertValidAssignedOperator(
        client,
        academyId,
        input.assigned_operator_id
      );

      // 3. Validate optional operator-confirmed order link within academy_id
      const { order: linkedOrder, resolvedStatus } = await this.verifyAndResolveOrderLink(
        client,
        academyId,
        normalizedLinkedOrderInput,
        followupStatus
      );

      const inquiryId = crypto.randomUUID();
      const now = new Date();
      const effectiveLastInteraction = lastInteractionAt || now;

      const insertRes = await client.query(
        `INSERT INTO social_inquiries (
           id, academy_id, channel, interested_sku, contact_name, contact_handle,
           email_normalized, phone, contact_basis, contact_basis_evidence,
           outbound_contact_allowed, observation_category, notes,
           utm_source, utm_medium, utm_campaign,
           assigned_operator_id, followup_status, last_interaction_at,
           next_action, next_action_at, linked_order_id, order_linked_by_operator_id, order_linked_at,
           idempotency_key, payload_hash, created_by_operator_id, updated_by_operator_id,
           created_at, updated_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6,
           $7, $8, $9, $10,
           $11, $12, $13,
           $14, $15, $16,
           $17, $18, $19,
           $20, $21, $22, $23, $24,
           $25, $26, $27, $27,
           $28, $28
         )
         RETURNING *`,
        [
          inquiryId,
          academyId,
          channel,
          product.sku,
          contact.contactName,
          contact.contactHandle,
          contact.emailNormalized,
          contact.phone,
          consentInfo.contactBasis,
          consentInfo.contactBasisEvidence,
          consentInfo.outboundContactAllowed,
          consentInfo.observationCategory,
          notes,
          utm.source,
          utm.medium,
          utm.campaign,
          assignedOperator ? assignedOperator.operator_id : null,
          resolvedStatus,
          effectiveLastInteraction,
          nextAction,
          nextActionAt,
          linkedOrder ? linkedOrder.id : null,
          linkedOrder ? session.operatorId : null,
          linkedOrder ? now : null,
          idempotencyKey,
          payloadHash,
          session.operatorId,
          now,
        ]
      );

      const eventId = crypto.randomUUID();
      const eventMetadata = {
        idempotency_key: idempotencyKey,
        action_hash: payloadHash,
        channel,
        interested_sku: product.sku,
        contact_basis: consentInfo.contactBasis,
        outbound_contact_allowed: consentInfo.outboundContactAllowed,
        observation_category: consentInfo.observationCategory,
        assigned_operator_id: assignedOperator ? assignedOperator.operator_id : null,
        linked_order_id: linkedOrder ? linkedOrder.id : null,
        linked_order_number: linkedOrder ? linkedOrder.order_number : null,
      };

      const evRes = await client.query(
        `INSERT INTO social_inquiry_events (
           id, academy_id, inquiry_id, event_type, previous_followup_status, new_followup_status,
           operator_id, notes, metadata
         ) VALUES ($1, $2, $3, $4, NULL, $5, $6, $7, $8)
         RETURNING *`,
        [
          eventId,
          academyId,
          inquiryId,
          linkedOrder ? 'inquiry_created_and_order_linked' : 'inquiry_created',
          resolvedStatus,
          session.operatorId,
          notes || `Prospecto registrado en canal ${channel}`,
          JSON.stringify(eventMetadata),
        ]
      );

      if (opts.injectFailureBeforeCommit) {
        throw new Error('INJECTED_TRANSACTION_FAILURE_BEFORE_COMMIT');
      }

      await client.query('COMMIT');

      return {
        isIdempotentReplay: false,
        statusCode: 201,
        inquiry: insertRes.rows[0],
        event: evRes.rows[0],
      };
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (_) {}

      // Fallback recovery for unique constraint race (23505) after ROLLBACK on the same client
      if (
        err.code === '23505' ||
        err.code === 23505 ||
        (err.data && err.data.code === '23505') ||
        (typeof err.message === 'string' && err.message.includes('uq_social_inquiries_academy_idempotency'))
      ) {
        const afterRollbackRes = await client.query(
          `SELECT * FROM social_inquiries WHERE academy_id = $1 AND idempotency_key = $2`,
          [academyId, idempotencyKey]
        );
        if (afterRollbackRes.rows.length > 0) {
          const existing = afterRollbackRes.rows[0];
          if (existing.payload_hash === payloadHash) {
            return {
              isIdempotentReplay: true,
              statusCode: 200,
              inquiry: existing,
            };
          }
          const conflictErr = new Error(
            'idempotency_key was already used with different inquiry parameters.'
          );
          conflictErr.statusCode = 409;
          conflictErr.code = 'IDEMPOTENCY_PAYLOAD_MISMATCH';
          throw conflictErr;
        }
      }

      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * PATCH /api/v1/admin/inquiries/:inquiry_id
   * Updates follow-up status, responsible operator, next action, or operator-confirmed order linkage.
   * Prohibits silent replacement of linked_order_id (requires explicit relink confirmation, expected_linked_order_id, and relink_reason).
   */
  async updateInquiry(session, inquiryId, input = {}, opts = {}) {
    const validInquiryId = assertValidUuid(inquiryId, 'inquiry_id');
    assertAllowedFields(input, ALLOWED_UPDATE_FIELDS);

    const idempotencyKey = assertValidUuid(input.idempotency_key, 'idempotency_key');
    const academyId = session.academyId || this.defaultAcademyId;

    if (hasOwn(input, 'followup_status')) {
      if (!ALLOWED_FOLLOWUP_STATUSES.has(input.followup_status)) {
        const err = new Error(`Invalid followup_status '${input.followup_status}'.`);
        err.statusCode = 422;
        err.code = 'VALIDATION_ERROR';
        throw err;
      }
    }

    if (hasOwn(input, 'contact_basis')) {
      if (!ALLOWED_CONTACT_BASES.has(input.contact_basis)) {
        const err = new Error(`Invalid contact_basis '${input.contact_basis}'.`);
        err.statusCode = 422;
        err.code = 'VALIDATION_ERROR';
        throw err;
      }
    }

    if (hasOwn(input, 'observation_category')) {
      if (!ALLOWED_OBSERVATION_CATEGORIES.has(input.observation_category)) {
        const err = new Error(`Invalid observation_category '${input.observation_category}'.`);
        err.statusCode = 422;
        err.code = 'VALIDATION_ERROR';
        throw err;
      }
    }

    let normalizedNextActionPatch = OMITTED_SENTINEL;
    if (hasOwn(input, 'next_action')) {
      if (input.next_action === null || input.next_action === '') {
        normalizedNextActionPatch = null;
      } else {
        normalizedNextActionPatch = validateGuidedCommercialText(input.next_action, 'next_action', {
          minLength: 3,
          maxLength: 180,
          requireCommercialIntent: true,
        });
      }
    }

    let normalizedNextActionAtPatch = OMITTED_SENTINEL;
    if (hasOwn(input, 'next_action_at')) {
      if (input.next_action_at === null || input.next_action_at === '') {
        normalizedNextActionAtPatch = null;
      } else {
        const parsed = new Date(input.next_action_at);
        if (Number.isNaN(parsed.getTime())) {
          const err = new Error('next_action_at must be a valid ISO timestamp.');
          err.statusCode = 422;
          err.code = 'VALIDATION_ERROR';
          throw err;
        }
        normalizedNextActionAtPatch = parsed.toISOString();
      }
    }

    let normalizedLastInteractionPatch = OMITTED_SENTINEL;
    if (hasOwn(input, 'last_interaction_at')) {
      if (input.last_interaction_at === null || input.last_interaction_at === '') {
        const err = new Error('last_interaction_at cannot be null.');
        err.statusCode = 422;
        err.code = 'VALIDATION_ERROR';
        throw err;
      }
      const parsedLast = new Date(input.last_interaction_at);
      if (Number.isNaN(parsedLast.getTime())) {
        const err = new Error('last_interaction_at must be a valid ISO timestamp.');
        err.statusCode = 422;
        err.code = 'VALIDATION_ERROR';
        throw err;
      }
      normalizedLastInteractionPatch = parsedLast.toISOString();
    }

    let normalizedNotesPatch = OMITTED_SENTINEL;
    if (hasOwn(input, 'notes')) {
      if (input.notes === null || input.notes === '') {
        normalizedNotesPatch = null;
      } else {
        normalizedNotesPatch = validateGuidedCommercialText(input.notes, 'notes', {
          minLength: 3,
          maxLength: 180,
          requireCommercialIntent: true,
        });
      }
    }

    let normalizedLinkedOrderPatch = OMITTED_SENTINEL;
    if (hasOwn(input, 'linked_order_id')) {
      if (input.linked_order_id === null || input.linked_order_id === '') {
        normalizedLinkedOrderPatch = null;
      } else {
        normalizedLinkedOrderPatch = assertValidUuid(input.linked_order_id, 'linked_order_id');
      }
    }

    let normalizedExpectedOrderPatch = OMITTED_SENTINEL;
    if (hasOwn(input, 'expected_linked_order_id')) {
      if (input.expected_linked_order_id === null || input.expected_linked_order_id === '') {
        normalizedExpectedOrderPatch = null;
      } else {
        normalizedExpectedOrderPatch = assertValidUuid(
          input.expected_linked_order_id,
          'expected_linked_order_id'
        );
      }
    }

    let normalizedRelinkReasonPatch = OMITTED_SENTINEL;
    if (hasOwn(input, 'relink_reason')) {
      if (input.relink_reason === null || input.relink_reason === '') {
        normalizedRelinkReasonPatch = null;
      } else {
        normalizedRelinkReasonPatch = validateGuidedCommercialText(
          input.relink_reason,
          'relink_reason',
          { minLength: 5, maxLength: 180, requireCommercialIntent: false }
        );
      }
    }

    // Complete PATCH actionHash: distinguishes omitted vs explicit null and includes last_interaction_at, notes, consent, and relink fields
    const actionHash = computeHash([
      academyId,
      validInquiryId,
      hasOwn(input, 'interested_sku')
        ? input.interested_sku === null
          ? null
          : String(input.interested_sku).trim()
        : OMITTED_SENTINEL,
      hasOwn(input, 'contact_name')
        ? input.contact_name === null
          ? null
          : String(input.contact_name).trim()
        : OMITTED_SENTINEL,
      hasOwn(input, 'contact_handle')
        ? input.contact_handle === null || input.contact_handle === ''
          ? null
          : String(input.contact_handle).trim()
        : OMITTED_SENTINEL,
      hasOwn(input, 'email')
        ? input.email === null || input.email === ''
          ? null
          : String(input.email).trim().toLowerCase()
        : OMITTED_SENTINEL,
      hasOwn(input, 'phone')
        ? input.phone === null || input.phone === ''
          ? null
          : String(input.phone).trim()
        : OMITTED_SENTINEL,
      hasOwn(input, 'contact_basis') ? input.contact_basis : OMITTED_SENTINEL,
      hasOwn(input, 'contact_basis_evidence')
        ? input.contact_basis_evidence === null || input.contact_basis_evidence === ''
          ? null
          : String(input.contact_basis_evidence).trim()
        : OMITTED_SENTINEL,
      hasOwn(input, 'outbound_contact_allowed')
        ? Boolean(input.outbound_contact_allowed)
        : OMITTED_SENTINEL,
      hasOwn(input, 'observation_category') ? input.observation_category : OMITTED_SENTINEL,
      hasOwn(input, 'assigned_operator_id')
        ? input.assigned_operator_id === null || input.assigned_operator_id === ''
          ? null
          : String(input.assigned_operator_id).trim()
        : OMITTED_SENTINEL,
      hasOwn(input, 'followup_status') ? input.followup_status : OMITTED_SENTINEL,
      normalizedLastInteractionPatch,
      normalizedNextActionPatch,
      normalizedNextActionAtPatch,
      normalizedLinkedOrderPatch,
      normalizedExpectedOrderPatch,
      hasOwn(input, 'confirm_order_relink') ? Boolean(input.confirm_order_relink) : OMITTED_SENTINEL,
      normalizedRelinkReasonPatch,
      normalizedNotesPatch,
    ]);

    const client = await this.db.getClient();
    try {
      await client.query('BEGIN');

      const inqRes = await client.query(
        `SELECT * FROM social_inquiries WHERE academy_id = $1 AND id = $2 FOR UPDATE`,
        [academyId, validInquiryId]
      );

      if (inqRes.rows.length === 0) {
        await client.query('ROLLBACK');
        const err = new Error('Social inquiry not found.');
        err.statusCode = 404;
        err.code = 'INQUIRY_NOT_FOUND';
        throw err;
      }

      const current = inqRes.rows[0];

      // Check idempotency in social_inquiry_events
      const evCheck = await client.query(
        `SELECT id, metadata FROM social_inquiry_events
         WHERE academy_id = $1 AND inquiry_id = $2
         ORDER BY created_at DESC`,
        [academyId, validInquiryId]
      );
      const matchingEv = evCheck.rows.find(
        (row) => row.metadata && row.metadata.idempotency_key === idempotencyKey
      );
      if (matchingEv) {
        if (matchingEv.metadata.action_hash === actionHash) {
          await client.query('COMMIT');
          return {
            isIdempotentReplay: true,
            statusCode: 200,
            inquiry: current,
          };
        }
        await client.query('ROLLBACK');
        const err = new Error('idempotency_key was already used with a different update payload.');
        err.statusCode = 409;
        err.code = 'IDEMPOTENCY_PAYLOAD_MISMATCH';
        throw err;
      }

      // Resolve updated fields
      let nextSku = current.interested_sku;
      if (hasOwn(input, 'interested_sku')) {
        const prod = await this.assertValidAcademyProduct(client, academyId, input.interested_sku);
        nextSku = prod.sku;
      }

      const mergedContact = this.validateContactFields(
        {
          contact_name: hasOwn(input, 'contact_name') ? input.contact_name : current.contact_name,
          email: hasOwn(input, 'email') ? input.email : current.email_normalized,
          phone: hasOwn(input, 'phone') ? input.phone : current.phone,
          contact_handle: hasOwn(input, 'contact_handle') ? input.contact_handle : current.contact_handle,
        },
        { requireAtLeastOneContact: true }
      );

      let nextAssignedOp = current.assigned_operator_id;
      if (hasOwn(input, 'assigned_operator_id')) {
        if (input.assigned_operator_id === null || input.assigned_operator_id === '') {
          nextAssignedOp = null;
        } else {
          const op = await this.assertValidAssignedOperator(client, academyId, input.assigned_operator_id);
          nextAssignedOp = op.operator_id;
        }
      }

      // P1 Protection: Prevent silent overwrite or removal of an existing linked_order_id
      let targetLinkedOrderId = current.linked_order_id;
      let isRelinkedOrder = false;
      let previousLinkedOrderRow = null;

      if (hasOwn(input, 'linked_order_id')) {
        if (current.linked_order_id) {
          if (normalizedLinkedOrderPatch === null) {
            await client.query('ROLLBACK');
            const err = new Error(
              `Inquiry is already linked to order '${current.linked_order_id}'. Unlinking is not permitted.`
            );
            err.statusCode = 409;
            err.code = 'ORDER_ALREADY_LINKED';
            throw err;
          }

          if (normalizedLinkedOrderPatch !== current.linked_order_id) {
            if (input.confirm_order_relink !== true) {
              await client.query('ROLLBACK');
              const err = new Error(
                `Inquiry is already linked to order '${current.linked_order_id}'. Silent replacement of linked_order_id is prohibited.`
              );
              err.statusCode = 409;
              err.code = 'ORDER_ALREADY_LINKED';
              throw err;
            }

            if (
              normalizedExpectedOrderPatch === OMITTED_SENTINEL ||
              normalizedExpectedOrderPatch !== current.linked_order_id
            ) {
              await client.query('ROLLBACK');
              const err = new Error(
                `Explicit order relink requires expected_linked_order_id matching '${current.linked_order_id}'.`
              );
              err.statusCode = 409;
              err.code = 'EXPECTED_LINKED_ORDER_MISMATCH';
              throw err;
            }

            if (normalizedRelinkReasonPatch === OMITTED_SENTINEL || !normalizedRelinkReasonPatch) {
              await client.query('ROLLBACK');
              const err = new Error(
                'Explicit order relink requires relink_reason (5-180 characters).'
              );
              err.statusCode = 422;
              err.code = 'RELINK_REASON_REQUIRED';
              throw err;
            }

            const prevOrdRes = await client.query(
              `SELECT id, order_number, status FROM orders WHERE academy_id = $1 AND id = $2`,
              [academyId, current.linked_order_id]
            );
            previousLinkedOrderRow = prevOrdRes.rows[0] || { id: current.linked_order_id };
            targetLinkedOrderId = normalizedLinkedOrderPatch;
            isRelinkedOrder = true;
          }
        } else {
          targetLinkedOrderId = normalizedLinkedOrderPatch;
        }
      }

      const targetFollowupStatus = hasOwn(input, 'followup_status')
        ? input.followup_status
        : current.followup_status;

      const { order: linkedOrder, resolvedStatus } = await this.verifyAndResolveOrderLink(
        client,
        academyId,
        targetLinkedOrderId,
        targetFollowupStatus
      );

      const mergedConsent = this.resolveContactConsentAndCategory({
        contactBasis: hasOwn(input, 'contact_basis') ? input.contact_basis : current.contact_basis,
        contactBasisEvidence: hasOwn(input, 'contact_basis_evidence')
          ? input.contact_basis_evidence
          : current.contact_basis_evidence,
        outboundContactAllowed: hasOwn(input, 'outbound_contact_allowed')
          ? input.outbound_contact_allowed
          : current.outbound_contact_allowed,
        observationCategory: hasOwn(input, 'observation_category')
          ? input.observation_category
          : current.observation_category,
        followupStatus: resolvedStatus,
      });

      const isNewlyLinkedOrder =
        Boolean(linkedOrder) && !current.linked_order_id;

      const nextActionVal =
        normalizedNextActionPatch !== OMITTED_SENTINEL ? normalizedNextActionPatch : current.next_action;

      const nextActionAtVal =
        normalizedNextActionAtPatch !== OMITTED_SENTINEL
          ? normalizedNextActionAtPatch
            ? new Date(normalizedNextActionAtPatch)
            : null
          : current.next_action_at;

      const notesVal =
        normalizedNotesPatch !== OMITTED_SENTINEL ? normalizedNotesPatch : current.notes;

      const now = new Date();
      const lastInteractionVal =
        normalizedLastInteractionPatch !== OMITTED_SENTINEL
          ? new Date(normalizedLastInteractionPatch)
          : now;

      const updRes = await client.query(
        `UPDATE social_inquiries
         SET interested_sku = $1,
             contact_name = $2,
             contact_handle = $3,
             email_normalized = $4,
             phone = $5,
             contact_basis = $6,
             contact_basis_evidence = $7,
             outbound_contact_allowed = $8,
             observation_category = $9,
             notes = $10,
             assigned_operator_id = $11,
             followup_status = $12,
             last_interaction_at = $13,
             next_action = $14,
             next_action_at = $15,
             linked_order_id = $16,
             order_linked_by_operator_id = $17,
             order_linked_at = $18,
             updated_by_operator_id = $19,
             updated_at = $20
         WHERE academy_id = $21 AND id = $22
         RETURNING *`,
        [
          nextSku,
          mergedContact.contactName,
          mergedContact.contactHandle,
          mergedContact.emailNormalized,
          mergedContact.phone,
          mergedConsent.contactBasis,
          mergedConsent.contactBasisEvidence,
          mergedConsent.outboundContactAllowed,
          mergedConsent.observationCategory,
          notesVal,
          nextAssignedOp,
          resolvedStatus,
          lastInteractionVal,
          nextActionVal,
          nextActionAtVal,
          linkedOrder ? linkedOrder.id : null,
          isNewlyLinkedOrder || isRelinkedOrder ? session.operatorId : current.order_linked_by_operator_id,
          isNewlyLinkedOrder || isRelinkedOrder ? now : current.order_linked_at,
          session.operatorId,
          now,
          academyId,
          validInquiryId,
        ]
      );

      const eventType = isRelinkedOrder
        ? 'order_relinked'
        : isNewlyLinkedOrder
          ? 'order_linked'
          : 'followup_updated';

      const eventMetadata = {
        idempotency_key: idempotencyKey,
        action_hash: actionHash,
        assigned_operator_id: nextAssignedOp,
        contact_basis: mergedConsent.contactBasis,
        outbound_contact_allowed: mergedConsent.outboundContactAllowed,
        observation_category: mergedConsent.observationCategory,
        next_action: nextActionVal,
        linked_order_id: linkedOrder ? linkedOrder.id : null,
        linked_order_number: linkedOrder ? linkedOrder.order_number : null,
        ...(isRelinkedOrder
          ? {
              previous_linked_order_id: current.linked_order_id,
              previous_linked_order_number: previousLinkedOrderRow?.order_number || null,
              new_linked_order_id: linkedOrder.id,
              new_linked_order_number: linkedOrder.order_number,
              expected_linked_order_id: current.linked_order_id,
              relink_reason: normalizedRelinkReasonPatch,
              operator_role: session.role,
            }
          : {}),
      };

      const evRes = await client.query(
        `INSERT INTO social_inquiry_events (
           id, academy_id, inquiry_id, event_type, previous_followup_status, new_followup_status,
           operator_id, notes, metadata
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
        [
          crypto.randomUUID(),
          academyId,
          validInquiryId,
          eventType,
          current.followup_status,
          resolvedStatus,
          session.operatorId,
          isRelinkedOrder
            ? normalizedRelinkReasonPatch
            : normalizedNotesPatch !== OMITTED_SENTINEL
              ? normalizedNotesPatch
              : null,
          JSON.stringify(eventMetadata),
        ]
      );

      if (opts.injectFailureBeforeCommit) {
        throw new Error('INJECTED_TRANSACTION_FAILURE_BEFORE_COMMIT');
      }

      await client.query('COMMIT');

      return {
        isIdempotentReplay: false,
        statusCode: 200,
        inquiry: updRes.rows[0],
        event: evRes.rows[0],
      };
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (_) {}
      throw err;
    } finally {
      client.release();
    }
  }
}
