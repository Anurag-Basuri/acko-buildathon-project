// Publishing Governance orchestration.
//
// Decides whether a proposed specification version may become the published
// baseline, computed entirely from trusted persisted backend state (the
// request only supplies the versionId — never compatibility results or a
// frontend canPublish flag).
//
// Concurrency: publication decisions for the same provider service are
// serialized with a Postgres transaction-level advisory lock. The current
// baseline and analysis freshness are re-checked INSIDE the transaction, so
// a blocked publication never changes the published state and two
// simultaneous publishes cannot both become "the current baseline" without
// rechecking.
//
// Every decision (published or blocked) is persisted as a PublishAttempt;
// history is never rewritten.
import prisma from '../database/prisma.js';
import { ApiError } from '../utils/api-error.js';
import { validateSpecContent } from './spec-validator.js';
import { normalizeSpec } from './spec-normalizer.js';
import { validateDeclaration } from './dependency-validator.js';
import { dependencyFingerprint, contentHash } from '../utils/fingerprint.js';
import {
  evaluatePublishingDecision,
  PUBLISH_POLICY,
} from './publishing-policy.js';

const LOCK_PREFIX = 'contract-guard:publish:';

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

// The current published baseline inside a transaction: the most recently
// published version of the service (publishing updates updatedAt, so this
// follows publish order, not upload order).
async function currentBaseline(tx, serviceId) {
  return tx.apiVersion.findFirst({
    where: { serviceId, status: 'PUBLISHED' },
    orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }],
  });
}

/**
 * Rule H: for an initial version (no baseline), check the provider's
 * registered consumer declarations against the proposed specification where
 * possible. Returns per-declaration issues; an empty list means clean.
 */
async function initialDeclarationIssues(tx, version, dependencies) {
  const normalized = normalizeSpec(version.parsedContent);
  if (!normalized.ok) {
    // The specification validity check (rule A) already blocks; there is
    // nothing more to validate against.
    return [];
  }

  const issues = [];
  for (const dependency of dependencies) {
    const result = validateDeclaration(
      { method: dependency.method, path: dependency.path, sends: dependency.sends, reads: dependency.reads },
      normalized.spec
    );
    if (result.operation.status === 'missing') {
      issues.push({
        consumer: dependency.consumer?.name ?? dependency.consumerServiceId,
        operation: `${dependency.method} ${dependency.path}`,
        message: `operation does not exist in this initial specification`,
      });
      continue;
    }
    if (result.operation.status === 'mismatch') {
      issues.push({
        consumer: dependency.consumer?.name ?? dependency.consumerServiceId,
        operation: `${dependency.method} ${dependency.path}`,
        message: `declared path does not match exactly; closest operation is ${dependency.method} ${result.operation.matchedPath}`,
      });
    }
    for (const field of [...result.fields.request, ...result.fields.response]) {
      if (field.status === 'not_found') {
        issues.push({
          consumer: dependency.consumer?.name ?? dependency.consumerServiceId,
          operation: `${dependency.method} ${dependency.path}`,
          message: `field path "${field.path}" is not present in this initial specification`,
        });
      }
    }
  }
  return issues;
}

/**
 * Attempt to publish a version. Returns the explainable decision:
 *
 *   {
 *     outcome: 'PUBLISHED' | 'BLOCKED',
 *     code: string,
 *     versionId, versionLabel, service: { id, name },
 *     reason: string,
 *     warnings: string[],
 *     affectedConsumers: [{ id, name, findingCount, operations }],
 *     attemptId: string,
 *     decisionDetails: object,
 *   }
 *
 * @throws ApiError 404 SPEC_VERSION_NOT_FOUND
 * @throws ApiError 409 ALREADY_PUBLISHED (duplicate publish of a version
 *   that is already published)
 */
export async function publishVersion(versionId, { policy = PUBLISH_POLICY } = {}) {
  const version = await getVersionOrThrow(versionId);
  const service = await prisma.service.findUnique({ where: { id: version.serviceId } });

  // Consistent handling of duplicate publish requests: a version that is
  // already published cannot be published again.
  if (version.status === 'PUBLISHED') {
    throw new ApiError(
      409,
      'ALREADY_PUBLISHED',
      `Version "${version.versionLabel}" of service "${service.name}" is already published`
    );
  }

  // Rule A input: re-validate the STORED specification content. Never trust
  // the request.
  const specCheck = await validateSpecContent(version.originalContent, {
    filename: version.versionLabel,
    format: version.format === 'YAML' ? 'yaml' : 'json',
  });

  const result = await prisma.$transaction(async (tx) => {
    // Serialize publication decisions per provider service. The lock is
    // released automatically when the transaction commits or rolls back.
    // $executeRaw (not $queryRaw): pg_advisory_xact_lock returns VOID, so
    // there is no result row to deserialize.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${LOCK_PREFIX + version.serviceId}))`;

    // Re-read state inside the transaction (concurrent publishes may have
    // changed it while we waited for the lock).
    const current = await tx.apiVersion.findUnique({ where: { id: version.id } });
    if (!current) {
      throw new ApiError(404, 'SPEC_VERSION_NOT_FOUND', `Specification version with id "${versionId}" was not found`);
    }
    if (current.status === 'PUBLISHED') {
      return { alreadyPublished: true };
    }
    const baseline = await currentBaseline(tx, service.id);

    // Current consumer dependency state (for the freshness fingerprint and,
    // for initial versions, the declaration check).
    const dependencies = await tx.consumerDependency.findMany({
      where: { providerServiceId: service.id },
      include: { consumer: { select: { id: true, name: true } } },
    });
    const fingerprintNow = dependencyFingerprint(dependencies);
    const specHashNow = contentHash(current.originalContent);

    let decision;
    let analysisRunId = null;

    if (!baseline) {
      // Rule H: initial version.
      const declarationIssues = await initialDeclarationIssues(tx, current, dependencies);
      decision = evaluatePublishingDecision({
        specValid: specCheck.ok,
        isInitialVersion: true,
        analysisRun: null,
        declarationIssues,
        policy,
      });
    } else {
      // Rules B/C: the LATEST completed analysis for this version, if any.
      const analysisRun = await tx.analysisRun.findFirst({
        where: { proposedVersionId: version.id },
        orderBy: { createdAt: 'desc' },
      });
      let analysisContext = null;
      if (analysisRun) {
        const findings = analysisRun.impact?.findings ?? [];
        const breakingByConsumer = new Map();
        for (const finding of findings) {
          if (finding.change.classification !== 'BREAKING') continue;
          const entry = breakingByConsumer.get(finding.consumer.id) ?? {
            id: finding.consumer.id,
            name: finding.consumer.name,
            findingCount: 0,
            operations: new Set(),
          };
          entry.findingCount += 1;
          entry.operations.add(`${finding.operation.method} ${finding.operation.path}`);
          breakingByConsumer.set(finding.consumer.id, entry);
        }
        analysisContext = {
          id: analysisRun.id,
          counts: {
            total: analysisRun.countsTotal,
            breaking: analysisRun.countsBreaking,
            nonBreaking: analysisRun.countsNonBreaking,
            unknown: analysisRun.countsUnknown,
          },
          freshness: {
            baselineStale: analysisRun.baselineVersionId !== baseline.id,
            dependenciesStale: analysisRun.dependencyFingerprint !== fingerprintNow,
            contentStale: analysisRun.specContentHash !== specHashNow,
          },
          breakingAffectedConsumers: [...breakingByConsumer.values()].map((entry) => ({
            id: entry.id,
            name: entry.name,
            findingCount: entry.findingCount,
            operations: [...entry.operations].sort(),
          })),
          unknownChanges: (analysisRun.classifiedChanges ?? [])
            .filter((change) => change.classification === 'UNKNOWN')
            .map((change) => ({
              changeType: change.changeType,
              path: change.path,
              fieldPath: typeof change.fieldPath === 'string' ? change.fieldPath : null,
            })),
        };
        analysisRunId = analysisRun.id;
      }

      decision = evaluatePublishingDecision({
        specValid: specCheck.ok,
        isInitialVersion: false,
        analysisRun: analysisContext,
        declarationIssues: [],
        policy,
      });
    }

    // Persist the attempt (both outcomes) — history is never rewritten.
    const attempt = await tx.publishAttempt.create({
      data: {
        versionId: version.id,
        analysisRunId,
        outcome: decision.outcome,
        reason: decision.reason,
        warnings: decision.warnings,
        decisionDetails: decision.decisionDetails,
      },
    });

    // Only a PUBLISHED outcome changes the published state, atomically with
    // the attempt record.
    if (decision.outcome === 'PUBLISHED') {
      await tx.apiVersion.update({
        where: { id: version.id },
        data: { status: 'PUBLISHED' },
      });
    }

    return { alreadyPublished: false, attempt, decision, analysisRunId };
  });

  if (result.alreadyPublished) {
    throw new ApiError(
      409,
      'ALREADY_PUBLISHED',
      `Version "${version.versionLabel}" of service "${service.name}" is already published`
    );
  }

  const { decision } = result;
  return {
    outcome: decision.outcome,
    code: decision.code,
    versionId: version.id,
    versionLabel: version.versionLabel,
    service: { id: service.id, name: service.name },
    reason: decision.reason,
    warnings: decision.warnings,
    affectedConsumers: decision.decisionDetails.breakingAffectedConsumers ?? [],
    attemptId: result.attempt.id,
    analysisRunId: result.analysisRunId,
    decisionDetails: decision.decisionDetails,
  };
}

/**
 * Publishing history for one version, newest first.
 */
export async function getPublishHistory(versionId) {
  const version = await getVersionOrThrow(versionId);
  const attempts = await prisma.publishAttempt.findMany({
    where: { versionId: version.id },
    orderBy: { createdAt: 'desc' },
    include: {
      analysisRun: {
        select: { id: true, baselineVersionId: true, dependencyFingerprint: true, createdAt: true },
      },
    },
  });

  return {
    version: versionMeta(version),
    attempts: attempts.map((attempt) => ({
      id: attempt.id,
      outcome: attempt.outcome,
      reason: attempt.reason,
      warnings: attempt.warnings,
      decisionDetails: attempt.decisionDetails,
      analysisRun: attempt.analysisRun
        ? {
            id: attempt.analysisRun.id,
            baselineVersionId: attempt.analysisRun.baselineVersionId,
            dependencyFingerprint: attempt.analysisRun.dependencyFingerprint,
            computedAt: attempt.analysisRun.createdAt,
          }
        : null,
      createdAt: attempt.createdAt,
    })),
  };
}
