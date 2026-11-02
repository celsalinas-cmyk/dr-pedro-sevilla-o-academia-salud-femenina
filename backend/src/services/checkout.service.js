import crypto from 'crypto';

export class CheckoutService {
  constructor(database, defaultAcademyId = 'dr-sevilla') {
    this.db = database;
    this.defaultAcademyId = defaultAcademyId;
  }

  /**
   * Deterministic canonical hash of the checkout intent.
   * Explicit Policy:
   * Included: sku, email_normalized, name, phone, terms_accepted, marketing_opt_in, privacy_version.
   * Excluded: UTM parameters (traffic attribution is tracking metadata, not commercial intent;
   * a customer re-entering the checkout from a different story/link with same idempotency key
   * must not trigger 409 conflict).
   */
  calculatePayloadHash(data) {
    const canonicalString = [
      data.sku || '',
      (data.email || '').trim().toLowerCase(),
      (data.name || '').trim(),
      data.phone ? data.phone.trim() : '',
      data.terms_accepted ? 'true' : 'false',
      data.marketing_opt_in ? 'true' : 'false',
      data.privacy_version || 'v1.0'
    ].join('|');

    return crypto.createHash('sha256').update(canonicalString).digest('hex');
  }

  /**
   * Strict validation of UTM tracking parameters.
   */
  validateAndSanitizeUtm(rawUtm) {
    if (!rawUtm || typeof rawUtm !== 'object' || Array.isArray(rawUtm)) {
      return { source: null, medium: null, campaign: null, content: null };
    }

    const utmRegex = /^[a-zA-Z0-9_-]{1,64}$/;
    const sanitizeField = (val, fieldName) => {
      if (val === undefined || val === null || val === '') return null;
      if (typeof val !== 'string') {
        throw Object.assign(new Error(`UTM ${fieldName} must be a string.`), { statusCode: 422, code: 'VALIDATION_ERROR' });
      }
      const trimmed = val.trim();
      if (!utmRegex.test(trimmed)) {
        throw Object.assign(new Error(`UTM ${fieldName} contains invalid characters or exceeds 64 chars.`), { statusCode: 422, code: 'VALIDATION_ERROR' });
      }
      return trimmed;
    };

    return {
      source: sanitizeField(rawUtm.source, 'source'),
      medium: sanitizeField(rawUtm.medium, 'medium'),
      campaign: sanitizeField(rawUtm.campaign, 'campaign'),
      content: sanitizeField(rawUtm.content, 'content'),
    };
  }

  /**
   * Validates input fields rigorously (Data Minimization & Schema Check).
   */
  validateCheckoutInput(input) {
    const errors = [];

    if (!input || typeof input !== 'object') {
      return ['Request payload must be a JSON object.'];
    }

    if (!input.sku || typeof input.sku !== 'string') {
      errors.push('SKU is required and must be a string.');
    }

    if (!input.name || typeof input.name !== 'string' || input.name.trim().length < 2 || input.name.trim().length > 80) {
      errors.push('Name must be between 2 and 80 characters.');
    } else {
      const nameRegex = /^[a-zA-ZáéíóúÁÉÍÓÚñÑüÜ\s'-]+$/;
      if (!nameRegex.test(input.name.trim())) {
        errors.push('Name contains invalid characters.');
      }
    }

    if (!input.email || typeof input.email !== 'string') {
      errors.push('Email is required and must be a string.');
    } else {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(input.email.trim()) || input.email.trim().length > 100) {
        errors.push('Email has an invalid format or exceeds 100 characters.');
      }
    }

    if (input.phone !== undefined && input.phone !== null && input.phone !== '') {
      if (typeof input.phone !== 'string') {
        errors.push('Phone must be a string.');
      } else {
        const phoneRegex = /^\+?[0-9]{7,15}$/;
        if (!phoneRegex.test(input.phone.trim())) {
          errors.push('Phone must be a valid numeric international string (7-15 digits).');
        }
      }
    }

    if (input.terms_accepted !== true) {
      errors.push('Terms of service and privacy policy must be explicitly accepted (boolean true).');
    }

    if (input.marketing_opt_in !== undefined && typeof input.marketing_opt_in !== 'boolean') {
      errors.push('marketing_opt_in must be a boolean.');
    }

    if (input.privacy_version !== undefined && (typeof input.privacy_version !== 'string' || input.privacy_version.length > 32)) {
      errors.push('privacy_version must be a string under 32 characters.');
    }

    if (!input.idempotency_key || typeof input.idempotency_key !== 'string') {
      errors.push('idempotency_key (UUID v4) is required.');
    } else {
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!uuidRegex.test(input.idempotency_key)) {
        errors.push('idempotency_key must be a valid UUID v4.');
      }
    }

    return errors;
  }

  /**
   * Atomic transactional checkout with strict idempotency, connection safety, and lead preservation.
   * @param {Object} input - Checkout request payload
   * @param {string} clientIp - Client IP
   * @param {string} userAgent - User agent
   * @param {Object} opts - Optional test hooks (e.g. injectFailureBeforeCommit)
   */
  async processCheckout(input, clientIp = '127.0.0.1', userAgent = '', opts = {}) {
    const validationErrors = this.validateCheckoutInput(input);
    if (validationErrors.length > 0) {
      const err = new Error(validationErrors.join(' '));
      err.statusCode = 422;
      err.code = 'VALIDATION_ERROR';
      throw err;
    }

    const sanitizedUtm = this.validateAndSanitizeUtm(input.utm);
    const academyId = this.defaultAcademyId;
    const incomingPayloadHash = this.calculatePayloadHash(input);
    const emailNormalized = input.email.trim().toLowerCase();
    const nameTrimmed = input.name.trim();
    const phoneTrimmed = input.phone && typeof input.phone === 'string' ? input.phone.trim() : null;

    const client = await this.db.getClient();

    try {
      await client.query('BEGIN');

      // 1. Check if an order already exists for this (academy_id, idempotency_key)
      const existingOrderRes = await client.query(
        `SELECT id, order_number, opaque_token, total_amount_minor, currency, status, payload_hash, expires_at 
         FROM orders 
         WHERE academy_id = $1 AND idempotency_key = $2 
         FOR UPDATE`,
        [academyId, input.idempotency_key]
      );

      if (existingOrderRes.rows.length > 0) {
        const existingOrder = existingOrderRes.rows[0];
        
        if (existingOrder.payload_hash === incomingPayloadHash) {
          await client.query('COMMIT');
          return {
            isNew: false,
            statusCode: 200,
            order: {
              order_number: existingOrder.order_number,
              opaque_token: existingOrder.opaque_token,
              total_amount_minor: existingOrder.total_amount_minor,
              currency: existingOrder.currency,
              status: existingOrder.status,
              expires_at: existingOrder.expires_at
            }
          };
        }

        await client.query('ROLLBACK');
        const conflictErr = new Error('The idempotency key was previously used with different checkout data.');
        conflictErr.statusCode = 409;
        conflictErr.code = 'IDEMPOTENCY_PAYLOAD_MISMATCH';
        throw conflictErr;
      }

      // 2. Validate product and fetch official price server-side
      const priceRes = await client.query(
        `SELECT p.amount_minor, p.currency 
         FROM prices p
         JOIN products pr ON pr.academy_id = p.academy_id AND pr.sku = p.sku
         WHERE p.academy_id = $1 AND p.sku = $2 AND p.is_current = TRUE AND pr.is_active = TRUE`,
        [academyId, input.sku]
      );

      if (priceRes.rows.length === 0) {
        await client.query('ROLLBACK');
        const notFoundErr = new Error(`Product SKU '${input.sku}' not found or inactive for academy '${academyId}'.`);
        notFoundErr.statusCode = 404;
        notFoundErr.code = 'PRODUCT_NOT_FOUND';
        throw notFoundErr;
      }

      const { amount_minor, currency } = priceRes.rows[0];

      // 3. Lead Identity Preservation:
      // An anonymous checkout MUST NOT modify ANY field of an existing lead, including phone even if NULL.
      // Insert if not exists. If already exists, do nothing (DO NOTHING) and retrieve existing ID.
      const leadId = crypto.randomUUID();
      const leadRes = await client.query(
        `INSERT INTO leads (id, academy_id, email_normalized, name, phone)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (academy_id, email_normalized) 
         DO NOTHING
         RETURNING id, name, phone`,
        [
          leadId,
          academyId,
          emailNormalized,
          nameTrimmed,
          phoneTrimmed
        ]
      );

      let actualLeadId;
      if (leadRes.rows.length > 0) {
        actualLeadId = leadRes.rows[0].id;
      } else {
        // Lead already exists: fetch existing record without updating any fields
        const existingLead = await client.query(
          `SELECT id, name, phone FROM leads WHERE academy_id = $1 AND email_normalized = $2`,
          [academyId, emailNormalized]
        );
        actualLeadId = existingLead.rows[0].id;
      }

      // 4. Record Consent
      const consentId = crypto.randomUUID();
      await client.query(
        `INSERT INTO consents (id, academy_id, lead_id, privacy_version, terms_accepted, marketing_opt_in, user_agent)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          consentId,
          academyId,
          actualLeadId,
          input.privacy_version || 'v1.0',
          true,
          input.marketing_opt_in === true,
          userAgent.substring(0, 255)
        ]
      );

      // 5. Generate collision-free monotonic order number via sequence
      const orderId = crypto.randomUUID();
      const seqRes = await client.query("SELECT nextval('order_number_seq') AS seq");
      const seqVal = seqRes.rows[0].seq;
      const datePart = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const orderNumber = `DPS-${datePart}-${seqVal}`;
      const opaqueToken = crypto.randomBytes(32).toString('hex');
      
      // Separated TTLs:
      // Order expires in 72 hours for payment; status inquiry token valid for 30 days
      const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000); 
      const tokenExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

      // 6. Insert Order
      const orderRes = await client.query(
        `INSERT INTO orders (
            id, academy_id, order_number, opaque_token, lead_id, currency, 
            total_amount_minor, status, idempotency_key, payload_hash, 
            utm_source, utm_medium, utm_campaign, utm_content,
            expires_at, token_expires_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending_payment', $8, $9, $10, $11, $12, $13, $14, $15)
         RETURNING id, order_number, opaque_token, total_amount_minor, currency, status, expires_at`,
        [
          orderId,
          academyId,
          orderNumber,
          opaqueToken,
          actualLeadId,
          currency,
          amount_minor,
          input.idempotency_key,
          incomingPayloadHash,
          sanitizedUtm.source,
          sanitizedUtm.medium,
          sanitizedUtm.campaign,
          sanitizedUtm.content,
          expiresAt,
          tokenExpiresAt
        ]
      );

      const newOrder = orderRes.rows[0];

      // 7. Insert Order Item (composite FK to products and orders)
      const orderItemId = crypto.randomUUID();
      await client.query(
        `INSERT INTO order_items (id, academy_id, order_id, sku, unit_amount_minor, quantity)
         VALUES ($1, $2, $3, $4, $5, 1)`,
        [orderItemId, academyId, newOrder.id, input.sku, amount_minor]
      );

      // 8. Record Audit Event (safe metadata without sensitive objects)
      const orderEventId = crypto.randomUUID();
      await client.query(
        `INSERT INTO order_events (id, academy_id, order_id, previous_status, new_status, reason, metadata)
         VALUES ($1, $2, $3, NULL, 'pending_payment', 'Checkout initiated from web', $4)`,
        [
          orderEventId,
          academyId, 
          newOrder.id, 
          JSON.stringify({ 
            sku: input.sku, 
            amount_minor, 
            utm_source: sanitizedUtm.source,
            utm_campaign: sanitizedUtm.campaign
          })
        ]
      );

      // Injected failure hook for testing transactional rollback from service
      if (opts.injectFailureBeforeCommit) {
        throw new Error('INJECTED_TRANSACTION_FAILURE_BEFORE_COMMIT');
      }

      await client.query('COMMIT');

      return {
        isNew: true,
        statusCode: 201,
        order: {
          order_number: newOrder.order_number,
          opaque_token: newOrder.opaque_token,
          total_amount_minor: newOrder.total_amount_minor,
          currency: newOrder.currency,
          status: newOrder.status,
          expires_at: newOrder.expires_at
        }
      };

    } catch (err) {
      // Always rollback active transaction on error
      try {
        await client.query('ROLLBACK');
      } catch (_) {}
      
      // PostgreSQL Unique Violation (23505) error handling for concurrent race conditions
      if (err.code === '23505' || err.code === 23505 || (err.data && err.data.code === '23505')) {
        // Reuse SAME connection without acquiring another connection from the pool!
        if (!err.constraint || err.constraint === 'uq_orders_academy_idempotency') {
          const existingRes = await client.query(
            `SELECT order_number, opaque_token, total_amount_minor, currency, status, payload_hash, expires_at 
             FROM orders 
             WHERE academy_id = $1 AND idempotency_key = $2`,
            [academyId, input.idempotency_key]
          );

          if (existingRes.rows.length > 0) {
            const existing = existingRes.rows[0];
            if (existing.payload_hash === incomingPayloadHash) {
              return {
                isNew: false,
                statusCode: 200,
                order: {
                  order_number: existing.order_number,
                  opaque_token: existing.opaque_token,
                  total_amount_minor: existing.total_amount_minor,
                  currency: existing.currency,
                  status: existing.status,
                  expires_at: existing.expires_at
                }
              };
            } else {
              const conflictErr = new Error('The idempotency key was previously used with different checkout data.');
              conflictErr.statusCode = 409;
              conflictErr.code = 'IDEMPOTENCY_PAYLOAD_MISMATCH';
              throw conflictErr;
            }
          }
        }

        if (err.constraint === 'uq_orders_academy_number') {
          const conflictErr = new Error('Order number conflict occurred. Please retry.');
          conflictErr.statusCode = 409;
          conflictErr.code = 'ORDER_NUMBER_CONFLICT';
          throw conflictErr;
        }
      }

      throw err;
    } finally {
      // Guarantee release of client back to pool
      client.release();
    }
  }

  /**
   * Retrieves order status by opaque token (Zero PII).
   * Checks token validity and marks order as expired if overdue.
   */
  async getOrderStatus(opaqueToken) {
    if (!opaqueToken || typeof opaqueToken !== 'string' || opaqueToken.length !== 64) {
      const err = new Error('Order not found.');
      err.statusCode = 404;
      err.code = 'ORDER_NOT_FOUND';
      throw err;
    }

    const academyId = this.defaultAcademyId;
    const res = await this.db.query(
      `SELECT o.id, o.order_number, o.status, o.total_amount_minor, o.currency, 
              o.created_at, o.expires_at, o.token_expires_at, oi.sku
       FROM orders o
       JOIN order_items oi ON oi.order_id = o.id AND oi.academy_id = o.academy_id
       WHERE o.academy_id = $1 AND o.opaque_token = $2`,
      [academyId, opaqueToken]
    );

    if (res.rows.length === 0) {
      const err = new Error('Order not found.');
      err.statusCode = 404;
      err.code = 'ORDER_NOT_FOUND';
      throw err;
    }

    const order = res.rows[0];
    const now = new Date();

    // Check token expiration
    if (new Date(order.token_expires_at) < now) {
      const err = new Error('Status token has expired.');
      err.statusCode = 410;
      err.code = 'TOKEN_EXPIRED';
      throw err;
    }

    // Atomic Lazy expiration in transaction:
    // UPDATE orders SET status = 'expired' WHERE status = 'pending_payment' AND expires_at < now()
    // AND INSERT INTO order_events in same transaction
    if (order.status === 'pending_payment' && new Date(order.expires_at) < now) {
      const client = await this.db.getClient();
      try {
        await client.query('BEGIN');
        const updateRes = await client.query(
          `UPDATE orders 
           SET status = 'expired' 
           WHERE id = $1 AND academy_id = $2 AND status = 'pending_payment'
           RETURNING id`,
          [order.id, academyId]
        );

        if (updateRes.rows.length > 0) {
          await client.query(
            `INSERT INTO order_events (id, academy_id, order_id, previous_status, new_status, reason)
             VALUES ($1, $2, $3, 'pending_payment', 'expired', 'Order payment window elapsed (72h)')`,
            [crypto.randomUUID(), academyId, order.id]
          );
          order.status = 'expired';
        }
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    }

    return {
      order_number: order.order_number,
      status: order.status,
      sku: order.sku,
      total_amount_minor: order.total_amount_minor,
      currency: order.currency,
      created_at: order.created_at,
      expires_at: order.expires_at
    };
  }
}
