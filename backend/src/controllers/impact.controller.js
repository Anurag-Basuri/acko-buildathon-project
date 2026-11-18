// HTTP handling for Consumer Impact Analysis.
import { analyzeVersionImpact } from '../services/impact.service.js';
import { isValidUuid } from '../validators/service.validators.js';
import { ApiError } from '../utils/api-error.js';

// GET /api/specs/:id/impact — runs (and persists) the impact analysis for a
// proposed version against its current published baseline: semantic
// comparison + compatibility classification + consumer impact analysis.
//
// Errors (HTTP 400, machine-readable codes):
//   NO_PUBLISHED_BASELINE  the service has no published version (initial)
//   INVALID_ANALYSIS       the version itself is the current baseline
//   UNSUPPORTED_SPEC       stored content cannot be normalized
export async function getImpactAnalysis(req, res) {
  const { id } = req.params;
  if (!isValidUuid(id)) {
    throw new ApiError(400, 'INVALID_ID', 'id must be a valid UUID');
  }

  const report = await analyzeVersionImpact(id);

  res.json({
    success: true,
    data: {
      serviceId: report.serviceId,
      service: report.service,
      proposedVersion: report.proposedVersion,
      baselineVersion: report.baselineVersion,
      analysisRunId: report.analysisRunId,
      computedAt: report.computedAt,
      dependencyFingerprint: report.dependencyFingerprint,
      changeCount: report.changeCount,
      breakingChangeCount: report.counts.breaking,
      nonBreakingChangeCount: report.counts.nonBreaking,
      unknownChangeCount: report.counts.unknown,
      affectedConsumerCount: report.impact.summary.affectedConsumerCount,
      affectedDependencyCount: report.impact.summary.affectedDependencyCount,
      affectedChangeCount: report.impact.summary.affectedChangeCount,
      changes: report.changes,
      impact: report.impact,
    },
  });
}
