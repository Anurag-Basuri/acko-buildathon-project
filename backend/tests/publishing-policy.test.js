// Unit tests for the publishing policy (publishing-policy.js).
// Pure module — no database, no app. Exercises every rule branch
// (A, B, C, D, E, F, G, H) and the policy overrides.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePublishingDecision, PUBLISH_POLICY } from '../src/services/publishing-policy.js';

// A fresh, clean analysis run (no unknown, no breaking).
const cleanRun = {
  id: 'run-1',
  counts: { total: 2, breaking: 0, nonBreaking: 2, unknown: 0 },
  freshness: { baselineStale: false, dependenciesStale: false, contentStale: false },
  breakingAffectedConsumers: [],
  unknownChanges: [],
};

function freshRun(overrides = {}) {
  return {
    id: 'run-1',
    counts: { total: 1, breaking: 0, nonBreaking: 1, unknown: 0 },
    freshness: { baselineStale: false, dependenciesStale: false, contentStale: false },
    breakingAffectedConsumers: [],
    unknownChanges: [],
    ...overrides,
  };
}

const base = {
  specValid: true,
  isInitialVersion: false,
  declarationIssues: [],
  policy: PUBLISH_POLICY,
};

// ---------------------------------------------------------------------------
// Rule A: invalid specifications never publish
// ---------------------------------------------------------------------------

test('rule A: an invalid specification is blocked', () => {
  const decision = evaluatePublishingDecision({ ...base, specValid: false, analysisRun: freshRun() });
  assert.equal(decision.outcome, 'BLOCKED');
  assert.equal(decision.code, 'INVALID_SPECIFICATION');
  assert.equal(decision.warnings.length, 0);
});

test('rule A: an invalid specification is blocked even without any analysis', () => {
  const decision = evaluatePublishingDecision({ ...base, specValid: false, analysisRun: null });
  assert.equal(decision.outcome, 'BLOCKED');
  assert.equal(decision.code, 'INVALID_SPECIFICATION');
});

// ---------------------------------------------------------------------------
// Rule H: initial versions
// ---------------------------------------------------------------------------

test('rule H: a clean initial version publishes without comparison', () => {
  const decision = evaluatePublishingDecision({ ...base, isInitialVersion: true, analysisRun: null });
  assert.equal(decision.outcome, 'PUBLISHED');
  assert.equal(decision.code, 'INITIAL_VERSION_PUBLISHED');
  assert.equal(decision.warnings.length, 0);
});

test('rule H: declaration mismatches on an initial version warn by default', () => {
  const issues = [{ consumer: 'mobile-app', operation: 'GET /quotes/{id}', message: 'no such operation' }];
  const decision = evaluatePublishingDecision({
    ...base,
    isInitialVersion: true,
    analysisRun: null,
    declarationIssues: issues,
  });
  assert.equal(decision.outcome, 'PUBLISHED');
  assert.equal(decision.code, 'INITIAL_VERSION_PUBLISHED');
  assert.equal(decision.warnings.length, 1);
  assert.match(decision.warnings[0], /mobile-app/);
});

test('rule H: declaration mismatches block when the policy is set to block', () => {
  const issues = [{ consumer: 'mobile-app', operation: 'GET /quotes/{id}', message: 'no such operation' }];
  const decision = evaluatePublishingDecision({
    ...base,
    isInitialVersion: true,
    analysisRun: null,
    declarationIssues: issues,
    policy: { ...PUBLISH_POLICY, initialVersionDeclarationMismatch: 'block' },
  });
  assert.equal(decision.outcome, 'BLOCKED');
  assert.equal(decision.code, 'INITIAL_DECLARATION_MISMATCH');
  assert.deepEqual(decision.decisionDetails.declarationIssues, issues);
});

// ---------------------------------------------------------------------------
// Rule B: a completed analysis is required
// ---------------------------------------------------------------------------

test('rule B: a version without a completed analysis is blocked', () => {
  const decision = evaluatePublishingDecision({ ...base, analysisRun: null });
  assert.equal(decision.outcome, 'BLOCKED');
  assert.equal(decision.code, 'ANALYSIS_NOT_COMPLETED');
});

// ---------------------------------------------------------------------------
// Rule C: freshness
// ---------------------------------------------------------------------------

test('rule C: a stale baseline blocks with STALE_ANALYSIS', () => {
  const decision = evaluatePublishingDecision({
    ...base,
    analysisRun: freshRun({ freshness: { baselineStale: true, dependenciesStale: false, contentStale: false } }),
  });
  assert.equal(decision.outcome, 'BLOCKED');
  assert.equal(decision.code, 'STALE_ANALYSIS');
  assert.match(decision.reason, /published baseline changed/);
  assert.deepEqual(decision.decisionDetails.staleness, ['published baseline changed']);
});

test('rule C: changed consumer dependencies block with STALE_ANALYSIS', () => {
  const decision = evaluatePublishingDecision({
    ...base,
    analysisRun: freshRun({ freshness: { baselineStale: false, dependenciesStale: true, contentStale: false } }),
  });
  assert.equal(decision.outcome, 'BLOCKED');
  assert.equal(decision.code, 'STALE_ANALYSIS');
  assert.match(decision.reason, /consumer dependency declarations changed/);
});

test('rule C: multiple staleness causes are all reported', () => {
  const decision = evaluatePublishingDecision({
    ...base,
    analysisRun: freshRun({
      freshness: { baselineStale: true, dependenciesStale: true, contentStale: true },
    }),
  });
  assert.equal(decision.outcome, 'BLOCKED');
  assert.equal(decision.code, 'STALE_ANALYSIS');
  assert.equal(decision.decisionDetails.staleness.length, 3);
});

test('rule C: staleness is skipped when the policy does not require freshness', () => {
  const decision = evaluatePublishingDecision({
    ...base,
    policy: { ...PUBLISH_POLICY, requireFreshAnalysis: false },
    analysisRun: freshRun({ freshness: { baselineStale: true, dependenciesStale: true, contentStale: false } }),
  });
  assert.equal(decision.outcome, 'PUBLISHED');
  assert.equal(decision.code, 'ALL_CHECKS_PASSED');
});

// ---------------------------------------------------------------------------
// Rule G: UNKNOWN changes block
// ---------------------------------------------------------------------------

test('rule G: UNKNOWN changes block until reviewed', () => {
  const decision = evaluatePublishingDecision({
    ...base,
    analysisRun: freshRun({
      counts: { total: 2, breaking: 0, nonBreaking: 1, unknown: 1 },
      unknownChanges: [{ changeType: 'PARAMETER_RENAMED', path: '/quotes/{id}', fieldPath: 'parameters.id' }],
    }),
  });
  assert.equal(decision.outcome, 'BLOCKED');
  assert.equal(decision.code, 'UNKNOWN_CHANGES');
  assert.match(decision.reason, /1 change\(s\) are classified UNKNOWN/);
  assert.equal(decision.decisionDetails.unknownChanges.length, 1);
});

test('rule G: UNKNOWN changes pass when the policy allows them', () => {
  const decision = evaluatePublishingDecision({
    ...base,
    policy: { ...PUBLISH_POLICY, blockOnUnknownChanges: false },
    analysisRun: freshRun({ counts: { total: 1, breaking: 0, nonBreaking: 0, unknown: 1 } }),
  });
  assert.equal(decision.outcome, 'PUBLISHED');
});

// ---------------------------------------------------------------------------
// Rules D / F: breaking changes and registered impact
// ---------------------------------------------------------------------------

test('rule D: breaking changes with affected registered consumers block', () => {
  const decision = evaluatePublishingDecision({
    ...base,
    analysisRun: freshRun({
      counts: { total: 2, breaking: 2, nonBreaking: 0, unknown: 0 },
      breakingAffectedConsumers: [
        { id: 'c1', name: 'payments-svc', findingCount: 1, operations: ['GET /policies/{policyId}'] },
        { id: 'c2', name: 'mobile-app', findingCount: 1, operations: ['POST /quotes'] },
      ],
    }),
  });
  assert.equal(decision.outcome, 'BLOCKED');
  assert.equal(decision.code, 'BREAKING_CHANGES_AFFECT_CONSUMERS');
  assert.match(decision.reason, /payments-svc/);
  assert.match(decision.reason, /mobile-app/);
  assert.equal(decision.decisionDetails.breakingAffectedConsumers.length, 2);
});

test('rule D: the block can be switched off in the policy', () => {
  const decision = evaluatePublishingDecision({
    ...base,
    policy: { ...PUBLISH_POLICY, blockBreakingWithAffectedConsumers: false },
    analysisRun: freshRun({
      counts: { total: 1, breaking: 1, nonBreaking: 0, unknown: 0 },
      breakingAffectedConsumers: [{ id: 'c1', name: 'payments-svc', findingCount: 1, operations: [] }],
    }),
  });
  assert.equal(decision.outcome, 'PUBLISHED');
  assert.ok(decision.warnings.length > 0);
});

test('rule F: breaking changes without registered impact publish with a warning', () => {
  const decision = evaluatePublishingDecision({
    ...base,
    analysisRun: freshRun({ counts: { total: 1, breaking: 1, nonBreaking: 0, unknown: 0 } }),
  });
  assert.equal(decision.outcome, 'PUBLISHED');
  assert.equal(decision.code, 'ALL_CHECKS_PASSED');
  assert.equal(decision.warnings.length, 1);
  assert.match(decision.warnings[0], /BREAKING_NO_REGISTERED_IMPACT/);
  assert.match(decision.warnings[0], /NOT guaranteed safe/);
});

test('rule F: breaking changes without registered impact block when configured to block', () => {
  const decision = evaluatePublishingDecision({
    ...base,
    policy: { ...PUBLISH_POLICY, breakingWithoutRegisteredImpact: 'block' },
    analysisRun: freshRun({ counts: { total: 1, breaking: 1, nonBreaking: 0, unknown: 0 } }),
  });
  assert.equal(decision.outcome, 'BLOCKED');
  assert.equal(decision.code, 'BREAKING_CHANGES_NO_REVIEW');
});

// ---------------------------------------------------------------------------
// Rule E: the happy path
// ---------------------------------------------------------------------------

test('rule E: an analysis with only non-breaking changes publishes cleanly', () => {
  const decision = evaluatePublishingDecision({ ...base, analysisRun: cleanRun });
  assert.equal(decision.outcome, 'PUBLISHED');
  assert.equal(decision.code, 'ALL_CHECKS_PASSED');
  assert.equal(decision.warnings.length, 0);
  assert.equal(decision.decisionDetails.freshness.baselineStale, false);
  assert.equal(decision.decisionDetails.counts.breaking, 0);
});

test('the decision always carries the evaluated policy for audit', () => {
  const policy = { ...PUBLISH_POLICY, blockOnUnknownChanges: false };
  const decision = evaluatePublishingDecision({
    ...base,
    policy,
    analysisRun: freshRun({ counts: { total: 1, breaking: 0, nonBreaking: 0, unknown: 1 } }),
  });
  assert.deepEqual(decision.decisionDetails.policy, policy);
});
