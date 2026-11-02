import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDatabase } from './setup-db.js';
import { CheckoutService } from '../src/services/checkout.service.js';

test('Checkout & Idempotency Suite (PostgreSQL Atomic Constraints)', async (t) => {
  let testDb;
  let service;

  t.beforeEach(async () => {
    testDb = await createTestDatabase();
    service = new CheckoutService(testDb, 'dr-sevilla');
  });

  t.afterEach(async () => {
    await testDb.close();
  });

  await t.test('1. Successful checkout creates order with server-side price (Bs 199 for pack)', async () => {
    const input = {
      sku: 'mujer-informada-4',
      name: 'Valeria Mendoza',
      email: 'valeria@ejemplo.com',
      phone: '+59178456338',
      terms_accepted: true,
      privacy_version: 'v1.0',
      idempotency_key: 'a0000000-0000-4000-8000-000000000001',
      utm: { source: 'instagram', medium: 'reels' }
    };

    const res = await service.processCheckout(input, '192.168.1.1', 'Mozilla/5.0');
    assert.equal(res.statusCode, 201);
    assert.equal(res.isNew, true);
    assert.equal(res.order.total_amount_minor, 19900); // Bs 199.00
    assert.equal(res.order.currency, 'BOB');
    assert.equal(res.order.status, 'pending_payment');
    assert.match(res.order.order_number, /^DPS-\d{8}-\d+$/);
    assert.ok(res.order.opaque_token);
  });

  await t.test('2. Idempotent retry with identical payload returns existing order (200 OK)', async () => {
    const input = {
      sku: 'sop',
      name: 'Lucia Rios',
      email: 'lucia@ejemplo.com',
      phone: '+59169058830',
      terms_accepted: true,
      privacy_version: 'v1.0',
      idempotency_key: 'b0000000-0000-4000-8000-000000000002',
    };

    const firstRes = await service.processCheckout(input);
    assert.equal(firstRes.statusCode, 201);
    assert.equal(firstRes.order.total_amount_minor, 7900); // Bs 79.00

    // Replay call (network retry or page reload)
    const secondRes = await service.processCheckout(input);
    assert.equal(secondRes.statusCode, 200);
    assert.equal(secondRes.isNew, false);
    assert.equal(secondRes.order.order_number, firstRes.order.order_number);
    assert.equal(secondRes.order.opaque_token, firstRes.order.opaque_token);
    assert.equal(secondRes.order.total_amount_minor, 7900);
  });

  await t.test('3. Reusing idempotency key with conflicting payload returns 409 Conflict', async () => {
    const key = 'c0000000-0000-4000-8000-000000000003';
    const originalInput = {
      sku: 'vaginosis',
      name: 'Elena Morales',
      email: 'elena@ejemplo.com',
      terms_accepted: true,
      idempotency_key: key
    };

    const firstRes = await service.processCheckout(originalInput);
    assert.equal(firstRes.statusCode, 201);

    // Conflicting call with same idempotency key but different SKU
    const conflictingInput = {
      sku: 'endometriosis',
      name: 'Elena Morales',
      email: 'elena@ejemplo.com',
      terms_accepted: true,
      idempotency_key: key
    };

    await assert.rejects(
      async () => service.processCheckout(conflictingInput),
      (err) => {
        assert.equal(err.statusCode, 409);
        assert.equal(err.code, 'IDEMPOTENCY_PAYLOAD_MISMATCH');
        return true;
      }
    );
  });

  await t.test('4. Atomic unique constraint prevents duplicates in concurrent execution', async () => {
    const key = 'd0000000-0000-4000-8000-000000000004';
    const input = {
      sku: 'aprende-mujer',
      name: 'Carla Diaz',
      email: 'carla@ejemplo.com',
      terms_accepted: true,
      idempotency_key: key
    };

    // Execute 5 concurrent requests simultaneously
    const results = await Promise.all([
      service.processCheckout(input),
      service.processCheckout(input),
      service.processCheckout(input),
      service.processCheckout(input),
      service.processCheckout(input)
    ]);

    // Exactly one created (201), the rest replayed (200)
    const createdCount = results.filter(r => r.statusCode === 201).length;
    const replayedCount = results.filter(r => r.statusCode === 200).length;

    assert.equal(createdCount, 1, 'Only one order should have been created (201)');
    assert.equal(replayedCount, 4, 'All concurrent calls should succeed idempotently (200)');

    // Verify DB count
    const countRes = await testDb.query(
      "SELECT count(*) FROM orders WHERE academy_id = 'dr-sevilla' AND idempotency_key = $1",
      [key]
    );
    assert.equal(parseInt(countRes.rows[0].count, 10), 1, 'Database must have exactly 1 order row');
  });

  await t.test('5. Data Minimization & Input Validation: Rejects invalid or open fields', async () => {
    const base = {
      sku: 'endometriosis',
      name: 'Valid Name',
      email: 'valid@ejemplo.com',
      terms_accepted: true,
      idempotency_key: 'e0000000-0000-4000-8000-000000000005'
    };

    // Missing terms accepted
    await assert.rejects(
      () => service.processCheckout({ ...base, terms_accepted: false }),
      (err) => err.statusCode === 422
    );

    // Invalid email
    await assert.rejects(
      () => service.processCheckout({ ...base, email: 'not-an-email' }),
      (err) => err.statusCode === 422
    );

    // Invalid name characters
    await assert.rejects(
      () => service.processCheckout({ ...base, name: '12345<script>' }),
      (err) => err.statusCode === 422
    );

    // Nonexistent SKU
    await assert.rejects(
      () => service.processCheckout({ ...base, sku: 'nonexistent-sku' }),
      (err) => err.statusCode === 404
    );
  });

  await t.test('6. Zero PII Order Status retrieval', async () => {
    const input = {
      sku: 'endometriosis',
      name: 'Sofia Reyes',
      email: 'sofia@ejemplo.com',
      terms_accepted: true,
      idempotency_key: 'f0000000-0000-4000-8000-000000000006'
    };

    const res = await service.processCheckout(input);
    const status = await service.getOrderStatus(res.order.opaque_token);

    assert.equal(status.order_number, res.order.order_number);
    assert.equal(status.status, 'pending_payment');
    assert.equal(status.sku, 'endometriosis');
    assert.equal(status.total_amount_minor, 7900);
    // Ensure no PII is returned
    assert.equal(status.name, undefined);
    assert.equal(status.email, undefined);
    assert.equal(status.phone, undefined);
  });
});
