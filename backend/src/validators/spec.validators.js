// Input validation for the Specification Management endpoints.
// Pure functions: no I/O, no Prisma.

import { isValidUuid } from './service.validators.js';

const MAX_VERSION_LABEL_LENGTH = 100;
const MAX_FILENAME_LENGTH = 255;

// Validates an optional format hint. Returns the normalised format
// ('yaml' | 'json'), or an error message.
function checkFormatHint(body) {
  if (body.format === undefined) return { ok: true, format: undefined };
  if (typeof body.format !== 'string') {
    return { ok: false, message: 'format must be a string ("yaml" or "json")' };
  }
  const normalised = body.format.trim().toLowerCase();
  if (normalised !== 'yaml' && normalised !== 'json') {
    return { ok: false, message: 'format must be "yaml" or "json"' };
  }
  return { ok: true, format: normalised };
}

// Validates an optional filename hint.
function checkFilenameHint(body) {
  if (body.filename === undefined) return { ok: true, filename: undefined };
  if (typeof body.filename !== 'string') {
    return { ok: false, message: 'filename must be a string' };
  }
  const filename = body.filename.trim();
  if (filename.length > MAX_FILENAME_LENGTH) {
    return {
      ok: false,
      message: `filename must be at most ${MAX_FILENAME_LENGTH} characters`,
    };
  }
  return { ok: true, filename };
}

// Validates the POST /api/specs/validate body.
// Returns { ok: true, data } or { ok: false, errors: [{ field, message }] }.
export function validateSpecCheckBody(body) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return {
      ok: false,
      errors: [{ field: 'body', message: 'Request body must be a JSON object' }],
    };
  }

  const errors = [];

  if (typeof body.content !== 'string' || body.content.trim() === '') {
    errors.push({ field: 'content', message: 'content is required and must be a non-empty string' });
  }

  const format = checkFormatHint(body);
  if (!format.ok) errors.push({ field: 'format', message: format.message });
  const filename = checkFilenameHint(body);
  if (!filename.ok) errors.push({ field: 'filename', message: filename.message });

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, data: { content: body.content, format: format.format, filename: filename.filename } };
}

// Validates the ?fromVersionId=&toVersionId= query used by the comparison
// (GET /api/specs/diff) and compatibility (GET /api/compatibility/check)
// endpoints.
// Returns { ok: true, data } or { ok: false, errors: [{ field, message }] }.
export function validateDiffQuery(query) {
  const errors = [];

  for (const field of ['fromVersionId', 'toVersionId']) {
    const value = query?.[field];
    if (typeof value !== 'string' || value.trim() === '') {
      errors.push({ field, message: `${field} is required` });
    } else if (!isValidUuid(value)) {
      errors.push({ field, message: `${field} must be a valid UUID` });
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    data: { fromVersionId: query.fromVersionId, toVersionId: query.toVersionId },
  };
}

// Validates the POST /api/specs/upload body.
// Returns { ok: true, data } or { ok: false, errors: [{ field, message }] }.
export function validateSpecUploadBody(body) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return {
      ok: false,
      errors: [{ field: 'body', message: 'Request body must be a JSON object' }],
    };
  }

  const errors = [];

  if (typeof body.serviceId !== 'string' || !isValidUuid(body.serviceId)) {
    errors.push({ field: 'serviceId', message: 'serviceId is required and must be a valid UUID' });
  }

  if (typeof body.versionLabel !== 'string') {
    errors.push({ field: 'versionLabel', message: 'versionLabel is required and must be a string' });
  } else {
    const versionLabel = body.versionLabel.trim();
    if (versionLabel === '') {
      errors.push({ field: 'versionLabel', message: 'versionLabel must not be empty' });
    } else if (versionLabel.length > MAX_VERSION_LABEL_LENGTH) {
      errors.push({
        field: 'versionLabel',
        message: `versionLabel must be at most ${MAX_VERSION_LABEL_LENGTH} characters`,
      });
    }
  }

  if (typeof body.content !== 'string' || body.content.trim() === '') {
    errors.push({ field: 'content', message: 'content is required and must be a non-empty string' });
  }

  const format = checkFormatHint(body);
  if (!format.ok) errors.push({ field: 'format', message: format.message });
  const filename = checkFilenameHint(body);
  if (!filename.ok) errors.push({ field: 'filename', message: filename.message });

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    data: {
      serviceId: body.serviceId,
      versionLabel: body.versionLabel.trim(),
      content: body.content,
      format: format.format,
      filename: filename.filename,
    },
  };
}
