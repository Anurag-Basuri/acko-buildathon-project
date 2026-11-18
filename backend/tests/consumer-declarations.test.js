// Unit tests for the starter-kit consumer declaration parser
// (consumer-declarations.js). Pure module — no database, no app.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConsumerDeclaration } from '../src/services/consumer-declarations.js';

test('parses a full declaration in the starter-kit shape', () => {
  const document = {
    consumer: 'mobile-app',
    team: 'Mobile',
    uses: [
      {
        provider: 'quote-api',
        method: 'POST',
        path: '/quotes',
        sends: ['vehicle.make', 'rider.age'],
        reads: ['quoteId', 'premium.total', 'premium.breakdown[].label'],
      },
      {
        provider: 'claims-api',
        method: 'get',
        path: '/claims/{claimId}',
        sends: ['claimId'],
        reads: ['claimId', 'status', 'amountApproved'],
      },
    ],
  };

  const result = parseConsumerDeclaration(document, 'mobile-app.yaml');
  assert.equal(result.ok, true);
  assert.deepEqual(result.declaration, {
    consumer: 'mobile-app',
    team: 'Mobile',
    uses: [
      {
        provider: 'quote-api',
        method: 'POST',
        path: '/quotes',
        sends: ['vehicle.make', 'rider.age'],
        reads: ['quoteId', 'premium.total', 'premium.breakdown[].label'],
      },
      {
        provider: 'claims-api',
        method: 'GET',
        path: '/claims/{claimId}',
        sends: ['claimId'],
        reads: ['claimId', 'status', 'amountApproved'],
      },
    ],
  });
});

test('preserves nested field paths and array notation verbatim', () => {
  const result = parseConsumerDeclaration(
    {
      consumer: 'partner-portal',
      team: 'Partner Integrations',
      uses: [
        {
          provider: 'quote-api',
          method: 'POST',
          path: '/quotes',
          sends: ['customer.address.city', 'items[].productId'],
          reads: ['premium.breakdown[].amount'],
        },
      ],
    },
    'partner-portal.yaml'
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.declaration.uses[0].sends, ['customer.address.city', 'items[].productId']);
  assert.deepEqual(result.declaration.uses[0].reads, ['premium.breakdown[].amount']);
});

test('normalizes HTTP methods to uppercase', () => {
  const result = parseConsumerDeclaration(
    { consumer: 'svc', uses: [{ provider: 'p', method: 'patch', path: '/x' }] },
    'svc.yaml'
  );
  assert.equal(result.ok, true);
  assert.equal(result.declaration.uses[0].method, 'PATCH');
});

test('missing sends/reads defaults to empty arrays', () => {
  const result = parseConsumerDeclaration(
    { consumer: 'svc', uses: [{ provider: 'p', method: 'GET', path: '/x' }] },
    'svc.yaml'
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.declaration.uses[0].sends, []);
  assert.deepEqual(result.declaration.uses[0].reads, []);
});

test('missing uses is allowed and yields an empty list', () => {
  const result = parseConsumerDeclaration({ consumer: 'svc', team: 'T' }, 'svc.yaml');
  assert.equal(result.ok, true);
  assert.deepEqual(result.declaration.uses, []);
});

test('rejects a non-object document', () => {
  const result = parseConsumerDeclaration(['consumer', 'svc'], 'bad.yaml');
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.field === 'bad.yaml'));
});

test('rejects a declaration without a consumer name', () => {
  const result = parseConsumerDeclaration({ team: 'T', uses: [] }, 'bad.yaml');
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.field === 'bad.yaml:consumer'));
});

test('reports a malformed uses entry but keeps the error message scoped', () => {
  const result = parseConsumerDeclaration(
    {
      consumer: 'svc',
      uses: [
        { provider: 'p', method: 'GET', path: '/ok' },
        { provider: 'p', method: 'FETCH', path: '/nope' },
      ],
    },
    'svc.yaml'
  );
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((e) => e.field === 'svc.yaml:uses[1]:method' && /method/.test(e.message))
  );
});

test('rejects a path that does not start with "/"', () => {
  const result = parseConsumerDeclaration(
    { consumer: 'svc', uses: [{ provider: 'p', method: 'GET', path: 'quotes' }] },
    'svc.yaml'
  );
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.field === 'svc.yaml:uses[0]:path'));
});

test('rejects non-string entries inside sends', () => {
  const result = parseConsumerDeclaration(
    {
      consumer: 'svc',
      uses: [{ provider: 'p', method: 'POST', path: '/x', sends: ['ok.field', 42, '   '] }],
    },
    'svc.yaml'
  );
  assert.equal(result.ok, false);
  assert.equal(
    result.errors.filter((e) => e.field.startsWith('svc.yaml:uses[0]:sends')).length,
    2
  );
});

test('rejects a declaration where uses is not an array', () => {
  const result = parseConsumerDeclaration({ consumer: 'svc', uses: 'nope' }, 'svc.yaml');
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.field === 'svc.yaml:uses'));
});
