// Unit tests for the structural comparison engine (pure module — no database,
// no HTTP server). Synthetic tests exercise every change type directly;
// fixture tests run the full resolve -> normalize -> compare pipeline against
// the starter-kit specification versions.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { load as loadYaml } from 'js-yaml';
import SwaggerParser from '@apidevtools/swagger-parser';
import { normalizeSpec, canonicalPath } from '../src/services/spec-normalizer.js';
import { compareSpecs } from '../src/services/spec-comparator.js';

// ---------------------------------------------------------------------------
// Synthetic spec builders (normalized representation)
// ---------------------------------------------------------------------------

function obj(properties, required = []) {
  return { type: 'object', properties, required };
}

function param(name, { location = 'query', required = false, schema = { type: 'string' } } = {}) {
  return { name, in: location, required, schema };
}

function body(required, schema, contentTypes = ['application/json']) {
  const content = {};
  for (const contentType of contentTypes) content[contentType] = { schema };
  return { required, content };
}

function response(status, schema, contentType = 'application/json') {
  return { [status]: { content: { [contentType]: { schema } } } };
}

function makeOp(overrides = {}) {
  const {
    method = 'GET',
    path = '/things/{id}',
    operationId = null,
    parameters = [],
    requestBody = null,
    responses = {},
  } = overrides;
  return { method, path, canonicalPath: canonicalPath(path), operationId, parameters, requestBody, responses };
}

function makeSpec(operations = []) {
  return { openApiVersion: '3.0.0', title: 'Test', version: '1.0.0', operations };
}

// ---------------------------------------------------------------------------
// Equivalence
// ---------------------------------------------------------------------------

test('semantically identical specs produce no changes', () => {
  const spec = makeSpec([
    makeOp({
      path: '/items',
      parameters: [param('limit')],
      requestBody: body(true, obj({ name: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } }, ['name'])),
      responses: response('200', obj({ id: { type: 'string' }, active: { type: 'boolean' } }, ['id'])),
    }),
  ]);
  assert.deepEqual(compareSpecs(spec, spec), []);
});

test('property order inside a schema is irrelevant', () => {
  const from = makeSpec([
    makeOp({
      path: '/items',
      responses: response('200', obj({ name: { type: 'string' }, age: { type: 'integer' } })),
    }),
  ]);
  const to = makeSpec([
    makeOp({
      path: '/items',
      responses: response('200', obj({ age: { type: 'integer' }, name: { type: 'string' } })),
    }),
  ]);
  assert.deepEqual(compareSpecs(from, to), []);
});

test('$ref layout vs inline schema is irrelevant (resolve + normalize + compare)', async () => {
  const withRefs = {
    openapi: '3.0.0',
    info: { title: 'T', version: '1.0.0' },
    paths: {
      '/items': {
        get: {
          responses: {
            '200': {
              description: 'ok',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Item' } } },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        Item: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string' }, name: { type: 'string' } },
        },
      },
    },
  };
  const inline = {
    openapi: '3.0.0',
    info: { title: 'T', version: '1.0.0' },
    paths: {
      '/items': {
        get: {
          responses: {
            '200': {
              description: 'ok',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['id'],
                    properties: { name: { type: 'string' }, id: { type: 'string' } },
                  },
                },
              },
            },
          },
        },
      },
    },
  };
  const from = normalizeSpec(await SwaggerParser.dereference(structuredClone(withRefs)));
  const to = normalizeSpec(await SwaggerParser.dereference(structuredClone(inline)));
  assert.equal(from.ok, true);
  assert.equal(to.ok, true);
  assert.deepEqual(compareSpecs(from.spec, to.spec), []);
});

test('path parameter rename is reported, other parameter renames are not', () => {
  const from = makeSpec([
    makeOp({
      path: '/users/{id}',
      parameters: [param('id', { location: 'path', required: true }), param('verbose')],
      responses: response('200', obj({ name: { type: 'string' } })),
    }),
  ]);
  const to = makeSpec([
    makeOp({
      path: '/users/{userId}',
      parameters: [param('userId', { location: 'path', required: true }), param('verbose')],
      responses: response('200', obj({ name: { type: 'string' } })),
    }),
  ]);
  const changes = compareSpecs(from, to);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].changeType, 'PARAMETER_RENAMED');
  assert.equal(changes[0].method, 'GET');
  assert.equal(changes[0].path, '/users/{id}');
  assert.equal(changes[0].location, 'parameter');
  assert.equal(changes[0].fieldPath, 'parameters.id');
  assert.deepEqual(changes[0].before, { name: 'id', in: 'path' });
  assert.deepEqual(changes[0].after, { name: 'userId', in: 'path' });
  assert.match(changes[0].description, /renamed/);
});

// ---------------------------------------------------------------------------
// Endpoints and methods
// ---------------------------------------------------------------------------

test('endpoint added', () => {
  const from = makeSpec([makeOp({ path: '/a', responses: response('200', { type: 'string' }) })]);
  const to = makeSpec([
    makeOp({ path: '/a', responses: response('200', { type: 'string' }) }),
    makeOp({ method: 'GET', path: '/b', responses: {} }),
    makeOp({ method: 'POST', path: '/b', responses: {} }),
  ]);
  const changes = compareSpecs(from, to);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].changeType, 'ENDPOINT_ADDED');
  assert.equal(changes[0].method, null);
  assert.equal(changes[0].path, '/b');
  assert.equal(changes[0].location, 'endpoint');
  assert.equal(changes[0].before, null);
  assert.deepEqual(changes[0].after, { methods: ['GET', 'POST'] });
});

test('endpoint removed', () => {
  const from = makeSpec([
    makeOp({ path: '/a', responses: {} }),
    makeOp({ method: 'GET', path: '/b', responses: {} }),
    makeOp({ method: 'DELETE', path: '/b', responses: {} }),
  ]);
  const to = makeSpec([makeOp({ path: '/a', responses: {} })]);
  const changes = compareSpecs(from, to);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].changeType, 'ENDPOINT_REMOVED');
  assert.deepEqual(changes[0].before, { methods: ['GET', 'DELETE'] });
  assert.equal(changes[0].after, null);
});

test('method added on an existing endpoint', () => {
  const from = makeSpec([makeOp({ path: '/a', responses: {} })]);
  const to = makeSpec([
    makeOp({ path: '/a', responses: {} }),
    makeOp({ method: 'DELETE', path: '/a', responses: {} }),
  ]);
  const changes = compareSpecs(from, to);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].changeType, 'METHOD_ADDED');
  assert.equal(changes[0].method, 'DELETE');
  assert.equal(changes[0].path, '/a');
  assert.equal(changes[0].location, 'method');
});

test('method removed from an existing endpoint', () => {
  const from = makeSpec([
    makeOp({ path: '/a', responses: {} }),
    makeOp({ method: 'PUT', path: '/a', responses: {} }),
  ]);
  const to = makeSpec([makeOp({ path: '/a', responses: {} })]);
  const changes = compareSpecs(from, to);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].changeType, 'METHOD_REMOVED');
  assert.equal(changes[0].method, 'PUT');
});

test('operationId change is reported on its own', () => {
  const from = makeSpec([makeOp({ path: '/a', operationId: 'oldId', responses: {} })]);
  const to = makeSpec([makeOp({ path: '/a', operationId: 'newId', responses: {} })]);
  const changes = compareSpecs(from, to);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].changeType, 'OPERATION_ID_CHANGED');
  assert.equal(changes[0].location, 'operation');
  assert.deepEqual(changes[0].before, { operationId: 'oldId' });
  assert.deepEqual(changes[0].after, { operationId: 'newId' });
});

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

test('optional parameter added', () => {
  const from = makeSpec([makeOp({ path: '/a', parameters: [] })]);
  const to = makeSpec([makeOp({ path: '/a', parameters: [param('limit', { required: false, schema: { type: 'integer' } })] })]);
  const changes = compareSpecs(from, to);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].changeType, 'PARAMETER_ADDED');
  assert.equal(changes[0].fieldPath, 'parameters.limit');
  assert.equal(changes[0].before, null);
  assert.equal(changes[0].after.name, 'limit');
  assert.equal(changes[0].after.required, false);
});

test('required parameter added carries required=true', () => {
  const from = makeSpec([makeOp({ path: '/a', parameters: [] })]);
  const to = makeSpec([makeOp({ path: '/a', parameters: [param('region', { required: true })] })]);
  const changes = compareSpecs(from, to);
  assert.equal(changes[0].changeType, 'PARAMETER_ADDED');
  assert.equal(changes[0].after.required, true);
});

test('parameter removed', () => {
  const from = makeSpec([makeOp({ path: '/a', parameters: [param('verbose')] })]);
  const to = makeSpec([makeOp({ path: '/a', parameters: [] })]);
  const changes = compareSpecs(from, to);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].changeType, 'PARAMETER_REMOVED');
  assert.equal(changes[0].before.name, 'verbose');
  assert.equal(changes[0].after, null);
});

test('parameter requiredness optional -> required', () => {
  const from = makeSpec([makeOp({ path: '/a', parameters: [param('limit', { required: false })] })]);
  const to = makeSpec([makeOp({ path: '/a', parameters: [param('limit', { required: true })] })]);
  const changes = compareSpecs(from, to);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].changeType, 'PARAMETER_REQUIREDNESS_CHANGED');
  assert.deepEqual(changes[0].before, { required: false });
  assert.deepEqual(changes[0].after, { required: true });
});

test('parameter requiredness required -> optional', () => {
  const from = makeSpec([makeOp({ path: '/a', parameters: [param('limit', { required: true })] })]);
  const to = makeSpec([makeOp({ path: '/a', parameters: [param('limit', { required: false })] })]);
  const changes = compareSpecs(from, to);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].changeType, 'PARAMETER_REQUIREDNESS_CHANGED');
  assert.deepEqual(changes[0].before, { required: true });
  assert.deepEqual(changes[0].after, { required: false });
});

test('parameter type change', () => {
  const from = makeSpec([makeOp({ path: '/a', parameters: [param('limit', { schema: { type: 'string' } })] })]);
  const to = makeSpec([makeOp({ path: '/a', parameters: [param('limit', { schema: { type: 'integer' } })] })]);
  const changes = compareSpecs(from, to);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].changeType, 'PARAMETER_TYPE_CHANGED');
  assert.equal(changes[0].before.type, 'string');
  assert.equal(changes[0].after.type, 'integer');
});

test('parameter enum change', () => {
  const from = makeSpec([
    makeOp({ path: '/a', parameters: [param('status', { schema: { type: 'string', enum: ['A', 'B'] } })] }),
  ]);
  const to = makeSpec([
    makeOp({ path: '/a', parameters: [param('status', { schema: { type: 'string', enum: ['A', 'B', 'C'] } })] }),
  ]);
  const changes = compareSpecs(from, to);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].changeType, 'PARAMETER_ENUM_CHANGED');
  assert.deepEqual(changes[0].before, { enum: ['A', 'B'] });
  assert.deepEqual(changes[0].after, { enum: ['A', 'B', 'C'] });
});

// ---------------------------------------------------------------------------
// Request body
// ---------------------------------------------------------------------------

test('request body added / removed / requiredness changed', () => {
  const from = makeSpec([makeOp({ method: 'POST', path: '/a' })]);
  const to = makeSpec([
    makeOp({ method: 'POST', path: '/a', requestBody: body(true, obj({ x: { type: 'string' } })) }),
  ]);

  const added = compareSpecs(from, to);
  assert.equal(added.length, 1);
  assert.equal(added[0].changeType, 'REQUEST_BODY_ADDED');
  assert.equal(added[0].location, 'requestBody');
  assert.equal(added[0].after.required, true);
  assert.deepEqual(added[0].after.contentTypes, ['application/json']);

  const removed = compareSpecs(to, from);
  assert.equal(removed.length, 1);
  assert.equal(removed[0].changeType, 'REQUEST_BODY_REMOVED');
  assert.equal(removed[0].before.required, true);

  const fromRequired = makeSpec([
    makeOp({ method: 'POST', path: '/a', requestBody: body(true, obj({ x: { type: 'string' } })) }),
  ]);
  const toOptional = makeSpec([
    makeOp({ method: 'POST', path: '/a', requestBody: body(false, obj({ x: { type: 'string' } })) }),
  ]);
  const changed = compareSpecs(fromRequired, toOptional);
  assert.equal(changed.length, 1);
  assert.equal(changed[0].changeType, 'REQUEST_BODY_REQUIREDNESS_CHANGED');
  assert.deepEqual(changed[0].before, { required: true });
  assert.deepEqual(changed[0].after, { required: false });
});

test('request content type added / removed', () => {
  const from = makeSpec([
    makeOp({ method: 'POST', path: '/a', requestBody: body(true, { type: 'string' }) }),
  ]);
  const to = makeSpec([
    makeOp({
      method: 'POST',
      path: '/a',
      requestBody: body(true, { type: 'string' }, ['application/json', 'text/plain']),
    }),
  ]);
  const added = compareSpecs(from, to);
  assert.equal(added.length, 1);
  assert.equal(added[0].changeType, 'REQUEST_CONTENT_TYPE_ADDED');
  assert.equal(added[0].fieldPath, 'request[text/plain]');
  assert.deepEqual(added[0].after, { contentType: 'text/plain' });

  const removed = compareSpecs(to, from);
  assert.equal(removed.length, 1);
  assert.equal(removed[0].changeType, 'REQUEST_CONTENT_TYPE_REMOVED');
  assert.deepEqual(removed[0].before, { contentType: 'text/plain' });
});

// ---------------------------------------------------------------------------
// Response statuses and content types
// ---------------------------------------------------------------------------

test('response status added / removed', () => {
  const from = makeSpec([makeOp({ method: 'POST', path: '/a', responses: response('200', { type: 'string' }) })]);
  const to = makeSpec([
    makeOp({
      method: 'POST',
      path: '/a',
      responses: { ...response('200', { type: 'string' }), ...response('429', { type: 'string' }) },
    }),
  ]);

  const added = compareSpecs(from, to);
  assert.equal(added.length, 1);
  assert.equal(added[0].changeType, 'RESPONSE_STATUS_ADDED');
  assert.equal(added[0].fieldPath, 'response.429');
  assert.deepEqual(added[0].after, { contentTypes: ['application/json'] });

  const removed = compareSpecs(to, from);
  assert.equal(removed.length, 1);
  assert.equal(removed[0].changeType, 'RESPONSE_STATUS_REMOVED');
  assert.equal(removed[0].fieldPath, 'response.429');
});

test('response content type added / removed', () => {
  const from = makeSpec([makeOp({ path: '/a', responses: response('200', { type: 'string' }) })]);
  const to = makeSpec([
    makeOp({
      path: '/a',
      responses: {
        '200': {
          content: {
            'application/json': { schema: { type: 'string' } },
            'text/html': { schema: { type: 'string' } },
          },
        },
      },
    }),
  ]);

  const added = compareSpecs(from, to);
  assert.equal(added.length, 1);
  assert.equal(added[0].changeType, 'RESPONSE_CONTENT_TYPE_ADDED');
  assert.equal(added[0].fieldPath, 'response.200[text/html]');

  const removed = compareSpecs(to, from);
  assert.equal(removed.length, 1);
  assert.equal(removed[0].changeType, 'RESPONSE_CONTENT_TYPE_REMOVED');
});

// ---------------------------------------------------------------------------
// Schema fields
// ---------------------------------------------------------------------------

test('request field added: optional and required are distinguishable', () => {
  const from = makeSpec([
    makeOp({ method: 'POST', path: '/a', requestBody: body(true, obj({ name: { type: 'string' } }, ['name'])) }),
  ]);
  const toOptional = makeSpec([
    makeOp({
      method: 'POST',
      path: '/a',
      requestBody: body(true, obj({ name: { type: 'string' }, notes: { type: 'string' } }, ['name'])),
    }),
  ]);
  const toRequired = makeSpec([
    makeOp({
      method: 'POST',
      path: '/a',
      requestBody: body(true, obj({ name: { type: 'string' }, notes: { type: 'string' } }, ['name', 'notes'])),
    }),
  ]);

  const optional = compareSpecs(from, toOptional);
  assert.equal(optional.length, 1);
  assert.equal(optional[0].changeType, 'FIELD_ADDED');
  assert.equal(optional[0].fieldPath, 'request.notes');
  assert.equal(optional[0].before, null);
  assert.equal(optional[0].after.required, false);
  assert.equal(optional[0].after.type, 'string');

  const required = compareSpecs(from, toRequired);
  assert.equal(required[0].changeType, 'FIELD_ADDED');
  assert.equal(required[0].after.required, true);
});

test('request field removed carries its prior requiredness', () => {
  const from = makeSpec([
    makeOp({
      method: 'POST',
      path: '/a',
      requestBody: body(true, obj({ name: { type: 'string' }, legacy: { type: 'string' } }, ['name'])),
    }),
  ]);
  const to = makeSpec([
    makeOp({ method: 'POST', path: '/a', requestBody: body(true, obj({ name: { type: 'string' } }, ['name'])) }),
  ]);
  const changes = compareSpecs(from, to);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].changeType, 'FIELD_REMOVED');
  assert.equal(changes[0].fieldPath, 'request.legacy');
  assert.equal(changes[0].after, null);
  assert.equal(changes[0].before.required, false);
  assert.equal(changes[0].before.type, 'string');
});

test('field type change short-circuits deeper comparison', () => {
  const from = makeSpec([
    makeOp({
      path: '/a',
      responses: response('200', { type: 'string' }),
    }),
  ]);
  const to = makeSpec([
    makeOp({
      path: '/a',
      responses: response(
        '200',
        obj({ nested: { type: 'string' }, other: { type: 'integer' } }, ['nested', 'other'])
      ),
    }),
  ]);
  const changes = compareSpecs(from, to);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].changeType, 'FIELD_TYPE_CHANGED');
  assert.equal(changes[0].fieldPath, 'response.200');
  assert.deepEqual(changes[0].before, { type: 'string', format: undefined });
  assert.deepEqual(changes[0].after, { type: 'object', format: undefined });
});

test('field requiredness change', () => {
  const from = makeSpec([
    makeOp({
      method: 'POST',
      path: '/a',
      requestBody: body(true, obj({ notes: { type: 'string' } }, [])),
    }),
  ]);
  const to = makeSpec([
    makeOp({
      method: 'POST',
      path: '/a',
      requestBody: body(true, obj({ notes: { type: 'string' } }, ['notes'])),
    }),
  ]);
  const changes = compareSpecs(from, to);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].changeType, 'FIELD_REQUIREDNESS_CHANGED');
  assert.equal(changes[0].fieldPath, 'request.notes');
  assert.deepEqual(changes[0].before, { required: false });
  assert.deepEqual(changes[0].after, { required: true });
});

test('enum change on a request field', () => {
  const from = makeSpec([
    makeOp({
      method: 'POST',
      path: '/a',
      requestBody: body(true, obj({ kind: { type: 'string', enum: ['A', 'B'] } })),
    }),
  ]);
  const to = makeSpec([
    makeOp({
      method: 'POST',
      path: '/a',
      requestBody: body(true, obj({ kind: { type: 'string', enum: ['A', 'B', 'C'] } })),
    }),
  ]);
  const changes = compareSpecs(from, to);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].changeType, 'ENUM_CHANGED');
  assert.equal(changes[0].fieldPath, 'request.kind');
  assert.deepEqual(changes[0].before, { enum: ['A', 'B'] });
  assert.deepEqual(changes[0].after, { enum: ['A', 'B', 'C'] });
});

test('nullable change', () => {
  const from = makeSpec([
    makeOp({ path: '/a', responses: response('200', { type: 'string' }) }),
  ]);
  const to = makeSpec([
    makeOp({ path: '/a', responses: response('200', { type: 'string', nullable: true }) }),
  ]);
  const changes = compareSpecs(from, to);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].changeType, 'NULLABLE_CHANGED');
  assert.deepEqual(changes[0].before, { nullable: false });
  assert.deepEqual(changes[0].after, { nullable: true });
});

test('constraint change reports only the changed key', () => {
  const from = makeSpec([
    makeOp({ path: '/a', responses: response('200', { type: 'integer', minimum: 0 }) }),
  ]);
  const to = makeSpec([
    makeOp({ path: '/a', responses: response('200', { type: 'integer', minimum: 1 }) }),
  ]);
  const changes = compareSpecs(from, to);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].changeType, 'CONSTRAINT_CHANGED');
  assert.equal(changes[0].fieldPath, 'response.200');
  assert.deepEqual(changes[0].before, { minimum: 0 });
  assert.deepEqual(changes[0].after, { minimum: 1 });
});

test('nested array changes use [] segments in fieldPath', () => {
  const item = obj({ label: { type: 'string' }, amount: { type: 'number' } }, ['label', 'amount']);
  const from = makeSpec([
    makeOp({ path: '/a', responses: response('200', { type: 'array', items: item }) }),
  ]);
  const to = makeSpec([
    makeOp({
      path: '/a',
      responses: response('200', { type: 'array', items: obj({ label: { type: 'string' }, total: { type: 'number' } }, ['label', 'total']) }),
    }),
  ]);
  const changes = compareSpecs(from, to);
  assert.equal(changes.length, 2);
  const removed = changes.find((c) => c.changeType === 'FIELD_REMOVED');
  const added = changes.find((c) => c.changeType === 'FIELD_ADDED');
  assert.equal(removed.fieldPath, 'response.200[].amount');
  assert.equal(added.fieldPath, 'response.200[].total');
  assert.equal(added.after.required, true);
});

test('changes are reported against the specific status when multiple exist', () => {
  const base = obj({ code: { type: 'string' } });
  const from = makeSpec([
    makeOp({
      path: '/a',
      responses: {
        ...response('200', base),
        ...response('409', base),
      },
    }),
  ]);
  const to = makeSpec([
    makeOp({
      path: '/a',
      responses: {
        ...response('200', base),
        ...response('409', obj({ code: { type: 'string' }, reason: { type: 'string' } })),
      },
    }),
  ]);
  const changes = compareSpecs(from, to);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].changeType, 'FIELD_ADDED');
  assert.equal(changes[0].fieldPath, 'response.409.reason');
  assert.equal(changes[0].location, 'response.409');
});

// ---------------------------------------------------------------------------
// Determinism and symmetry
// ---------------------------------------------------------------------------

test('comparison is deterministic: identical output across runs', () => {
  const from = makeSpec([
    makeOp({ path: '/a/{id}', parameters: [param('id', { location: 'path', required: true })], responses: response('200', obj({ x: { type: 'string' } })) }),
    makeOp({ method: 'POST', path: '/b', requestBody: body(true, obj({ y: { type: 'integer' } })) }),
  ]);
  const to = makeSpec([
    makeOp({ path: '/a/{key}', parameters: [param('key', { location: 'path', required: true })], responses: response('200', obj({ x: { type: 'string' }, z: { type: 'boolean' } })) }),
    makeOp({ method: 'POST', path: '/b', requestBody: body(false, obj({ y: { type: 'integer' }, w: { type: 'string' } })) }),
    makeOp({ method: 'GET', path: '/c', responses: {} }),
  ]);
  const first = compareSpecs(from, to);
  const second = compareSpecs(from, to);
  assert.deepEqual(first, second);
});

test('reversed comparison inverts every directional change', async () => {
  const fixture = async (name) => {
    const file = fileURLToPath(new URL(`../../specs/${name}`, import.meta.url));
    const resolved = await SwaggerParser.dereference(loadYaml(readFileSync(file, 'utf8')));
    const result = normalizeSpec(resolved);
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    return result.spec;
  };

  const from = await fixture('policy-api/2-deprecations.yaml');
  const to = await fixture('policy-api/3-remove-old-fields.yaml');
  const forward = compareSpecs(from, to);
  const backward = compareSpecs(to, from);

  assert.ok(forward.length > 0);
  assert.equal(forward.length, backward.length);

  const inverse = {
    ENDPOINT_ADDED: 'ENDPOINT_REMOVED',
    ENDPOINT_REMOVED: 'ENDPOINT_ADDED',
    METHOD_ADDED: 'METHOD_REMOVED',
    METHOD_REMOVED: 'METHOD_ADDED',
    PARAMETER_ADDED: 'PARAMETER_REMOVED',
    PARAMETER_REMOVED: 'PARAMETER_ADDED',
    FIELD_ADDED: 'FIELD_REMOVED',
    FIELD_REMOVED: 'FIELD_ADDED',
  };
  for (const change of forward) {
    const match = backward.find(
      (b) =>
        b.changeType === (inverse[change.changeType] ?? change.changeType) &&
        b.method === change.method &&
        b.fieldPath === change.fieldPath
    );
    assert.ok(match, `no inverse for ${change.changeType} ${change.fieldPath}`);
  }
});

// ---------------------------------------------------------------------------
// Starter-kit fixtures
// ---------------------------------------------------------------------------

async function loadFixture(name) {
  const file = fileURLToPath(new URL(`../../specs/${name}`, import.meta.url));
  const resolved = await SwaggerParser.dereference(loadYaml(readFileSync(file, 'utf8')));
  const result = normalizeSpec(resolved);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  return result.spec;
}

test('policy 1 -> 2: deprecation/x-sunset metadata is not structural', async () => {
  const from = await loadFixture('policy-api/1-initial.yaml');
  const to = await loadFixture('policy-api/2-deprecations.yaml');
  assert.deepEqual(compareSpecs(from, to), []);
});

test('policy 2 -> 3: removed response fields across both endpoints', async () => {
  const from = await loadFixture('policy-api/2-deprecations.yaml');
  const to = await loadFixture('policy-api/3-remove-old-fields.yaml');
  const changes = compareSpecs(from, to);
  assert.equal(changes.length, 4);
  for (const change of changes) assert.equal(change.changeType, 'FIELD_REMOVED');
  const removed = changes.map((c) => `${c.method} ${c.path} ${c.fieldPath}`).sort();
  assert.deepEqual(removed, [
    'GET /policies response.200[].holder.phone',
    'GET /policies response.200[].legacyCode',
    'GET /policies/{policyId} response.200.holder.phone',
    'GET /policies/{policyId} response.200.legacyCode',
  ]);
});

test('policy 3 -> 4: enum value removed + required request field added', async () => {
  const from = await loadFixture('policy-api/3-remove-old-fields.yaml');
  const to = await loadFixture('policy-api/4-endorsement-rules.yaml');
  const changes = compareSpecs(from, to);
  assert.equal(changes.length, 2);

  const enumChange = changes.find((c) => c.changeType === 'ENUM_CHANGED');
  assert.equal(enumChange.method, 'POST');
  assert.equal(enumChange.path, '/policies/{policyId}/endorsements');
  assert.equal(enumChange.fieldPath, 'request.type');
  assert.deepEqual(enumChange.before, { enum: ['ADDRESS', 'NOMINEE', 'VEHICLE'] });
  assert.deepEqual(enumChange.after, { enum: ['ADDRESS', 'NOMINEE'] });

  const added = changes.find((c) => c.changeType === 'FIELD_ADDED');
  assert.equal(added.fieldPath, 'request.requestedBy');
  assert.equal(added.after.required, true);
  assert.equal(added.after.type, 'string');
});

test('quote 1 -> 2: path parameter rename is visible; $ref reorganisation is silent', async () => {
  const from = await loadFixture('quote-api/1-initial.yaml');
  const to = await loadFixture('quote-api/2-reorganised.yaml');
  const changes = compareSpecs(from, to);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].changeType, 'PARAMETER_RENAMED');
  assert.equal(changes[0].method, 'GET');
  assert.deepEqual(changes[0].before, { name: 'id', in: 'path' });
  assert.deepEqual(changes[0].after, { name: 'quoteId', in: 'path' });
});

test('quote 2 -> 3: required parameter, enum expansion, field rename', async () => {
  const from = await loadFixture('quote-api/2-reorganised.yaml');
  const to = await loadFixture('quote-api/3-price-lines.yaml');
  const changes = compareSpecs(from, to);
  assert.equal(changes.length, 7);

  const param = changes.find((c) => c.changeType === 'PARAMETER_ADDED');
  assert.equal(param.method, 'DELETE');
  assert.equal(param.path, '/internal/pricing-cache');
  assert.equal(param.after.name, 'region');
  assert.equal(param.after.required, true);
  assert.equal(param.after.in, 'query');

  const enums = changes.filter((c) => c.changeType === 'ENUM_CHANGED');
  assert.equal(enums.length, 2);
  for (const change of enums) {
    assert.deepEqual(change.before, { enum: ['DRAFT', 'FINAL'] });
    assert.deepEqual(change.after, { enum: ['DRAFT', 'EXPIRED', 'FINAL'] });
  }
  assert.deepEqual(
    enums.map((c) => c.fieldPath).sort(),
    ['response.200.status', 'response.201.status']
  );

  const renames = changes.filter((c) => c.changeType === 'FIELD_ADDED' || c.changeType === 'FIELD_REMOVED');
  assert.equal(renames.length, 4);
  assert.deepEqual(
    renames.map((c) => `${c.changeType} ${c.fieldPath}`).sort(),
    [
      'FIELD_ADDED response.200.premium.breakdown[].value',
      'FIELD_ADDED response.201.premium.breakdown[].value',
      'FIELD_REMOVED response.200.premium.breakdown[].amount',
      'FIELD_REMOVED response.201.premium.breakdown[].amount',
    ]
  );
});

test('quote 3 -> 4: optional additions only', async () => {
  const from = await loadFixture('quote-api/3-price-lines.yaml');
  const to = await loadFixture('quote-api/4-ncb-and-taxes.yaml');
  const changes = compareSpecs(from, to);
  assert.equal(changes.length, 3);
  for (const change of changes) {
    assert.equal(change.changeType, 'FIELD_ADDED');
    assert.equal(change.after.required, false);
  }
  const ncb = changes.find((c) => c.fieldPath === 'request.rider.ncbPercent');
  assert.equal(ncb.method, 'POST');
  assert.equal(ncb.path, '/quotes');
  assert.equal(ncb.after.type, 'integer');
  assert.equal(ncb.after.minimum, 0);
  assert.equal(ncb.after.maximum, 50);
  assert.deepEqual(
    changes.map((c) => c.fieldPath).sort(),
    ['request.rider.ncbPercent', 'response.200.premium.taxes', 'response.201.premium.taxes']
  );
});

test('claims 1 -> 3: optional channel enum + assessorNotes added', async () => {
  const from = await loadFixture('claims-api/1-initial.yaml');
  const to = await loadFixture('claims-api/3-channel-and-notes-fixed.yaml');
  const changes = compareSpecs(from, to);
  assert.equal(changes.length, 3);
  for (const change of changes) {
    assert.equal(change.changeType, 'FIELD_ADDED');
    assert.equal(change.after.required, false);
  }
  const channel = changes.find((c) => c.fieldPath === 'request.channel');
  assert.deepEqual(channel.after.enum, ['APP', 'PARTNER', 'WEB']);
  assert.deepEqual(
    changes
      .filter((c) => c.fieldPath === 'response.200.assessorNotes' || c.fieldPath === 'response.201.assessorNotes')
      .map((c) => c.fieldPath).sort(),
    ['response.200.assessorNotes', 'response.201.assessorNotes']
  );
});

test('claims 3 -> 4: response status added + requiredness relaxed', async () => {
  const from = await loadFixture('claims-api/3-channel-and-notes-fixed.yaml');
  const to = await loadFixture('claims-api/4-approval-later.yaml');
  const changes = compareSpecs(from, to);
  assert.equal(changes.length, 3);

  const status = changes.find((c) => c.changeType === 'RESPONSE_STATUS_ADDED');
  assert.equal(status.method, 'POST');
  assert.equal(status.path, '/claims');
  assert.equal(status.fieldPath, 'response.202');
  assert.deepEqual(status.after, { contentTypes: ['application/json'] });

  const requiredness = changes.filter((c) => c.changeType === 'FIELD_REQUIREDNESS_CHANGED');
  assert.equal(requiredness.length, 2);
  for (const change of requiredness) {
    assert.equal(change.fieldPath.endsWith('.amountApproved'), true);
    assert.deepEqual(change.before, { required: true });
    assert.deepEqual(change.after, { required: false });
  }
});
