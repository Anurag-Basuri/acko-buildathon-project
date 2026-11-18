// Specification Management business logic.
// All Prisma access for specs lives here; controllers never query the
// database directly. OpenAPI parsing/validation is delegated to the reusable
// spec-validator module.
import { Prisma } from '@prisma/client';
import prisma from '../database/prisma.js';
import { ApiError } from '../utils/api-error.js';
import { getService } from './service-registry.service.js';
import { validateSpecContent } from './spec-validator.js';

// Returns the version's PUBLISHED baseline, if one exists.
// Publishing is not implemented yet, so this is null today; the lookup is in
// place so the publish flow can set the baseline without schema changes.
async function findPublishedBaseline(serviceId) {
  const published = await prisma.apiVersion.findFirst({
    where: { serviceId, status: 'PUBLISHED' },
    orderBy: { createdAt: 'desc' },
  });
  return published ? published.id : null;
}

/**
 * Validate and persist a new specification version as PROPOSED.
 *
 * @returns {Promise<{
 *   version: object,          // the created ApiVersion row
 *   isInitialVersion: boolean,
 *   baselineVersionId: string | null,
 * }>}
 */
export async function uploadSpecVersion({ serviceId, versionLabel, content, filename, format }) {
  // 1. The service must exist.
  const service = await getService(serviceId); // 404 SERVICE_NOT_FOUND

  // 2. The specification must be valid OpenAPI (parse + structure + $refs).
  const result = await validateSpecContent(content, { filename, format });
  if (!result.ok) {
    throw new ApiError(400, 'INVALID_SPEC', 'Specification failed validation', result.errors);
  }

  // 3. The (serviceId, versionLabel) pair must be unique.
  const existing = await prisma.apiVersion.findUnique({
    where: { serviceId_versionLabel: { serviceId, versionLabel } },
  });
  if (existing) {
    throw new ApiError(
      409,
      'DUPLICATE_VERSION',
      `Service "${service.name}" already has a version labeled "${versionLabel}"`
    );
  }

  // 4. Baseline context: is this the service's first version, and is there a
  //    published baseline to compare against later? No comparison happens in
  //    this increment — these are reported, not acted on.
  const [versionCount, baselineVersionId] = await Promise.all([
    prisma.apiVersion.count({ where: { serviceId } }),
    findPublishedBaseline(serviceId),
  ]);

  try {
    const version = await prisma.apiVersion.create({
      data: {
        serviceId,
        versionLabel,
        // Original content preserved verbatim; resolved document stored
        // separately for the comparison engine.
        originalContent: content,
        parsedContent: result.resolved,
        format: result.format === 'yaml' ? 'YAML' : 'JSON',
        openApiVersion: result.openApiVersion,
        status: 'PROPOSED',
      },
    });
    return { version, isInitialVersion: versionCount === 0, baselineVersionId };
  } catch (err) {
    // Guard against a race between the check in step 3 and the insert.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002'
    ) {
      throw new ApiError(
        409,
        'DUPLICATE_VERSION',
        `Service "${service.name}" already has a version labeled "${versionLabel}"`
      );
    }
    throw err;
  }
}

// Returns the full ApiVersion row (metadata plus stored content).
export async function getSpecVersion(id) {
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
