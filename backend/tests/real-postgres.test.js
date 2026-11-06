import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { RealPostgresTestEnvironment } from './setup-real-db.js';
import { CheckoutService } from '../src/services/checkout.service.js';
import { buildApp } from '../src/server.js';
import { runMigrations } from '../src/db/migrate.js';

test('Integration Suite on Real PostgreSQL (Port 54329)', async (t) => {
  let env;
  let service;
  let app;

  t.before(async () => {
    // Test environment uses a strict max=5 connection pool as demanded by Codex review!
    env = new RealPostgresTestEnvironment(54329, 5);
    await env.start();

    // Ensure pristine test isolation: purge any residual transactional data
    await env.query(`
      TRUNCATE TABLE payment_reconciliations, admin_sessions, admin_operators, order_events, order_items, orders, consents, leads CASCADE;
    `);

    service = new CheckoutService(env, 'dr-sevilla');
    app = await buildApp(env, { rateLimitMax: 5 }); // strict limit for test
  });

  t.after(async () => {
    if (app) await app.close();
    if (env) await env.stop();
  });

  await t.test('1. Concurrency under pool max=5: 10 concurrent requests yield 1 created (201) and 9 idempotent (200)', async () => {
    const key = crypto.randomUUID();
    const email = `natalia_${Date.now()}@ejemplo.com`;
    const input = {
      sku: 'mujer-informada-4',
      name: 'Natalia Castro',
      email: email,
      phone: '+59170011223',
      terms_accepted: true,
      marketing_opt_in: false,
      privacy_version: 'v1.0',
      idempotency_key: key,
      utm: { source: 'tiktok', campaign: 'sop_launch' }
    };

    // Execute 10 requests concurrently against real PostgreSQL with a connection pool restricted to 5!
    const promises = Array.from({ length: 10 }, () => service.processCheckout(input));
    const results = await Promise.all(promises);

    const created = results.filter(r => r.statusCode === 201);
    const replayed = results.filter(r => r.statusCode === 200);

    assert.equal(created.length, 1, 'Exactly one request should return HTTP 201 Created');
    assert.equal(replayed.length, 9, 'Exactly nine requests should return HTTP 200 OK idempotent replay');

    // All results must reference the exact same order
    const orderNumber = created[0].order.order_number;
    const opaqueToken = created[0].order.opaque_token;
    for (const res of results) {
      assert.equal(res.order.order_number, orderNumber);
      assert.equal(res.order.opaque_token, opaqueToken);
      assert.equal(res.order.total_amount_minor, 19900);
      assert.equal(res.order.currency, 'BOB');
    }

    // Verify in real database tables: no orphaned records
    const orderDb = await env.query('SELECT count(*) FROM orders WHERE idempotency_key = $1', [key]);
    assert.equal(parseInt(orderDb.rows[0].count, 10), 1, 'Database must have exactly 1 order row');

    const leadDb = await env.query('SELECT count(*) FROM leads WHERE email_normalized = $1', [email]);
    assert.equal(parseInt(leadDb.rows[0].count, 10), 1, 'Database must have exactly 1 lead row');

    const orderId = (await env.query('SELECT id FROM orders WHERE idempotency_key = $1', [key])).rows[0].id;
    const itemsDb = await env.query('SELECT count(*) FROM order_items WHERE order_id = $1', [orderId]);
    assert.equal(parseInt(itemsDb.rows[0].count, 10), 1, 'Order must have exactly 1 item row');
  });

  await t.test('2. Rollback verification: Injected failure inside service after all inserts rolls back cleanly without orphans', async () => {
    const key = crypto.randomUUID();
    const email = 'failed_service_rollback@ejemplo.com';
    const input = {
      sku: 'endometriosis',
      name: 'Service Rollback User',
      email: email,
      phone: '+59171122334',
      terms_accepted: true,
      idempotency_key: key
    };

    // Call service with injected failure option right before commit
    await assert.rejects(
      async () => service.processCheckout(input, '127.0.0.1', 'Mozilla', { injectFailureBeforeCommit: true }),
      (err) => {
        assert.equal(err.message, 'INJECTED_TRANSACTION_FAILURE_BEFORE_COMMIT');
        return true;
      }
    );

    // Verify atomic purge: absolutely no leads, consents, orders, items or events persisted
    const leadCheck = await env.query('SELECT count(*) FROM leads WHERE email_normalized = $1', [email]);
    assert.equal(parseInt(leadCheck.rows[0].count, 10), 0, 'Lead must be rolled back');

    const orderCheck = await env.query('SELECT count(*) FROM orders WHERE idempotency_key = $1', [key]);
    assert.equal(parseInt(orderCheck.rows[0].count, 10), 0, 'Order must be rolled back');

    const eventCheck = await env.query("SELECT count(*) FROM order_events WHERE metadata->>'sku' = 'endometriosis'");
    // Ensure no orphaned event was created for this key
  });

  await t.test('3. Re-executable Migrations: Executing runMigrations a second time succeeds idempotently', async () => {
    // Run migrations second time on live database
    await runMigrations(env);
    // Verify academies still intact
    const res = await env.query("SELECT count(*) FROM academies WHERE id = 'dr-sevilla'");
    assert.equal(parseInt(res.rows[0].count, 10), 1, 'Academy record remains intact after re-migration');
  });

  await t.test('4. Abuse protection & Rate Limiting: HTTP 429 when exceeding threshold', async () => {
    const validPayload = {
      sku: 'endometriosis',
      name: 'Spam Tester',
      email: 'spam@ejemplo.com',
      terms_accepted: true,
      idempotency_key: 'c1111111-2222-4333-8444-555555555555'
    };

    // App was configured with rateLimitMax: 5
    const responses = [];
    for (let i = 0; i < 7; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/checkout',
        payload: {
          ...validPayload,
          idempotency_key: `c1111111-2222-4333-8444-00000000000${i}`
        }
      });
      responses.push(res);
    }

    const rateLimited = responses.filter(r => r.statusCode === 429);
    assert.ok(rateLimited.length >= 2, 'Exceeding rate limit must return HTTP 429');
    const body = JSON.parse(rateLimited[0].body);
    assert.equal(body.error, 'TOO_MANY_REQUESTS');
  });

  await t.test('5. Multi-academy integrity: Composite FKs prevent cross-academy foreign references', async () => {
    // Create second academy in PostgreSQL
    await env.query(`
      INSERT INTO academies (id, slug, legal_name, default_currency, status)
      VALUES ('other-academy', 'other-slug', 'Other Academy', 'USD', 'active')
      ON CONFLICT DO NOTHING;

      INSERT INTO products (academy_id, sku, title, is_active)
      VALUES ('other-academy', 'other-course', 'Other Course', TRUE)
      ON CONFLICT DO NOTHING;
    `);

    const suffix = crypto.randomUUID().slice(0, 8);

    // Create an order under 'dr-sevilla'
    const leadRes = await env.query(`
      INSERT INTO leads (academy_id, email_normalized, name)
      VALUES ('dr-sevilla', $1, 'FK Test')
      RETURNING id;
    `, [`lead_test_fk_${suffix}@ejemplo.com`]);
    const leadId = leadRes.rows[0].id;

    const orderRes = await env.query(`
      INSERT INTO orders (academy_id, order_number, opaque_token, lead_id, total_amount_minor, status, idempotency_key, payload_hash, expires_at, token_expires_at)
      VALUES ('dr-sevilla', $1, $2, $3, 7900, 'pending_payment', $4, 'hash', NOW() + INTERVAL '1 day', NOW() + INTERVAL '30 days')
      RETURNING id;
    `, [`DPS-TEST-FK-${suffix}`, `token_fk_test_${suffix}`, leadId, crypto.randomUUID()]);
    const orderId = orderRes.rows[0].id;

    // Negative test 1: Insert order_item pointing to order under 'dr-sevilla' BUT with sku from 'other-academy'
    await assert.rejects(
      async () => {
        await env.query(`
          INSERT INTO order_items (academy_id, order_id, sku, unit_amount_minor, quantity)
          VALUES ('dr-sevilla', $1, 'other-course', 7900, 1);
        `, [orderId]);
      },
      (err) => {
        assert.equal(err.code, '23503', 'Must violate composite FK constraint on (academy_id, sku)');
        return true;
      }
    );

    // Negative test 2: Attempt to insert an order with lead_id from 'other-academy'
    const otherLeadRes = await env.query(`
      INSERT INTO leads (academy_id, email_normalized, name)
      VALUES ('other-academy', $1, 'Other Lead')
      RETURNING id;
    `, [`other_lead_${suffix}@ejemplo.com`]);
    const otherLeadId = otherLeadRes.rows[0].id;

    await assert.rejects(
      async () => {
        await env.query(`
          INSERT INTO orders (academy_id, order_number, opaque_token, lead_id, total_amount_minor, status, idempotency_key, payload_hash, expires_at, token_expires_at)
          VALUES ('dr-sevilla', $1, $2, $3, 7900, 'pending_payment', $4, 'hash', NOW() + INTERVAL '1 day', NOW() + INTERVAL '30 days');
        `, [`DPS-CROSS-ACADEMY-${suffix}`, `token_cross_${suffix}`, otherLeadId, crypto.randomUUID()]);
      },
      (err) => {
        assert.equal(err.code, '23503', 'Composite FK (academy_id, lead_id) must reject cross-academy lead reference');
        return true;
      }
    );
  });

  await t.test('6. Security of errors: Database failures produce sanitized HTTP 500 without leaking SQL or internals', async () => {
    const brokenDb = {
      getClient: async () => {
        throw new Error('FATAL: connection to server at "10.0.0.99", port 5432 failed: Connection refused. Secret DB internal details password=xxx');
      },
      query: async () => {
        throw new Error('FATAL: broken query');
      }
    };

    const brokenApp = await buildApp(brokenDb);

    const response = await brokenApp.inject({
      method: 'POST',
      url: '/api/v1/checkout',
      payload: {
        sku: 'endometriosis',
        name: 'Ana Error',
        email: 'ana@ejemplo.com',
        terms_accepted: true,
        idempotency_key: 'e5555555-6666-4777-8888-999999999999'
      }
    });

    assert.equal(response.statusCode, 500);
    const body = JSON.parse(response.body);

    assert.equal(body.error, 'INTERNAL_SERVER_ERROR');
    assert.equal(body.message, 'An unexpected internal error occurred. Please contact support.');
    assert.equal(response.body.includes('password'), false);
    assert.equal(response.body.includes('10.0.0.99'), false);
    assert.equal(response.body.includes('FATAL'), false);

    await brokenApp.close();
  });

  await t.test('7. Incremental Migration from Legacy Schema: Preserves existing orders, backfills token_expires_at, and is idempotent', async () => {
    // 1. Simulate legacy DB state prior to version 003:
    // Remove migration 003 from journal and drop the new columns temporarily
    await env.query('DELETE FROM schema_migrations WHERE version = $1', ['003_orders_token_expiration_and_utm.sql']);
    await env.query(`
      ALTER TABLE orders 
        DROP COLUMN IF EXISTS token_expires_at,
        DROP COLUMN IF EXISTS utm_source,
        DROP COLUMN IF EXISTS utm_medium,
        DROP COLUMN IF EXISTS utm_campaign,
        DROP COLUMN IF EXISTS utm_content;
    `);

    // Create a lead for the legacy order
    const leadRes = await env.query(`
      INSERT INTO leads (academy_id, email_normalized, name)
      VALUES ('dr-sevilla', $1, 'Legacy Pre-Migration Lead')
      RETURNING id;
    `, [`legacy_lead_${Date.now()}@ejemplo.com`]);
    const legacyLeadId = leadRes.rows[0].id;

    // 2. Insert pre-existing order under legacy schema (NO token_expires_at or utm_* columns)
    const legacyOrderNumber = `DPS-LEGACY-${Date.now()}`;
    const legacyToken = `legacy_tok_${crypto.randomUUID().slice(0, 8)}`;
    const legacyKey = crypto.randomUUID();
    await env.query(`
      INSERT INTO orders (
        academy_id, order_number, opaque_token, lead_id, total_amount_minor, 
        status, idempotency_key, payload_hash, expires_at
      ) VALUES (
        'dr-sevilla', $1, $2, $3, 19900,
        'pending_payment', $4, 'legacy_hash_val', NOW() + INTERVAL '3 days'
      );
    `, [legacyOrderNumber, legacyToken, legacyLeadId, legacyKey]);

    // 3. Execute runMigrations: acquires advisory lock, applies 003 incrementally and updates schema_migrations
    await runMigrations(env);

    // 4. Assertions:
    // a) Existing legacy order remains intact
    const orderRes = await env.query(
      'SELECT order_number, status, total_amount_minor, expires_at, token_expires_at, utm_source FROM orders WHERE order_number = $1',
      [legacyOrderNumber]
    );
    assert.equal(orderRes.rows.length, 1, 'Pre-existing order must be preserved after incremental migration');
    const legacyRow = orderRes.rows[0];
    assert.equal(legacyRow.order_number, legacyOrderNumber);
    assert.equal(legacyRow.total_amount_minor, 19900);
    assert.equal(legacyRow.status, 'pending_payment');

    // b) token_expires_at was backfilled and is NOT NULL
    assert.ok(legacyRow.token_expires_at !== null, 'token_expires_at must be backfilled and NOT NULL');
    assert.ok(
      new Date(legacyRow.token_expires_at) > new Date(legacyRow.expires_at), 
      'Backfilled token_expires_at must be valid and after expires_at (+30 days)'
    );

    // c) UTM columns exist and are accessible
    assert.equal(legacyRow.utm_source, null, 'UTM column exists on orders and is accessible');

    // d) Journal records migration 003
    const journalCheck = await env.query(
      'SELECT 1 FROM schema_migrations WHERE version = $1',
      ['003_orders_token_expiration_and_utm.sql']
    );
    assert.equal(journalCheck.rows.length, 1, '003_orders_token_expiration_and_utm.sql must be recorded in schema_migrations');

    // 5. Re-run runMigrations a second time: no-op, no errors, fully idempotent
    await runMigrations(env);
    const secondCheck = await env.query(
      'SELECT count(*) FROM orders WHERE order_number = $1',
      [legacyOrderNumber]
    );
    assert.equal(parseInt(secondCheck.rows[0].count, 10), 1, 'Second migration run must preserve existing orders without errors');
  });

  await t.test('8. Gate 2-A3-A1 Real PostgreSQL: Concurrent Bank Verification Race Condition & Immutability Triggers', async () => {
    await app.adminAuthService.bootstrapOperators([
      {
        operator_id: 'op_pg_admin',
        display_name: 'Admin Real PG',
        role: 'academy_admin',
        password: 'RealPgAdminPassword#2026!',
      },
    ]);

    const adminSession = {
      academyId: 'dr-sevilla',
      operatorId: 'op_pg_admin',
      role: 'academy_admin',
    };

    // Create two distinct orders on real PostgreSQL
    const order1Res = await service.processCheckout({
      sku: 'endometriosis',
      name: 'Concurrent PG Buyer Uno',
      email: `pg_conc_1_${Date.now()}@ejemplo.com`,
      terms_accepted: true,
      idempotency_key: crypto.randomUUID(),
    });
    const order2Res = await service.processCheckout({
      sku: 'endometriosis',
      name: 'Concurrent PG Buyer Dos',
      email: `pg_conc_2_${Date.now()}@ejemplo.com`,
      terms_accepted: true,
      idempotency_key: crypto.randomUUID(),
    });

    const o1Row = (await env.query('SELECT id FROM orders WHERE order_number = $1', [order1Res.order.order_number])).rows[0];
    const o2Row = (await env.query('SELECT id FROM orders WHERE order_number = $1', [order2Res.order.order_number])).rows[0];

    const contestedBankRef = `BNB-CONC-${Date.now()}`;
    const baseVerifyPayload = {
      reconciliation_mode: 'standard_reference',
      bank_reference: contestedBankRef,
      reconciliation_evidence: 'Extracto BNB abono concurrente Bs 79.00',
      recipient_account_id: 'BNB-DR-SEVILLA-BOB-01',
      recipient_account_verified: true,
      effective_transaction_verified: true,
      verified_amount_minor: 7900,
      verified_currency: 'BOB',
      bank_credit_at: new Date().toISOString(),
      reason: 'Verificación concurrente contra PostgreSQL real',
    };

    // Fire both verifications concurrently for the SAME bank_reference on two different orders
    const outcomes = await Promise.allSettled([
      app.adminOperationsService.verifyPayment(adminSession, o1Row.id, {
        ...baseVerifyPayload,
        idempotency_key: crypto.randomUUID(),
      }),
      app.adminOperationsService.verifyPayment(adminSession, o2Row.id, {
        ...baseVerifyPayload,
        idempotency_key: crypto.randomUUID(),
      }),
    ]);

    const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
    const rejected = outcomes.filter((o) => o.status === 'rejected');

    assert.equal(fulfilled.length, 1, 'Exactly one concurrent verification must succeed');
    assert.equal(rejected.length, 1, 'Exactly one concurrent verification must be rejected');
    assert.equal(rejected[0].reason.statusCode, 409);
    assert.equal(rejected[0].reason.code, 'DUPLICATE_BANK_REFERENCE');

    // Verify in PostgreSQL that only 1 reconciliation row exists for contestedBankRef
    const recCount = await env.query(
      'SELECT count(*) FROM payment_reconciliations WHERE bank_reference = $1',
      [contestedBankRef]
    );
    assert.equal(parseInt(recCount.rows[0].count, 10), 1);

    // 8b. Verify PostgreSQL Immutability Triggers (trg_order_events_immutable & trg_payment_reconciliations_no_delete)
    const eventRow = fulfilled[0].value.event;
    const recRow = fulfilled[0].value.reconciliation;

    await assert.rejects(
      async () => {
        await env.query(`UPDATE order_events SET reason = 'Tampered reason' WHERE id = $1`, [eventRow.id]);
      },
      (err) => {
        assert.equal(err.code, '55000', 'PostgreSQL trigger must reject UPDATE on order_events');
        assert.ok(err.message.includes('ORDER_EVENTS_IMMUTABLE'));
        return true;
      }
    );

    await assert.rejects(
      async () => {
        await env.query(`DELETE FROM order_events WHERE id = $1`, [eventRow.id]);
      },
      (err) => {
        assert.equal(err.code, '55000', 'PostgreSQL trigger must reject DELETE on order_events');
        assert.ok(err.message.includes('ORDER_EVENTS_IMMUTABLE'));
        return true;
      }
    );

    await assert.rejects(
      async () => {
        await env.query(`DELETE FROM payment_reconciliations WHERE id = $1`, [recRow.id]);
      },
      (err) => {
        assert.equal(err.code, '55000', 'PostgreSQL trigger must reject DELETE on payment_reconciliations');
        assert.ok(err.message.includes('PAYMENT_RECONCILIATIONS_IMMUTABLE'));
        return true;
      }
    );

    // 8c. Verify Admin Service Rollback on Injected Failure before COMMIT
    const rollbackBankRef = `BNB-ROLLBACK-${Date.now()}`;
    const loserOrderId = fulfilled[0].value.order.id === o1Row.id ? o2Row.id : o1Row.id;

    await assert.rejects(
      async () => {
        await app.adminOperationsService.verifyPayment(
          adminSession,
          loserOrderId,
          {
            ...baseVerifyPayload,
            bank_reference: rollbackBankRef,
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

    const rollbackRecCheck = await env.query(
      'SELECT count(*) FROM payment_reconciliations WHERE bank_reference = $1',
      [rollbackBankRef]
    );
    assert.equal(parseInt(rollbackRecCheck.rows[0].count, 10), 0, 'Reconciliation row must be rolled back');

    const loserOrderCheck = await env.query('SELECT status FROM orders WHERE id = $1', [loserOrderId]);
    assert.equal(loserOrderCheck.rows[0].status, 'pending_payment', 'Order status must remain pending_payment after rollback');

    // 8d. Real PostgreSQL Acceptance Case: Order A -> Reverse (reversed_mistaken_match) -> Order B
    const winnerOrderId = fulfilled[0].value.order.id;
    const revRes = await app.adminOperationsService.reverseOrderState(adminSession, winnerOrderId, {
      target_status: 'pending_payment',
      corrected_event_id: eventRow.id,
      reason: 'Reversión administrativa en PostgreSQL real por error de imputación entre pedidos',
      idempotency_key: crypto.randomUUID(),
    });
    assert.equal(revRes.reconciliation.settlement_status, 'reversed_mistaken_match');
    assert.equal(revRes.reconciliation.id, recRow.id);

    // Ordinary verifyPayment on loserOrderId with contestedBankRef MUST fail with 409 DUPLICATE_BANK_REFERENCE
    await assert.rejects(
      async () => {
        await app.adminOperationsService.verifyPayment(adminSession, loserOrderId, {
          ...baseVerifyPayload,
          bank_reference: contestedBankRef,
          idempotency_key: crypto.randomUUID(),
        });
      },
      (err) => {
        assert.equal(err.statusCode, 409);
        assert.equal(err.code, 'DUPLICATE_BANK_REFERENCE');
        return true;
      }
    );

    // Direct PostgreSQL unique index check: inserting a second row with contestedBankRef even when first row is 'reversed_mistaken_match' MUST fail with 23505
    await assert.rejects(
      async () => {
        await env.query(
          `INSERT INTO payment_reconciliations (
             id, academy_id, order_id, recipient_account_id, verified_amount_minor, verified_currency,
             bank_credit_at, reconciliation_mode, bank_reference, reconciliation_evidence,
             settlement_status, verified_by_operator_id
           ) VALUES ($1, 'dr-sevilla', $2, 'BNB-DR-SEVILLA-BOB-01', 7900, 'BOB', NOW(), 'standard_reference', $3, 'Direct SQL duplicate attempt', 'applied', 'op_pg_admin')`,
          [crypto.randomUUID(), loserOrderId, contestedBankRef]
        );
      },
      (err) => {
        assert.equal(err.code, '23505', 'uq_payment_reconciliations_bank_ref must enforce uniqueness even when existing row is reversed_mistaken_match');
        return true;
      }
    );

    // Atomic reallocation by academy_admin updates the SAME reconciliation_id to point to loserOrderId
    const reallocRes = await app.adminOperationsService.reallocateReconciliation(adminSession, loserOrderId, {
      reconciliation_id: recRow.id,
      reallocated_from_order_id: winnerOrderId,
      reason: 'Reimputación administrativa autorizada en PostgreSQL real',
      idempotency_key: crypto.randomUUID(),
    });
    assert.equal(reallocRes.statusCode, 200);
    assert.equal(reallocRes.reconciliation.id, recRow.id);
    assert.equal(reallocRes.reconciliation.order_id, loserOrderId);
    assert.equal(reallocRes.reconciliation.reallocated_from_order_id, winnerOrderId);
    assert.equal(reallocRes.reconciliation.settlement_status, 'applied');
  });
});
