// Consumer Impact Analysis orchestration.
//
// Given a stored specification version: finds its published baseline, runs
// the semantic comparison + compatibility classification, loads the
// provider's registered consumer dependencies, runs the deterministic impact
// analyzer, and PERSISTS the completed analysis as an immutable AnalysisRun
// (historical results are preserved; re-analysis creates a new run).
//
// All Prisma access for impact analysis lives here; controllers never query
// the database directly.
import prisma from '../database/prisma.js';
import { ApiError } from '../utils/api-error.js';
import { normalizeSpec } from './spec-normalizer.js';
import { compareSpecs } from './spec-comparator.js';
import { classifyChanges } from './compatibility-classifier.js';
import { analyzeImpact } from './impact-analyzer.js';
import { dependencyFingerprint, contentHash } from '../utils/fingerprint.js';

function versionMeta(version) {
  return {
    id: version.id,
    serviceId: version.serviceId,
    versionLabel: version.versionLabel,
    format: version.format,
    openApiVersion: version.openApiVersion,
    status: version.status,
    createdAt: version.createdAt,
  };
}

async function getVersionOrThrow(id) {
  const version = await prisma.apiVersion.findUnique({ where: { id } });
  if (!version) {
    throw new ApiError(
      404,
      'SPEC_VERSION_NOT_FOUND',
      `Specification version with id "${id}" was not found`
    );
  }
  return version;
}

/**
 * The service's current published baseline: the latest PUBLISHED version by
 * creation time (the convention shared with the publish flow and the
 * import-time declaration validation).
 */
export async function getPublishedBaseline(serviceId) {
  return prisma.apiVersion.findFirst({
    where: { serviceId, status: 'PUBLISHED' },
    orderBy: { createdAt: 'desc' },
  });
}

/**
 * Run the full impact analysis for a proposed version and persist it as an
 * AnalysisRun.
 *
 * @throws ApiError 404 SPEC_VERSION_NOT_FOUND
 * @throws ApiError 400 NO_PUBLISHED_BASELINE  (initial version, no baseline)
 * @throws ApiError 400 INVALID_ANALYSIS       (the version IS the baseline)
 * @throws ApiError 400 UNSUPPORTED_SPEC
 */
export async function analyzeVersionImpact(proposedVersionId) {
  const version = await getVersionOrThrow(proposedVersionId);
  const service = await prisma.service.findUnique({ where: { id: version.serviceId } });

  // 1. Baseline: the current published version of the same service.
  const baseline = await getPublishedBaseline(service.id);
  if (!baseline) {
    throw new ApiError(
      400,
      'NO_PUBLISHED_BASELINE',
      `Service "${service.name}" has no published version yet; impact analysis requires a baseline. Publish the current version first, or analyze after the next proposed version has a baseline to compare against.`
    );
  }
  if (baseline.id === version.id) {
    throw new ApiError(
      400,
      'INVALID_ANALYSIS',
      'This version is the current published baseline; there is no older published version to compare it against'
    );
  }

  // 2. Semantic comparison + compatibility classification (same pipeline as
  //    the diff endpoint, from the baseline to the proposed version).
  const fromNormalized = normalizeSpec(baseline.parsedContent);
  if (!fromNormalized.ok) {
    throw new ApiError(
      400,
      'UNSUPPORTED_SPEC',
      `The stored specification (version "${baseline.versionLabel}") contains unsupported constructs`,
      fromNormalized.errors
    );
  }
  const toNormalized = normalizeSpec(version.parsedContent);
  if (!toNormalized.ok) {
    throw new ApiError(
      400,
      'UNSUPPORTED_SPEC',
      `The stored specification (version "${version.versionLabel}") contains unsupported constructs`,
      toNormalized.errors
    );
  }
  const changes = compareSpecs(fromNormalized.spec, toNormalized.spec);
  const { changes: classified, counts } = classifyChanges(changes);

  // 3. Registered consumer dependencies of the provider, with consumer names.
  const dependencies = await prisma.consumerDependency.findMany({
    where: { providerServiceId: service.id },
    include: { consumer: { select: { id: true, name: true } } },
  });

  // 4. Deterministic impact analysis.
  const { summary, findings } = analyzeImpact({
    changes: classified,
    dependencies,
    provider: { id: service.id, name: service.name },
    proposedVersionId: version.id,
    baselineVersionId: baseline.id,
  });

  // 5. Persist as an immutable, historical AnalysisRun. The fingerprints let
  //    the publish flow detect stale results (baseline or dependencies
  //    changed after the analysis ran).
  const fingerprint = dependencyFingerprint(dependencies);
  const specHash = contentHash(version.originalContent);
  const run = await prisma.analysisRun.create({
    data: {
      proposedVersionId: version.id,
      baselineVersionId: baseline.id,
      providerServiceId: service.id,
      dependencyFingerprint: fingerprint,
      specContentHash: specHash,
      countsTotal: counts.total,
      countsBreaking: counts.breaking,
      countsNonBreaking: counts.nonBreaking,
      countsUnknown: counts.unknown,
      affectedConsumerCount: summary.affectedConsumerCount,
      affectedDependencyCount: summary.affectedDependencyCount,
      affectedChangeCount: summary.affectedChangeCount,
      classifiedChanges: classified,
      impact: { summary, findings },
    },
  });

  return {
    serviceId: service.id,
    service: { id: service.id, name: service.name },
    proposedVersion: versionMeta(version),
    baselineVersion: versionMeta(baseline),
    analysisRunId: run.id,
    computedAt: run.createdAt,
    dependencyFingerprint: fingerprint,
    counts,
    changeCount: classified.length,
    changes: classified,
    impact: { summary, findings },
  };
}

/**
 * The latest completed analysis run for a proposed version, if any
 * (null when comparison/classification/impact analysis has not been run).
 */
export async function getLatestAnalysisRun(proposedVersionId) {
  return prisma.analysisRun.findFirst({
    where: { proposedVersionId },
    orderBy: { createdAt: 'desc' },
  });
}
