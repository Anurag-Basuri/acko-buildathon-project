// Unit tests for dependency semantic validation (dependency-validator.js).
// Pure module — no database, no app. Uses small hand-built normalized
// operation objects in the spec-normalizer output shape.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  matchDeclaredOperation,
  tokenizeFieldPath,
  fieldPathMatches,
  fieldStatusInSchema,
  validateDeclaredFields,
  validateDeclaration,
} from '../src/services/dependency-validator.js';

// A normalized Quote-like operation: GET /quotes/{quoteId} returning a
// Quote with nested premium.breakdown[] array fields.
const quoteSchema = {
  type: 'object',
  required: ['quoteId', 'status', 'premium'],
  properties: {
    quoteId: { type: 'string' },
    status: { type: 'string', enum: ['DRAFT', 'FINAL', 'EXPIRED'] },
    premium: {
      type: 'object',
      required: ['total', 'currency', 'breakdown'],
      properties: {
        total: { type: 'number' },
        currency: { type: 'string' },
        breakdown: {
          type: 'array',
          items: {
            type: 'object',
            required: ['label', 'amount'],
            properties: {
              label: { type: 'string' },
              amount: { type: 'number' },
            },
          },
        },
      },
    },
  },
};

const quoteOperation = {
  method: 'GET',
  path: '/quotes/{quoteId}',
  canonicalPath: '/quotes/{param_0}',
  operationId: 'getQuote',
  parameters: [{ name: 'quoteId', in: 'path', required: true, schema: { type: 'string' } }],
  requestBody: null,
  responses: {
    '200': { content: { 'application/json': { schema: quoteSchema } } },
    '404': { content: {} },
  },
};

const createQuoteOperation = {
  method: 'POST',
  path: '/quotes',
  canonicalPath: '/quotes',
  operationId: 'createQuote',
  parameters: [],
  requestBody: {
    required: true,
    content: {
      'application/json': {
        schema: {
          type: 'object',
          required: ['vehicle', 'rider'],
          properties: {
            vehicle: {
              type: 'object',
              required: ['make', 'cc'],
              properties: { make: { type: 'string' }, model: { type: 'string' }, cc: { type: 'integer' } },
            },
            rider: {
              type: 'object',
              required: ['age'],
              properties: { age: { type: 'integer' }, city: { type: 'string' } },
            },
          },
        },
      },
    },
  },
  responses: {
    '201': { content: { 'application/json': { schema: quoteSchema } } },
    '400': { content: {} },
  },
};

// ---------------------------------------------------------------------------
// Operation matching
// ---------------------------------------------------------------------------

test('matches the exact path and method', () => {
  const result = matchDeclaredOperation('GET', '/quotes/{quoteId}', [quoteOperation]);
  assert.equal(result.status, 'exact');
  assert.equal(result.operation.path, '/quotes/{quoteId}');
});

test('matches a renamed path parameter positionally (mismatch, not missing)', () => {
  const result = matchDeclaredOperation('GET', '/quotes/{id}', [quoteOperation]);
  assert.equal(result.status, 'mismatch');
  assert.equal(result.operation.path, '/quotes/{quoteId}');
});

test('does not match a different method on the same path', () => {
  const result = matchDeclaredOperation('POST', '/quotes/{id}', [quoteOperation]);
  assert.equal(result.status, 'missing');
  assert.equal(result.operation, null);
});

test('does not match an absent path template', () => {
  const result = matchDeclaredOperation('GET', '/policies/{policyId}', [quoteOperation]);
  assert.equal(result.status, 'missing');
});

test('prefers the exact match when both exact and positional matches exist', () => {
  const other = { ...quoteOperation, path: '/quotes/{id}', canonicalPath: '/quotes/{param_0}' };
  const result = matchDeclaredOperation('GET', '/quotes/{id}', [quoteOperation, other]);
  assert.equal(result.status, 'exact');
  assert.equal(result.operation.operationId, 'getQuote');
});

// ---------------------------------------------------------------------------
// Field path tokens and matching
// ---------------------------------------------------------------------------

test('tokenizes nested paths and array markers', () => {
  assert.deepEqual(tokenizeFieldPath('items[].productId'), [
    { name: 'items', array: true },
    { name: 'productId', array: false },
  ]);
  assert.deepEqual(tokenizeFieldPath('customer.address.city'), [
    { name: 'customer', array: false },
    { name: 'address', array: false },
    { name: 'city', array: false },
  ]);
});

test('a changed parent object matches declared nested descendants', () => {
  assert.equal(fieldPathMatches('customer.address.city', 'customer'), true);
});

test('a changed nested field matches a declared parent object', () => {
  assert.equal(fieldPathMatches('customer', 'customer.address.city'), true);
});

test('exact paths match', () => {
  assert.equal(fieldPathMatches('premium.breakdown[].amount', 'premium.breakdown[].amount'), true);
});

test('string-prefix collisions do NOT match (segment boundary)', () => {
  assert.equal(fieldPathMatches('customer.name', 'customer.nameSuffix'), false);
  assert.equal(fieldPathMatches('items[].productName', 'items[].productId'), false);
});

test('array markers are tolerated when matching (items[] vs items)', () => {
  // The array node and its element node are different views of the same
  // data: a consumer that reads either is affected when the other changes.
  assert.equal(fieldPathMatches('items[]', 'items'), true);
});

// ---------------------------------------------------------------------------
// Field resolution against schemas
// ---------------------------------------------------------------------------

test('resolves a nested field in an object schema', () => {
  const { status } = fieldStatusInSchema(tokenizeFieldPath('premium.total'), quoteSchema);
  assert.equal(status, 'exists');
});

test('resolves an array-item field with [] notation', () => {
  const { status } = fieldStatusInSchema(
    tokenizeFieldPath('premium.breakdown[].label'),
    quoteSchema
  );
  assert.equal(status, 'exists');
});

test('reports not_found for a missing nested field', () => {
  const { status } = fieldStatusInSchema(tokenizeFieldPath('premium.missingField'), quoteSchema);
  assert.equal(status, 'not_found');
});

test('reports not_found for a segment-boundary collision', () => {
  const schema = {
    type: 'object',
    properties: {
      customer: {
        type: 'object',
        properties: { nameSuffix: { type: 'string' } },
      },
    },
  };
  const { status } = fieldStatusInSchema(tokenizeFieldPath('customer.name'), schema);
  assert.equal(status, 'not_found');
});

test('reports not_found when an array marker is used on a non-array field', () => {
  const { status } = fieldStatusInSchema(tokenizeFieldPath('premium[].total'), quoteSchema);
  assert.equal(status, 'not_found');
});

test('reports unverifiable for a schema of type "any"', () => {
  const { status } = fieldStatusInSchema(tokenizeFieldPath('anything'), { type: 'any' });
  assert.equal(status, 'unverifiable');
});

test('reports unverifiable for an object schema with no declared properties', () => {
  const { status } = fieldStatusInSchema(tokenizeFieldPath('foo'), { type: 'object' });
  assert.equal(status, 'unverifiable');
});

test('reports not_found when descending through a scalar', () => {
  const { status } = fieldStatusInSchema(tokenizeFieldPath('quoteId.sub'), quoteSchema);
  assert.equal(status, 'not_found');
});

// ---------------------------------------------------------------------------
// Declared-field validation per side
// ---------------------------------------------------------------------------

test('request side: parameter names count as valid sent fields', () => {
  const results = validateDeclaredFields(['quoteId', 'ghost'], quoteOperation, 'request');
  assert.deepEqual(results[0], { path: 'quoteId', status: 'exists' });
  assert.deepEqual(results[1], { path: 'ghost', status: 'not_found' });
});

test('request side: body fields resolve against the request schema', () => {
  const results = validateDeclaredFields(
    ['vehicle.make', 'vehicle.cc', 'rider.age', 'nope.deep'],
    createQuoteOperation,
    'request'
  );
  assert.equal(results[0].status, 'exists');
  assert.equal(results[1].status, 'exists');
  assert.equal(results[2].status, 'exists');
  assert.equal(results[3].status, 'not_found');
});

test('request side: without a request body, non-parameter fields cannot exist', () => {
  const results = validateDeclaredFields(['vehicle.make'], quoteOperation, 'request');
  assert.deepEqual(results[0], { path: 'vehicle.make', status: 'not_found' });
});

test('response side: fields resolve against 2xx response schemas', () => {
  const results = validateDeclaredFields(
    ['quoteId', 'premium.total', 'premium.breakdown[].amount', 'legacyCode'],
    quoteOperation,
    'response'
  );
  assert.equal(results[0].status, 'exists');
  assert.equal(results[1].status, 'exists');
  assert.equal(results[2].status, 'exists');
  assert.equal(results[3].status, 'not_found');
});

test('response side: non-2xx schemas are not searched', () => {
  const operation = {
    method: 'GET',
    path: '/x',
    canonicalPath: '/x',
    operationId: null,
    parameters: [],
    requestBody: null,
    responses: {
      '400': {
        content: {
          'application/json': {
            schema: { type: 'object', properties: { error: { type: 'string' } } },
          },
        },
      },
    },
  };
  const results = validateDeclaredFields(['error'], operation, 'response');
  assert.deepEqual(results[0], { path: 'error', status: 'not_found' });
});

test('validateDeclaration: missing operation skips field validation', () => {
  const result = validateDeclaration(
    { method: 'GET', path: '/policies/{policyId}', sends: ['policyId'], reads: ['status'] },
    { operations: [quoteOperation] }
  );
  assert.equal(result.operation.status, 'missing');
  assert.equal(result.operation.matchedPath, null);
  assert.deepEqual(result.fields, { request: [], response: [] });
});

test('validateDeclaration: a positional mismatch still validates fields', () => {
  const result = validateDeclaration(
    {
      method: 'GET',
      path: '/quotes/{id}',
      sends: ['id'],
      reads: ['premium.breakdown[].amount', 'ghostField'],
    },
    { operations: [quoteOperation] }
  );
  assert.equal(result.operation.status, 'mismatch');
  assert.equal(result.operation.matchedPath, '/quotes/{quoteId}');
  // "id" is not the parameter name (quoteId) and there is no body: not found.
  assert.equal(result.fields.request[0].status, 'not_found');
  assert.equal(result.fields.response[0].status, 'exists');
  assert.equal(result.fields.response[1].status, 'not_found');
});
