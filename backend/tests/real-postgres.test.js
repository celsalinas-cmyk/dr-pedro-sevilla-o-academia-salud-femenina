import test from 'node:test';
import assert from 'node:assert/strict';
import { RealPostgresTestEnvironment } from './setup-real-db.js';
import { CheckoutService } from '../src/services/checkout.service.js';
import { buildApp } from '../src/server.js';

test('Integration Suite on Real PostgreSQL (Port 54329)', async (t) => {
  let env;
  let service;
  let app;

  t.before(async () => {
    env = new RealPostgresTestEnvironment(54329);
    await env.start();
    service = new CheckoutService(env, 'dr-sevilla');
    app = await buildApp(env);
  });

  t.after(async () => {
    if (app) await app.close();
    if (env) await env.stop();
  });

  await t.test('1. Concurrency: 10 concurrent requests with same idempotency key result in 1 created and 9 idempotent responses', async () => {
    const key = 'a1111111-2222-4333-8444-555555555555';
    const input = {
      sku: 'mujer-informada-4',
      name: 'Natalia Castro',
      email: 'natalia@ejemplo.com',
      phone: '+59170011223',
      terms_accepted: true,
      marketing_opt_in: false,
      privacy_version: 'v1.0',
      idempotency_key: key,
      utm: { source: 'tiktok', campaign: 'sop_launch' }
    };

    // Execute 10 requests concurrently against real PostgreSQL
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

    const leadDb = await env.query('SELECT count(*) FROM leads WHERE email_normalized = $1', ['natalia@ejemplo.com']);
    assert.equal(parseInt(leadDb.rows[0].count, 10), 1, 'Database must have exactly 1 lead row');

    const orderId = (await env.query('SELECT id FROM orders WHERE idempotency_key = $1', [key])).rows[0].id;
    const itemsDb = await env.query('SELECT count(*) FROM order_items WHERE order_id = $1', [orderId]);
    assert.equal(parseInt(itemsDb.rows[0].count, 10), 1, 'Order must have exactly 1 item row');
  });

  await t.test('2. Rollback verification: Deliberate failure after partial inserts rolls back cleanly without orphans', async () => {
    const key = 'b2222222-3333-4444-8555-666666666666';
    const email = 'failed_midway_rollback@ejemplo.com';
    const client = await env.getClient();

    // Verify atomic transactional rollback when an error occurs MIDWAY inside the transaction
    // after leads and orders have already been inserted:
    try {
      await client.query('BEGIN');

      // 1. Insert lead inside transaction
      const leadId = crypto.randomUUID();
      await client.query(
        `INSERT INTO leads (id, academy_id, email_normalized, name)
         VALUES ($1, 'dr-sevilla', $2, 'Midway User')`,
        [leadId, email]
      );

      // 2. Insert order inside transaction
      const orderId = crypto.randomUUID();
      await client.query(
        `INSERT INTO orders (id, academy_id, order_number, opaque_token, lead_id, total_amount_minor, status, idempotency_key, payload_hash, expires_at)
         VALUES ($1, 'dr-sevilla', 'DPS-ROLLBACK-TEST', 'token_midway', $2, 7900, 'pending_payment', $3, 'hash_midway', NOW() + INTERVAL '1 day')`,
        [orderId, leadId, key]
      );

      // 3. Deliberately trigger constraint violation / error MIDWAY before COMMIT
      // Violates composite FK (academy_id, sku) REFERENCES products(academy_id, sku)
      await client.query(
        `INSERT INTO order_items (id, academy_id, order_id, sku, unit_amount_minor, quantity)
         VALUES ($1, 'dr-sevilla', $2, 'nonexistent_sku_midway', 7900, 1)`,
        [crypto.randomUUID(), orderId]
      );

      await client.query('COMMIT');
      assert.fail('Should not reach commit');
    } catch (err) {
      await client.query('ROLLBACK');
      assert.equal(err.code, '23503', 'Triggered expected foreign key violation');
    } finally {
      client.release();
    }

    // Crucial assertion: Verify that NEITHER the lead NOR the order persisted in PostgreSQL
    const leadCheck = await env.query('SELECT count(*) FROM leads WHERE email_normalized = $1', [email]);
    assert.equal(parseInt(leadCheck.rows[0].count, 10), 0, 'Lead inserted before the error must NOT persist after ROLLBACK');

    const orderCheck = await env.query('SELECT count(*) FROM orders WHERE idempotency_key = $1', [key]);
    assert.equal(parseInt(orderCheck.rows[0].count, 10), 0, 'Order inserted before the error must NOT persist after ROLLBACK');
  });

  await t.test('3. Multi-academy integrity: Composite FKs prevent cross-academy foreign references', async () => {
    // Attempt to insert an order item referencing a SKU from a different academy
    // Create a second academy directly in real PostgreSQL
    await env.query(`
      INSERT INTO academies (id, slug, legal_name, default_currency, status)
      VALUES ('other-academy', 'other-slug', 'Other Academy', 'USD', 'active')
      ON CONFLICT DO NOTHING;

      INSERT INTO products (academy_id, sku, title, is_active)
      VALUES ('other-academy', 'other-course', 'Other Course', TRUE)
      ON CONFLICT DO NOTHING;
    `);

    // Create an order under 'dr-sevilla'
    const leadRes = await env.query(`
      INSERT INTO leads (academy_id, email_normalized, name)
      VALUES ('dr-sevilla', 'lead_test_fk@ejemplo.com', 'FK Test')
      RETURNING id;
    `);
    const leadId = leadRes.rows[0].id;

    const orderRes = await env.query(`
      INSERT INTO orders (academy_id, order_number, opaque_token, lead_id, total_amount_minor, status, idempotency_key, payload_hash, expires_at)
      VALUES ('dr-sevilla', 'DPS-TEST-FK', 'token_fk_test', $1, 7900, 'pending_payment', 'c3333333-4444-4555-8666-777777777777', 'hash', NOW() + INTERVAL '1 day')
      RETURNING id;
    `, [leadId]);
    const orderId = orderRes.rows[0].id;

    // Negative test 1: Insert order_item pointing to order under 'dr-sevilla' BUT with sku from 'other-academy'
    // Composite FK (academy_id, sku) REFERENCES products(academy_id, sku) will BLOCK this
    await assert.rejects(
      async () => {
        await env.query(`
          INSERT INTO order_items (academy_id, order_id, sku, unit_amount_minor, quantity)
          VALUES ('dr-sevilla', $1, 'other-course', 7900, 1);
        `, [orderId]);
      },
      (err) => {
        assert.equal(err.code, '23503', 'Must violate foreign key constraint');
        return true;
      }
    );

    // Negative test 2: Attempt to insert an order with lead_id from 'other-academy'
    const otherLeadRes = await env.query(`
      INSERT INTO leads (academy_id, email_normalized, name)
      VALUES ('other-academy', 'other_lead@ejemplo.com', 'Other Lead')
      RETURNING id;
    `);
    const otherLeadId = otherLeadRes.rows[0].id;

    await assert.rejects(
      async () => {
        await env.query(`
          INSERT INTO orders (academy_id, order_number, opaque_token, lead_id, total_amount_minor, status, idempotency_key, payload_hash, expires_at)
          VALUES ('dr-sevilla', 'DPS-CROSS-ACADEMY', 'token_cross', $1, 7900, 'pending_payment', 'd4444444-5555-4666-8777-888888888888', 'hash', NOW() + INTERVAL '1 day');
        `, [otherLeadId]);
      },
      (err) => {
        assert.equal(err.code, '23503', 'Composite FK (academy_id, lead_id) must reject cross-academy lead reference');
        return true;
      }
    );
  });

  await t.test('4. Security of errors: Database failures produce sanitized HTTP 500 without leaking SQL or internals', async () => {
    // Send a request to an app configured with a broken database client to trigger a deliberate internal 500
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

    // Must return controlled error response
    assert.equal(body.error, 'INTERNAL_SERVER_ERROR');
    assert.equal(body.message, 'An unexpected internal error occurred. Please contact support.');
    // Must NOT leak SQL, passwords or internal connection strings
    assert.equal(response.body.includes('password'), false);
    assert.equal(response.body.includes('10.0.0.99'), false);
    assert.equal(response.body.includes('FATAL'), false);

    await brokenApp.close();
  });
});
