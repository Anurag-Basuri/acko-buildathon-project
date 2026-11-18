// Unit tests for the OpenAPI spec normalizer (pure module — no database,
// no HTTP server).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSpec, canonicalPath } from '../src/services/spec-normalizer.js';

function baseDocument() {
  return {
    openapi: '3.0.3',
    info: { title: 'Base API', version: '1.0.0' },
    paths: {
      '/users/{id}': {
        get: {
          operationId: 'getUser',
          parameters: [{ name: 'id', in: 'path', schema: { type: 'string' } }],
          responses: {
            '200': {
              description: 'ok',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['name'],
                    properties: {
                      name: { type: 'string' },
                      age: { type: 'integer', minimum: 0, maximum: 150 },
                      email: { type: 'string', format: 'email', nullable: true, maxLength: 320 },
                    },
                  },
                },
              },
            },
            '404': { description: 'not found' },
          },
        },
        post: {
          operationId: 'createUser',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['name', 'role'],
                  properties: {
                    name: { type: 'string' },
                    role: { type: 'string', enum: ['ADMIN', 'USER'] },
                    tags: { type: 'array', items: { type: 'string' } },
                  },
                },
              },
            },
          },
          responses: { '201': { description: 'created' } },
        },
      },
    },
  };
}

test('canonicalPath: parameter names are positional, static segments intact', () => {
  assert.equal(canonicalPath('/users/{id}'), '/users/{param_0}');
  assert.equal(canonicalPath('/users/{userId}'), '/users/{param_0}');
  assert.equal(canonicalPath('/a/{x}/b/{y}'), '/a/{param_0}/b/{param_1}');
  assert.equal(canonicalPath('/static/path'), '/static/path');
});

test('valid document: operations are extracted with methods uppercased', () => {
  const result = normalizeSpec(baseDocument());
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.spec.openApiVersion, '3.0.3');
  assert.equal(result.spec.title, 'Base API');
  assert.equal(result.spec.version, '1.0.0');
  assert.equal(result.spec.operations.length, 2);

  // Deterministic order: canonical path, then method.
  const [get, post] = result.spec.operations;
  assert.equal(get.method, 'GET');
  assert.equal(post.method, 'POST');
  assert.equal(get.path, '/users/{id}');
  assert.equal(get.canonicalPath, '/users/{param_0}');
  assert.equal(get.operationId, 'getUser');
});

test('valid document: parameters, request body and responses are extracted', () => {
  const result = normalizeSpec(baseDocument());
  const [get, post] = result.spec.operations;

  // Path parameters are always required per OpenAPI 3.0, even when the spec
  // omits `required`.
  assert.deepEqual(get.parameters, [
    { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
  ]);

  assert.equal(post.requestBody.required, true);
  const requestSchema = post.requestBody.content['application/json'].schema;
  assert.equal(requestSchema.type, 'object');
  assert.deepEqual(requestSchema.required, ['name', 'role']);
  assert.deepEqual(requestSchema.properties.role.enum, ['ADMIN', 'USER']);
  assert.deepEqual(requestSchema.properties.tags, {
    type: 'array',
    items: { type: 'string' },
  });

  // Response schemas.
  const okSchema = get.responses['200'].content['application/json'].schema;
  assert.equal(okSchema.type, 'object');
  assert.deepEqual(okSchema.required, ['name']);
  assert.deepEqual(okSchema.properties.age, {
    type: 'integer',
    minimum: 0,
    maximum: 150,
  });
  assert.deepEqual(okSchema.properties.email, {
    type: 'string',
    format: 'email',
    nullable: true,
    maxLength: 320,
  });

  // A response without content.
  assert.deepEqual(get.responses['404'], { content: {} });
  // A request without a body.
  assert.equal(get.requestBody, null);
});

test('valid document: different parameter names at the same position are equivalent', () => {
  const a = normalizeSpec({
    openapi: '3.0.3',
    info: { title: 'A', version: '1.0.0' },
    paths: {
      '/users/{id}': {
        get: {
          parameters: [{ name: 'id', in: 'path', schema: { type: 'string' } }],
          responses: { '200': { description: 'ok' } },
        },
      },
    },
  });
  const b = normalizeSpec({
    openapi: '3.0.3',
    info: { title: 'A', version: '1.0.0' },
    paths: {
      '/users/{userId}': {
        get: {
          parameters: [{ name: 'userId', in: 'path', schema: { type: 'string' } }],
          responses: { '200': { description: 'ok' } },
        },
      },
    },
  });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(a.spec.operations[0].canonicalPath, b.spec.operations[0].canonicalPath);
  // Original names are preserved.
  assert.equal(a.spec.operations[0].parameters[0].name, 'id');
  assert.equal(b.spec.operations[0].parameters[0].name, 'userId');
});

test('valid document: path-level parameters merge with operation-level ones', () => {
  const result = normalizeSpec({
    openapi: '3.0.3',
    info: { title: 'Merge', version: '1.0.0' },
    paths: {
      '/things/{tid}': {
        parameters: [{ name: 'tid', in: 'path', required: true, schema: { type: 'string' } }],
        get: {
          parameters: [{ name: 'verbose', in: 'query', required: false, schema: { type: 'boolean' } }],
          responses: { '200': { description: 'ok' } },
        },
        put: {
          responses: { '204': { description: 'done' } },
        },
      },
    },
  });
  assert.equal(result.ok, true);
  const [get, put] = result.spec.operations;
  assert.deepEqual(
    get.parameters.map((p) => `${p.in}:${p.name}`),
    ['query:verbose', 'path:tid']
  );
  // The path parameter is inherited by both operations.
  assert.deepEqual(put.parameters, [
    { name: 'tid', in: 'path', required: true, schema: { type: 'string' } },
  ]);
});

test('valid document: operation-level parameter wins over path-level duplicate', () => {
  const result = normalizeSpec({
    openapi: '3.0.3',
    info: { title: 'Dup', version: '1.0.0' },
    paths: {
      '/things': {
        parameters: [{ name: 'q', in: 'query', required: false, schema: { type: 'string' } }],
        get: {
          parameters: [{ name: 'q', in: 'query', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'ok' } },
        },
      },
    },
  });
  assert.equal(result.ok, true);
  const op = result.spec.operations[0];
  assert.equal(op.parameters.length, 1);
  assert.equal(op.parameters[0].required, true);
});

test('required lists are deduplicated and ordered deterministically', () => {
  const result = normalizeSpec({
    openapi: '3.0.3',
    info: { title: 'Req', version: '1.0.0' },
    paths: {
      '/x': {
        post: {
          requestBody: {
            required: false,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['b', 'a', 'b'],
                  properties: { a: { type: 'string' }, b: { type: 'string' } },
                },
              },
            },
          },
          responses: { '200': { description: 'ok' } },
        },
      },
    },
  });
  assert.equal(result.ok, true);
  const schema = result.spec.operations[0].requestBody.content['application/json'].schema;
  assert.deepEqual(schema.required, ['a', 'b']);
});

test('document without paths normalizes to zero operations', () => {
  const result = normalizeSpec({ openapi: '3.0.3', info: { title: 'Empty', version: '1.0.0' } });
  assert.equal(result.ok, true);
  assert.deepEqual(result.spec.operations, []);
  assert.equal(result.spec.title, 'Empty');
});

test('residual $ref is reported, never silently dropped', () => {
  const result = normalizeSpec({
    openapi: '3.0.3',
    info: { title: 'Refs', version: '1.0.0' },
    paths: {
      '/x': {
        get: {
          responses: {
            '200': {
              description: 'ok',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/X' } } },
            },
          },
        },
      },
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].code, 'UNRESOLVED_REFERENCE');
  assert.match(result.errors[0].message, /#\/components\/schemas\/X/);
  assert.equal(result.errors[0].path, '/paths/~1x/get/responses/200/application~1json');
});

test('unsupported schema constructs are reported with their pointer', () => {
  for (const construct of ['allOf', 'oneOf', 'anyOf', 'not']) {
    const result = normalizeSpec({
      openapi: '3.0.3',
      info: { title: 'C', version: '1.0.0' },
      paths: {
        '/x': {
          get: {
            responses: {
              '200': {
                description: 'ok',
                content: {
                  'application/json': {
                    schema: { [construct]: [{ type: 'object' }] },
                  },
                },
              },
            },
          },
        },
      },
    });
    assert.equal(result.ok, false, construct);
    const error = result.errors.find((e) => e.code === 'UNSUPPORTED_CONSTRUCT');
    assert.ok(error, `${construct} should be reported`);
    assert.match(error.message, new RegExp(construct));
  }
});

test('discriminator and patternProperties are unsupported', () => {
  const result = normalizeSpec({
    openapi: '3.0.3',
    info: { title: 'D', version: '1.0.0' },
    paths: {
      '/x': {
        get: {
          responses: {
            '200': {
              description: 'ok',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    discriminator: { propertyName: 'kind' },
                    patternProperties: { '^x_': { type: 'string' } },
                  },
                },
              },
            },
          },
        },
      },
    },
  });
  assert.equal(result.ok, false);
  const constructs = result.errors
    .filter((e) => e.code === 'UNSUPPORTED_CONSTRUCT')
    .map((e) => e.message.match(/"(\w+)"/)[1]);
  assert.ok(constructs.includes('discriminator'));
  assert.ok(constructs.includes('patternProperties'));
});

test('OpenAPI 3.1 union types are unsupported', () => {
  const result = normalizeSpec({
    openapi: '3.1.0',
    info: { title: 'Union', version: '1.0.0' },
    paths: {
      '/x': {
        get: {
          responses: {
            '200': {
              description: 'ok',
              content: {
                'application/json': {
                  schema: { type: ['string', 'null'] },
                },
              },
            },
          },
        },
      },
    },
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === 'UNSUPPORTED_CONSTRUCT' && /union type/.test(e.message)));
});

test('missing or non-3.x openapi version is rejected', () => {
  const missing = normalizeSpec({ info: { title: 'No version' } });
  assert.equal(missing.ok, false);
  assert.equal(missing.errors[0].code, 'UNSUPPORTED_VERSION');

  const swagger = normalizeSpec({ swagger: '2.0', info: { title: 'Old' } });
  assert.equal(swagger.ok, false);
  assert.equal(swagger.errors[0].code, 'UNSUPPORTED_VERSION');
});

test('non-object documents are rejected', () => {
  assert.equal(normalizeSpec(null).ok, false);
  assert.equal(normalizeSpec(['openapi']).ok, false);
  assert.equal(normalizeSpec('openapi: 3.0.3').ok, false);
});
