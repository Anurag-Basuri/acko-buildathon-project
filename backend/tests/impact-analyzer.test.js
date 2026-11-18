// Unit tests for the Consumer Impact Analysis engine (impact-analyzer.js).
// Pure module — no database, no app. Exercises the matching rules:
// operation matching (method + positional path template), direction
// (sends vs reads), token-aware field matching (nested, array, segment
// boundaries), operation-level changes, requirement introduction, and
// summary counts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeImpact, fieldContext, dependencyMatchesOperation } from '../src/services/impact-analyzer.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const quote = { id: 'provider-1', name: 'quote-api' };
const mobileApp = { id: 'consumer-1', name: 'mobile-app' };
const portal = { id: 'consumer-2', name: 'partner-portal' };
const payments = { id: 'consumer-3', name: 'payments-svc' };

function dep({ id, consumer, method, path, sends = [], reads = [] }) {
  return {
    id,
    consumerServiceId: consumer.id,
    consumer,
    method,
    path,
    sends,
    reads,
  };
}

function change(partial) {
  return {
    method: null,
    path: null,
    description: 'test change',
    classification: 'BREAKING',
    ruleId: 'TEST_RULE',
    reason: 'test rule',
    ...partial,
  };
}

const deps = [
  dep({
    id: 'd1',
    consumer: mobileApp,
    method: 'GET',
    path: '/quotes/{id}',
    sends: ['id'],
    reads: ['quoteId', 'status', 'premium.total', 'premium.breakdown[].amount'],
  }),
  dep({
    id: 'd2',
    consumer: portal,
    method: 'POST',
    path: '/quotes',
    sends: ['vehicle.make', 'vehicle.model', 'rider.age'],
    reads: ['quoteId', 'premium.total'],
  }),
  dep({
    id: 'd3',
    consumer: payments,
    method: 'GET',
    path: '/policies/{policyId}',
    sends: ['policyId'],
    reads: ['policyId', 'status'],
  }),
];

function run(changes, dependencies = deps) {
  return analyzeImpact({
    changes,
    dependencies,
    provider: quote,
    proposedVersionId: 'v3',
    baselineVersionId: 'v2',
  });
}

// ---------------------------------------------------------------------------
// Operation matching
// ---------------------------------------------------------------------------

test('matches a consumer to the affected operation', () => {
  const { findings, summary } = run([
    change({
      changeType: 'FIELD_REMOVED',
      method: 'GET',
      path: '/quotes/{quoteId}',
      fieldPath: 'response.200.quoteId',
      location: 'response.200',
      before: { type: 'string' },
      after: null,
    }),
  ]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].consumer.name, 'mobile-app');
  assert.equal(findings[0].operation.path, '/quotes/{id}');
  assert.equal(summary.affectedConsumerCount, 1);
});

test('does not match a different HTTP method on the same path', () => {
  const { findings } = run([
    change({
      changeType: 'FIELD_REMOVED',
      method: 'GET',
      path: '/quotes',
      fieldPath: 'response.200.quoteId',
      location: 'response.200',
      before: { type: 'string' },
      after: null,
    }),
  ]);
  // portal declares POST /quotes — different method, no match.
  assert.equal(findings.length, 0);
});

test('matches path templates with different parameter names', () => {
  // The consumer declared /quotes/{id}; the change is on /quotes/{quoteId}.
  const { findings } = run([
    change({
      changeType: 'FIELD_REMOVED',
      method: 'GET',
      path: '/quotes/{quoteId}',
      fieldPath: 'response.200.quoteId',
      location: 'response.200',
      before: { type: 'string' },
      after: null,
    }),
  ]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].consumer.name, 'mobile-app');
});

test('does not affect consumers of unrelated operations', () => {
  const { findings, summary } = run([
    change({
      changeType: 'FIELD_REMOVED',
      method: 'GET',
      path: '/quotes/{quoteId}',
      fieldPath: 'response.200.quoteId',
      location: 'response.200',
      before: { type: 'string' },
      after: null,
    }),
  ]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].consumer.name, 'mobile-app');
  // payments-svc declares only /policies/{policyId} — no matching dependency.
  assert.deepEqual(summary.noMatchingDeclaration.consumers.map((c) => c.name), [
    'partner-portal',
    'payments-svc',
  ]);
});

test('endpoint removal affects every consumer of that path (any method)', () => {
  const { findings } = run([
    change({
      changeType: 'ENDPOINT_REMOVED',
      path: '/quotes/{quoteId}',
      location: 'endpoint',
      before: { methods: ['GET', 'POST'] },
      after: null,
    }),
  ]);
  // d1 (GET /quotes/{id}) matches; d2 (POST /quotes) is a different template.
  assert.equal(findings.length, 1);
  assert.equal(findings[0].consumer.name, 'mobile-app');
  assert.equal(findings[0].dependency.direction, 'OPERATION');
});

test('method removal affects only consumers of that method', () => {
  const { findings } = run([
    change({
      changeType: 'METHOD_REMOVED',
      method: 'POST',
      path: '/quotes',
      location: 'method',
      before: null,
      after: null,
    }),
  ]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].consumer.name, 'partner-portal');
});

// ---------------------------------------------------------------------------
// Direction: request changes vs sends, response changes vs reads
// ---------------------------------------------------------------------------

test('request-side changes are matched against sends only', () => {
  const { findings } = run([
    change({
      changeType: 'FIELD_REMOVED',
      method: 'POST',
      path: '/quotes',
      fieldPath: 'request.vehicle.make',
      location: 'request',
      before: { type: 'string' },
      after: null,
    }),
  ]);
  assert.equal(findings.length, 1);
  const finding = findings[0];
  assert.equal(finding.consumer.name, 'partner-portal');
  assert.equal(finding.dependency.direction, 'SENDS');
  assert.deepEqual(finding.dependency.matchedDeclaredFields, ['vehicle.make']);
});

test('a consumer that only reads a field is not affected by a request-side change', () => {
  const { findings } = run([
    change({
      changeType: 'FIELD_REMOVED',
      method: 'GET',
      path: '/quotes/{quoteId}',
      fieldPath: 'request.ghost',
      location: 'request',
      before: { type: 'string' },
      after: null,
    }),
  ]);
  assert.equal(findings.length, 0);
});

test('response-side changes are matched against reads only', () => {
  const { findings } = run([
    change({
      changeType: 'FIELD_REMOVED',
      method: 'GET',
      path: '/quotes/{quoteId}',
      fieldPath: 'response.200.quoteId',
      location: 'response.200',
      before: { type: 'string' },
      after: null,
    }),
  ]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].dependency.direction, 'READS');
  assert.deepEqual(findings[0].dependency.matchedDeclaredFields, ['quoteId']);
});

// ---------------------------------------------------------------------------
// Field matching
// ---------------------------------------------------------------------------

test('matches nested field dependencies', () => {
  const { findings } = run([
    change({
      changeType: 'FIELD_REMOVED',
      method: 'GET',
      path: '/quotes/{quoteId}',
      fieldPath: 'response.200.premium.total',
      location: 'response.200',
      before: { type: 'number' },
      after: null,
    }),
  ]);
  assert.equal(findings.length, 1);
  assert.deepEqual(findings[0].dependency.matchedDeclaredFields, ['premium.total']);
});

test('a parent object removal affects consumers using nested descendants', () => {
  const { findings } = run([
    change({
      changeType: 'FIELD_REMOVED',
      method: 'GET',
      path: '/quotes/{quoteId}',
      fieldPath: 'response.200.customer',
      location: 'response.200',
      before: { type: 'object' },
      after: null,
    }),
  ]);
  // d1 declares customer.address.city? No — add it explicitly here.
  const custom = [
    dep({
      id: 'd9',
      consumer: mobileApp,
      method: 'GET',
      path: '/quotes/{id}',
      reads: ['customer.address.city'],
    }),
  ];
  const result = analyzeImpact({
    changes: [
      change({
        changeType: 'FIELD_REMOVED',
        method: 'GET',
        path: '/quotes/{quoteId}',
        fieldPath: 'response.200.customer',
        location: 'response.200',
        before: { type: 'object' },
        after: null,
      }),
    ],
    dependencies: custom,
    provider: quote,
    proposedVersionId: 'v3',
    baselineVersionId: 'v2',
  });
  assert.equal(result.findings.length, 1);
  const finding = result.findings[0];
  assert.equal(finding.dependency.matchedDeclaredFields[0], 'customer.address.city');
  assert.match(finding.reason, /parent field customer/);
});

test('array paths such as items[].productId match correctly', () => {
  const { findings } = run([
    change({
      changeType: 'FIELD_REMOVED',
      method: 'GET',
      path: '/quotes/{quoteId}',
      fieldPath: 'response.200.items[].productId',
      location: 'response.200',
      before: { type: 'string' },
      after: null,
    }),
  ]);
  // d1 does not declare items[].productId...
  assert.equal(findings.length, 0);

  const arrayConsumer = [
    dep({
      id: 'd10',
      consumer: mobileApp,
      method: 'GET',
      path: '/quotes/{id}',
      reads: ['items[].productId'],
    }),
  ];
  const result = analyzeImpact({
    changes: [
      change({
        changeType: 'FIELD_REMOVED',
        method: 'GET',
        path: '/quotes/{quoteId}',
        fieldPath: 'response.200.items[].productId',
        location: 'response.200',
        before: { type: 'string' },
        after: null,
      }),
    ],
    dependencies: arrayConsumer,
    provider: quote,
    proposedVersionId: 'v3',
    baselineVersionId: 'v2',
  });
  assert.equal(result.findings.length, 1);
  assert.deepEqual(result.findings[0].dependency.matchedDeclaredFields, ['items[].productId']);
});

test('string-prefix collisions do not match (customer.name vs customer.nameSuffix)', () => {
  const { findings } = run([
    change({
      changeType: 'FIELD_REMOVED',
      method: 'GET',
      path: '/quotes/{quoteId}',
      fieldPath: 'response.200.customer.name',
      location: 'response.200',
      before: { type: 'string' },
      after: null,
    }),
  ]);
  // No dependency declares customer.name or a descendant — and crucially a
  // declaration of customer.nameSuffix must NOT match customer.name.
  assert.equal(findings.length, 0);

  const suffixConsumer = [
    dep({
      id: 'd11',
      consumer: mobileApp,
      method: 'GET',
      path: '/quotes/{id}',
      reads: ['customer.nameSuffix'],
    }),
  ];
  const result = analyzeImpact({
    changes: [
      change({
        changeType: 'FIELD_REMOVED',
        method: 'GET',
        path: '/quotes/{quoteId}',
        fieldPath: 'response.200.customer.name',
        location: 'response.200',
        before: { type: 'string' },
        after: null,
      }),
    ],
    dependencies: suffixConsumer,
    provider: quote,
    proposedVersionId: 'v3',
    baselineVersionId: 'v2',
  });
  assert.equal(result.findings.length, 0);
});

test('a consumer declaring the operation but not the changed field is not affected', () => {
  const { findings, summary } = run([
    change({
      changeType: 'FIELD_REMOVED',
      method: 'GET',
      path: '/quotes/{quoteId}',
      fieldPath: 'response.200.legacyCode',
      location: 'response.200',
      before: { type: 'string' },
      after: null,
    }),
  ]);
  assert.equal(findings.length, 0);
  // mobile-app declares the operation, so it is NOT in noMatchingDeclaration,
  // but it has no affected findings either.
  assert.equal(summary.affectedConsumerCount, 0);
  assert.equal(summary.consumersDeclaringAffectedOperations, 1);
  assert.deepEqual(summary.noMatchingDeclaration.consumers.map((c) => c.name), [
    'partner-portal',
    'payments-svc',
  ]);
});

test('a breaking change with no registered dependencies affects no one', () => {
  const { summary, findings } = run(
    [
      change({
        changeType: 'FIELD_REMOVED',
        method: 'GET',
        path: '/quotes/{quoteId}',
        fieldPath: 'response.200.quoteId',
        location: 'response.200',
        before: { type: 'string' },
        after: null,
      }),
    ],
    []
  );
  assert.equal(findings.length, 0);
  assert.equal(summary.registeredConsumerCount, 0);
  assert.equal(summary.affectedConsumerCount, 0);
  assert.equal(summary.affectedChangeCount, 0);
});

// ---------------------------------------------------------------------------
// Requirements and parameters
// ---------------------------------------------------------------------------

test('a new required request field affects consumers that do not send it', () => {
  const { findings } = run([
    change({
      changeType: 'FIELD_ADDED',
      method: 'POST',
      path: '/quotes',
      fieldPath: 'request.rider.licence',
      location: 'request',
      before: null,
      after: { required: true, type: 'string' },
      classification: 'BREAKING',
    }),
  ]);
  // portal sends vehicle.make/model, rider.age — not rider.licence -> affected.
  assert.equal(findings.length, 1);
  assert.equal(findings[0].consumer.name, 'partner-portal');
  assert.deepEqual(findings[0].dependency.matchedDeclaredFields, []);
  assert.match(findings[0].reason, /makes rider\.licence required/);
});

test('a new required request field does not affect a consumer that already sends it', () => {
  const { findings } = run([
    change({
      changeType: 'FIELD_ADDED',
      method: 'POST',
      path: '/quotes',
      fieldPath: 'request.rider.age',
      location: 'request',
      before: null,
      after: { required: true, type: 'integer' },
      classification: 'BREAKING',
    }),
  ]);
  assert.equal(findings.length, 0);
});

test('a new optional request field affects no one', () => {
  const { findings } = run([
    change({
      changeType: 'FIELD_ADDED',
      method: 'POST',
      path: '/quotes',
      fieldPath: 'request.rider.nickname',
      location: 'request',
      before: null,
      after: { required: false, type: 'string' },
      classification: 'NON_BREAKING',
    }),
  ]);
  assert.equal(findings.length, 0);
});

test('a parameter rename affects consumers sending the old name', () => {
  const { findings } = run([
    change({
      changeType: 'PARAMETER_RENAMED',
      method: 'GET',
      path: '/quotes/{quoteId}',
      fieldPath: 'parameters.id',
      location: 'parameter',
      before: { name: 'id', in: 'path' },
      after: { name: 'quoteId', in: 'path' },
      classification: 'UNKNOWN',
    }),
  ]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].consumer.name, 'mobile-app');
  assert.equal(findings[0].dependency.direction, 'SENDS');
  assert.match(findings[0].reason, /renames it to "quoteId"/);
});

test('an optional parameter addition affects no one', () => {
  const { findings } = run([
    change({
      changeType: 'PARAMETER_ADDED',
      method: 'GET',
      path: '/quotes/{quoteId}',
      fieldPath: 'parameters.verbose',
      location: 'parameter',
      before: null,
      after: { name: 'verbose', in: 'query', required: false, schema: { type: 'boolean' } },
      classification: 'NON_BREAKING',
    }),
  ]);
  assert.equal(findings.length, 0);
});

test('a removed 2xx response status affects consumers that read responses', () => {
  const { findings } = run([
    change({
      changeType: 'RESPONSE_STATUS_REMOVED',
      method: 'GET',
      path: '/quotes/{quoteId}',
      fieldPath: 'response.200',
      location: 'response',
      before: { contentTypes: ['application/json'] },
      after: null,
    }),
  ]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].consumer.name, 'mobile-app');
  assert.equal(findings[0].dependency.direction, 'READS');
});

test('a removed 4xx response status does not affect readers', () => {
  const { findings } = run([
    change({
      changeType: 'RESPONSE_STATUS_REMOVED',
      method: 'GET',
      path: '/quotes/{quoteId}',
      fieldPath: 'response.404',
      location: 'response',
      before: { contentTypes: ['application/json'] },
      after: null,
    }),
  ]);
  assert.equal(findings.length, 0);
});

test('a request body removal affects consumers that send fields', () => {
  const { findings } = run([
    change({
      changeType: 'REQUEST_BODY_REMOVED',
      method: 'POST',
      path: '/quotes',
      location: 'requestBody',
      before: { required: true, contentTypes: ['application/json'] },
      after: null,
    }),
  ]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].consumer.name, 'partner-portal');
  assert.equal(findings[0].dependency.direction, 'SENDS');
});

// ---------------------------------------------------------------------------
// Deduplication and summary
// ---------------------------------------------------------------------------

test('multiple matching fields produce ONE finding, not duplicates', () => {
  const { findings, summary } = run([
    change({
      changeType: 'FIELD_REMOVED',
      method: 'GET',
      path: '/quotes/{quoteId}',
      fieldPath: 'response.200.premium',
      location: 'response.200',
      before: { type: 'object' },
      after: null,
    }),
  ]);
  // mobile-app declares premium.total AND premium.breakdown[].amount —
  // both match the removed parent, but it is a single finding.
  assert.equal(findings.length, 1);
  assert.deepEqual(
    findings[0].dependency.matchedDeclaredFields.sort(),
    ['premium.breakdown[].amount', 'premium.total']
  );
  assert.equal(summary.affectedDependencyCount, 1);
  assert.equal(summary.affectedChangeCount, 1);
});

test('summary counts registered vs affected consumers accurately', () => {
  const { summary } = run([
    change({
      changeType: 'FIELD_REMOVED',
      method: 'GET',
      path: '/quotes/{quoteId}',
      fieldPath: 'response.200.quoteId',
      location: 'response.200',
      before: { type: 'string' },
      after: null,
    }),
    change({
      changeType: 'FIELD_REMOVED',
      method: 'POST',
      path: '/quotes',
      fieldPath: 'request.vehicle.make',
      location: 'request',
      before: { type: 'string' },
      after: null,
    }),
  ]);
  assert.equal(summary.registeredConsumerCount, 3);
  assert.equal(summary.consumersDeclaringAffectedOperations, 2);
  assert.equal(summary.affectedConsumerCount, 2);
  assert.equal(summary.affectedDependencyCount, 2);
  assert.equal(summary.affectedChangeCount, 2);
  assert.deepEqual(summary.affectedConsumers.map((c) => c.name).sort(), [
    'mobile-app',
    'partner-portal',
  ]);
  assert.equal(summary.basedOn, 'registered consumer declarations');
});

test('findings are deterministic across repeated runs', () => {
  const changes = [
    change({
      changeType: 'FIELD_REMOVED',
      method: 'GET',
      path: '/quotes/{quoteId}',
      fieldPath: 'response.200.quoteId',
      location: 'response.200',
      before: { type: 'string' },
      after: null,
    }),
  ];
  const a = run(changes);
  const b = run(changes);
  assert.deepEqual(a.findings, b.findings);
  assert.deepEqual(a.summary, b.summary);
});

// ---------------------------------------------------------------------------
// fieldContext unit behavior
// ---------------------------------------------------------------------------

test('fieldContext: request, parameter and response field paths', () => {
  assert.deepEqual(fieldContext({ location: 'request', fieldPath: 'request.vehicle.make' }), {
    side: 'request',
    kind: 'field',
    relative: 'vehicle.make',
    status: null,
  });
  assert.deepEqual(fieldContext({ location: 'parameter', fieldPath: 'parameters.id' }), {
    side: 'request',
    kind: 'parameter',
    relative: 'id',
    status: null,
  });
  assert.deepEqual(
    fieldContext({ location: 'response.200', fieldPath: 'response.200.quote.premium' }),
    { side: 'response', kind: 'field', relative: 'quote.premium', status: '200', is2xx: true }
  );
  assert.deepEqual(
    fieldContext({
      location: 'response.200[application/json]',
      fieldPath: 'response.200[application/json].amount',
    }),
    {
      side: 'response',
      kind: 'field',
      relative: 'amount',
      status: '200[application/json]',
      is2xx: true,
    }
  );
  assert.deepEqual(fieldContext({ location: 'response', fieldPath: 'response.200' }), {
    side: 'response',
    kind: 'operation',
    relative: null,
    status: '200',
    is2xx: true,
  });
});

test('dependencyMatchesOperation is method- and template-aware', () => {
  const d = dep({ id: 'x', consumer: mobileApp, method: 'GET', path: '/quotes/{id}' });
  assert.equal(dependencyMatchesOperation(d, { method: 'GET', path: '/quotes/{quoteId}' }), true);
  assert.equal(dependencyMatchesOperation(d, { method: 'POST', path: '/quotes/{quoteId}' }), false);
  assert.equal(dependencyMatchesOperation(d, { method: null, path: '/quotes/{quoteId}' }), true);
  assert.equal(dependencyMatchesOperation(d, { method: 'GET', path: '/claims/{claimId}' }), false);
});
