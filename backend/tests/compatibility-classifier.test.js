// Unit tests for the compatibility classification engine (pure module — no
// database, no HTTP server, no LLM). Covers every rule in the initial rule
// set, both directions of each conditional rule, the UNKNOWN fallbacks, and
// the counting contract.
//
// Minimum coverage required by the task:
//   1.  endpoint removal              2.  endpoint addition
//   3.  required request field add    4.  optional request field add
//   5.  request field removal         6.  response field removal
//   7.  optional response field add   8.  required response field add
//   9.  request type change          10.  response type change
//   11. optional parameter -> required
//   12. request enum value removal    13. request enum value addition
//   14. response enum value addition  15. response enum value removal
//   16. response status removal      17. response status addition
//   18. unknown change type          19. missing/ambiguous metadata
//   20. empty change list
// Plus: a single UNKNOWN change must not be counted as NON_BREAKING.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyChange, classifyChanges, COMPATIBILITY } from '../src/services/compatibility-classifier.js';

function change(overrides = {}) {
  return {
    changeType: 'FIELD_REMOVED',
    method: 'GET',
    path: '/things',
    before: null,
    after: null,
    ...overrides,
  };
}

function requestField(changeType, { required = false } = {}) {
  return change({
    changeType,
    method: 'POST',
    path: '/things',
    location: 'request',
    fieldPath: 'request.nested.field',
    before: changeType === 'FIELD_ADDED' ? null : { required, type: 'string' },
    after: changeType === 'FIELD_REMOVED' ? null : { required, type: 'string' },
  });
}

function responseField(changeType, { required = false } = {}) {
  return change({
    changeType,
    location: 'response.200',
    fieldPath: 'response.200.field',
    before: changeType === 'FIELD_ADDED' ? null : { required, type: 'string' },
    after: changeType === 'FIELD_REMOVED' ? null : { required, type: 'string' },
  });
}

function assertClassification(changeInput, { classification, ruleId, reasonMatches }) {
  const result = classifyChange(changeInput);
  assert.equal(result.classification, classification, ruleId);
  assert.equal(result.ruleId, ruleId);
  if (reasonMatches) assert.match(result.reason, reasonMatches);
  return result;
}

// ---------------------------------------------------------------------------
// 1-2: Endpoints
// ---------------------------------------------------------------------------

test('endpoint removal is BREAKING', () => {
  assertClassification(
    change({
      changeType: 'ENDPOINT_REMOVED',
      method: null,
      path: '/policies',
      location: 'endpoint',
      before: { methods: ['GET', 'POST'] },
      after: null,
    }),
    {
      classification: COMPATIBILITY.BREAKING,
      ruleId: 'ENDPOINT_REMOVED',
      reasonMatches: /\/policies/,
    }
  );
});

test('endpoint addition is NON_BREAKING', () => {
  assertClassification(
    change({
      changeType: 'ENDPOINT_ADDED',
      method: null,
      path: '/policies/search',
      location: 'endpoint',
      before: null,
      after: { methods: ['GET'] },
    }),
    {
      classification: COMPATIBILITY.NON_BREAKING,
      ruleId: 'ENDPOINT_ADDED',
      reasonMatches: /\/policies\/search/,
    }
  );
});

test('method removal is BREAKING and method addition is NON_BREAKING', () => {
  assertClassification(
    change({ changeType: 'METHOD_REMOVED', method: 'DELETE', location: 'method' }),
    { classification: COMPATIBILITY.BREAKING, ruleId: 'METHOD_REMOVED', reasonMatches: /DELETE \/things/ }
  );
  assertClassification(
    change({ changeType: 'METHOD_ADDED', method: 'PUT', location: 'method' }),
    { classification: COMPATIBILITY.NON_BREAKING, ruleId: 'METHOD_ADDED' }
  );
});

// ---------------------------------------------------------------------------
// 3-5: Request fields
// ---------------------------------------------------------------------------

test('required request field addition is BREAKING', () => {
  assertClassification(requestField('FIELD_ADDED', { required: true }), {
    classification: COMPATIBILITY.BREAKING,
    ruleId: 'REQUEST_FIELD_ADDED_REQUIRED',
    reasonMatches: /field/,
  });
});

test('optional request field addition is NON_BREAKING', () => {
  assertClassification(requestField('FIELD_ADDED', { required: false }), {
    classification: COMPATIBILITY.NON_BREAKING,
    ruleId: 'REQUEST_FIELD_ADDED_OPTIONAL',
  });
});

test('request field removal is BREAKING', () => {
  assertClassification(requestField('FIELD_REMOVED'), {
    classification: COMPATIBILITY.BREAKING,
    ruleId: 'REQUEST_FIELD_REMOVED',
  });
});

test('request field type change is BREAKING', () => {
  assertClassification(
    change({
      changeType: 'FIELD_TYPE_CHANGED',
      method: 'POST',
      location: 'request',
      fieldPath: 'request.amount',
      before: { type: 'string' },
      after: { type: 'number' },
    }),
    {
      classification: COMPATIBILITY.BREAKING,
      ruleId: 'REQUEST_FIELD_TYPE_CHANGED',
      reasonMatches: /string/,
    }
  );
});

test('request field optional -> required is BREAKING; required -> optional is NON_BREAKING', () => {
  assertClassification(
    change({
      changeType: 'FIELD_REQUIREDNESS_CHANGED',
      method: 'POST',
      location: 'request',
      fieldPath: 'request.notes',
      before: { required: false },
      after: { required: true },
    }),
    { classification: COMPATIBILITY.BREAKING, ruleId: 'REQUEST_FIELD_OPTIONAL_TO_REQUIRED' }
  );
  assertClassification(
    change({
      changeType: 'FIELD_REQUIREDNESS_CHANGED',
      method: 'POST',
      location: 'request',
      fieldPath: 'request.notes',
      before: { required: true },
      after: { required: false },
    }),
    { classification: COMPATIBILITY.NON_BREAKING, ruleId: 'REQUEST_FIELD_REQUIRED_TO_OPTIONAL' }
  );
});

test('request enum value removal is BREAKING, even when other values are added', () => {
  assertClassification(
    change({
      changeType: 'ENUM_CHANGED',
      method: 'POST',
      location: 'request',
      fieldPath: 'request.type',
      before: { enum: ['ADDRESS', 'NOMINEE', 'VEHICLE'] },
      after: { enum: ['ADDRESS', 'NOMINEE'] },
    }),
    {
      classification: COMPATIBILITY.BREAKING,
      ruleId: 'REQUEST_ENUM_VALUES_REMOVED',
      reasonMatches: /VEHICLE/,
    }
  );
});

test('request enum value addition only is NON_BREAKING', () => {
  assertClassification(
    change({
      changeType: 'ENUM_CHANGED',
      method: 'POST',
      location: 'request',
      fieldPath: 'request.channel',
      before: { enum: ['APP', 'WEB'] },
      after: { enum: ['APP', 'PARTNER', 'WEB'] },
    }),
    {
      classification: COMPATIBILITY.NON_BREAKING,
      ruleId: 'REQUEST_ENUM_VALUES_ADDED',
      reasonMatches: /PARTNER/,
    }
  );
});

// ---------------------------------------------------------------------------
// 6-8: Response fields
// ---------------------------------------------------------------------------

test('response field removal is BREAKING', () => {
  assertClassification(responseField('FIELD_REMOVED'), {
    classification: COMPATIBILITY.BREAKING,
    ruleId: 'RESPONSE_FIELD_REMOVED',
    reasonMatches: /no longer returned/,
  });
});

test('optional response field addition is NON_BREAKING', () => {
  assertClassification(responseField('FIELD_ADDED', { required: false }), {
    classification: COMPATIBILITY.NON_BREAKING,
    ruleId: 'RESPONSE_FIELD_ADDED_OPTIONAL',
  });
});

test('required response field addition is UNKNOWN', () => {
  assertClassification(responseField('FIELD_ADDED', { required: true }), {
    classification: COMPATIBILITY.UNKNOWN,
    ruleId: 'RESPONSE_FIELD_ADDED_REQUIRED',
    reasonMatches: /manual review/,
  });
});

test('response field type change is BREAKING', () => {
  assertClassification(
    change({
      changeType: 'FIELD_TYPE_CHANGED',
      location: 'response.200',
      fieldPath: 'response.200.total',
      before: { type: 'string' },
      after: { type: 'number' },
    }),
    {
      classification: COMPATIBILITY.BREAKING,
      ruleId: 'RESPONSE_FIELD_TYPE_CHANGED',
      reasonMatches: /200/,
    }
  );
});

test('response field requiredness change is UNKNOWN in both directions', () => {
  assertClassification(
    change({
      changeType: 'FIELD_REQUIREDNESS_CHANGED',
      location: 'response.200',
      fieldPath: 'response.200.total',
      before: { required: false },
      after: { required: true },
    }),
    { classification: COMPATIBILITY.UNKNOWN, ruleId: 'RESPONSE_FIELD_OPTIONAL_TO_REQUIRED' }
  );
  assertClassification(
    change({
      changeType: 'FIELD_REQUIREDNESS_CHANGED',
      location: 'response.200',
      fieldPath: 'response.200.total',
      before: { required: true },
      after: { required: false },
    }),
    { classification: COMPATIBILITY.UNKNOWN, ruleId: 'RESPONSE_FIELD_REQUIRED_TO_OPTIONAL' }
  );
});

// ---------------------------------------------------------------------------
// 14-15: Response enums
// ---------------------------------------------------------------------------

test('response enum value addition is UNKNOWN', () => {
  assertClassification(
    change({
      changeType: 'ENUM_CHANGED',
      location: 'response.200',
      fieldPath: 'response.200.status',
      before: { enum: ['DRAFT', 'FINAL'] },
      after: { enum: ['DRAFT', 'EXPIRED', 'FINAL'] },
    }),
    {
      classification: COMPATIBILITY.UNKNOWN,
      ruleId: 'RESPONSE_ENUM_VALUES_ADDED',
      reasonMatches: /EXPIRED/,
    }
  );
});

test('response enum value removal is UNKNOWN', () => {
  assertClassification(
    change({
      changeType: 'ENUM_CHANGED',
      location: 'response.200',
      fieldPath: 'response.200.status',
      before: { enum: ['DRAFT', 'FINAL'] },
      after: { enum: ['FINAL'] },
    }),
    { classification: COMPATIBILITY.UNKNOWN, ruleId: 'RESPONSE_ENUM_VALUES_REMOVED' }
  );
});

// ---------------------------------------------------------------------------
// 16-17: Response status codes
// ---------------------------------------------------------------------------

test('response status code addition is NON_BREAKING', () => {
  assertClassification(
    change({
      changeType: 'RESPONSE_STATUS_ADDED',
      method: 'POST',
      location: 'response',
      fieldPath: 'response.202',
      before: null,
      after: { contentTypes: ['application/json'] },
    }),
    { classification: COMPATIBILITY.NON_BREAKING, ruleId: 'RESPONSE_STATUS_ADDED', reasonMatches: /202/ }
  );
});

test('response status code removal is UNKNOWN', () => {
  assertClassification(
    change({
      changeType: 'RESPONSE_STATUS_REMOVED',
      method: 'POST',
      location: 'response',
      fieldPath: 'response.202',
      before: { contentTypes: ['application/json'] },
      after: null,
    }),
    { classification: COMPATIBILITY.UNKNOWN, ruleId: 'RESPONSE_STATUS_REMOVED', reasonMatches: /202/ }
  );
});

test('response content type addition/removal is UNKNOWN', () => {
  assertClassification(
    change({
      changeType: 'RESPONSE_CONTENT_TYPE_ADDED',
      location: 'response.200',
      fieldPath: 'response.200[text/html]',
      before: null,
      after: { contentType: 'text/html' },
    }),
    { classification: COMPATIBILITY.UNKNOWN, ruleId: 'RESPONSE_CONTENT_TYPE_ADDED' }
  );
  assertClassification(
    change({
      changeType: 'RESPONSE_CONTENT_TYPE_REMOVED',
      location: 'response.200',
      fieldPath: 'response.200[text/html]',
      before: { contentType: 'text/html' },
      after: null,
    }),
    { classification: COMPATIBILITY.UNKNOWN, ruleId: 'RESPONSE_CONTENT_TYPE_REMOVED' }
  );
});

// ---------------------------------------------------------------------------
// 11 + rest: Request parameters
// ---------------------------------------------------------------------------

test('optional parameter becoming required is BREAKING', () => {
  assertClassification(
    change({
      changeType: 'PARAMETER_REQUIREDNESS_CHANGED',
      location: 'parameter',
      fieldPath: 'parameters.limit',
      before: { required: false },
      after: { required: true },
    }),
    { classification: COMPATIBILITY.BREAKING, ruleId: 'PARAMETER_OPTIONAL_TO_REQUIRED', reasonMatches: /limit/ }
  );
});

test('required parameter becoming optional is NON_BREAKING', () => {
  assertClassification(
    change({
      changeType: 'PARAMETER_REQUIREDNESS_CHANGED',
      location: 'parameter',
      fieldPath: 'parameters.limit',
      before: { required: true },
      after: { required: false },
    }),
    { classification: COMPATIBILITY.NON_BREAKING, ruleId: 'PARAMETER_REQUIRED_TO_OPTIONAL' }
  );
});

test('parameter removal is BREAKING', () => {
  assertClassification(
    change({
      changeType: 'PARAMETER_REMOVED',
      location: 'parameter',
      fieldPath: 'parameters.verbose',
      before: { name: 'verbose', in: 'query', required: false, schema: { type: 'boolean' } },
      after: null,
    }),
    { classification: COMPATIBILITY.BREAKING, ruleId: 'PARAMETER_REMOVED', reasonMatches: /verbose/ }
  );
});

test('required parameter addition is BREAKING; optional is NON_BREAKING', () => {
  assertClassification(
    change({
      changeType: 'PARAMETER_ADDED',
      location: 'parameter',
      fieldPath: 'parameters.region',
      before: null,
      after: { name: 'region', in: 'query', required: true, schema: { type: 'string' } },
    }),
    { classification: COMPATIBILITY.BREAKING, ruleId: 'PARAMETER_ADDED_REQUIRED', reasonMatches: /region/ }
  );
  assertClassification(
    change({
      changeType: 'PARAMETER_ADDED',
      location: 'parameter',
      fieldPath: 'parameters.verbose',
      before: null,
      after: { name: 'verbose', in: 'query', required: false, schema: { type: 'boolean' } },
    }),
    { classification: COMPATIBILITY.NON_BREAKING, ruleId: 'PARAMETER_ADDED_OPTIONAL' }
  );
});

test('parameter type change is BREAKING (real comparator shape: schema descriptors)', () => {
  assertClassification(
    change({
      changeType: 'PARAMETER_TYPE_CHANGED',
      location: 'parameter',
      fieldPath: 'parameters.limit',
      before: { type: 'string' },
      after: { type: 'integer' },
    }),
    {
      classification: COMPATIBILITY.BREAKING,
      ruleId: 'PARAMETER_TYPE_CHANGED',
      reasonMatches: /limit/,
    }
  );
});

test('parameter enum value removal is BREAKING; addition only is NON_BREAKING (real comparator shape)', () => {
  assertClassification(
    change({
      changeType: 'PARAMETER_ENUM_CHANGED',
      location: 'parameter',
      fieldPath: 'parameters.status',
      before: { enum: ['DRAFT', 'FINAL'] },
      after: { enum: ['FINAL'] },
    }),
    {
      classification: COMPATIBILITY.BREAKING,
      ruleId: 'PARAMETER_ENUM_VALUES_REMOVED',
      reasonMatches: /DRAFT/,
    }
  );
  assertClassification(
    change({
      changeType: 'PARAMETER_ENUM_CHANGED',
      location: 'parameter',
      fieldPath: 'parameters.status',
      before: { enum: ['DRAFT', 'FINAL'] },
      after: { enum: ['DRAFT', 'EXPIRED', 'FINAL'] },
    }),
    { classification: COMPATIBILITY.NON_BREAKING, ruleId: 'PARAMETER_ENUM_VALUES_ADDED' }
  );
});

test('parameter rename is UNKNOWN (no rule in the initial set)', () => {
  assertClassification(
    change({
      changeType: 'PARAMETER_RENAMED',
      location: 'parameter',
      fieldPath: 'parameters.id',
      before: { name: 'id', in: 'path' },
      after: { name: 'quoteId', in: 'path' },
    }),
    { classification: COMPATIBILITY.UNKNOWN, ruleId: 'PARAMETER_RENAMED', reasonMatches: /renamed/ }
  );
});

// ---------------------------------------------------------------------------
// Request body
// ---------------------------------------------------------------------------

test('request body removal is BREAKING; requiredness changes follow direction', () => {
  assertClassification(
    change({
      changeType: 'REQUEST_BODY_REMOVED',
      method: 'POST',
      location: 'requestBody',
      before: { required: true, contentTypes: ['application/json'] },
      after: null,
    }),
    { classification: COMPATIBILITY.BREAKING, ruleId: 'REQUEST_BODY_REMOVED' }
  );
  assertClassification(
    change({
      changeType: 'REQUEST_BODY_REQUIREDNESS_CHANGED',
      method: 'POST',
      location: 'requestBody',
      before: { required: false },
      after: { required: true },
    }),
    { classification: COMPATIBILITY.BREAKING, ruleId: 'REQUEST_BODY_BECAME_REQUIRED' }
  );
  assertClassification(
    change({
      changeType: 'REQUEST_BODY_REQUIREDNESS_CHANGED',
      method: 'POST',
      location: 'requestBody',
      before: { required: true },
      after: { required: false },
    }),
    { classification: COMPATIBILITY.NON_BREAKING, ruleId: 'REQUEST_BODY_BECAME_OPTIONAL' }
  );
});

test('request body addition and request content type changes are UNKNOWN', () => {
  assertClassification(
    change({
      changeType: 'REQUEST_BODY_ADDED',
      method: 'POST',
      location: 'requestBody',
      before: null,
      after: { required: false, contentTypes: ['application/json'] },
    }),
    { classification: COMPATIBILITY.UNKNOWN, ruleId: 'REQUEST_BODY_ADDED' }
  );
  assertClassification(
    change({
      changeType: 'REQUEST_CONTENT_TYPE_ADDED',
      method: 'POST',
      location: 'request',
      fieldPath: 'request[text/plain]',
      before: null,
      after: { contentType: 'text/plain' },
    }),
    { classification: COMPATIBILITY.UNKNOWN, ruleId: 'REQUEST_CONTENT_TYPE_ADDED' }
  );
  assertClassification(
    change({
      changeType: 'REQUEST_CONTENT_TYPE_REMOVED',
      method: 'POST',
      location: 'request',
      fieldPath: 'request[text/plain]',
      before: { contentType: 'text/plain' },
      after: null,
    }),
    { classification: COMPATIBILITY.UNKNOWN, ruleId: 'REQUEST_CONTENT_TYPE_REMOVED' }
  );
});

// ---------------------------------------------------------------------------
// 18: Unknown change types
// ---------------------------------------------------------------------------

test('unknown change types default to UNKNOWN with ruleId NO_RULE', () => {
  assertClassification(change({ changeType: 'SOME_FUTURE_CHANGE' }), {
    classification: COMPATIBILITY.UNKNOWN,
    ruleId: 'NO_RULE',
    reasonMatches: /SOME_FUTURE_CHANGE/,
  });
});

test('operationId change and other no-rule changes are UNKNOWN, never NON_BREAKING', () => {
  const operationId = assertClassification(
    change({
      changeType: 'OPERATION_ID_CHANGED',
      location: 'operation',
      before: { operationId: 'old' },
      after: { operationId: 'new' },
    }),
    { classification: COMPATIBILITY.UNKNOWN, ruleId: 'OPERATION_ID_CHANGED' }
  );
  assert.match(operationId.reason, /manual review/);

  assertClassification(
    change({
      changeType: 'NULLABLE_CHANGED',
      location: 'request',
      fieldPath: 'request.value',
      before: { nullable: false },
      after: { nullable: true },
    }),
    { classification: COMPATIBILITY.UNKNOWN, ruleId: 'NULLABLE_CHANGED' }
  );
  assertClassification(
    change({
      changeType: 'CONSTRAINT_CHANGED',
      location: 'request',
      fieldPath: 'request.rider.ncbPercent',
      before: { minimum: 0 },
      after: { minimum: 5 },
    }),
    { classification: COMPATIBILITY.UNKNOWN, ruleId: 'CONSTRAINT_CHANGED', reasonMatches: /minimum/ }
  );
});

// ---------------------------------------------------------------------------
// 19: Missing or ambiguous metadata
// ---------------------------------------------------------------------------

test('missing requiredness metadata defaults to optional (OpenAPI default)', () => {
  // The comparator always emits `required` for added/removed fields and
  // parameters, but a hand-built change without it must not be classified
  // as more restrictive than the evidence supports.
  const field = assertClassification(
    change({
      changeType: 'FIELD_ADDED',
      method: 'POST',
      location: 'request',
      fieldPath: 'request.extra',
      before: null,
      after: { type: 'string' }, // no `required` key
    }),
    { classification: COMPATIBILITY.NON_BREAKING, ruleId: 'REQUEST_FIELD_ADDED_OPTIONAL' }
  );
  assert.match(field.reason, /Optional request field/);

  const parameter = assertClassification(
    change({
      changeType: 'PARAMETER_ADDED',
      location: 'parameter',
      fieldPath: 'parameters.flag',
      before: null,
      after: { name: 'flag', in: 'query', schema: { type: 'boolean' } }, // no `required` key
    }),
    { classification: COMPATIBILITY.NON_BREAKING, ruleId: 'PARAMETER_ADDED_OPTIONAL' }
  );
  assert.match(parameter.reason, /Optional parameter/);
});

test('enum changes with missing enum lists are treated as empty sets', () => {
  const addedFromEmpty = assertClassification(
    change({
      changeType: 'ENUM_CHANGED',
      method: 'POST',
      location: 'request',
      fieldPath: 'request.kind',
      before: { enum: null },
      after: { enum: ['A', 'B'] },
    }),
    { classification: COMPATIBILITY.NON_BREAKING, ruleId: 'REQUEST_ENUM_VALUES_ADDED' }
  );
  assert.match(addedFromEmpty.reason, /\[A, B\]/);
});

// ---------------------------------------------------------------------------
// 20 + counts: empty change list and counting contract
// ---------------------------------------------------------------------------

test('empty change list yields zero counts', () => {
  const result = classifyChanges([]);
  assert.deepEqual(result.counts, { total: 0, breaking: 0, nonBreaking: 0, unknown: 0 });
  assert.deepEqual(result.changes, []);
});

test('a single UNKNOWN change is not counted as NON_BREAKING', () => {
  const result = classifyChanges([
    change({
      changeType: 'NULLABLE_CHANGED',
      location: 'request',
      fieldPath: 'request.value',
      before: { nullable: false },
      after: { nullable: true },
    }),
  ]);
  assert.deepEqual(result.counts, { total: 1, breaking: 0, nonBreaking: 0, unknown: 1 });
});

test('counts reflect a mixed change set exactly', () => {
  const result = classifyChanges([
    change({
      changeType: 'FIELD_REMOVED',
      method: 'GET',
      location: 'response.200',
      fieldPath: 'response.200.legacy',
      before: { required: false, type: 'string' },
      after: null,
    }),
    change({
      changeType: 'FIELD_ADDED',
      method: 'POST',
      location: 'request',
      fieldPath: 'request.extra',
      before: null,
      after: { required: false, type: 'string' },
    }),
    change({
      changeType: 'SOME_FUTURE_CHANGE',
      method: 'GET',
      path: '/things',
    }),
    change({
      changeType: 'FIELD_ADDED',
      method: 'POST',
      location: 'request',
      fieldPath: 'request.mandatory',
      before: null,
      after: { required: true, type: 'string' },
    }),
  ]);
  assert.deepEqual(result.counts, { total: 4, breaking: 2, nonBreaking: 1, unknown: 1 });
});

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

test('classified changes preserve all comparator fields and add classification data', () => {
  const original = change({
    changeType: 'FIELD_REMOVED',
    method: 'GET',
    path: '/users/{id}',
    location: 'response.200',
    fieldPath: 'response.200.user.email',
    description: 'Field "email" was removed from the response (200) schema of GET /users/{id}.',
    before: { required: true, type: 'string' },
    after: null,
  });
  const { changes } = classifyChanges([original]);
  assert.equal(changes.length, 1);
  const classified = changes[0];
  // Original comparator fields preserved.
  assert.equal(classified.changeType, 'FIELD_REMOVED');
  assert.equal(classified.method, 'GET');
  assert.equal(classified.path, '/users/{id}');
  assert.equal(classified.fieldPath, 'response.200.user.email');
  assert.equal(classified.location, 'response.200');
  assert.equal(classified.description, original.description);
  assert.deepEqual(classified.before, { required: true, type: 'string' });
  assert.equal(classified.after, null);
  // Classification data added.
  assert.equal(classified.classification, COMPATIBILITY.BREAKING);
  assert.equal(classified.ruleId, 'RESPONSE_FIELD_REMOVED');
  assert.match(classified.reason, /email/);
  assert.match(classified.reason, /no longer returned/);
});

test('classification is deterministic and does not mutate its input', () => {
  const input = [
    change({
      changeType: 'ENUM_CHANGED',
      method: 'POST',
      location: 'request',
      fieldPath: 'request.type',
      before: { enum: ['A', 'B'] },
      after: { enum: ['A'] },
    }),
    change({
      changeType: 'RESPONSE_STATUS_ADDED',
      method: 'POST',
      location: 'response',
      fieldPath: 'response.202',
      before: null,
      after: { contentTypes: ['application/json'] },
    }),
  ];
  const first = classifyChanges(input);
  const second = classifyChanges(input);
  assert.deepEqual(first, second);
  // Input is not mutated.
  assert.equal(input[0].classification, undefined);
  assert.equal(input[0].ruleId, undefined);
  assert.equal(input[0].reason, undefined);
});
