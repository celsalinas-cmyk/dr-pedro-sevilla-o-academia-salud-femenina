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
]);

const ALLOWED_CREATE_FIELDS = new Set([
  'channel',
  'interested_sku',
  'contact_name',
  'contact_handle',
  'email',
  'phone',
  'utm',
  'assigned_operator_id',
  'followup_status',
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
  'assigned_operator_id',
  'followup_status',
  'last_interaction_at',
  'next_action',
  'next_action_at',
  'linked_order_id',
  'notes',
  'idempotency_key',
]);

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NAME_REGEX = /^[a-zA-ZáéíóúÁÉÍÓÚñÑüÜ\s'-]+$/;
const EMAIL_REGEX = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
const PHONE_REGEX = /^\+?[0-9\s-]{6,25}$/;
const HANDLE_REGEX = /^@?[a-zA-Z0-9._-]{2,64}$/;
const UTM_REGEX = /^[a-zA-Z0-9_-]{1,100}$/;

// Privacy Guardrail: Prohibit clinical, diagnostic, or medical history content in the Mini CRM
const PROHIBITED_CLINICAL_REGEX =
  /\b(diagn[oó]stico|s[ií]ntoma|s[ií]ntomas|receta m[eé]dica|historia cl[ií]nica|historial m[eé]dico|tratamiento m[eé]dico|medicaci[oó]n|biopsia|ecograf[ií]a|laboratorio cl[ií]nico|paciente con)\b/i;

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
  if (typeof text === 'string' && PROHIBITED_CLINICAL_REGEX.test(text)) {
    const err = new Error(
      `Field '${fieldName}' contains prohibited clinical or diagnostic terminology. The Mini CRM is strictly restricted to commercial and educational follow-up.`
    );
    err.statusCode = 422;
    err.code = 'CLINICAL_DATA_PROHIBITED';
    throw err;
  }
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
   * Lists social inquiries scoped strictly by session.academyId with optional filters.
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
       ORDER BY si.created_at DESC`,
      params
    );

    const inquiries = [];
    for (const row of res.rows) {
      let suggestedOrderMatch = null;
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
          `SELECT o.id AS order_id, o.order_number, o.status, o.total_amount_minor, o.currency, oi.sku
           FROM orders o
           JOIN leads l ON l.academy_id = o.academy_id AND l.id = o.lead_id
           JOIN order_items oi ON oi.academy_id = o.academy_id AND oi.order_id = o.id
           WHERE o.academy_id = $1 AND (${matchConds.join(' OR ')})
           ORDER BY o.created_at DESC
           LIMIT 1`,
          matchParams
        );
        if (sugRes.rows.length > 0) {
          suggestedOrderMatch = sugRes.rows[0];
        }
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
   * Registers a new omnichannel social inquiry with strict validation, privacy guardrails, and idempotency.
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

    const utm = this.validateUtm(input.utm);

    let nextAction = null;
    if (input.next_action !== undefined && input.next_action !== null && input.next_action !== '') {
      if (typeof input.next_action !== 'string' || input.next_action.trim().length < 3 || input.next_action.trim().length > 255) {
        const err = new Error('next_action must be between 3 and 255 characters.');
        err.statusCode = 422;
        err.code = 'VALIDATION_ERROR';
        throw err;
      }
      assertNoClinicalContent(input.next_action, 'next_action');
      nextAction = input.next_action.trim();
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

    let notes = null;
    if (input.notes !== undefined && input.notes !== null && input.notes !== '') {
      if (typeof input.notes !== 'string' || input.notes.trim().length > 500) {
        const err = new Error('notes must not exceed 500 characters.');
        err.statusCode = 422;
        err.code = 'VALIDATION_ERROR';
        throw err;
      }
      assertNoClinicalContent(input.notes, 'notes');
      notes = input.notes.trim();
    }

    const payloadHash = computeHash([
      academyId,
      channel,
      String(input.interested_sku || '').trim(),
      contact.contactName,
      contact.contactHandle,
      contact.emailNormalized,
      contact.phone,
      utm.source,
      utm.medium,
      utm.campaign,
      input.assigned_operator_id || null,
      followupStatus,
      nextAction,
      nextActionAt ? nextActionAt.toISOString() : null,
      input.linked_order_id || null,
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
        input.linked_order_id,
        followupStatus
      );

      const inquiryId = crypto.randomUUID();
      const now = new Date();

      const insertRes = await client.query(
        `INSERT INTO social_inquiries (
           id, academy_id, channel, interested_sku, contact_name, contact_handle,
           email_normalized, phone, utm_source, utm_medium, utm_campaign,
           assigned_operator_id, followup_status, last_interaction_at,
           next_action, next_action_at, linked_order_id, order_linked_by_operator_id, order_linked_at,
           idempotency_key, payload_hash, created_by_operator_id, updated_by_operator_id,
           created_at, updated_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6,
           $7, $8, $9, $10, $11,
           $12, $13, $14,
           $15, $16, $17, $18, $19,
           $20, $21, $22, $22,
           $14, $14
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
          utm.source,
          utm.medium,
          utm.campaign,
          assignedOperator ? assignedOperator.operator_id : null,
          resolvedStatus,
          now,
          nextAction,
          nextActionAt,
          linkedOrder ? linkedOrder.id : null,
          linkedOrder ? session.operatorId : null,
          linkedOrder ? now : null,
          idempotencyKey,
          payloadHash,
          session.operatorId,
        ]
      );

      const eventId = crypto.randomUUID();
      const eventMetadata = {
        idempotency_key: idempotencyKey,
        action_hash: payloadHash,
        channel,
        interested_sku: product.sku,
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
          notes || `Prospect registered from ${channel}`,
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
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * PATCH /api/v1/admin/inquiries/:inquiry_id
   * Updates follow-up status, responsible operator, next action, or operator-confirmed order linkage.
   */
  async updateInquiry(session, inquiryId, input = {}, opts = {}) {
    const validInquiryId = assertValidUuid(inquiryId, 'inquiry_id');
    assertAllowedFields(input, ALLOWED_UPDATE_FIELDS);

    const idempotencyKey = assertValidUuid(input.idempotency_key, 'idempotency_key');
    const academyId = session.academyId || this.defaultAcademyId;

    if (input.followup_status !== undefined) {
      if (!ALLOWED_FOLLOWUP_STATUSES.has(input.followup_status)) {
        const err = new Error(`Invalid followup_status '${input.followup_status}'.`);
        err.statusCode = 422;
        err.code = 'VALIDATION_ERROR';
        throw err;
      }
    }

    if (input.next_action !== undefined && input.next_action !== null && input.next_action !== '') {
      if (typeof input.next_action !== 'string' || input.next_action.trim().length < 3 || input.next_action.trim().length > 255) {
        const err = new Error('next_action must be between 3 and 255 characters.');
        err.statusCode = 422;
        err.code = 'VALIDATION_ERROR';
        throw err;
      }
      assertNoClinicalContent(input.next_action, 'next_action');
    }

    if (input.notes !== undefined && input.notes !== null && input.notes !== '') {
      if (typeof input.notes !== 'string' || input.notes.trim().length > 500) {
        const err = new Error('notes must not exceed 500 characters.');
        err.statusCode = 422;
        err.code = 'VALIDATION_ERROR';
        throw err;
      }
      assertNoClinicalContent(input.notes, 'notes');
    }

    const actionHash = computeHash([
      academyId,
      validInquiryId,
      input.interested_sku ?? null,
      input.contact_name ?? null,
      input.contact_handle ?? null,
      input.email ?? null,
      input.phone ?? null,
      input.assigned_operator_id ?? null,
      input.followup_status ?? null,
      input.next_action ?? null,
      input.next_action_at ?? null,
      input.linked_order_id ?? null,
      input.notes ?? null,
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
      if (input.interested_sku !== undefined) {
        const prod = await this.assertValidAcademyProduct(client, academyId, input.interested_sku);
        nextSku = prod.sku;
      }

      const mergedContact = this.validateContactFields(
        {
          contact_name: input.contact_name !== undefined ? input.contact_name : current.contact_name,
          email: input.email !== undefined ? input.email : current.email_normalized,
          phone: input.phone !== undefined ? input.phone : current.phone,
          contact_handle: input.contact_handle !== undefined ? input.contact_handle : current.contact_handle,
        },
        { requireAtLeastOneContact: true }
      );

      let nextAssignedOp = current.assigned_operator_id;
      if (input.assigned_operator_id !== undefined) {
        if (input.assigned_operator_id === null || input.assigned_operator_id === '') {
          nextAssignedOp = null;
        } else {
          const op = await this.assertValidAssignedOperator(client, academyId, input.assigned_operator_id);
          nextAssignedOp = op.operator_id;
        }
      }

      const targetFollowupStatus =
        input.followup_status !== undefined ? input.followup_status : current.followup_status;
      const targetLinkedOrderId =
        input.linked_order_id !== undefined ? input.linked_order_id : current.linked_order_id;

      const { order: linkedOrder, resolvedStatus } = await this.verifyAndResolveOrderLink(
        client,
        academyId,
        targetLinkedOrderId,
        targetFollowupStatus
      );

      const isNewlyLinkedOrder =
        Boolean(linkedOrder) && current.linked_order_id !== linkedOrder.id;

      const nextActionVal =
        input.next_action !== undefined
          ? input.next_action === null || input.next_action === ''
            ? null
            : input.next_action.trim()
          : current.next_action;

      let nextActionAtVal = current.next_action_at;
      if (input.next_action_at !== undefined) {
        if (input.next_action_at === null || input.next_action_at === '') {
          nextActionAtVal = null;
        } else {
          const parsed = new Date(input.next_action_at);
          if (Number.isNaN(parsed.getTime())) {
            const err = new Error('next_action_at must be a valid ISO timestamp.');
            err.statusCode = 422;
            err.code = 'VALIDATION_ERROR';
            throw err;
          }
          nextActionAtVal = parsed;
        }
      }

      const now = new Date();
      const lastInteractionVal = input.last_interaction_at ? new Date(input.last_interaction_at) : now;

      const updRes = await client.query(
        `UPDATE social_inquiries
         SET interested_sku = $1,
             contact_name = $2,
             contact_handle = $3,
             email_normalized = $4,
             phone = $5,
             assigned_operator_id = $6,
             followup_status = $7,
             last_interaction_at = $8,
             next_action = $9,
             next_action_at = $10,
             linked_order_id = $11,
             order_linked_by_operator_id = $12,
             order_linked_at = $13,
             updated_by_operator_id = $14,
             updated_at = $15
         WHERE academy_id = $16 AND id = $17
         RETURNING *`,
        [
          nextSku,
          mergedContact.contactName,
          mergedContact.contactHandle,
          mergedContact.emailNormalized,
          mergedContact.phone,
          nextAssignedOp,
          resolvedStatus,
          lastInteractionVal,
          nextActionVal,
          nextActionAtVal,
          linkedOrder ? linkedOrder.id : null,
          isNewlyLinkedOrder ? session.operatorId : current.order_linked_by_operator_id,
          isNewlyLinkedOrder ? now : current.order_linked_at,
          session.operatorId,
          now,
          academyId,
          validInquiryId,
        ]
      );

      const eventType = isNewlyLinkedOrder ? 'order_linked' : 'followup_updated';
      const eventMetadata = {
        idempotency_key: idempotencyKey,
        action_hash: actionHash,
        assigned_operator_id: nextAssignedOp,
        next_action: nextActionVal,
        linked_order_id: linkedOrder ? linkedOrder.id : null,
        linked_order_number: linkedOrder ? linkedOrder.order_number : null,
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
          input.notes ? input.notes.trim() : null,
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
