import crypto from 'crypto';

export class CheckoutService {
  constructor(database, defaultAcademyId = 'dr-sevilla') {
    this.db = database;
    this.defaultAcademyId = defaultAcademyId;
  }

  /**
   * Generates a deterministic canonical hash of the checkout intent.
   */
  calculatePayloadHash(data) {
    const canonicalString = [
      data.sku || '',
      (data.email || '').trim().toLowerCase(),
      (data.name || '').trim(),
      (data.phone || '').trim(),
      data.terms_accepted ? 'true' : 'false',
      data.privacy_version || 'v1.0'
    ].join('|');

    return crypto.createHash('sha256').update(canonicalString).digest('hex');
  }

  /**
   * Validates input fields rigorously (Data Minimization & Schema Check).
   */
  validateCheckoutInput(input) {
    const errors = [];

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
      errors.push('Email is required.');
    } else {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(input.email.trim()) || input.email.trim().length > 100) {
        errors.push('Email has an invalid format or exceeds 100 characters.');
      }
    }

    if (input.phone) {
      const phoneRegex = /^\+?[0-9]{7,15}$/;
      if (!phoneRegex.test(input.phone.trim())) {
        errors.push('Phone must be a valid numeric international string (7-15 digits).');
      }
    }

    if (input.terms_accepted !== true) {
      errors.push('Terms of service and privacy policy must be explicitly accepted.');
    }

    if (!input.idempotency_key || typeof input.idempotency_key !== 'string') {
      errors.push('idempotency_key (UUID) is required.');
    } else {
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!uuidRegex.test(input.idempotency_key)) {
        errors.push('idempotency_key must be a valid UUID v4.');
      }
    }

    return errors;
  }

  /**
   * Atomic transactional checkout with strict idempotency and concurrency control.
   */
  async processCheckout(input, clientIp = '127.0.0.1', userAgent = '') {
    const validationErrors = this.validateCheckoutInput(input);
    if (validationErrors.length > 0) {
      const err = new Error(validationErrors.join(' '));
      err.statusCode = 422;
      err.code = 'VALIDATION_ERROR';
      throw err;
    }

    const academyId = this.defaultAcademyId;
    const incomingPayloadHash = this.calculatePayloadHash(input);
    const emailNormalized = input.email.trim().toLowerCase();
    const nameTrimmed = input.name.trim();
    const phoneTrimmed = input.phone ? input.phone.trim() : null;

    const client = await this.db.getClient();

    try {
      await client.query('BEGIN');

      // 1. Check if an order already exists for this (academy_id, idempotency_key)
      // Using FOR UPDATE on existing row or inserting with atomic conflict handling
      const existingOrderRes = await client.query(
        `SELECT id, order_number, opaque_token, total_amount_minor, currency, status, payload_hash, expires_at 
         FROM orders 
         WHERE academy_id = $1 AND idempotency_key = $2 
         FOR UPDATE`,
        [academyId, input.idempotency_key]
      );

      if (existingOrderRes.rows.length > 0) {
        const existingOrder = existingOrderRes.rows[0];
        
        // Idempotency check:
        // Case A: Identical payload hash -> Return existing order (200 OK)
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

        // Case B: Same idempotency key, different payload -> Reject with 409 Conflict
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

      // 3. Upsert Lead (scoped unique per academy_id, email_normalized)
      const leadId = crypto.randomUUID();
      const leadRes = await client.query(
        `INSERT INTO leads (id, academy_id, email_normalized, name, phone, utm_source, utm_medium, utm_campaign, utm_content)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (academy_id, email_normalized) 
         DO UPDATE SET 
            name = EXCLUDED.name,
            phone = COALESCE(EXCLUDED.phone, leads.phone),
            updated_at = NOW()
         RETURNING id`,
        [
          leadId,
          academyId,
          emailNormalized,
          nameTrimmed,
          phoneTrimmed,
          input.utm?.source || null,
          input.utm?.medium || null,
          input.utm?.campaign || null,
          input.utm?.content || null
        ]
      );

      const actualLeadId = leadRes.rows[0].id;

      // 4. Record Consent
      const consentId = crypto.randomUUID();
      const ipHash = crypto.createHash('sha256').update(clientIp + 'salt').digest('hex').substring(0, 32);
      await client.query(
        `INSERT INTO consents (id, academy_id, lead_id, privacy_version, terms_accepted, marketing_opt_in, ip_hash, user_agent)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          consentId,
          academyId,
          actualLeadId,
          input.privacy_version || 'v1.0',
          true,
          input.marketing_opt_in === true,
          ipHash,
          userAgent.substring(0, 255)
        ]
      );

      // 5. Generate secure identifiers
      const orderId = crypto.randomUUID();
      const randomSuffix = crypto.randomInt(1000, 9999);
      const orderNumber = `DPS-2026-${randomSuffix}`;
      const opaqueToken = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000); // 72 hours TTL

      // 6. Insert Order
      const orderRes = await client.query(
        `INSERT INTO orders (
            id, academy_id, order_number, opaque_token, lead_id, currency, 
            total_amount_minor, status, idempotency_key, payload_hash, expires_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending_payment', $8, $9, $10)
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
          expiresAt
        ]
      );

      const newOrder = orderRes.rows[0];

      // 7. Insert Order Item
      const orderItemId = crypto.randomUUID();
      await client.query(
        `INSERT INTO order_items (id, academy_id, order_id, sku, unit_amount_minor, quantity)
         VALUES ($1, $2, $3, $4, $5, 1)`,
        [orderItemId, academyId, newOrder.id, input.sku, amount_minor]
      );

      // 8. Record Audit Event
      const orderEventId = crypto.randomUUID();
      await client.query(
        `INSERT INTO order_events (id, academy_id, order_id, previous_status, new_status, reason, metadata)
         VALUES ($1, $2, $3, NULL, 'pending_payment', 'Checkout initiated from web', $4)`,
        [
          orderEventId,
          academyId, 
          newOrder.id, 
          JSON.stringify({ sku: input.sku, amount_minor, utm: input.utm || {} })
        ]
      );

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
      await client.query('ROLLBACK');
      
      // PostgreSQL Unique Violation (23505) error handling for race conditions
      if (err.code === '23505' || err.code === 23505 || (err.data && err.data.code === '23505')) {
        // Race condition: another concurrent process committed the order milliseconds ago
        // Re-read committed order and apply idempotency logic
        const existingRes = await this.db.query(
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

      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Retrieves order status by opaque token (Zero PII).
   */
  async getOrderStatus(opaqueToken) {
    const academyId = this.defaultAcademyId;
    const res = await this.db.query(
      `SELECT o.order_number, o.status, o.total_amount_minor, o.currency, o.created_at, o.expires_at, oi.sku
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

    return res.rows[0];
  }
}
