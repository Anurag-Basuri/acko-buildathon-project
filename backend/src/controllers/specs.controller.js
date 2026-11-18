// HTTP handling for Specification Management. Delegates business logic and
// database access to the service layer; spec parsing/validation to the
// reusable spec-validator module.
import { uploadSpecVersion, getSpecVersion } from '../services/spec.service.js';
import { compareSpecVersions } from '../services/comparison.service.js';
import { validateSpecContent } from '../services/spec-validator.js';
import {
  validateSpecCheckBody,
  validateSpecUploadBody,
  validateDiffQuery,
} from '../validators/spec.validators.js';
import { isValidUuid } from '../validators/service.validators.js';
import { ApiError } from '../utils/api-error.js';

// POST /api/specs/validate — checks a specification without persisting it.
// Returns 200 with { valid, format, openApiVersion, errors } whether or not
// the specification is valid: the validity verdict is the payload, not an
// HTTP error.
export async function validateSpec(req, res) {
  const result = validateSpecCheckBody(req.body);
  if (!result.ok) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Request body failed validation', result.errors);
  }

  const outcome = await validateSpecContent(result.data.content, {
    filename: result.data.filename,
    format: result.data.format,
  });

  res.json({
    success: true,
    data: {
      valid: outcome.ok,
      format: outcome.format ?? null,
      openApiVersion: outcome.openApiVersion ?? null,
      errors: outcome.ok ? [] : outcome.errors,
    },
  });
}

// POST /api/specs/upload — persists a new PROPOSED specification version.
export async function uploadSpec(req, res) {
  const result = validateSpecUploadBody(req.body);
  if (!result.ok) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Request body failed validation', result.errors);
  }

  const { version, isInitialVersion, baselineVersionId } = await uploadSpecVersion(result.data);

  res.status(201).json({
    success: true,
    data: {
      id: version.id,
      serviceId: version.serviceId,
      versionLabel: version.versionLabel,
      format: version.format,
      openApiVersion: version.openApiVersion,
      status: version.status,
      isInitialVersion,
      baselineVersionId,
      createdAt: version.createdAt,
      updatedAt: version.updatedAt,
    },
  });
}

// GET /api/specs/:id — metadata and stored content for one version.
export async function getSpecVersionById(req, res) {
  const { id } = req.params;
  if (!isValidUuid(id)) {
    throw new ApiError(400, 'INVALID_ID', 'id must be a valid UUID');
  }
  const version = await getSpecVersion(id);
  res.json({ success: true, data: version });
}

// GET /api/specs/diff?fromVersionId=...&toVersionId=... — structural
// comparison of two versions of the same service, with every change
// classified as BREAKING / NON_BREAKING / UNKNOWN by the deterministic
// compatibility rule engine (each change carries classification, ruleId and
// a plain-language reason).
export async function diffSpecs(req, res) {
  const result = validateDiffQuery(req.query);
  if (!result.ok) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Query parameters failed validation', result.errors);
  }

  const report = await compareSpecVersions(result.data);

  res.json({
    success: true,
    data: {
      serviceId: report.serviceId,
      fromVersion: report.fromVersion,
      toVersion: report.toVersion,
      changeCount: report.changes.length,
      breakingChangeCount: report.counts.breaking,
      nonBreakingChangeCount: report.counts.nonBreaking,
      unknownChangeCount: report.counts.unknown,
      changes: report.changes,
    },
  });
}
