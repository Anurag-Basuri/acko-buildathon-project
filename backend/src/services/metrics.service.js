// Dashboard & Metrics business logic.
//
// Every number comes from the real database via aggregates where practical
// (groupBy / count). No mock data, no runtime traffic monitoring.
//
// Compatibility and impact metrics use ONLY the latest AnalysisRun per
// proposed version: re-running the analysis persists a new historical run,
// so summing all runs would count the same changes multiple times. The raw
// run count is reported separately as `analysisRunCount`.
//
// Publishing metrics never count a blocked attempt as a success:
// successRate = published / (published + blocked), null when there are no
// attempts at all.

import prisma from '../database/prisma.js';

const RECENT_ACTIVITY_LIMIT = 10;

/**
 * Pick the latest AnalysisRun row per proposed version.
 * Runs are ordered by createdAt ascending; the last one wins.
 */
function latestRunPerVersion(runs) {
  const latest = new Map();
  for (const run of runs) {
    latest.set(run.proposedVersionId, run);
  }
  return [...latest.values()];
}

/**
 * Full dashboard payload.
 */
export async function getMetrics() {
  const [serviceCount, specCount, publishedSpecCount, proposedSpecCount, runs, attempts] =
    await Promise.all([
      prisma.service.count(),
      prisma.apiVersion.count(),
      prisma.apiVersion.count({ where: { status: 'PUBLISHED' } }),
      prisma.apiVersion.count({ where: { status: 'PROPOSED' } }),
      prisma.analysisRun.findMany({
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          proposedVersionId: true,
          createdAt: true,
          countsTotal: true,
          countsBreaking: true,
          countsNonBreaking: true,
          countsUnknown: true,
          affectedConsumerCount: true,
          affectedDependencyCount: true,
          affectedChangeCount: true,
        },
      }),
      prisma.publishAttempt.findMany({
        select: {
          outcome: true,
          createdAt: true,
          decisionDetails: true,
          version: { select: { versionLabel: true, service: { select: { name: true } } } },
        },
      }),
    ]);

  // Services: consumers (have outgoing dependencies) and providers (have
  // incoming dependencies or spec versions).
  const [consumerServiceIds, providerServiceIds] = await Promise.all([
    prisma.service
      .findMany({ where: { consumerDependencies: { some: {} } }, select: { id: true } })
      .then((rows) => rows.map((row) => row.id)),
    prisma.service
      .findMany({ where: { OR: [{ providedDependencies: { some: {} } }, { apiVersions: { some: {} } }] }, select: { id: true } })
      .then((rows) => rows.map((row) => row.id)),
  ]);

  // Compatibility / impact from the latest run per proposed version.
  const latest = latestRunPerVersion(runs);
  const latestRuns = [];
  for (const run of latest) {
    const meta = await prisma.apiVersion.findUnique({
      where: { id: run.proposedVersionId },
      select: {
        versionLabel: true,
        createdAt: true,
        service: { select: { id: true, name: true } },
      },
    });
    if (!meta) continue;
    latestRuns.push({
      id: run.id,
      service: meta.service,
      versionLabel: meta.versionLabel,
      proposedAt: meta.createdAt,
      at: run.createdAt,
      totalChanges: run.countsTotal,
      breakingChanges: run.countsBreaking,
      nonBreakingChanges: run.countsNonBreaking,
      unknownChanges: run.countsUnknown,
      affectedConsumers: run.affectedConsumerCount,
    });
  }
  latestRuns.sort((a, b) => new Date(b.at) - new Date(a.at));
  const compatibility = {
    analyzedVersionCount: latest.length,
    analysisRunCount: runs.length,
    totalChanges: latest.reduce((sum, run) => sum + run.countsTotal, 0),
    breakingChanges: latest.reduce((sum, run) => sum + run.countsBreaking, 0),
    nonBreakingChanges: latest.reduce((sum, run) => sum + run.countsNonBreaking, 0),
    unknownChanges: latest.reduce((sum, run) => sum + run.countsUnknown, 0),
    lastAnalyzedAt: runs.length > 0 ? runs[runs.length - 1].createdAt : null,
    latestRuns,
  };
  const impact = {
    affectedConsumerCount: latest.reduce((sum, run) => sum + run.affectedConsumerCount, 0),
    affectedDependencyCount: latest.reduce((sum, run) => sum + run.affectedDependencyCount, 0),
    affectedChangeCount: latest.reduce((sum, run) => sum + run.affectedChangeCount, 0),
  };

  // Publishing.
  const publishedCount = attempts.filter((attempt) => attempt.outcome === 'PUBLISHED').length;
  const blockedCount = attempts.length - publishedCount;
  const blockedByCode = {};
  for (const attempt of attempts) {
    if (attempt.outcome !== 'BLOCKED') continue;
    const code = attempt.decisionDetails?.code ?? 'UNKNOWN_CODE';
    blockedByCode[code] = (blockedByCode[code] ?? 0) + 1;
  }
  const publishing = {
    attemptCount: attempts.length,
    publishedCount,
    blockedCount,
    // Null (not 0) when there are no attempts: a rate is undefined, not zero.
    successRate: attempts.length > 0 ? publishedCount / attempts.length : null,
    blockedByCode,
    lastAttemptAt:
      attempts.length > 0
        ? [...attempts].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0].createdAt
        : null,
  };

  return {
    generatedAt: new Date(),
    services: {
      total: serviceCount,
      consumerCount: consumerServiceIds.length,
      providerCount: providerServiceIds.length,
    },
    specs: {
      totalVersions: specCount,
      published: publishedSpecCount,
      proposed: proposedSpecCount,
    },
    compatibility,
    impact,
    publishing,
  };
}

/**
 * Recent activity feed: the newest events across spec uploads, analysis
 * runs, publish decisions and service registrations, newest first.
 */
export async function getRecentActivity(limit = RECENT_ACTIVITY_LIMIT) {
  const [versions, runs, attempts, services] = await Promise.all([
    prisma.apiVersion.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        createdAt: true,
        versionLabel: true,
        service: { select: { name: true } },
      },
    }),
    prisma.analysisRun.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        createdAt: true,
        countsTotal: true,
        countsBreaking: true,
        countsUnknown: true,
        affectedConsumerCount: true,
        proposedVersion: { select: { versionLabel: true, service: { select: { name: true } } } },
        baselineVersion: { select: { versionLabel: true } },
      },
    }),
    prisma.publishAttempt.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        createdAt: true,
        outcome: true,
        reason: true,
        version: { select: { versionLabel: true, service: { select: { name: true } } } },
      },
    }),
    prisma.service.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: { id: true, name: true, createdAt: true },
    }),
  ]);

  const events = [
    ...versions.map((version) => ({
      type: 'SPEC_UPLOADED',
      at: version.createdAt,
      subject: `${version.service.name} ${version.versionLabel}`,
      detail: 'specification version uploaded',
      versionId: version.id,
    })),
    ...runs.map((run) => ({
      type: 'ANALYSIS_COMPLETED',
      at: run.createdAt,
      subject: `${run.proposedVersion.service.name} ${run.proposedVersion.versionLabel}`,
      detail: `${run.countsTotal} change(s) vs ${run.baselineVersion.versionLabel}: ${run.countsBreaking} breaking, ${run.countsUnknown} unknown, ${run.affectedConsumerCount} consumer(s) affected`,
      versionId: run.proposedVersion.id,
    })),
    ...attempts.map((attempt) => ({
      type: attempt.outcome === 'PUBLISHED' ? 'SPEC_PUBLISHED' : 'PUBLISH_BLOCKED',
      at: attempt.createdAt,
      subject: `${attempt.version.service.name} ${attempt.version.versionLabel}`,
      detail: attempt.reason,
      versionId: attempt.version.id,
    })),
    ...services.map((service) => ({
      type: 'SERVICE_REGISTERED',
      at: service.createdAt,
      subject: service.name,
      detail: 'service registered',
      serviceId: service.id,
    })),
  ];

  return events
    .sort((a, b) => new Date(b.at) - new Date(a.at))
    .slice(0, limit);
}

/**
 * Per-service overview rows for the services metrics endpoint.
 */
export async function getServiceMetrics() {
  const services = await prisma.service.findMany({
    where: { OR: [{ consumerDependencies: { some: {} } }, { providedDependencies: { some: {} } }, { apiVersions: { some: {} } }] },
    include: {
      apiVersions: { select: { id: true, versionLabel: true, status: true, createdAt: true, updatedAt: true } },
      consumerDependencies: { select: { id: true, providerServiceId: true } },
      providedDependencies: { select: { id: true, consumerServiceId: true } },
    },
    orderBy: { name: 'asc' },
  });

  const latestRunByService = new Map();
  const runs = await prisma.analysisRun.findMany({
    orderBy: { createdAt: 'asc' },
    select: {
      providerServiceId: true,
      createdAt: true,
      countsTotal: true,
      countsBreaking: true,
      countsUnknown: true,
      affectedConsumerCount: true,
    },
  });
  for (const run of runs) {
    latestRunByService.set(run.providerServiceId, run);
  }

  const attempts = await prisma.publishAttempt.groupBy({
    by: ['versionId'],
    _count: { _all: true },
  });
  const attemptsByVersion = new Map(attempts.map((row) => [row.versionId, row._count._all]));

  return services.map((service) => {
    const published = service.apiVersions.filter((version) => version.status === 'PUBLISHED');
    const baseline = published.sort((a, b) => {
      const byUpdated = new Date(b.updatedAt) - new Date(a.updatedAt);
      if (byUpdated !== 0) return byUpdated;
      return new Date(b.createdAt) - new Date(a.createdAt);
    })[0];
    const run = latestRunByService.get(service.id) ?? null;
    return {
      id: service.id,
      name: service.name,
      owner: service.owner,
      versionCount: service.apiVersions.length,
      publishedVersionCount: published.length,
      currentBaseline: baseline
        ? { id: baseline.id, versionLabel: baseline.versionLabel, publishedAt: baseline.updatedAt }
        : null,
      dependencyCount: service.consumerDependencies.length,
      consumerDependencyCount: service.providedDependencies.length,
      latestAnalysis: run
        ? {
            at: run.createdAt,
            totalChanges: run.countsTotal,
            breakingChanges: run.countsBreaking,
            unknownChanges: run.countsUnknown,
            affectedConsumers: run.affectedConsumerCount,
          }
        : null,
      publishAttemptCount: service.apiVersions.reduce(
        (sum, version) => sum + (attemptsByVersion.get(version.id) ?? 0),
        0
      ),
    };
  });
}

/**
 * Publishing-focused metrics for the publishing metrics endpoint.
 */
export async function getPublishingMetrics() {
  const attempts = await prisma.publishAttempt.findMany({
    orderBy: { createdAt: 'desc' },
    include: {
      version: {
        select: {
          id: true,
          versionLabel: true,
          status: true,
          service: { select: { id: true, name: true } },
        },
      },
      analysisRun: { select: { id: true, baselineVersionId: true, createdAt: true } },
    },
  });

  const publishedCount = attempts.filter((attempt) => attempt.outcome === 'PUBLISHED').length;
  const blockedCount = attempts.length - publishedCount;

  const blockedByCode = {};
  for (const attempt of attempts) {
    if (attempt.outcome !== 'BLOCKED') continue;
    const code = attempt.decisionDetails?.code ?? 'UNKNOWN_CODE';
    blockedByCode[code] = (blockedByCode[code] ?? 0) + 1;
  }

  // Latest blocked attempts, most recent first (for the "needs attention" list).
  const recentBlocked = attempts
    .filter((attempt) => attempt.outcome === 'BLOCKED')
    .slice(0, 5)
    .map((attempt) => ({
      id: attempt.id,
      at: attempt.createdAt,
      service: attempt.version.service,
      versionLabel: attempt.version.versionLabel,
      reason: attempt.reason,
      warnings: attempt.warnings,
      analysisRun: attempt.analysisRun
        ? { id: attempt.analysisRun.id, computedAt: attempt.analysisRun.createdAt }
        : null,
    }));

  return {
    attemptCount: attempts.length,
    publishedCount,
    blockedCount,
    successRate: attempts.length > 0 ? publishedCount / attempts.length : null,
    blockedByCode,
    recentBlocked,
  };
}
