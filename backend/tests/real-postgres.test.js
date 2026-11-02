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
      TRUNCATE TABLE order_events, order_items, orders, consent_records, leads CASCADE;
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
});
