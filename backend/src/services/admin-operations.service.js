import crypto from 'crypto';

/**
 * Provisional functional Moodle course identifiers per SKU.
 * Explicitly provisional until verified and commercially ratified in Gate 2-A3-A3.
 */
export const PROVISIONAL_SKU_MOODLE_COURSES = Object.freeze({
  'endometriosis': Object.freeze(['endometriosis']),
  'vaginosis': Object.freeze(['vaginosis']),
  'sop': Object.freeze(['sop']),
  'aprende-mujer': Object.freeze(['aprende-mujer']),
  'mujer-informada-4': Object.freeze(['endometriosis', 'vaginosis', 'sop', 'aprende-mujer']),
});

export const PROVISIONAL_COMMERCIAL_TERMS = Object.freeze({
  provisional_access_days: 180,
  moodle_ids_status: 'provisional_functional_identifiers_pending_ratification',
  access_duration_status: 'provisional_parameter_pending_commercial_ratification',
});

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertValidUuid(value, fieldName) {
  if (!value || typeof value !== 'string' || !UUID_REGEX.test(value.trim())) {
    const err = new Error(`${fieldName} must be a valid UUID.`);
    err.statusCode = 422;
    err.code = 'VALIDATION_ERROR';
    throw err;
  }
  return value.trim();
}

function computeActionHash(actionType, canonicalParts) {
  return crypto
    .createHash('sha256')
    .update([actionType, ...canonicalParts.map((v) => String(v ?? ''))].join('|'))
    .digest('hex');
}

export class AdminOperationsService {
  constructor(database, defaultAcademyId = 'dr-sevilla') {
    this.db = database;
    this.defaultAcademyId = defaultAcademyId;
  }

  /**
   * Checks if an administrative mutation with the same idempotency_key was already applied on this order.
   */
  async checkActionIdempotency(client, academyId, orderId, idempotencyKey, actionType, actionHash) {
    const existingRes = await client.query(
      `SELECT id, previous_status, new_status, reason, operator_id, metadata, created_at
       FROM order_events
       WHERE academy_id = $1 AND order_id = $2
       ORDER BY created_at ASC`,
      [academyId, orderId]
    );

    const matchingEvent = existingRes.rows.find(
      (row) => row.metadata && row.metadata.idempotency_key === idempotencyKey
    );

    if (!matchingEvent) {
      return null;
    }

    if (
      matchingEvent.metadata.action_type !== actionType ||
      matchingEvent.metadata.action_hash !== actionHash
    ) {
      const err = new Error('The idempotency_key was already used with different administrative parameters.');
      err.statusCode = 409;
      err.code = 'ADMIN_IDEMPOTENCY_CONFLICT';
      throw err;
    }

    const orderRes = await client.query(
      `SELECT o.id, o.academy_id, o.order_number, o.status, o.total_amount_minor, o.currency,
              o.created_at, o.expires_at, oi.sku
       FROM orders o
       JOIN order_items oi ON oi.academy_id = o.academy_id AND oi.order_id = o.id
       WHERE o.academy_id = $1 AND o.id = $2`,
      [academyId, orderId]
    );

    const recRes = await client.query(
      `SELECT * FROM payment_reconciliations
       WHERE academy_id = $1 AND order_id = $2
       ORDER BY CASE WHEN settlement_status = 'applied' THEN 0 ELSE 1 END, updated_at DESC, created_at DESC
       LIMIT 1`,
      [academyId, orderId]
    );

    return {
      isIdempotentReplay: true,
      statusCode: 200,
      order: orderRes.rows[0],
      event: matchingEvent,
      reconciliation: recRes.rows[0] || null,
    };
  }

  /**
   * Locks an order row FOR UPDATE and returns order + SKU + lead info.
   */
  async lockOrderForUpdate(client, academyId, orderId) {
    assertValidUuid(orderId, 'order_id');

    const orderRes = await client.query(
      `SELECT o.id, o.academy_id, o.order_number, o.status, o.total_amount_minor, o.currency,
              o.created_at, o.expires_at, o.lead_id
       FROM orders o
       WHERE o.academy_id = $1 AND o.id = $2
       FOR UPDATE`,
      [academyId, orderId]
    );

    if (orderRes.rows.length === 0) {
      const err = new Error('Order not found.');
      err.statusCode = 404;
      err.code = 'ORDER_NOT_FOUND';
      throw err;
    }

    const order = orderRes.rows[0];
    const itemRes = await client.query(
      `SELECT oi.sku, p.title AS product_title
       FROM order_items oi
       JOIN products p ON p.academy_id = oi.academy_id AND p.sku = oi.sku
       WHERE oi.academy_id = $1 AND oi.order_id = $2`,
      [academyId, orderId]
    );

    const leadRes = await client.query(
      `SELECT name, email_normalized, phone
       FROM leads
       WHERE academy_id = $1 AND id = $2`,
      [academyId, order.lead_id]
    );

    return {
      ...order,
      sku: itemRes.rows[0]?.sku || null,
      product_title: itemRes.rows[0]?.product_title || null,
      lead_name: leadRes.rows[0]?.name || null,
      lead_email: leadRes.rows[0]?.email_normalized || null,
      lead_phone: leadRes.rows[0]?.phone || null,
    };
  }

  /**
   * Lists orders for the authenticated operator's academy with optional status filter.
   */
  async listOrders(session, query = {}) {
    const academyId = session.academyId || this.defaultAcademyId;
    const params = [academyId];
    let statusClause = '';

    if (query && typeof query.status === 'string' && query.status.trim() !== '') {
      params.push(query.status.trim());
      statusClause = `AND o.status = $2`;
    }

    // Lazily expire overdue pending_payment orders in a transaction first
    const now = new Date();
    const overdueRes = await this.db.query(
      `SELECT id FROM orders WHERE academy_id = $1 AND status = 'pending_payment' AND expires_at < $2`,
      [academyId, now]
    );

    for (const row of overdueRes.rows) {
      const client = await this.db.getClient();
      try {
        await client.query('BEGIN');
        const upd = await client.query(
          `UPDATE orders SET status = 'expired'
           WHERE academy_id = $1 AND id = $2 AND status = 'pending_payment'
           RETURNING id`,
          [academyId, row.id]
        );
        if (upd.rows.length > 0) {
          await client.query(
            `INSERT INTO order_events (id, academy_id, order_id, previous_status, new_status, reason)
             VALUES ($1, $2, $3, 'pending_payment', 'expired', 'Order payment window elapsed (72h)')`,
            [crypto.randomUUID(), academyId, row.id]
          );
        }
        await client.query('COMMIT');
      } catch (_) {
        try {
          await client.query('ROLLBACK');
        } catch (__) {}
      } finally {
        client.release();
      }
    }

    const res = await this.db.query(
      `SELECT o.id, o.academy_id, o.order_number, o.status, o.total_amount_minor, o.currency,
              o.created_at, o.expires_at,
              oi.sku, p.title AS product_title,
              l.name AS lead_name, l.email_normalized AS lead_email, l.phone AS lead_phone
       FROM orders o
       JOIN order_items oi ON oi.academy_id = o.academy_id AND oi.order_id = o.id
       JOIN products p ON p.academy_id = oi.academy_id AND p.sku = oi.sku
       JOIN leads l ON l.academy_id = o.academy_id AND l.id = o.lead_id
       WHERE o.academy_id = $1 ${statusClause}
       ORDER BY o.created_at DESC`,
      params
    );

    return {
      academy_id: academyId,
      provisional_commercial_terms: PROVISIONAL_COMMERCIAL_TERMS,
      orders: res.rows.map((row) => ({
        ...row,
        provisional_moodle_courses: PROVISIONAL_SKU_MOODLE_COURSES[row.sku] || [],
        provisional_access_days: PROVISIONAL_COMMERCIAL_TERMS.provisional_access_days,
      })),
    };
  }

  /**
   * Retrieves complete administrative detail of a single order, its reconciliations, and append-only events.
   */
  async getOrderDetail(session, orderId) {
    assertValidUuid(orderId, 'order_id');
    const academyId = session.academyId || this.defaultAcademyId;

    const orderRes = await this.db.query(
      `SELECT o.id, o.academy_id, o.order_number, o.status, o.total_amount_minor, o.currency,
              o.created_at, o.expires_at,
              oi.sku, p.title AS product_title,
              l.name AS lead_name, l.email_normalized AS lead_email, l.phone AS lead_phone
       FROM orders o
       JOIN order_items oi ON oi.academy_id = o.academy_id AND oi.order_id = o.id
       JOIN products p ON p.academy_id = oi.academy_id AND p.sku = oi.sku
       JOIN leads l ON l.academy_id = o.academy_id AND l.id = o.lead_id
       WHERE o.academy_id = $1 AND o.id = $2`,
      [academyId, orderId]
    );

    if (orderRes.rows.length === 0) {
      const err = new Error('Order not found.');
      err.statusCode = 404;
      err.code = 'ORDER_NOT_FOUND';
      throw err;
    }

    const order = orderRes.rows[0];
    if (order.status === 'pending_payment' && new Date(order.expires_at) < new Date()) {
      const client = await this.db.getClient();
      try {
        await client.query('BEGIN');
        const upd = await client.query(
          `UPDATE orders SET status = 'expired'
           WHERE academy_id = $1 AND id = $2 AND status = 'pending_payment'
           RETURNING id`,
          [academyId, order.id]
        );
        if (upd.rows.length > 0) {
          await client.query(
            `INSERT INTO order_events (id, academy_id, order_id, previous_status, new_status, reason)
             VALUES ($1, $2, $3, 'pending_payment', 'expired', 'Order payment window elapsed (72h)')`,
            [crypto.randomUUID(), academyId, order.id]
          );
          order.status = 'expired';
        }
        await client.query('COMMIT');
      } catch (_) {
        try {
          await client.query('ROLLBACK');
        } catch (__) {}
      } finally {
        client.release();
      }
    }

    const reconciliationsRes = await this.db.query(
      `SELECT *
       FROM payment_reconciliations
       WHERE academy_id = $1 AND (order_id = $2 OR reallocated_from_order_id = $2)
       ORDER BY created_at ASC`,
      [academyId, orderId]
    );

    const eventsRes = await this.db.query(
      `SELECT id, academy_id, order_id, previous_status, new_status, reason, operator_id, metadata, created_at
       FROM order_events
       WHERE academy_id = $1 AND order_id = $2
       ORDER BY created_at ASC`,
      [academyId, orderId]
    );

    return {
      order: {
        ...order,
        provisional_moodle_courses: PROVISIONAL_SKU_MOODLE_COURSES[order.sku] || [],
        provisional_access_days: PROVISIONAL_COMMERCIAL_TERMS.provisional_access_days,
        provisional_commercial_terms: PROVISIONAL_COMMERCIAL_TERMS,
      },
      reconciliations: reconciliationsRes.rows,
      events: eventsRes.rows,
    };
  }

  /**
   * T-01: Records manual QR coordination or buyer receipt report WITHOUT verifying payment.
   */
  async recordCoordinationEvent(session, orderId, input = {}, opts = {}) {
    const validEventTypes = new Set(['qr_sent', 'receipt_received', 'payment_discrepancy']);
    if (!input || !validEventTypes.has(input.event_type)) {
      const err = new Error("event_type must be one of: 'qr_sent', 'receipt_received', 'payment_discrepancy'.");
      err.statusCode = 422;
      err.code = 'VALIDATION_ERROR';
      throw err;
    }

    const channel = typeof input.channel === 'string' ? input.channel.trim() : '';
    const notes = typeof input.notes === 'string' ? input.notes.trim() : '';
    const externalReference =
      typeof input.external_reference === 'string' && input.external_reference.trim() !== ''
        ? input.external_reference.trim()
        : null;
    const idempotencyKey = assertValidUuid(input.idempotency_key, 'idempotency_key');

    if (!channel || channel.length > 64) {
      const err = new Error('channel is required and must not exceed 64 characters.');
      err.statusCode = 422;
      err.code = 'VALIDATION_ERROR';
      throw err;
    }

    if (notes.length < 5 || notes.length > 1000) {
      const err = new Error('notes must be between 5 and 1000 characters.');
      err.statusCode = 422;
      err.code = 'VALIDATION_ERROR';
      throw err;
    }

    const academyId = session.academyId || this.defaultAcademyId;
    const actionHash = computeActionHash(input.event_type, [orderId, channel, externalReference, notes]);

    const client = await this.db.getClient();
    try {
      await client.query('BEGIN');

      const order = await this.lockOrderForUpdate(client, academyId, orderId);

      const replay = await this.checkActionIdempotency(
        client,
        academyId,
        orderId,
        idempotencyKey,
        input.event_type,
        actionHash
      );
      if (replay) {
        await client.query('COMMIT');
        return replay;
      }

      if (order.status !== 'pending_payment') {
        await client.query('ROLLBACK');
        const err = new Error(`Coordination events can only be recorded while order is in 'pending_payment' (current: '${order.status}').`);
        err.statusCode = 409;
        err.code = 'INVALID_ORDER_STATE_FOR_COORDINATION';
        throw err;
      }

      const eventId = crypto.randomUUID();
      const metadata = {
        idempotency_key: idempotencyKey,
        action_type: input.event_type,
        action_hash: actionHash,
        event_type: input.event_type,
        channel,
        external_reference: externalReference,
        operator_role: session.role,
        payment_verified: false,
      };

      const evRes = await client.query(
        `INSERT INTO order_events (
           id, academy_id, order_id, previous_status, new_status, reason, operator_id, metadata
         ) VALUES ($1, $2, $3, 'pending_payment', 'pending_payment', $4, $5, $6)
         RETURNING id, academy_id, order_id, previous_status, new_status, reason, operator_id, metadata, created_at`,
        [eventId, academyId, orderId, notes, session.operatorId, JSON.stringify(metadata)]
      );

      if (opts.injectFailureBeforeCommit) {
        throw new Error('INJECTED_TRANSACTION_FAILURE_BEFORE_COMMIT');
      }

      await client.query('COMMIT');

      return {
        isIdempotentReplay: false,
        statusCode: 201,
        order: {
          id: order.id,
          order_number: order.order_number,
          status: 'pending_payment',
          sku: order.sku,
          total_amount_minor: order.total_amount_minor,
          currency: order.currency,
        },
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
   * Validates bank verification payload fields shared by verify-payment and verify-late-payment.
   */
  validateBankVerificationInput(session, order, input) {
    if (!input || typeof input !== 'object') {
      const err = new Error('Verification payload must be a JSON object.');
      err.statusCode = 422;
      err.code = 'VALIDATION_ERROR';
      throw err;
    }

    const mode = input.reconciliation_mode;
    if (mode !== 'standard_reference' && mode !== 'manual_resolution') {
      const err = new Error("reconciliation_mode must be 'standard_reference' or 'manual_resolution'.");
      err.statusCode = 422;
      err.code = 'VALIDATION_ERROR';
      throw err;
    }

    if (mode === 'manual_resolution' && session.role !== 'academy_admin') {
      const err = new Error('Ambiguous or reference-less bank reconciliations require academy_admin resolution.');
      err.statusCode = 403;
      err.code = 'MANUAL_RESOLUTION_REQUIRES_ADMIN';
      throw err;
    }

    const recipientAccountId =
      typeof input.recipient_account_id === 'string' ? input.recipient_account_id.trim() : '';
    if (
      input.recipient_account_verified !== true ||
      !recipientAccountId ||
      recipientAccountId.length > 64 ||
      input.effective_transaction_verified !== true
    ) {
      const err = new Error(
        'Official recipient account and effective bank transaction must be explicitly verified.'
      );
      err.statusCode = 422;
      err.code = 'RECIPIENT_OR_TRANSACTION_UNVERIFIED';
      throw err;
    }

    const creditAt = input.bank_credit_at ? new Date(input.bank_credit_at) : null;
    if (!creditAt || Number.isNaN(creditAt.getTime())) {
      const err = new Error('A valid bank_credit_at timestamp is required.');
      err.statusCode = 422;
      err.code = 'RECIPIENT_OR_TRANSACTION_UNVERIFIED';
      throw err;
    }

    if (
      input.verified_amount_minor !== order.total_amount_minor ||
      input.verified_currency !== order.currency
    ) {
      const err = new Error(
        `Verified amount/currency (${input.verified_amount_minor} ${input.verified_currency}) does not match order total (${order.total_amount_minor} ${order.currency}).`
      );
      err.statusCode = 422;
      err.code = 'AMOUNT_OR_CURRENCY_MISMATCH';
      throw err;
    }

    const rawBankRef =
      typeof input.bank_reference === 'string' && input.bank_reference.trim() !== ''
        ? input.bank_reference.trim()
        : null;

    if (mode === 'standard_reference') {
      if (!rawBankRef || rawBankRef.length < 6 || rawBankRef.length > 64) {
        const err = new Error('bank_reference (6-64 characters) is required for standard_reference mode.');
        err.statusCode = 422;
        err.code = 'BANK_REFERENCE_REQUIRED';
        throw err;
      }
    }

    const evidence =
      typeof input.reconciliation_evidence === 'string' ? input.reconciliation_evidence.trim() : '';
    const minEvidenceLen = mode === 'manual_resolution' ? 20 : 10;
    if (evidence.length < minEvidenceLen) {
      const err = new Error(
        `reconciliation_evidence must contain at least ${minEvidenceLen} characters documenting the verified bank statement entry.`
      );
      err.statusCode = 422;
      err.code = 'INSUFFICIENT_RECONCILIATION_EVIDENCE';
      throw err;
    }

    return {
      reconciliationMode: mode,
      recipientAccountId,
      bankReference: rawBankRef,
      reconciliationEvidence: evidence,
      bankCreditAt: creditAt,
      verifiedAmountMinor: input.verified_amount_minor,
      verifiedCurrency: input.verified_currency,
    };
  }

  /**
   * Checks that a bank_reference has NEVER been used in payment_reconciliations in ANY state
   * ('applied', 'reversed_mistaken_match', or 'refunded_or_annulled').
   */
  async assertBankReferenceNotReserved(client, academyId, recipientAccountId, bankReference) {
    if (!bankReference) return;

    const dupRes = await client.query(
      `SELECT id, order_id, settlement_status
       FROM payment_reconciliations
       WHERE academy_id = $1 AND recipient_account_id = $2 AND bank_reference = $3`,
      [academyId, recipientAccountId, bankReference]
    );

    if (dupRes.rows.length > 0) {
      const existing = dupRes.rows[0];
      const err = new Error(
        `Bank reference '${bankReference}' is already permanently reserved by reconciliation '${existing.id}' (status: '${existing.settlement_status}').`
      );
      err.statusCode = 409;
      err.code = 'DUPLICATE_BANK_REFERENCE';
      throw err;
    }
  }

  /**
   * T-02: Verifies an ordinary in-window bank deposit (pending_payment -> paid_verified).
   */
  async verifyPayment(session, orderId, input = {}, opts = {}) {
    const idempotencyKey = assertValidUuid(input?.idempotency_key, 'idempotency_key');
    const reason = typeof input?.reason === 'string' ? input.reason.trim() : '';
    if (reason.length < 10) {
      const err = new Error('reason must be at least 10 characters.');
      err.statusCode = 422;
      err.code = 'VALIDATION_ERROR';
      throw err;
    }

    const academyId = session.academyId || this.defaultAcademyId;
    const actionHash = computeActionHash('verify_payment', [
      orderId,
      input.reconciliation_mode,
      input.bank_reference || '',
      input.recipient_account_id || '',
      input.verified_amount_minor,
      input.verified_currency,
      reason,
    ]);

    const client = await this.db.getClient();
    let committed = false;
    try {
      await client.query('BEGIN');

      const order = await this.lockOrderForUpdate(client, academyId, orderId);

      const replay = await this.checkActionIdempotency(
        client,
        academyId,
        orderId,
        idempotencyKey,
        'verify_payment',
        actionHash
      );
      if (replay) {
        await client.query('COMMIT');
        committed = true;
        return replay;
      }

      const now = opts.now ? new Date(opts.now) : new Date();
      if (order.status === 'pending_payment' && new Date(order.expires_at) < now) {
        await client.query(
          `UPDATE orders SET status = 'expired' WHERE academy_id = $1 AND id = $2`,
          [academyId, orderId]
        );
        await client.query(
          `INSERT INTO order_events (id, academy_id, order_id, previous_status, new_status, reason)
           VALUES ($1, $2, $3, 'pending_payment', 'expired', 'Order payment window elapsed (72h)')`,
          [crypto.randomUUID(), academyId, orderId]
        );
        await client.query('COMMIT');
        committed = true;

        const err = new Error(
          'Order has expired. Late payment verification requires academy_admin authorization via verify-late-payment.'
        );
        err.statusCode = 409;
        err.code = 'ORDER_EXPIRED_REQUIRES_LATE_PAYMENT_AUTH';
        throw err;
      }

      if (order.status === 'expired') {
        await client.query('ROLLBACK');
        const err = new Error(
          'Order is expired. Late payment verification requires academy_admin authorization via verify-late-payment.'
        );
        err.statusCode = 409;
        err.code = 'ORDER_EXPIRED_REQUIRES_LATE_PAYMENT_AUTH';
        throw err;
      }

      if (order.status !== 'pending_payment') {
        await client.query('ROLLBACK');
        const err = new Error(`Cannot verify payment from status '${order.status}'.`);
        err.statusCode = 409;
        err.code = 'INVALID_ORDER_STATE_TRANSITION';
        throw err;
      }

      const verified = this.validateBankVerificationInput(session, order, input);

      await this.assertBankReferenceNotReserved(
        client,
        academyId,
        verified.recipientAccountId,
        verified.bankReference
      );

      const reconciliationId = crypto.randomUUID();
      const recRes = await client.query(
        `INSERT INTO payment_reconciliations (
           id, academy_id, order_id, recipient_account_id, verified_amount_minor, verified_currency,
           bank_credit_at, reconciliation_mode, bank_reference, reconciliation_evidence,
           settlement_status, verified_by_operator_id
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'applied', $11)
         RETURNING *`,
        [
          reconciliationId,
          academyId,
          orderId,
          verified.recipientAccountId,
          verified.verifiedAmountMinor,
          verified.verifiedCurrency,
          verified.bankCreditAt,
          verified.reconciliationMode,
          verified.bankReference,
          verified.reconciliationEvidence,
          session.operatorId,
        ]
      );

      await client.query(
        `UPDATE orders SET status = 'paid_verified' WHERE academy_id = $1 AND id = $2`,
        [academyId, orderId]
      );

      const eventId = crypto.randomUUID();
      const metadata = {
        idempotency_key: idempotencyKey,
        action_type: 'verify_payment',
        action_hash: actionHash,
        operator_role: session.role,
        reconciliation_id: reconciliationId,
        reconciliation_mode: verified.reconciliationMode,
        bank_reference: verified.bankReference,
        reconciliation_evidence: verified.reconciliationEvidence,
        recipient_account_id: verified.recipientAccountId,
        verified_amount_minor: verified.verifiedAmountMinor,
        verified_currency: verified.verifiedCurrency,
        bank_credit_at: verified.bankCreditAt.toISOString(),
      };

      const evRes = await client.query(
        `INSERT INTO order_events (
           id, academy_id, order_id, previous_status, new_status, reason, operator_id, metadata
         ) VALUES ($1, $2, $3, 'pending_payment', 'paid_verified', $4, $5, $6)
         RETURNING id, academy_id, order_id, previous_status, new_status, reason, operator_id, metadata, created_at`,
        [eventId, academyId, orderId, reason, session.operatorId, JSON.stringify(metadata)]
      );

      if (opts.injectFailureBeforeCommit) {
        throw new Error('INJECTED_TRANSACTION_FAILURE_BEFORE_COMMIT');
      }

      await client.query('COMMIT');
      committed = true;

      return {
        isIdempotentReplay: false,
        statusCode: 200,
        order: {
          id: order.id,
          order_number: order.order_number,
          status: 'paid_verified',
          sku: order.sku,
          total_amount_minor: order.total_amount_minor,
          currency: order.currency,
        },
        reconciliation: recRes.rows[0],
        event: evRes.rows[0],
      };
    } catch (err) {
      if (!committed) {
        try {
          await client.query('ROLLBACK');
        } catch (_) {}
      }

      if (err.code === '23505' || err.code === 23505 || (err.data && err.data.code === '23505')) {
        if (!err.constraint || err.constraint === 'uq_payment_reconciliations_bank_ref') {
          const dupErr = new Error('Bank reference is already permanently reserved in payment_reconciliations.');
          dupErr.statusCode = 409;
          dupErr.code = 'DUPLICATE_BANK_REFERENCE';
          throw dupErr;
        }
        if (err.constraint === 'uq_payment_reconciliations_active_order') {
          const activeErr = new Error('Order already has an active payment reconciliation.');
          activeErr.statusCode = 409;
          activeErr.code = 'ORDER_ALREADY_RECONCILED';
          throw activeErr;
        }
      }
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * T-06: Verifies a late payment on an expired order (expired -> paid_verified).
   * Requires academy_admin, full bank verification, late_payment_reason, and fulfillment_feasibility_confirmed.
   */
  async verifyLatePayment(session, orderId, input = {}, opts = {}) {
    if (session.role !== 'academy_admin') {
      const err = new Error('Only academy_admin can authorize late payment reconciliation.');
      err.statusCode = 403;
      err.code = 'INSUFFICIENT_ROLE_PERMISSIONS';
      throw err;
    }

    const idempotencyKey = assertValidUuid(input?.idempotency_key, 'idempotency_key');
    const lateReason =
      typeof input?.late_payment_reason === 'string' ? input.late_payment_reason.trim() : '';
    if (lateReason.length < 15) {
      const err = new Error('late_payment_reason (minimum 15 characters) is mandatory for late payment resolution.');
      err.statusCode = 422;
      err.code = 'LATE_PAYMENT_REASON_REQUIRED';
      throw err;
    }

    if (input?.fulfillment_feasibility_confirmed !== true) {
      const err = new Error(
        'fulfillment_feasibility_confirmed must be explicitly true to reactivate an expired order.'
      );
      err.statusCode = 422;
      err.code = 'FULFILLMENT_FEASIBILITY_REQUIRED';
      throw err;
    }

    const academyId = session.academyId || this.defaultAcademyId;
    const actionHash = computeActionHash('verify_late_payment', [
      orderId,
      input.reconciliation_mode,
      input.bank_reference || '',
      input.recipient_account_id || '',
      input.verified_amount_minor,
      input.verified_currency,
      lateReason,
      true,
    ]);

    const client = await this.db.getClient();
    let committed = false;
    try {
      await client.query('BEGIN');

      const order = await this.lockOrderForUpdate(client, academyId, orderId);

      const replay = await this.checkActionIdempotency(
        client,
        academyId,
        orderId,
        idempotencyKey,
        'verify_late_payment',
        actionHash
      );
      if (replay) {
        await client.query('COMMIT');
        committed = true;
        return replay;
      }

      const now = opts.now ? new Date(opts.now) : new Date();
      if (order.status === 'pending_payment' && new Date(order.expires_at) < now) {
        await client.query(
          `UPDATE orders SET status = 'expired' WHERE academy_id = $1 AND id = $2`,
          [academyId, orderId]
        );
        await client.query(
          `INSERT INTO order_events (id, academy_id, order_id, previous_status, new_status, reason)
           VALUES ($1, $2, $3, 'pending_payment', 'expired', 'Order payment window elapsed (72h)')`,
          [crypto.randomUUID(), academyId, orderId]
        );
        order.status = 'expired';
      }

      if (order.status === 'pending_payment') {
        await client.query('ROLLBACK');
        const err = new Error('Order is not expired; use standard verify-payment endpoint.');
        err.statusCode = 409;
        err.code = 'ORDER_NOT_EXPIRED_USE_STANDARD_VERIFY';
        throw err;
      }

      if (order.status !== 'expired') {
        await client.query('ROLLBACK');
        const err = new Error(`Cannot verify late payment from status '${order.status}'.`);
        err.statusCode = 409;
        err.code = 'INVALID_ORDER_STATE_TRANSITION';
        throw err;
      }

      const verified = this.validateBankVerificationInput(session, order, input);

      await this.assertBankReferenceNotReserved(
        client,
        academyId,
        verified.recipientAccountId,
        verified.bankReference
      );

      const reconciliationId = crypto.randomUUID();
      const recRes = await client.query(
        `INSERT INTO payment_reconciliations (
           id, academy_id, order_id, recipient_account_id, verified_amount_minor, verified_currency,
           bank_credit_at, reconciliation_mode, bank_reference, reconciliation_evidence,
           settlement_status, verified_by_operator_id
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'applied', $11)
         RETURNING *`,
        [
          reconciliationId,
          academyId,
          orderId,
          verified.recipientAccountId,
          verified.verifiedAmountMinor,
          verified.verifiedCurrency,
          verified.bankCreditAt,
          verified.reconciliationMode,
          verified.bankReference,
          verified.reconciliationEvidence,
          session.operatorId,
        ]
      );

      await client.query(
        `UPDATE orders SET status = 'paid_verified' WHERE academy_id = $1 AND id = $2`,
        [academyId, orderId]
      );

      const eventId = crypto.randomUUID();
      const metadata = {
        idempotency_key: idempotencyKey,
        action_type: 'verify_late_payment',
        action_hash: actionHash,
        operator_role: session.role,
        reconciliation_id: reconciliationId,
        reconciliation_mode: verified.reconciliationMode,
        bank_reference: verified.bankReference,
        reconciliation_evidence: verified.reconciliationEvidence,
        recipient_account_id: verified.recipientAccountId,
        verified_amount_minor: verified.verifiedAmountMinor,
        verified_currency: verified.verifiedCurrency,
        bank_credit_at: verified.bankCreditAt.toISOString(),
        late_payment_reason: lateReason,
        fulfillment_feasibility_confirmed: true,
      };

      const evRes = await client.query(
        `INSERT INTO order_events (
           id, academy_id, order_id, previous_status, new_status, reason, operator_id, metadata
         ) VALUES ($1, $2, $3, 'expired', 'paid_verified', $4, $5, $6)
         RETURNING id, academy_id, order_id, previous_status, new_status, reason, operator_id, metadata, created_at`,
        [eventId, academyId, orderId, lateReason, session.operatorId, JSON.stringify(metadata)]
      );

      if (opts.injectFailureBeforeCommit) {
        throw new Error('INJECTED_TRANSACTION_FAILURE_BEFORE_COMMIT');
      }

      await client.query('COMMIT');
      committed = true;

      return {
        isIdempotentReplay: false,
        statusCode: 200,
        order: {
          id: order.id,
          order_number: order.order_number,
          status: 'paid_verified',
          sku: order.sku,
          total_amount_minor: order.total_amount_minor,
          currency: order.currency,
        },
        reconciliation: recRes.rows[0],
        event: evRes.rows[0],
      };
    } catch (err) {
      if (!committed) {
        try {
          await client.query('ROLLBACK');
        } catch (_) {}
      }

      if (err.code === '23505' || err.code === 23505 || (err.data && err.data.code === '23505')) {
        const dupErr = new Error('Bank reference is already permanently reserved in payment_reconciliations.');
        dupErr.statusCode = 409;
        dupErr.code = 'DUPLICATE_BANK_REFERENCE';
        throw dupErr;
      }
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * T-09: Atomic Administrative Re-imputation over the same reconciliation_id (Order A -> reverse -> Order B)
   * Exclusively for academy_admin. Never creates a second deposit identity!
   */
  async reallocateReconciliation(session, targetOrderId, input = {}, opts = {}) {
    if (session.role !== 'academy_admin') {
      const err = new Error('Only academy_admin can reallocate a reversed bank reconciliation.');
      err.statusCode = 403;
      err.code = 'INSUFFICIENT_ROLE_PERMISSIONS';
      throw err;
    }

    const validTargetOrderId = assertValidUuid(targetOrderId, 'order_id');
    const reconciliationId = assertValidUuid(input?.reconciliation_id, 'reconciliation_id');
    const fromOrderId = assertValidUuid(input?.reallocated_from_order_id, 'reallocated_from_order_id');
    const idempotencyKey = assertValidUuid(input?.idempotency_key, 'idempotency_key');
    const reason = typeof input?.reason === 'string' ? input.reason.trim() : '';

    if (reason.length < 15) {
      const err = new Error('reason (minimum 15 characters) is mandatory for administrative reallocation.');
      err.statusCode = 422;
      err.code = 'VALIDATION_ERROR';
      throw err;
    }

    if (validTargetOrderId === fromOrderId) {
      const err = new Error('Target order must be different from reallocated_from_order_id.');
      err.statusCode = 422;
      err.code = 'VALIDATION_ERROR';
      throw err;
    }

    const academyId = session.academyId || this.defaultAcademyId;
    const actionHash = computeActionHash('reallocate_reconciliation', [
      validTargetOrderId,
      reconciliationId,
      fromOrderId,
      reason,
    ]);

    const client = await this.db.getClient();
    try {
      await client.query('BEGIN');

      // Lock both orders in deterministic ID order to avoid deadlocks
      const [firstId, secondId] =
        validTargetOrderId < fromOrderId
          ? [validTargetOrderId, fromOrderId]
          : [fromOrderId, validTargetOrderId];

      const firstOrder = await this.lockOrderForUpdate(client, academyId, firstId);
      const secondOrder = await this.lockOrderForUpdate(client, academyId, secondId);

      const targetOrder = validTargetOrderId === firstId ? firstOrder : secondOrder;
      const sourceOrder = fromOrderId === firstId ? firstOrder : secondOrder;

      const replay = await this.checkActionIdempotency(
        client,
        academyId,
        validTargetOrderId,
        idempotencyKey,
        'reallocate_reconciliation',
        actionHash
      );
      if (replay) {
        await client.query('COMMIT');
        return replay;
      }

      // Lock the existing reconciliation record by reconciliation_id
      const recLockRes = await client.query(
        `SELECT *
         FROM payment_reconciliations
         WHERE academy_id = $1 AND id = $2
         FOR UPDATE`,
        [academyId, reconciliationId]
      );

      if (recLockRes.rows.length === 0) {
        await client.query('ROLLBACK');
        const err = new Error('Original payment reconciliation record not found.');
        err.statusCode = 404;
        err.code = 'RECONCILIATION_NOT_FOUND';
        throw err;
      }

      const reconciliation = recLockRes.rows[0];

      if (reconciliation.order_id !== fromOrderId) {
        await client.query('ROLLBACK');
        const err = new Error('Reconciliation record does not belong to reallocated_from_order_id.');
        err.statusCode = 409;
        err.code = 'RECONCILIATION_SOURCE_ORDER_MISMATCH';
        throw err;
      }

      if (reconciliation.settlement_status !== 'reversed_mistaken_match') {
        await client.query('ROLLBACK');
        const err = new Error(
          `Reconciliation '${reconciliationId}' has status '${reconciliation.settlement_status}' and cannot be reallocated.`
        );
        err.statusCode = 409;
        err.code = 'RECONCILIATION_NOT_REALLOCATABLE';
        throw err;
      }

      const now = opts.now ? new Date(opts.now) : new Date();
      let previousTargetStatus = targetOrder.status;

      if (targetOrder.status === 'pending_payment' && new Date(targetOrder.expires_at) < now) {
        await client.query(
          `UPDATE orders SET status = 'expired' WHERE academy_id = $1 AND id = $2`,
          [academyId, validTargetOrderId]
        );
        await client.query(
          `INSERT INTO order_events (id, academy_id, order_id, previous_status, new_status, reason)
           VALUES ($1, $2, $3, 'pending_payment', 'expired', 'Order payment window elapsed (72h)')`,
          [crypto.randomUUID(), academyId, validTargetOrderId]
        );
        previousTargetStatus = 'expired';
      }

      if (previousTargetStatus === 'expired') {
        const lateReason =
          typeof input.late_payment_reason === 'string' ? input.late_payment_reason.trim() : '';
        if (lateReason.length < 15 || input.fulfillment_feasibility_confirmed !== true) {
          await client.query('ROLLBACK');
          const err = new Error(
            'Target order is expired; reallocation requires late_payment_reason and fulfillment_feasibility_confirmed = true.'
          );
          err.statusCode = 422;
          err.code = 'LATE_PAYMENT_CONTROLS_REQUIRED_FOR_EXPIRED_TARGET';
          throw err;
        }
      } else if (previousTargetStatus !== 'pending_payment') {
        await client.query('ROLLBACK');
        const err = new Error(`Target order cannot receive reallocated reconciliation in status '${previousTargetStatus}'.`);
        err.statusCode = 409;
        err.code = 'INVALID_ORDER_STATE_TRANSITION';
        throw err;
      }

      if (
        targetOrder.total_amount_minor !== reconciliation.verified_amount_minor ||
        targetOrder.currency !== reconciliation.verified_currency
      ) {
        await client.query('ROLLBACK');
        const err = new Error('Target order amount or currency does not match the original verified deposit.');
        err.statusCode = 422;
        err.code = 'AMOUNT_OR_CURRENCY_MISMATCH';
        throw err;
      }

      // Update the SAME row in payment_reconciliations (preserving reconciliation_id and bank_reference!)
      const updRecRes = await client.query(
        `UPDATE payment_reconciliations
         SET order_id = $1,
             reallocated_from_order_id = $2,
             settlement_status = 'applied',
             reallocated_by_operator_id = $3,
             reallocation_reason = $4,
             reallocated_at = NOW(),
             updated_at = NOW()
         WHERE academy_id = $5 AND id = $6
         RETURNING *`,
        [
          validTargetOrderId,
          fromOrderId,
          session.operatorId,
          reason,
          academyId,
          reconciliationId,
        ]
      );

      await client.query(
        `UPDATE orders SET status = 'paid_verified' WHERE academy_id = $1 AND id = $2`,
        [academyId, validTargetOrderId]
      );

      // Append audit event on target order (Order B)
      const targetEventMetadata = {
        idempotency_key: idempotencyKey,
        action_type: 'reallocate_reconciliation',
        action_hash: actionHash,
        operator_role: session.role,
        reconciliation_id: reconciliationId,
        bank_reference: reconciliation.bank_reference,
        reallocated_from_order_id: fromOrderId,
        reallocated_from_order_number: sourceOrder.order_number,
        verified_amount_minor: reconciliation.verified_amount_minor,
        verified_currency: reconciliation.verified_currency,
      };

      const targetEvRes = await client.query(
        `INSERT INTO order_events (
           id, academy_id, order_id, previous_status, new_status, reason, operator_id, metadata
         ) VALUES ($1, $2, $3, $4, 'paid_verified', $5, $6, $7)
         RETURNING id, academy_id, order_id, previous_status, new_status, reason, operator_id, metadata, created_at`,
        [
          crypto.randomUUID(),
          academyId,
          validTargetOrderId,
          previousTargetStatus,
          reason,
          session.operatorId,
          JSON.stringify(targetEventMetadata),
        ]
      );

      // Append cross-reference audit event on source order (Order A) so both histories are linked
      const sourceEventMetadata = {
        action_type: 'reconciliation_reallocated_out',
        operator_role: session.role,
        reconciliation_id: reconciliationId,
        bank_reference: reconciliation.bank_reference,
        reallocated_to_order_id: validTargetOrderId,
        reallocated_to_order_number: targetOrder.order_number,
      };

      await client.query(
        `INSERT INTO order_events (
           id, academy_id, order_id, previous_status, new_status, reason, operator_id, metadata
         ) VALUES ($1, $2, $3, $4, $4, $5, $6, $7)`,
        [
          crypto.randomUUID(),
          academyId,
          fromOrderId,
          sourceOrder.status,
          `Reconciliation ${reconciliationId} reallocated to order ${targetOrder.order_number}: ${reason}`,
          session.operatorId,
          JSON.stringify(sourceEventMetadata),
        ]
      );

      if (opts.injectFailureBeforeCommit) {
        throw new Error('INJECTED_TRANSACTION_FAILURE_BEFORE_COMMIT');
      }

      await client.query('COMMIT');

      return {
        isIdempotentReplay: false,
        statusCode: 200,
        order: {
          id: targetOrder.id,
          order_number: targetOrder.order_number,
          status: 'paid_verified',
          sku: targetOrder.sku,
          total_amount_minor: targetOrder.total_amount_minor,
          currency: targetOrder.currency,
        },
        reconciliation: updRecRes.rows[0],
        event: targetEvRes.rows[0],
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
   * T-03: Initiates manual Moodle enrollment workflow (paid_verified -> enrollment_pending).
   */
  async startEnrollment(session, orderId, input = {}, opts = {}) {
    const idempotencyKey = assertValidUuid(input?.idempotency_key, 'idempotency_key');
    const reason =
      typeof input?.reason === 'string' && input.reason.trim().length >= 5
        ? input.reason.trim()
        : 'Manual Moodle enrollment initiated after verified bank deposit';

    const academyId = session.academyId || this.defaultAcademyId;
    const actionHash = computeActionHash('start_enrollment', [orderId, reason]);

    const client = await this.db.getClient();
    try {
      await client.query('BEGIN');

      const order = await this.lockOrderForUpdate(client, academyId, orderId);

      const replay = await this.checkActionIdempotency(
        client,
        academyId,
        orderId,
        idempotencyKey,
        'start_enrollment',
        actionHash
      );
      if (replay) {
        await client.query('COMMIT');
        return replay;
      }

      if (order.status !== 'paid_verified') {
        await client.query('ROLLBACK');
        const err = new Error(
          `Cannot start Moodle enrollment when order status is '${order.status}'. Order must be in 'paid_verified'.`
        );
        err.statusCode = 409;
        err.code = 'ENROLLMENT_REQUIRES_PAID_VERIFIED';
        throw err;
      }

      const activeRecRes = await client.query(
        `SELECT id FROM payment_reconciliations
         WHERE academy_id = $1 AND order_id = $2 AND settlement_status = 'applied'`,
        [academyId, orderId]
      );
      if (activeRecRes.rows.length === 0) {
        await client.query('ROLLBACK');
        const err = new Error('Order has no active applied payment reconciliation.');
        err.statusCode = 409;
        err.code = 'ENROLLMENT_REQUIRES_PAID_VERIFIED';
        throw err;
      }

      const provisionalCourses = PROVISIONAL_SKU_MOODLE_COURSES[order.sku] || [];

      await client.query(
        `UPDATE orders SET status = 'enrollment_pending' WHERE academy_id = $1 AND id = $2`,
        [academyId, orderId]
      );

      const metadata = {
        idempotency_key: idempotencyKey,
        action_type: 'start_enrollment',
        action_hash: actionHash,
        operator_role: session.role,
        reconciliation_id: activeRecRes.rows[0].id,
        provisional_target_courses: provisionalCourses,
        provisional_access_days: PROVISIONAL_COMMERCIAL_TERMS.provisional_access_days,
        commercial_ratification_status: PROVISIONAL_COMMERCIAL_TERMS.moodle_ids_status,
      };

      const evRes = await client.query(
        `INSERT INTO order_events (
           id, academy_id, order_id, previous_status, new_status, reason, operator_id, metadata
         ) VALUES ($1, $2, $3, 'paid_verified', 'enrollment_pending', $4, $5, $6)
         RETURNING id, academy_id, order_id, previous_status, new_status, reason, operator_id, metadata, created_at`,
        [crypto.randomUUID(), academyId, orderId, reason, session.operatorId, JSON.stringify(metadata)]
      );

      if (opts.injectFailureBeforeCommit) {
        throw new Error('INJECTED_TRANSACTION_FAILURE_BEFORE_COMMIT');
      }

      await client.query('COMMIT');

      return {
        isIdempotentReplay: false,
        statusCode: 200,
        order: {
          id: order.id,
          order_number: order.order_number,
          status: 'enrollment_pending',
          sku: order.sku,
          provisional_target_courses: provisionalCourses,
          provisional_access_days: PROVISIONAL_COMMERCIAL_TERMS.provisional_access_days,
        },
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
   * T-04: Confirms manual Moodle enrollment completion (enrollment_pending -> fulfilled).
   * Pack requires all 4 verified courses.
   */
  async confirmEnrollment(session, orderId, input = {}, opts = {}) {
    const idempotencyKey = assertValidUuid(input?.idempotency_key, 'idempotency_key');
    const moodleUser =
      typeof input?.moodle_user_identifier === 'string' ? input.moodle_user_identifier.trim() : '';
    const reason = typeof input?.reason === 'string' ? input.reason.trim() : '';

    if (!moodleUser || moodleUser.length > 128) {
      const err = new Error('moodle_user_identifier is required (max 128 chars).');
      err.statusCode = 422;
      err.code = 'VALIDATION_ERROR';
      throw err;
    }

    if (input?.access_confirmed !== true) {
      const err = new Error('access_confirmed must be explicitly true to complete fulfillment.');
      err.statusCode = 422;
      err.code = 'MOODLE_ACCESS_CONFIRMATION_REQUIRED';
      throw err;
    }

    if (reason.length < 5) {
      const err = new Error('reason (minimum 5 characters) is required.');
      err.statusCode = 422;
      err.code = 'VALIDATION_ERROR';
      throw err;
    }

    if (!Array.isArray(input?.moodle_courses_enrolled) || input.moodle_courses_enrolled.length === 0) {
      const err = new Error('moodle_courses_enrolled must be a non-empty array of verified course identifiers.');
      err.statusCode = 422;
      err.code = 'INCOMPLETE_MOODLE_COURSES_ENROLLED';
      throw err;
    }

    const normalizedCourses = input.moodle_courses_enrolled.map((c) =>
      typeof c === 'string' ? c.trim() : ''
    );
    const academyId = session.academyId || this.defaultAcademyId;
    const actionHash = computeActionHash('confirm_enrollment', [
      orderId,
      moodleUser,
      [...normalizedCourses].sort().join(','),
      reason,
    ]);

    const client = await this.db.getClient();
    try {
      await client.query('BEGIN');

      const order = await this.lockOrderForUpdate(client, academyId, orderId);

      const replay = await this.checkActionIdempotency(
        client,
        academyId,
        orderId,
        idempotencyKey,
        'confirm_enrollment',
        actionHash
      );
      if (replay) {
        await client.query('COMMIT');
        return replay;
      }

      if (order.status !== 'enrollment_pending') {
        await client.query('ROLLBACK');
        const err = new Error(
          `Cannot confirm Moodle enrollment when order status is '${order.status}'. Order must be in 'enrollment_pending'.`
        );
        err.statusCode = 409;
        err.code = 'CONFIRM_ENROLLMENT_REQUIRES_ENROLLMENT_PENDING';
        throw err;
      }

      const requiredCourses = PROVISIONAL_SKU_MOODLE_COURSES[order.sku] || [];
      const uniqueProvided = new Set(normalizedCourses);

      if (
        uniqueProvided.size !== normalizedCourses.length ||
        uniqueProvided.size !== requiredCourses.length ||
        requiredCourses.some((reqCourse) => !uniqueProvided.has(reqCourse))
      ) {
        await client.query('ROLLBACK');
        const err = new Error(
          `SKU '${order.sku}' requires exact verified enrollment in [${requiredCourses.join(', ')}].`
        );
        err.statusCode = 422;
        err.code = 'INCOMPLETE_MOODLE_COURSES_ENROLLED';
        throw err;
      }

      await client.query(
        `UPDATE orders SET status = 'fulfilled' WHERE academy_id = $1 AND id = $2`,
        [academyId, orderId]
      );

      const metadata = {
        idempotency_key: idempotencyKey,
        action_type: 'confirm_enrollment',
        action_hash: actionHash,
        operator_role: session.role,
        moodle_user_identifier: moodleUser,
        moodle_courses_enrolled: requiredCourses,
        verified_enrollments_count: requiredCourses.length,
        access_confirmed: true,
        provisional_access_days: PROVISIONAL_COMMERCIAL_TERMS.provisional_access_days,
        commercial_ratification_status: PROVISIONAL_COMMERCIAL_TERMS.moodle_ids_status,
      };

      const evRes = await client.query(
        `INSERT INTO order_events (
           id, academy_id, order_id, previous_status, new_status, reason, operator_id, metadata
         ) VALUES ($1, $2, $3, 'enrollment_pending', 'fulfilled', $4, $5, $6)
         RETURNING id, academy_id, order_id, previous_status, new_status, reason, operator_id, metadata, created_at`,
        [crypto.randomUUID(), academyId, orderId, reason, session.operatorId, JSON.stringify(metadata)]
      );

      if (opts.injectFailureBeforeCommit) {
        throw new Error('INJECTED_TRANSACTION_FAILURE_BEFORE_COMMIT');
      }

      await client.query('COMMIT');

      return {
        isIdempotentReplay: false,
        statusCode: 200,
        order: {
          id: order.id,
          order_number: order.order_number,
          status: 'fulfilled',
          sku: order.sku,
          moodle_courses_enrolled: requiredCourses,
        },
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
   * T-07: Cancels an unpaid order (pending_payment or expired -> cancelled).
   */
  async cancelOrder(session, orderId, input = {}, opts = {}) {
    const idempotencyKey = assertValidUuid(input?.idempotency_key, 'idempotency_key');
    const reason = typeof input?.reason === 'string' ? input.reason.trim() : '';

    if (reason.length < 10) {
      const err = new Error('reason (minimum 10 characters) is required to cancel an unpaid order.');
      err.statusCode = 422;
      err.code = 'VALIDATION_ERROR';
      throw err;
    }

    const academyId = session.academyId || this.defaultAcademyId;
    const actionHash = computeActionHash('cancel', [orderId, reason]);

    const client = await this.db.getClient();
    try {
      await client.query('BEGIN');

      const order = await this.lockOrderForUpdate(client, academyId, orderId);

      const replay = await this.checkActionIdempotency(
        client,
        academyId,
        orderId,
        idempotencyKey,
        'cancel',
        actionHash
      );
      if (replay) {
        await client.query('COMMIT');
        return replay;
      }

      if (['paid_verified', 'enrollment_pending', 'fulfilled'].includes(order.status)) {
        await client.query('ROLLBACK');
        const err = new Error('Orders with verified payments cannot be cancelled without an administrative reversal.');
        err.statusCode = 409;
        err.code = 'PAID_ORDER_REQUIRES_ADMIN_REVERSAL';
        throw err;
      }

      if (order.status !== 'pending_payment' && order.status !== 'expired') {
        await client.query('ROLLBACK');
        const err = new Error(`Cannot cancel order in status '${order.status}'.`);
        err.statusCode = 409;
        err.code = 'INVALID_ORDER_STATE_TRANSITION';
        throw err;
      }

      await client.query(
        `UPDATE orders SET status = 'cancelled' WHERE academy_id = $1 AND id = $2`,
        [academyId, orderId]
      );

      const metadata = {
        idempotency_key: idempotencyKey,
        action_type: 'cancel',
        action_hash: actionHash,
        operator_role: session.role,
      };

      const evRes = await client.query(
        `INSERT INTO order_events (
           id, academy_id, order_id, previous_status, new_status, reason, operator_id, metadata
         ) VALUES ($1, $2, $3, $4, 'cancelled', $5, $6, $7)
         RETURNING id, academy_id, order_id, previous_status, new_status, reason, operator_id, metadata, created_at`,
        [
          crypto.randomUUID(),
          academyId,
          orderId,
          order.status,
          reason,
          session.operatorId,
          JSON.stringify(metadata),
        ]
      );

      if (opts.injectFailureBeforeCommit) {
        throw new Error('INJECTED_TRANSACTION_FAILURE_BEFORE_COMMIT');
      }

      await client.query('COMMIT');

      return {
        isIdempotentReplay: false,
        statusCode: 200,
        order: {
          id: order.id,
          order_number: order.order_number,
          status: 'cancelled',
          sku: order.sku,
        },
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
   * T-08: Administrative reversal (exclusive to academy_admin) with compensation & deposit reservation.
   */
  async reverseOrderState(session, orderId, input = {}, opts = {}) {
    if (session.role !== 'academy_admin') {
      const err = new Error('Only academy_admin can execute administrative reversals.');
      err.statusCode = 403;
      err.code = 'INSUFFICIENT_ROLE_PERMISSIONS';
      throw err;
    }

    const idempotencyKey = assertValidUuid(input?.idempotency_key, 'idempotency_key');
    const correctedEventId = assertValidUuid(input?.corrected_event_id, 'corrected_event_id');
    const targetStatus = typeof input?.target_status === 'string' ? input.target_status.trim() : '';
    const reason = typeof input?.reason === 'string' ? input.reason.trim() : '';

    if (reason.length < 15) {
      const err = new Error('reason (minimum 15 characters) is mandatory for administrative reversals.');
      err.statusCode = 422;
      err.code = 'VALIDATION_ERROR';
      throw err;
    }

    const academyId = session.academyId || this.defaultAcademyId;
    const actionHash = computeActionHash('reverse', [
      orderId,
      targetStatus,
      correctedEventId,
      reason,
      input.reversal_compensation_ref || '',
      input.access_impact_statement || '',
    ]);

    const client = await this.db.getClient();
    try {
      await client.query('BEGIN');

      const order = await this.lockOrderForUpdate(client, academyId, orderId);

      const replay = await this.checkActionIdempotency(
        client,
        academyId,
        orderId,
        idempotencyKey,
        'reverse',
        actionHash
      );
      if (replay) {
        await client.query('COMMIT');
        return replay;
      }

      const allowedTransitions = {
        paid_verified: ['pending_payment', 'cancelled'],
        enrollment_pending: ['paid_verified'],
        fulfilled: ['enrollment_pending'],
      };

      const validTargets = allowedTransitions[order.status] || [];
      if (!validTargets.includes(targetStatus)) {
        await client.query('ROLLBACK');
        const err = new Error(
          `Invalid administrative reversal transition from '${order.status}' to '${targetStatus}'.`
        );
        err.statusCode = 409;
        err.code = 'INVALID_REVERSAL_TRANSITION';
        throw err;
      }

      const evCheck = await client.query(
        `SELECT id FROM order_events WHERE academy_id = $1 AND order_id = $2 AND id = $3`,
        [academyId, orderId, correctedEventId]
      );
      if (evCheck.rows.length === 0) {
        await client.query('ROLLBACK');
        const err = new Error('corrected_event_id does not belong to this order.');
        err.statusCode = 422;
        err.code = 'INVALID_CORRECTED_EVENT_ID';
        throw err;
      }

      let updatedReconciliation = null;
      let settlementStatusAfterReverse = null;
      const compensationRef =
        typeof input.reversal_compensation_ref === 'string' ? input.reversal_compensation_ref.trim() : null;
      const accessImpactStatement =
        typeof input.access_impact_statement === 'string' ? input.access_impact_statement.trim() : null;

      if (order.status === 'paid_verified' && targetStatus === 'cancelled') {
        if (!compensationRef || compensationRef.length < 5) {
          await client.query('ROLLBACK');
          const err = new Error(
            'reversal_compensation_ref (minimum 5 chars) is required when reversing paid_verified to cancelled.'
          );
          err.statusCode = 422;
          err.code = 'REVERSAL_COMPENSATION_REF_REQUIRED';
          throw err;
        }
        settlementStatusAfterReverse = 'refunded_or_annulled';
        const recUpd = await client.query(
          `UPDATE payment_reconciliations
           SET settlement_status = 'refunded_or_annulled',
               reversed_by_operator_id = $1,
               reversal_reason = $2,
               reversal_compensation_ref = $3,
               reversed_at = NOW(),
               updated_at = NOW()
           WHERE academy_id = $4 AND order_id = $5 AND settlement_status = 'applied'
           RETURNING *`,
          [session.operatorId, reason, compensationRef, academyId, orderId]
        );
        updatedReconciliation = recUpd.rows[0] || null;
      } else if (order.status === 'paid_verified' && targetStatus === 'pending_payment') {
        settlementStatusAfterReverse = 'reversed_mistaken_match';
        const recUpd = await client.query(
          `UPDATE payment_reconciliations
           SET settlement_status = 'reversed_mistaken_match',
               reversed_by_operator_id = $1,
               reversal_reason = $2,
               reversed_at = NOW(),
               updated_at = NOW()
           WHERE academy_id = $3 AND order_id = $4 AND settlement_status = 'applied'
           RETURNING *`,
          [session.operatorId, reason, academyId, orderId]
        );
        updatedReconciliation = recUpd.rows[0] || null;
      } else if (order.status === 'fulfilled' && targetStatus === 'enrollment_pending') {
        if (!accessImpactStatement || accessImpactStatement.length < 15) {
          await client.query('ROLLBACK');
          const err = new Error(
            'access_impact_statement (minimum 15 chars) is required when reversing fulfilled to enrollment_pending.'
          );
          err.statusCode = 422;
          err.code = 'ACCESS_IMPACT_STATEMENT_REQUIRED';
          throw err;
        }
      }

      await client.query(
        `UPDATE orders SET status = $1 WHERE academy_id = $2 AND id = $3`,
        [targetStatus, academyId, orderId]
      );

      const metadata = {
        idempotency_key: idempotencyKey,
        action_type: 'reverse',
        action_hash: actionHash,
        operator_role: session.role,
        corrected_event_id: correctedEventId,
        reconciliation_id: updatedReconciliation?.id || null,
        settlement_status_after_reverse: settlementStatusAfterReverse,
        reversal_compensation_ref: compensationRef,
        access_impact_statement: accessImpactStatement,
      };

      const evRes = await client.query(
        `INSERT INTO order_events (
           id, academy_id, order_id, previous_status, new_status, reason, operator_id, metadata
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, academy_id, order_id, previous_status, new_status, reason, operator_id, metadata, created_at`,
        [
          crypto.randomUUID(),
          academyId,
          orderId,
          order.status,
          targetStatus,
          reason,
          session.operatorId,
          JSON.stringify(metadata),
        ]
      );

      if (opts.injectFailureBeforeCommit) {
        throw new Error('INJECTED_TRANSACTION_FAILURE_BEFORE_COMMIT');
      }

      await client.query('COMMIT');

      return {
        isIdempotentReplay: false,
        statusCode: 200,
        order: {
          id: order.id,
          order_number: order.order_number,
          status: targetStatus,
          sku: order.sku,
        },
        reconciliation: updatedReconciliation,
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
