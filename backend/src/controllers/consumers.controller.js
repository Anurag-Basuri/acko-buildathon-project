// HTTP handling for the Consumer Registry. Delegates all business logic and
// database access to the service layer.
import {
  registerConsumer,
  listConsumers,
  getConsumer,
  replaceDependencies,
  listProviderConsumers,
  importDeclarations,
} from '../services/consumer.service.js';
import { importStarterKitDeclarations } from '../services/consumer-importer.js';
import {
  validateConsumerRegistration,
  validateDependencyList,
  validateImportBody,
  isValidUuid,
} from '../validators/consumer.validators.js';
import { ApiError } from '../utils/api-error.js';

// GET /api/consumers — every registered consumer with its dependencies.
export async function listAllConsumers(req, res) {
  const consumers = await listConsumers();
  res.json({ success: true, data: consumers });
}

// POST /api/consumers — register a consumer (a Service record).
export async function registerConsumerEndpoint(req, res) {
  const result = validateConsumerRegistration(req.body);
  if (!result.ok) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Request body failed validation', result.errors);
  }
  const consumer = await registerConsumer(result.data);
  res.status(201).json({ success: true, data: consumer });
}

// GET /api/consumers/:id — one consumer, its declared dependencies (uses)
// and the dependencies other services declare against it (consumedBy).
export async function getConsumerById(req, res) {
  const { id } = req.params;
  if (!isValidUuid(id)) {
    throw new ApiError(400, 'INVALID_ID', 'id must be a valid UUID');
  }
  const consumer = await getConsumer(id);
  res.json({ success: true, data: consumer });
}

// PUT /api/consumers/:id — REPLACE the consumer's dependency declarations.
// The body is the complete set of dependencies: entries are upserted and
// existing dependencies missing from the body are deleted.
export async function updateConsumerDependencies(req, res) {
  const { id } = req.params;
  if (!isValidUuid(id)) {
    throw new ApiError(400, 'INVALID_ID', 'id must be a valid UUID');
  }
  const result = validateDependencyList(req.body);
  if (!result.ok) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Request body failed validation', result.errors);
  }
  const consumer = await replaceDependencies(id, result.data.dependencies);
  res.json({ success: true, data: consumer });
}

// POST /api/consumers/import — import consumer declarations.
// Empty body: import the starter-kit files from disk.
// Body { declarations: [...] }: import the supplied declarations (each in
// the starter-kit shape { consumer, team, uses: [...] }).
export async function importConsumerDeclarations(req, res) {
  const result = validateImportBody(req.body);
  if (!result.ok) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Request body failed validation', result.errors);
  }

  let report;
  if (result.data.declarations === null) {
    report = await importStarterKitDeclarations();
  } else {
    // Parse each supplied declaration; malformed ones are reported, valid
    // ones are imported.
    const { parseConsumerDeclaration } = await import('../services/consumer-declarations.js');
    const valid = [];
    const bodyReport = {
      source: 'request-body',
      declarationsProcessed: result.data.declarations.length,
      consumersCreated: 0,
      consumersExisting: 0,
      dependenciesUpserted: 0,
      unresolvedProviders: [],
      declarations: [],
    };
    result.data.declarations.forEach((declaration, index) => {
      const parsed = parseConsumerDeclaration(declaration, `declarations[${index}]`);
      if (parsed.ok) {
        valid.push({ ...parsed.declaration, source: `declarations[${index}]` });
      } else {
        bodyReport.declarations.push({
          source: `declarations[${index}]`,
          consumer:
            declaration && typeof declaration.consumer === 'string' ? declaration.consumer : null,
          team: null,
          consumerServiceId: null,
          status: 'parse_error',
          errors: parsed.errors,
          uses: [],
        });
      }
    });
    if (valid.length > 0) {
      const imported = await importDeclarations(valid, { source: 'request-body' });
      bodyReport.consumersCreated = imported.consumersCreated;
      bodyReport.consumersExisting = imported.consumersExisting;
      bodyReport.dependenciesUpserted = imported.dependenciesUpserted;
      bodyReport.unresolvedProviders = imported.unresolvedProviders;
      bodyReport.declarations.push(...imported.declarations);
    }
    bodyReport.declarations.sort((a, b) => String(a.source ?? '').localeCompare(String(b.source ?? '')));
    report = bodyReport;
  }

  res.json({ success: true, data: report });
}

// GET /api/services/:id/consumers — registered consumers depending on this
// provider service (mounted on the /api/services router).
export async function getProviderConsumers(req, res) {
  const { id } = req.params;
  if (!isValidUuid(id)) {
    throw new ApiError(400, 'INVALID_ID', 'id must be a valid UUID');
  }
  const result = await listProviderConsumers(id);
  res.json({ success: true, data: result });
}
