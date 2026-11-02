import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDatabase } from './setup-db.js';
import { CheckoutService } from '../src/services/checkout.service.js';

test('Multi-Tenant Isolation Suite (academy_id Scoping)', async (t) => {
  let testDb;

  t.beforeEach(async () => {
    testDb = await createTestDatabase();

    // Insert synthetic second tenant for isolation testing (test-synthetic-academy)
    await testDb.query(`
      INSERT INTO academies (id, slug, legal_name, default_currency, status, billing_entity)
      VALUES ('synthetic-test', 'synthetic-test-academy', 'Synthetic Test Academy', 'USD', 'active', 'Test Corp');

      INSERT INTO products (academy_id, sku, title, description, is_active, access_duration_days)
      VALUES ('synthetic-test', 'python-basic', 'Curso Python Básico', 'Intro a Python', TRUE, 90);

      INSERT INTO prices (id, academy_id, sku, currency, amount_minor, is_current)
      VALUES ('99999999-9999-4999-a999-999999999999', 'synthetic-test', 'python-basic', 'USD', 4900, TRUE);
    `);
  });

  t.afterEach(async () => {
    await testDb.close();
  });

  await t.test('1. Dr. Sevilla service rejects purchasing a product from another academy', async () => {
    const drSevillaService = new CheckoutService(testDb, 'dr-sevilla');

    const input = {
      sku: 'python-basic', // Belongs to synthetic-test, not dr-sevilla
      name: 'Camila Rojas',
      email: 'camila@ejemplo.com',
      terms_accepted: true,
      idempotency_key: '10000000-0000-4000-8000-000000000001'
    };

    await assert.rejects(
      async () => drSevillaService.processCheckout(input),
      (err) => {
        assert.equal(err.statusCode, 404);
        assert.equal(err.code, 'PRODUCT_NOT_FOUND');
        assert.match(err.message, /dr-sevilla/);
        return true;
      }
    );
  });

  await t.test('2. Independent leads per academy with same email (No cross-tenant data leak)', async () => {
    const drSevillaService = new CheckoutService(testDb, 'dr-sevilla');
    const syntheticService = new CheckoutService(testDb, 'synthetic-test');

    const sharedEmail = 'mariana@ejemplo.com';

    // Mariana buys in Dr. Sevilla
    const res1 = await drSevillaService.processCheckout({
      sku: 'endometriosis',
      name: 'Mariana Paz',
      email: sharedEmail,
      terms_accepted: true,
      idempotency_key: '20000000-0000-4000-8000-000000000001'
    });
    assert.equal(res1.statusCode, 201);

    // Mariana buys in synthetic academy
    const res2 = await syntheticService.processCheckout({
      sku: 'python-basic',
      name: 'Mariana Paz',
      email: sharedEmail,
      terms_accepted: true,
      idempotency_key: '20000000-0000-4000-8000-000000000002'
    });
    assert.equal(res2.statusCode, 201);

    // Verify 2 distinct lead records in DB (scoped per academy_id)
    const leadsRes = await testDb.query(
      'SELECT id, academy_id, email_normalized FROM leads WHERE email_normalized = $1',
      [sharedEmail]
    );
    assert.equal(leadsRes.rows.length, 2, 'Should create 2 distinct lead records for each academy');
    assert.ok(leadsRes.rows.some(r => r.academy_id === 'dr-sevilla'));
    assert.ok(leadsRes.rows.some(r => r.academy_id === 'synthetic-test'));
  });

  await t.test('3. Cross-tenant order status query returns 404 (Cannot query token from another tenant)', async () => {
    const drSevillaService = new CheckoutService(testDb, 'dr-sevilla');
    const syntheticService = new CheckoutService(testDb, 'synthetic-test');

    // Create order in Dr. Sevilla
    const res = await drSevillaService.processCheckout({
      sku: 'sop',
      name: 'Gabriela Soto',
      email: 'gabriela@ejemplo.com',
      terms_accepted: true,
      idempotency_key: '30000000-0000-4000-8000-000000000001'
    });
    const opaqueToken = res.order.opaque_token;

    // Dr. Sevilla service can read it
    const orderDrSevilla = await drSevillaService.getOrderStatus(opaqueToken);
    assert.equal(orderDrSevilla.order_number, res.order.order_number);

    // Synthetic service CANNOT read it -> 404
    await assert.rejects(
      async () => syntheticService.getOrderStatus(opaqueToken),
      (err) => {
        assert.equal(err.statusCode, 404);
        assert.equal(err.code, 'ORDER_NOT_FOUND');
        return true;
      }
    );
  });
});
