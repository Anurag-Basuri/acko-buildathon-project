// Reusable OpenAPI specification validation.
//
// Pure module — no database access, no Express. Parses YAML or JSON content,
// validates the OpenAPI document structure with @apidevtools/swagger-parser
// (which also resolves internal $ref references), and returns structured
// errors. Used by the specs endpoints today and by the comparison engine
// later.
//
// Supported documents: OpenAPI 3.x (the parser validates 3.0.0–3.0.4 and
// 3.1.0–3.1.2). Swagger 2.0 documents are rejected explicitly.

import { load as loadYaml } from 'js-yaml';
import SwaggerParser from '@apidevtools/swagger-parser';

const MAX_CONTENT_LENGTH = 1_000_000; // 1 MB, mirrors the HTTP body limit

// Un-escape an AJV instancePath ("~1" -> "/", "~0" -> "~").
function unescapePointer(instancePath) {
  if (!instancePath) return '';
  return instancePath.replace(/~1/g, '/').replace(/~0/g, '~');
}

// First line only, bounded, so a huge payload cannot balloon an error message.
function firstLine(value, max = 300) {
  const line = String(value).split('\n', 1)[0];
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

function makeError(code, message, path = undefined) {
  return path === undefined ? { code, message } : { code, message, path };
}

// Detect the format to parse with. An explicit `format` wins; then a
// `filename` extension; otherwise auto-detect (JSON first, since every valid
// JSON document is also valid YAML).
function detectFormat(content, { filename, format } = {}) {
  if (format === 'yaml') return 'yaml';
  if (format === 'json') return 'json';

  if (typeof filename === 'string') {
    const lower = filename.toLowerCase();
    if (lower.endsWith('.json')) return 'json';
    if (lower.endsWith('.yaml') || lower.endsWith('.yml')) return 'yaml';
  }

  return 'auto';
}

// Parse raw content into a JS value. Returns { ok: true, value, format } or
// { ok: false, format, errors } with a PARSE_ERROR. `format` is the format the
// document was detected as (or explicitly hinted): in auto mode anything that
// is not valid JSON is treated as YAML, so a broken non-JSON document reports
// 'yaml'.
function parseContent(content, mode) {
  const failureFormat = mode === 'auto' ? 'yaml' : mode;

  if (mode === 'json') {
    try {
      return { ok: true, value: JSON.parse(content), format: 'json' };
    } catch (err) {
      return {
        ok: false,
        format: failureFormat,
        errors: [
          makeError('PARSE_ERROR', `Content is not valid JSON: ${firstLine(err.message)}`),
        ],
      };
    }
  }

  if (mode === 'yaml') {
    try {
      return { ok: true, value: loadYaml(content), format: 'yaml' };
    } catch (err) {
      // YAMLException messages already include the offending line/column and
      // a snippet, which is what callers want to see.
      return {
        ok: false,
        format: failureFormat,
        errors: [makeError('PARSE_ERROR', firstLine(err.message, 500))],
      };
    }
  }

  // auto: JSON is a subset of YAML, so a successful JSON.parse means the
  // content is JSON; otherwise treat it as YAML.
  try {
    return { ok: true, value: JSON.parse(content), format: 'json' };
  } catch {
    // fall through to YAML
  }
  try {
    return { ok: true, value: loadYaml(content), format: 'yaml' };
  } catch (err) {
    return {
      ok: false,
      format: failureFormat,
      errors: [makeError('PARSE_ERROR', firstLine(err.message, 500))],
    };
  }
}

// Validate the `openapi`/`swagger` version field before delegating to the
// parser, so the error messages are specific (the parser's own message is
// less useful for the common cases).
function checkVersion(doc) {
  if (typeof doc.openapi === 'number') {
    return {
      ok: false,
      error: makeError(
        'INVALID_DOCUMENT',
        `openapi version must be a quoted string (got a number; write openapi: "3.0.3" in YAML)`
      ),
    };
  }
  if (typeof doc.openapi === 'string') {
    if (!doc.openapi.startsWith('3.')) {
      return {
        ok: false,
        error: makeError(
          'UNSUPPORTED_VERSION',
          `Unsupported OpenAPI version "${doc.openapi}" — this registry supports OpenAPI 3.x`
        ),
      };
    }
    return { ok: true, version: doc.openapi };
  }
  if (typeof doc.swagger === 'string') {
    return {
      ok: false,
      error: makeError(
        'UNSUPPORTED_VERSION',
        `Swagger ${doc.swagger} documents are not supported — this registry accepts OpenAPI 3.x specifications`
      ),
    };
  }
  return {
    ok: false,
    error: makeError(
      'INVALID_DOCUMENT',
      "Document is not an OpenAPI specification: missing the 'openapi' version field"
    ),
  };
}

// Map a thrown swagger-parser error to structured validation errors.
function mapParserError(err) {
  // Unresolvable $ref (internal or external).
  if (err.code === 'EMISSINGPOINTER' || err.code === 'ERESOLVER') {
    const ref =
      err.targetRef ?? (String(err.message).match(/Missing \$ref pointer "([^"]+)"/)?.[1]);
    const external =
      ref && !ref.startsWith('#')
        ? ' (external file references are not supported; keep all $ref pointers inside the document)'
        : '';
    return [
      makeError(
        'UNRESOLVED_REFERENCE',
        `Unresolved $ref "${ref ?? 'unknown'}". ${err.message}${external}`,
        ref
      ),
    ];
  }

  // Schema validation failure: the parser aggregates AJV errors in .details.
  if (Array.isArray(err.details)) {
    return err.details.map((detail) =>
      makeError(
        'SCHEMA_VALIDATION',
        detail.message,
        unescapePointer(detail.instancePath)
      )
    );
  }

  // Unsupported/unknown OpenAPI version.
  if (/Unsupported OpenAPI version/.test(err.message)) {
    return [
      makeError(
        'UNSUPPORTED_VERSION',
        `Unsupported OpenAPI version — ${firstLine(err.message.replace(/^Swagger schema validation failed\.\s*/, ''))}`
      ),
    ];
  }

  return [makeError('SPEC_VALIDATION_ERROR', firstLine(err.message, 500))];
}

/**
 * Validate an OpenAPI specification.
 *
 * @param {string} content  Raw specification text (YAML or JSON).
 * @param {{ filename?: string, format?: 'yaml' | 'json' }} [options]
 *   filename — optional file name used as a format hint (.json/.yaml/.yml).
 *   format   — optional explicit format; wins over filename detection.
 * @returns {Promise<{
 *   ok: true,
 *   format: 'yaml' | 'json',
 *   openApiVersion: string,
 *   resolved: object,          // fully $ref-resolved document
 * } | {
 *   ok: false,
 *   format?: 'yaml' | 'json',
 *   openApiVersion?: string,
 *   errors: Array<{ code: string, message: string, path?: string }>,
 * }>}
 */
export async function validateSpecContent(content, options = {}) {
  if (typeof content !== 'string' || content.trim() === '') {
    return {
      ok: false,
      errors: [makeError('INVALID_CONTENT', 'Specification content is required (non-empty string)')],
    };
  }
  if (content.length > MAX_CONTENT_LENGTH) {
    return {
      ok: false,
      errors: [
        makeError(
          'INVALID_CONTENT',
          `Specification content is too large (${content.length} bytes, max ${MAX_CONTENT_LENGTH})`
        ),
      ],
    };
  }

  const mode = detectFormat(content, options);
  const parsed = parseContent(content, mode);
  if (!parsed.ok) {
    return { ok: false, format: parsed.format ?? null, errors: parsed.errors };
  }

  const doc = parsed.value;
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    return {
      ok: false,
      format: parsed.format,
      errors: [
        makeError(
          'INVALID_DOCUMENT',
          `OpenAPI document must be an object (mapping); got ${
            doc === null ? 'null' : Array.isArray(doc) ? 'an array' : typeof doc
          }`
        ),
      ],
    };
  }

  const version = checkVersion(doc);
  if (!version.ok) {
    return { ok: false, format: parsed.format, errors: [version.error] };
  }

  try {
    const resolved = await SwaggerParser.validate(doc);
    return {
      ok: true,
      format: parsed.format,
      openApiVersion: version.version,
      resolved,
    };
  } catch (err) {
    return {
      ok: false,
      format: parsed.format,
      openApiVersion: version.version,
      errors: mapParserError(err),
    };
  }
}

export default validateSpecContent;
