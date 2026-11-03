import test from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'stream';
import { createTestDatabase } from './setup-db.js';
import { buildApp } from '../src/server.js';

test('Server Log Sanitization & Sentinel Absence Suite (P1 Control)', async (t) => {
  let testDb;
  let app;
  let capturedLogs;
  let logStream;

  t.beforeEach(async () => {
    testDb = await createTestDatabase();
    capturedLogs = [];
    logStream = new Writable({
      write(chunk, encoding, callback) {
        capturedLogs.push(chunk.toString());
        callback();
      }
    });

    app = await buildApp(testDb, {
      logger: {
        level: 'info',
        stream: logStream
      }
    });
  });

  t.afterEach(async () => {
    if (app) await app.close();
    if (testDb) await testDb.close();
  });

  await t.test('1. Inspection of /api/v1/orders/BAD_TOKEN: No raw token or URL logged, route sanitized', async () => {
    // 1a. Test incomplete/invalid order endpoint: /api/v1/orders/BAD_TOKEN_SENTINEL
    const res1 = await app.inject({
      method: 'GET',
      url: '/api/v1/orders/BAD_TOKEN_SENTINEL'
    });
    assert.equal(res1.statusCode, 404);

    // 1b. Test status endpoint with non-existent token: /api/v1/orders/BAD_TOKEN_SENTINEL/status
    const res2 = await app.inject({
      method: 'GET',
      url: '/api/v1/orders/BAD_TOKEN_SENTINEL/status'
    });
    assert.equal(res2.statusCode, 404);

    const logOutput = capturedLogs.join('\n');

    // Strict sentinel assertion: BAD_TOKEN_SENTINEL must NEVER appear anywhere in the logs
    assert.equal(
      logOutput.includes('BAD_TOKEN_SENTINEL'), 
      false, 
      'Effective logs must NOT contain the token sentinel BAD_TOKEN_SENTINEL'
    );

    // Check that route templates are properly logged
    assert.ok(
      logOutput.includes('"route":"unknown_route"'),
      'Incomplete route must log fixed unknown_route label'
    );
    assert.ok(
      logOutput.includes('"route":"/api/v1/orders/:opaque_token/status"'),
      'Status endpoint must log router template /api/v1/orders/:opaque_token/status'
    );
  });

  await t.test('2. Inspection of /unknown/SECRET?email=SECRET: No query strings, secrets, or raw paths logged', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/unknown/SECRET_PATH_SENTINEL?email=SECRET_QUERY_SENTINEL'
    });
    assert.equal(res.statusCode, 404);

    const logOutput = capturedLogs.join('\n');

    // Strict sentinel assertion
    assert.equal(
      logOutput.includes('SECRET_PATH_SENTINEL'), 
      false, 
      'Effective logs must NOT contain secret path parameters'
    );
    assert.equal(
      logOutput.includes('SECRET_QUERY_SENTINEL'), 
      false, 
      'Effective logs must NOT contain secret query parameters'
    );
    assert.equal(
      logOutput.includes('?email='), 
      false, 
      'Effective logs must NOT contain query strings'
    );

    // Must use fixed 'unknown_route' label
    assert.ok(
      logOutput.includes('"route":"unknown_route"'),
      'Unknown route must log fixed unknown_route label'
    );
  });

  await t.test('3. Inspection of SKU SECRET_EMAIL@example.com: 4xx error logs must not leak user input', async () => {
    const sentinelSku = 'SECRET_EMAIL@example.com';
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/checkout',
      payload: {
        sku: sentinelSku,
        name: 'Maria Tester',
        email: 'maria@ejemplo.com',
        terms_accepted: true,
        idempotency_key: 'b1111111-2222-4333-8444-555555555555'
      }
    });

    assert.equal(res.statusCode, 404);
    const body = JSON.parse(res.body);
    assert.equal(body.error, 'PRODUCT_NOT_FOUND');

    const logOutput = capturedLogs.join('\n');

    // Strict sentinel assertion: user input SKU must NEVER appear in the effective logs
    assert.equal(
      logOutput.includes(sentinelSku), 
      false, 
      'Effective logs must NOT contain user-supplied SKU sentinel'
    );

    // Route must be logged as /api/v1/checkout
    assert.ok(
      logOutput.includes('"route":"/api/v1/checkout"'),
      'Must log router route template /api/v1/checkout'
    );
    assert.ok(
      logOutput.includes('"errCode":"PRODUCT_NOT_FOUND"'),
      'Must log sanitized error code'
    );
    assert.ok(
      logOutput.includes('"statusCode":404'),
      'Must log status code 404'
    );
    assert.ok(
      logOutput.includes('"msg":"Handled request error"'),
      'Must log static message without raw error message or user data'
    );
  });
});
