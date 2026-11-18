import { test } from 'node:test';
import assert from 'node:assert/strict';
import './helpers/ensure-test-env.js';
import { notFoundHandler } from '../src/middleware/not-found.js';
import { errorHandler } from '../src/middleware/error-handler.js';

function fakeRes() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

test('notFoundHandler responds with the 404 envelope', () => {
  const req = { method: 'DELETE', path: '/api/missing' };
  const res = fakeRes();
  notFoundHandler(req, res);
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, {
    error: { code: 'NOT_FOUND', message: 'Cannot DELETE /api/missing' },
  });
});

test('errorHandler maps unknown errors to 500 INTERNAL_ERROR', () => {
  const res = fakeRes();
  errorHandler(new Error('boom'), { method: 'GET', path: '/x' }, res);
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.error.code, 'INTERNAL_ERROR');
  assert.equal(res.body.error.message, 'boom');
});

test('errorHandler preserves status, code and details when provided', () => {
  const err = Object.assign(new Error('nope'), {
    status: 409,
    code: 'DUPLICATE_VERSION',
    details: ['version 1.0.0 already exists for this service'],
  });
  const res = fakeRes();
  errorHandler(err, { method: 'POST', path: '/x' }, res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error.code, 'DUPLICATE_VERSION');
  assert.deepEqual(res.body.error.details, [
    'version 1.0.0 already exists for this service',
  ]);
});

test('errorHandler maps JSON body parse failures to INVALID_JSON', () => {
  const err = Object.assign(new SyntaxError('bad json'), {
    status: 400,
    type: 'entity.parse.failed',
  });
  const res = fakeRes();
  errorHandler(err, { method: 'POST', path: '/x' }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error.code, 'INVALID_JSON');
});
