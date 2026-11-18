// Parser for the starter-kit consumer declaration format.
//
// Pure module — no database access, no file I/O. Takes an ALREADY PARSED
// document (YAML/JSON object) and validates its structure, returning the
// declaration in normalized form. The starter-kit files look like this
// (actual fixture shape — field names are preserved verbatim):
//
//   consumer: mobile-app
//   team: Mobile
//   uses:
//   - provider: quote-api
//     method: POST
//     path: /quotes
//     sends:
//     - vehicle.make
//     - rider.age
//     reads:
//     - quoteId
//     - premium.breakdown[].amount
//
// Structural parsing only: this module checks that the document has the
// expected shape. Semantic validation against a provider's published
// specification is a separate step (dependency-validator.js).

import { normalizeHttpMethod } from '../validators/consumer.validators.js';

const MAX_FIELD_PATH_LENGTH = 300;

// Validates one `sends`/`reads` list from a declaration.
function validateFieldList(value, field, prefix, errors) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    errors.push({ field, message: `${field} must be an array of field-path strings` });
    return [];
  }
  const paths = [];
  for (let i = 0; i < value.length; i += 1) {
    const entryField = `${field}[${i}]`;
    if (typeof value[i] !== 'string' || value[i].trim() === '') {
      errors.push({
        field: entryField,
        message: 'each field path must be a non-empty string',
      });
    } else {
      const trimmed = value[i].trim();
      if (trimmed.length > MAX_FIELD_PATH_LENGTH) {
        errors.push({
          field: entryField,
          message: `field path must be at most ${MAX_FIELD_PATH_LENGTH} characters`,
        });
      } else {
        // Nested and array notation (e.g. "items[].productId") is preserved
        // verbatim — it is the representation the registry stores and the
        // impact analyzer matches on.
        paths.push(trimmed);
      }
    }
  }
  return paths;
}

/**
 * Parse one consumer declaration document.
 *
 * @param {object} document  Parsed YAML/JSON consumer declaration
 * @param {string} sourceName  Identifier of the source (file name), used in
 *   error reporting
 * @returns {{ ok: true, declaration: {
 *   consumer: string,
 *   team: string,
 *   uses: Array<{ provider: string, method: string, path: string,
 *                 sends: string[], reads: string[] }>,
 * }} } | {{ ok: false, errors: Array<{ field: string, message: string }> }}
 */
export function parseConsumerDeclaration(document, sourceName = '(inline)') {
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    return {
      ok: false,
      errors: [
        {
          field: `${sourceName}`,
          message: 'consumer declaration must be a mapping with consumer/team/uses keys',
        },
      ],
    };
  }

  const errors = [];

  if (typeof document.consumer !== 'string' || document.consumer.trim() === '') {
    errors.push({
      field: `${sourceName}:consumer`,
      message: 'consumer must be a non-empty service name',
    });
  }

  let team = '';
  if (document.team !== undefined && document.team !== null) {
    if (typeof document.team !== 'string') {
      errors.push({ field: `${sourceName}:team`, message: 'team must be a string' });
    } else {
      team = document.team.trim();
    }
  }

  const uses = [];
  if (document.uses !== undefined && document.uses !== null) {
    if (!Array.isArray(document.uses)) {
      errors.push({ field: `${sourceName}:uses`, message: 'uses must be an array of operation declarations' });
    } else {
      document.uses.forEach((use, index) => {
        const prefix = `${sourceName}:uses[${index}]`;
        if (typeof use !== 'object' || use === null || Array.isArray(use)) {
          errors.push({ field: prefix, message: 'each use must be a mapping with provider/method/path' });
          return;
        }

        if (typeof use.provider !== 'string' || use.provider.trim() === '') {
          errors.push({
            field: `${prefix}:provider`,
            message: 'provider must be a non-empty service name',
          });
        }

        const method = normalizeHttpMethod(use.method);
        if (method === null) {
          errors.push({
            field: `${prefix}:method`,
            message: 'method must be a supported HTTP method (GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS)',
          });
        }

        let path;
        if (typeof use.path !== 'string' || use.path.trim() === '') {
          errors.push({ field: `${prefix}:path`, message: 'path is required and must be a non-empty string' });
        } else {
          path = use.path.trim();
          if (!path.startsWith('/')) {
            errors.push({ field: `${prefix}:path`, message: 'path must start with "/"' });
          }
        }

        const sends = validateFieldList(use.sends, `${prefix}:sends`, prefix, errors);
        const reads = validateFieldList(use.reads, `${prefix}:reads`, prefix, errors);

        // A single bad entry does not discard the whole declaration: the
        // import reports per-use results, so well-formed uses still import.
        if (
          typeof use.provider === 'string' &&
          use.provider.trim() !== '' &&
          method !== null &&
          typeof use.path === 'string' &&
          use.path.trim().startsWith('/')
        ) {
          uses.push({
            provider: use.provider.trim(),
            method,
            path: use.path.trim(),
            sends,
            reads,
          });
        }
      });
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    declaration: {
      consumer: document.consumer.trim(),
      team,
      uses,
    },
  };
}

export default parseConsumerDeclaration;
