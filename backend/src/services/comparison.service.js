// Comparison orchestration: retrieves stored specification versions,
// normalizes them, runs the structural comparison, and classifies each
// change with the deterministic compatibility rule engine. All Prisma access
// for comparisons lives here; controllers never query the database directly.
// Structural comparison (spec-comparator) stays independent of
// compatibility policy (compatibility-rules/classifier).
import prisma from '../database/prisma.js';
import { ApiError } from '../utils/api-error.js';
import { normalizeSpec } from './spec-normalizer.js';
import { compareSpecs } from './spec-comparator.js';
import { classifyChanges } from './compatibility-classifier.js';

// Version metadata without stored content (the raw/parsed content is large
// and is served by GET /api/specs/:id instead).
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
 * Compare two stored specification versions belonging to the same service.
 *
 * @throws ApiError 404 SPEC_VERSION_NOT_FOUND when either version is missing
 * @throws ApiError 400 INVALID_COMPARISON when the versions belong to
 *   different services
 * @throws ApiError 400 UNSUPPORTED_SPEC when a stored document contains
 *   constructs the normalizer does not support
 *
 * @returns {Promise<{
 *   serviceId: string,
 *   fromVersion: object,
 *   toVersion: object,
 *   counts: { total: number, breaking: number, nonBreaking: number, unknown: number },
 *   changes: Array<object & { classification: string, ruleId: string, reason: string }>,
 * }>}
 */
export async function compareSpecVersions({ fromVersionId, toVersionId }) {
  const [fromVersion, toVersion] = await Promise.all([
    getVersionOrThrow(fromVersionId),
    getVersionOrThrow(toVersionId),
  ]);

  if (fromVersion.serviceId !== toVersion.serviceId) {
    throw new ApiError(
      400,
      'INVALID_COMPARISON',
      'Cannot compare specification versions that belong to different services',
      {
        fromVersionId,
        toVersionId,
        fromServiceId: fromVersion.serviceId,
        toServiceId: toVersion.serviceId,
      }
    );
  }

  const fromNormalized = normalizeSpec(fromVersion.parsedContent);
  if (!fromNormalized.ok) {
    throw new ApiError(
      400,
      'UNSUPPORTED_SPEC',
      `The stored specification (version "${fromVersion.versionLabel}") contains unsupported constructs`,
      fromNormalized.errors
    );
  }
  const toNormalized = normalizeSpec(toVersion.parsedContent);
  if (!toNormalized.ok) {
    throw new ApiError(
      400,
      'UNSUPPORTED_SPEC',
      `The stored specification (version "${toVersion.versionLabel}") contains unsupported constructs`,
      toNormalized.errors
    );
  }

  const changes = compareSpecs(fromNormalized.spec, toNormalized.spec);
  // Structural comparison is policy-free; classification is a separate,
  // deterministic step applied here so the comparator stays reusable.
  const { changes: classified, counts } = classifyChanges(changes);

  return {
    serviceId: fromVersion.serviceId,
    fromVersion: versionMeta(fromVersion),
    toVersion: versionMeta(toVersion),
    counts,
    changes: classified,
  };
}

export default compareSpecVersions;
