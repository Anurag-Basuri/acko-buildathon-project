// Consumer Registry business logic.
// All Prisma access for consumers and dependencies lives here; controllers
// never query the database directly.
//
// Consumers are Service records (no duplicate identity model): a service
// "becomes" a consumer when it gains ConsumerDependency rows. The same
// service can be a consumer and a provider at the same time.
import { Prisma } from '@prisma/client';
import prisma from '../database/prisma.js';
import { ApiError } from '../utils/api-error.js';
import { createService } from './service-registry.service.js';
import { normalizeSpec } from './spec-normalizer.js';
import { validateDeclaration } from './dependency-validator.js';

// Dependency row without consumer/provider relations (used in bulk ops).
function dependencyRow(dependency) {
  return {
    id: dependency.id,
    consumerServiceId: dependency.consumerServiceId,
    providerServiceId: dependency.providerServiceId,
    method: dependency.method,
    path: dependency.path,
    sends: dependency.sends,
    reads: dependency.reads,
    createdAt: dependency.createdAt,
    updatedAt: dependency.updatedAt,
  };
}

async function getConsumerOrThrow(id) {
  const service = await prisma.service.findUnique({ where: { id } });
  if (!service) {
    throw new ApiError(404, 'CONSUMER_NOT_FOUND', `Consumer (service) with id "${id}" was not found`);
  }
  return service;
}

/**
 * Register a consumer. Reuses the Service Registry model: a consumer is a
 * service record. Returns the created service.
 */
export async function registerConsumer({ name, owner, description }) {
  return createService({ name, owner, description }); // 409 DUPLICATE_SERVICE on duplicate
}

/**
 * List all services that have at least one dependency declaration (i.e. act
 * as a consumer), with their dependencies grouped by provider.
 */
export async function listConsumers() {
  const services = await prisma.service.findMany({
    where: { consumerDependencies: { some: {} } },
    include: {
      consumerDependencies: {
        include: { provider: { select: { id: true, name: true } } },
      },
      providedDependencies: {
        include: { consumer: { select: { id: true, name: true } } },
      },
    },
    orderBy: { name: 'asc' },
  });

  return services.map((service) => {
    const providers = new Map();
    for (const dependency of service.consumerDependencies) {
      const entry = providers.get(dependency.providerServiceId) ?? {
        id: dependency.provider.id,
        name: dependency.provider.name,
        dependencyCount: 0,
      };
      entry.dependencyCount += 1;
      providers.set(dependency.providerServiceId, entry);
    }
    const consumedBy = new Map();
    for (const dependency of service.providedDependencies) {
      const entry = consumedBy.get(dependency.consumerServiceId) ?? {
        id: dependency.consumer.id,
        name: dependency.consumer.name,
        dependencyCount: 0,
      };
      entry.dependencyCount += 1;
      consumedBy.set(dependency.consumerServiceId, entry);
    }
    return {
      id: service.id,
      name: service.name,
      owner: service.owner,
      description: service.description,
      dependencyCount: service.consumerDependencies.length,
      providers: [...providers.values()],
      uses: service.consumerDependencies.map(dependencyRow),
      consumedBy: [...consumedBy.values()],
      createdAt: service.createdAt,
      updatedAt: service.updatedAt,
    };
  });
}

/**
 * One consumer's record plus the dependencies it declares (as consumer) and
 * the dependencies other services declare against it (as provider).
 */
export async function getConsumer(id) {
  const service = await getConsumerOrThrow(id);
  const [consumerDependencies, providedDependencies] = await Promise.all([
    prisma.consumerDependency.findMany({
      where: { consumerServiceId: id },
      include: { provider: { select: { id: true, name: true } } },
    }),
    prisma.consumerDependency.findMany({
      where: { providerServiceId: id },
      include: { consumer: { select: { id: true, name: true } } },
    }),
  ]);

  return {
    id: service.id,
    name: service.name,
    owner: service.owner,
    description: service.description,
    uses: consumerDependencies.map(dependencyRow),
    consumedBy: providedDependencies.map((dependency) => ({
      ...dependencyRow(dependency),
      consumerName: dependency.consumer.name,
    })),
    createdAt: service.createdAt,
    updatedAt: service.updatedAt,
  };
}

/**
 * REPLACE all dependency declarations of a consumer.
 *
 * Semantics (documented behavior): the request body is the complete,
 * authoritative set of the consumer's dependencies.
 *   - dependencies present in the request are upserted (sends/reads are
 *     updated to the declared values);
 *   - existing dependencies NOT present in the request are deleted.
 * An empty array clears every dependency.
 */
export async function replaceDependencies(consumerId, dependencies) {
  const consumer = await getConsumerOrThrow(consumerId);

  // Every referenced provider must exist.
  const providerIds = [...new Set(dependencies.map((d) => d.providerId))];
  const providers = await prisma.service.findMany({
    where: { id: { in: providerIds } },
    select: { id: true, name: true },
  });
  const found = new Set(providers.map((p) => p.id));
  const missing = [...new Set(dependencies.map((d) => d.providerId))].filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw new ApiError(
      400,
      'PROVIDER_NOT_FOUND',
      'One or more referenced provider services do not exist',
      { missingProviderIds: missing }
    );
  }

  await prisma.$transaction(async (tx) => {
    const keep = dependencies.map((d) => ({
      consumerServiceId: consumerId,
      providerServiceId: d.providerId,
      method: d.method,
      path: d.path,
    }));
    if (keep.length > 0) {
      await tx.consumerDependency.deleteMany({
        where: { consumerServiceId: consumerId, NOT: { OR: keep } },
      });
    } else {
      await tx.consumerDependency.deleteMany({ where: { consumerServiceId: consumerId } });
    }

    for (const dependency of dependencies) {
      await tx.consumerDependency.upsert({
        where: {
          consumerServiceId_providerServiceId_method_path: {
            consumerServiceId: consumerId,
            providerServiceId: dependency.providerId,
            method: dependency.method,
            path: dependency.path,
          },
        },
        create: {
          consumerServiceId: consumerId,
          providerServiceId: dependency.providerId,
          method: dependency.method,
          path: dependency.path,
          sends: dependency.sends,
          reads: dependency.reads,
        },
        update: {
          sends: dependency.sends,
          reads: dependency.reads,
        },
      });
    }
  });

  return getConsumer(consumerId);
}

/**
 * All registered consumers that declare dependencies on a provider service,
 * grouped per consumer.
 */
export async function listProviderConsumers(providerId) {
  const provider = await prisma.service.findUnique({ where: { id: providerId } });
  if (!provider) {
    throw new ApiError(404, 'SERVICE_NOT_FOUND', `Service with id "${providerId}" was not found`);
  }

  const dependencies = await prisma.consumerDependency.findMany({
    where: { providerServiceId: providerId },
    include: { consumer: { select: { id: true, name: true, owner: true } } },
  });

  const byConsumer = new Map();
  for (const dependency of dependencies) {
    const entry = byConsumer.get(dependency.consumerServiceId) ?? {
      id: dependency.consumer.id,
      name: dependency.consumer.name,
      owner: dependency.consumer.owner,
      dependencies: [],
    };
    entry.dependencies.push(dependencyRow(dependency));
    byConsumer.set(dependency.consumerServiceId, entry);
  }

  return {
    provider: { id: provider.id, name: provider.name, owner: provider.owner },
    consumers: [...byConsumer.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
  };
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

// The provider's latest published version, if any (the baseline a declaration
// is validated against — the same convention the publish flow uses).
async function getPublishedVersion(serviceId) {
  return prisma.apiVersion.findFirst({
    where: { serviceId, status: 'PUBLISHED' },
    orderBy: { createdAt: 'desc' },
  });
}

function fieldIssues(fieldResults, side) {
  return fieldResults
    .filter((field) => field.status === 'not_found')
    .map((field) => ({
      kind: 'field',
      side,
      field: field.path,
      message: `field path "${field.path}" is not present in the published ${side === 'request' ? 'request' : 'response'} schema`,
    }));
}

function useValidationResult(declaration, result) {
  const issues = [];
  let status;

  if (result.operation.status === 'missing') {
    status = 'invalid_operation';
    issues.push({
      kind: 'operation',
      side: null,
      field: `${declaration.method} ${declaration.path}`,
      message: `operation ${declaration.method} ${declaration.path} does not exist in the published specification`,
    });
    return { status, issues };
  }

  const requestIssues = fieldIssues(result.fields.request, 'request');
  const responseIssues = fieldIssues(result.fields.response, 'response');
  const unverifiable = [
    ...result.fields.request.filter((f) => f.status === 'unverifiable'),
    ...result.fields.response.filter((f) => f.status === 'unverifiable'),
  ].map((f) => ({
    kind: 'unverifiable',
    side: null,
    field: f.path,
    message: `field path "${f.path}" could not be verified against the schema`,
  }));

  if (result.operation.status === 'mismatch') {
    status = 'operation_mismatch';
    issues.push({
      kind: 'operation',
      side: null,
      field: `${declaration.method} ${declaration.path}`,
      message: `declared path ${declaration.path} does not exist as written; the published specification has ${declaration.method} ${result.operation.matchedPath} (path parameter names differ)`,
    });
  } else if (requestIssues.length > 0 || responseIssues.length > 0) {
    status = 'field_mismatches';
  } else {
    status = 'validated';
  }

  return { status, issues: [...issues, ...requestIssues, ...responseIssues, ...unverifiable] };
}

/**
 * Import consumer declarations (from starter-kit files or the request body).
 * Idempotent: consumer services are upserted by name, provider references are
 * resolved by name (unresolved providers are reported, never created), and
 * dependencies are upserted on their unique (consumer, provider, method,
 * path) key — importing the same declarations twice creates no duplicates.
 */
export async function importDeclarations(declarations, { source = 'request-body' } = {}) {
  const report = {
    source,
    declarationsProcessed: 0,
    consumersCreated: 0,
    consumersExisting: 0,
    dependenciesUpserted: 0,
    unresolvedProviders: [],
    declarations: [],
  };

  for (const declaration of declarations) {
    report.declarationsProcessed += 1;
    const entry = {
      source: declaration.source ?? null,
      consumer: declaration.consumer,
      team: declaration.team ?? null,
      consumerServiceId: null,
      status: 'ok',
      uses: [],
    };
    report.declarations.push(entry);

    // 1. Consumer: upsert the Service record by name.
    const existingConsumer = await prisma.service.findUnique({
      where: { name: declaration.consumer },
    });
    if (existingConsumer) {
      entry.consumerServiceId = existingConsumer.id;
      report.consumersExisting += 1;
    } else {
      try {
        const created = await prisma.service.create({
          data: {
            name: declaration.consumer,
            owner: declaration.team || 'Starter Kit',
            description: declaration.team ? `Consumer of API operations (team: ${declaration.team})` : null,
          },
        });
        entry.consumerServiceId = created.id;
        report.consumersCreated += 1;
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          // Lost a race: another import created it concurrently.
          const raced = await prisma.service.findUnique({ where: { name: declaration.consumer } });
          entry.consumerServiceId = raced?.id ?? null;
          report.consumersExisting += 1;
        } else {
          throw err;
        }
      }
    }

    // 2. Resolve provider references by name.
    const providerNames = [...new Set(declaration.uses.map((use) => use.provider))];
    const providers = await prisma.service.findMany({
      where: { name: { in: providerNames } },
      select: { id: true, name: true },
    });
    const providerByName = new Map(providers.map((p) => [p.name, p]));

    const usesToImport = [];
    for (const use of declaration.uses) {
      const provider = providerByName.get(use.provider);
      if (!provider) {
        entry.status = entry.status === 'ok' ? 'unresolved' : entry.status;
        report.unresolvedProviders.push({ provider: use.provider, declaredBy: declaration.consumer });
        entry.uses.push({
          method: use.method,
          path: use.path,
          status: 'unresolved_provider',
          issues: [
            {
              kind: 'provider',
              side: null,
              field: use.provider,
              message: `provider "${use.provider}" is not registered; the declaration was not imported (providers are never created implicitly)`,
            },
          ],
        });
        continue;
      }
      usesToImport.push({ use, provider });
    }

    // 3. Per-provider validation context: latest published specification.
    const validationCache = new Map(); // providerId -> 'pending' | {spec}
    for (const { use, provider } of usesToImport) {
      if (!validationCache.has(provider.id)) {
        const published = await getPublishedVersion(provider.id);
        if (!published) {
          validationCache.set(provider.id, 'pending');
        } else {
          const normalized = normalizeSpec(published.parsedContent);
          validationCache.set(
            provider.id,
            normalized.ok ? { spec: normalized.spec, versionLabel: published.versionLabel } : null
          );
        }
      }
      const context = validationCache.get(provider.id);

      let useResult;
      if (context === 'pending') {
        // No published specification yet: preserve the declaration and say
        // validation is pending.
        useResult = {
          status: 'pending_validation',
          issues: [
            {
              kind: 'validation',
              side: null,
              field: `${use.method} ${use.path}`,
              message: 'provider has no published specification yet; validation is pending',
            },
          ],
        };
      } else if (context === null) {
        // A published spec exists but cannot be normalized: report it, keep
        // the declaration.
        useResult = {
          status: 'pending_validation',
          issues: [
            {
              kind: 'validation',
              side: null,
              field: `${use.method} ${use.path}`,
              message: 'published specification could not be normalized; validation is pending',
            },
          ],
        };
      } else {
        const result = validateDeclaration(use, context.spec);
        useResult = useValidationResult(use, result);
      }

      entry.uses.push({
        provider: provider.name,
        method: use.method,
        path: use.path,
        ...useResult,
      });

      await prisma.consumerDependency.upsert({
        where: {
          consumerServiceId_providerServiceId_method_path: {
            consumerServiceId: entry.consumerServiceId,
            providerServiceId: provider.id,
            method: use.method,
            path: use.path,
          },
        },
        create: {
          consumerServiceId: entry.consumerServiceId,
          providerServiceId: provider.id,
          method: use.method,
          path: use.path,
          sends: use.sends,
          reads: use.reads,
        },
        update: { sends: use.sends, reads: use.reads },
      });
      report.dependenciesUpserted += 1;
    }

    if (entry.status === 'ok' && entry.uses.length === 0) entry.status = 'no_uses';
  }

  return report;
}
