// Publishing policy — the initial, product-owner-proposed rules.
//
// Pure module — no database, no Express. The policy is a plain in-code
// configuration: revising a rule after product-owner confirmation means
// editing this file, not a database migration. evaluatePublishingDecision
// is deterministic and returns a fully explainable decision:
//
//   { outcome: 'PUBLISHED' | 'BLOCKED',
//     code: string,            // machine-readable decision identifier
//     reason: string,          // plain-language explanation
//     warnings: string[],      // non-blocking notices
//     decisionDetails: object  // machine-readable record for audit
// }
//
// Rules (in evaluation order):
//   A  invalid specifications never publish
//   H  initial versions (no published baseline): no comparison required;
//      existing consumer declarations are checked where possible
//   B  a version with a baseline needs a COMPLETED analysis (comparison +
//      classification + impact) before publication
//   C  the analysis must be FRESH (baseline and consumer dependencies
//      unchanged since it ran) — stale analyses are never trusted
//   G  any UNKNOWN change blocks until reviewed (never treated as
//      NON_BREAKING)
//   D  a BREAKING change affecting at least one registered consumer blocks
//   F  a BREAKING change with no registered consumer impact: initial policy
//      allows with a clear warning (NOT guaranteed safe — the registry may
//      be incomplete); switchable to 'block' in the config below
//   E  otherwise (all changes NON_BREAKING, or breaking without impact under
//      rule F) publication is allowed

export const PUBLISH_POLICY = {
  requireCompletedAnalysis: true,
  requireFreshAnalysis: true,
  blockOnUnknownChanges: true,
  blockBreakingWithAffectedConsumers: true,
  // 'warn' | 'block'
  breakingWithoutRegisteredImpact: 'warn',
  // 'warn' | 'block'
  initialVersionDeclarationMismatch: 'warn',
};

/**
 * Evaluate the publishing decision for one version.
 *
 * @param {{
 *   specValid: boolean,
 *   isInitialVersion: boolean,
 *   analysisRun: null | {
 *     id: string,
 *     counts: { total: number, breaking: number, nonBreaking: number, unknown: number },
 *     freshness: { baselineStale: boolean, dependenciesStale: boolean, contentStale: boolean },
 *     breakingAffectedConsumers: Array<{ id: string, name: string, findingCount: number, operations: string[] }>,
 *     unknownChanges: Array<{ changeType: string, path: string | null, fieldPath: string | null }>,
 *   },
 *   declarationIssues: Array<{ consumer: string, operation: string, message: string }>,
 *   policy: object,
 * }} context
 */
export function evaluatePublishingDecision({
  specValid,
  isInitialVersion,
  analysisRun,
  declarationIssues = [],
  policy = PUBLISH_POLICY,
}) {
  // Accumulating machine-readable audit record. Every decision embeds the
  // decision code so persisted attempts are self-describing.
  const details = { policy: { ...policy } };

  const finish = (outcome, code, reason, warnings, extra = {}) => ({
    outcome,
    code,
    reason,
    warnings,
    decisionDetails: { code, ...details, ...extra },
  });

  // Rule A: invalid specifications never publish.
  if (!specValid) {
    return finish(
      'BLOCKED',
      'INVALID_SPECIFICATION',
      'The stored specification is not a valid OpenAPI document and can never be published.',
      []
    );
  }

  // Rule H: initial version — no baseline comparison is fabricated; the
  // existing consumer declarations are checked against the new operation set.
  if (isInitialVersion) {
    details.declarationIssues = declarationIssues;
    const warnings = declarationIssues.map(
      (issue) => `${issue.consumer} (${issue.operation}): ${issue.message}`
    );
    if (declarationIssues.length > 0 && policy.initialVersionDeclarationMismatch === 'block') {
      return finish(
        'BLOCKED',
        'INITIAL_DECLARATION_MISMATCH',
        'Registered consumer declarations do not match this initial specification.',
        warnings
      );
    }
    return finish(
      'PUBLISHED',
      'INITIAL_VERSION_PUBLISHED',
      declarationIssues.length > 0
        ? 'Initial API version published; registered consumer declarations were checked and mismatches are reported as warnings.'
        : 'Initial API version published; no baseline comparison required.',
      warnings
    );
  }

  // Rule B: a completed analysis must exist.
  if (policy.requireCompletedAnalysis && !analysisRun) {
    return finish(
      'BLOCKED',
      'ANALYSIS_NOT_COMPLETED',
      'Semantic comparison, compatibility classification and consumer impact analysis have not been completed for this version. Run GET /api/specs/:id/impact first.',
      []
    );
  }

  // Rule C: freshness — the analysis must still describe the current state.
  const staleness = [];
  if (analysisRun.freshness?.baselineStale) staleness.push('published baseline changed');
  if (analysisRun.freshness?.dependenciesStale) staleness.push('consumer dependency declarations changed');
  if (analysisRun.freshness?.contentStale) staleness.push('specification content changed');
  details.freshness = analysisRun.freshness;
  details.counts = analysisRun.counts;
  if (staleness.length > 0 && policy.requireFreshAnalysis) {
    return finish(
      'BLOCKED',
      'STALE_ANALYSIS',
      `The completed analysis is stale: ${staleness.join('; ')}. Run GET /api/specs/:id/impact again to recompute the analysis against the current state.`,
      [],
      { staleness, analysisRunId: analysisRun.id }
    );
  }

  // Rule G: UNKNOWN changes block until reviewed.
  const unknownCount = analysisRun.counts?.unknown ?? 0;
  if (unknownCount > 0 && policy.blockOnUnknownChanges) {
    details.unknownChanges = analysisRun.unknownChanges ?? [];
    return finish(
      'BLOCKED',
      'UNKNOWN_CHANGES',
      `${unknownCount} change(s) are classified UNKNOWN and require manual review before publication. UNKNOWN changes are never treated as NON_BREAKING.`,
      []
    );
  }

  // Rule D / F: breaking changes and their registered impact.
  const breakingCount = analysisRun.counts?.breaking ?? 0;
  const affected = analysisRun.breakingAffectedConsumers ?? [];
  details.breakingAffectedConsumers = affected;
  if (breakingCount > 0 && affected.length > 0 && policy.blockBreakingWithAffectedConsumers) {
    return finish(
      'BLOCKED',
      'BREAKING_CHANGES_AFFECT_CONSUMERS',
      `${breakingCount} breaking change(s) affect ${affected.length} registered consumer(s): ${affected
        .map((consumer) => consumer.name)
        .join(', ')}. Review the impact analysis before publishing.`,
      []
    );
  }
  if (breakingCount > 0 && policy.breakingWithoutRegisteredImpact === 'block') {
    return finish(
      'BLOCKED',
      'BREAKING_CHANGES_NO_REVIEW',
      `${breakingCount} breaking change(s) exist and no review exemption is configured (policy: blockBreakingWithAffectedConsumers / breakingWithoutRegisteredImpact=block).`,
      []
    );
  }

  // Rule E (+ F warning): publish.
  const warnings = [];
  if (breakingCount > 0) {
    warnings.push(
      `BREAKING_NO_REGISTERED_IMPACT: ${breakingCount} breaking change(s) have no matching registered consumer impact. ` +
        'This is NOT guaranteed safe: the consumer registry may be incomplete.'
    );
  }
  return finish(
    'PUBLISHED',
    'ALL_CHECKS_PASSED',
    breakingCount > 0
      ? 'Publication allowed: no UNKNOWN changes, and the breaking changes have no matching registered consumer impact (warning issued).'
      : 'All publishing checks passed.',
    warnings
  );
}

export default evaluatePublishingDecision;
