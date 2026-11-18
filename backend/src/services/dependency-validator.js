// Semantic validation of consumer dependency declarations against a
// provider's (normalized) OpenAPI representation.
//
// Pure module — no database access. Structural parsing (is the declaration
// well-formed?) lives in consumer-declarations.js; this module answers the
// semantic questions:
//   - does the declared operation exist in the specification?
//   - do the declared request/response field paths exist in the schema?
//
// Path templates are matched positionally (canonicalPath), so a consumer that
// declared /quotes/{id} still matches a specification that renamed the
// parameter to /quotes/{quoteId} — reported as an operation mismatch, not a
// silent pass and not a hard failure.
//
// Field matching is token-aware (segments split on "." with "[]" array
// markers) and never naive string-prefix matching, so "customer.name" does
// not match "customer.nameSuffix".

import { canonicalPath } from './spec-normalizer.js';

/**
 * Match a declared operation ({ method, path }) against the normalized spec's
 * operations.
 *
 * @param {string} method      uppercase HTTP method
 * @param {string} declaredPath  path as the consumer declared it
 * @param {object[]} operations  normalized operations (spec-normalizer output)
 * @returns {{ status: 'exact' | 'mismatch' | 'missing',
 *             operation: object | null }}
 *   exact    — an operation with the same method and the same original path
 *   mismatch — an operation with the same method matches positionally, but
 *              the path parameter names differ
 *   missing  — no operation with that method on that path template
 */
export function matchDeclaredOperation(method, declaredPath, operations) {
  const declaredCanonical = canonicalPath(declaredPath);
  let mismatchCandidate = null;
  for (const operation of operations) {
    if (operation.method !== method) continue;
    if (operation.path === declaredPath) {
      return { status: 'exact', operation };
    }
    if (mismatchCandidate === null && canonicalPath(operation.path) === declaredCanonical) {
      mismatchCandidate = operation;
    }
  }
  if (mismatchCandidate !== null) {
    return { status: 'mismatch', operation: mismatchCandidate };
  }
  return { status: 'missing', operation: null };
}

/**
 * Split a declared field path into segments. "items[].productId" becomes
 * [{ name: 'items', array: true }, { name: 'productId', array: false }].
 */
export function tokenizeFieldPath(fieldPath) {
  return String(fieldPath)
    .split('.')
    .filter((segment) => segment !== '')
    .map((segment) => {
      const array = segment.endsWith('[]');
      const name = array ? segment.slice(0, -2) : segment;
      return { name, array };
    });
}

/**
 * Token-aware prefix relationship between a declared field path and a
 * changed field path (both relative to the schema root).
 *
 * True when one path is a segment-wise prefix of the other:
 *   - changed "customer"        vs declared "customer.address.city" -> true
 *     (removing the parent object affects consumers using descendants)
 *   - changed "customer.address.city" vs declared "customer" -> true
 *     (a consumer that reads the whole object is affected by nested changes)
 *   - changed "customer.name"   vs declared "customer.nameSuffix" -> false
 *     (segment boundary: "name" is not a prefix of "nameSuffix")
 */
export function fieldPathMatches(declaredPath, changedPath) {
  const declared = tokenizeFieldPath(declaredPath);
  const changed = tokenizeFieldPath(changedPath);
  const [shorter, longer] =
    declared.length <= changed.length ? [declared, changed] : [changed, declared];
  for (let i = 0; i < shorter.length; i += 1) {
    if (shorter[i].name !== longer[i].name) return false;
  }
  return true;
}

/**
 * Resolve a declared field path against a normalized schema descriptor.
 *
 * @param {object[]} tokens  tokenizeFieldPath output
 * @param {object|null} rootSchema  normalized schema descriptor (the parent
 *   object that contains the first named property)
 * @returns {{ status: 'exists' | 'not_found' | 'unverifiable' }}
 *   not_found    — the schema is inspectable and the path does not exist
 *   unverifiable — the schema cannot be inspected (absent, type "any", or an
 *                  object with no declared properties); the path neither
 *                  exists nor is absent
 */
export function fieldStatusInSchema(tokens, rootSchema) {
  let current = rootSchema;
  for (const { name, array } of tokens) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return { status: 'unverifiable' };
    }
    if (current.type === 'any') {
      return { status: 'unverifiable' };
    }
    const properties = current.properties;
    if (properties === undefined) {
      // A schema node with no named children: arrays (items), scalars, or an
      // object that declares no properties at all.
      if (current.type === 'object') return { status: 'unverifiable' };
      return { status: 'not_found' };
    }
    if (properties[name] === undefined) {
      return { status: 'not_found' };
    }
    current = properties[name];
    if (array) {
      if (current.type !== 'array') return { status: 'not_found' };
      current = current.items ?? { type: 'any' };
    }
  }
  return { status: 'exists' };
}

// The request-body schema of an operation, if any (first content type that
// carries a schema, application/json preferred).
function requestBodySchema(operation) {
  if (!operation.requestBody || typeof operation.requestBody.content !== 'object') {
    return null;
  }
  const contentTypes = Object.keys(operation.requestBody.content);
  const ordered = ['application/json', ...contentTypes.filter((ct) => ct !== 'application/json')];
  for (const contentType of ordered) {
    const entry = operation.requestBody.content[contentType];
    if (entry && entry.schema) return entry.schema;
  }
  return null;
}

// Schemas carried by all 2xx responses of an operation (all content types).
function responseSchemas(operation) {
  const schemas = [];
  for (const [status, response] of Object.entries(operation.responses ?? {})) {
    if (!status.startsWith('2')) continue;
    for (const entry of Object.values(response.content ?? {})) {
      if (entry && entry.schema) schemas.push(entry.schema);
    }
  }
  return schemas;
}

/**
 * Check a set of declared field paths against one side of an operation.
 *
 * @param {string[]} fieldPaths  declared "sends" or "reads" paths
 * @param {object} operation     normalized operation
 * @param {'request'|'response'} side
 * @returns {Array<{ path: string, status: 'exists' | 'not_found' | 'unverifiable' }>}
 *   Request-side paths also match operation parameter names (path parameters
 *   are declared in `sends`, e.g. "policyId" for /policies/{policyId}).
 */
export function validateDeclaredFields(fieldPaths, operation, side) {
  if (side === 'request') {
    const bodySchema = requestBodySchema(operation);
    const parameterNames = new Set(
      (operation.parameters ?? []).map((parameter) => parameter.name)
    );
    return fieldPaths.map((fieldPath) => {
      if (parameterNames.has(fieldPath)) {
        return { path: fieldPath, status: 'exists' };
      }
      if (bodySchema === null) {
        // No request body at all: a non-parameter field cannot exist.
        return { path: fieldPath, status: 'not_found' };
      }
      const { status } = fieldStatusInSchema(tokenizeFieldPath(fieldPath), bodySchema);
      return { path: fieldPath, status };
    });
  }

  const schemas = responseSchemas(operation);
  return fieldPaths.map((fieldPath) => {
    if (schemas.length === 0) {
      return { path: fieldPath, status: 'not_found' };
    }
    // A field is considered available when it exists in at least one
    // successful response schema of the operation. If none of the
    // inspectable schemas contains it, it is not found; only schemas that
    // cannot be inspected at all keep the result "unverifiable".
    let sawInspectable = false;
    for (const schema of schemas) {
      const { status } = fieldStatusInSchema(tokenizeFieldPath(fieldPath), schema);
      if (status === 'exists') return { path: fieldPath, status };
      if (status === 'not_found') sawInspectable = true;
    }
    return { path: fieldPath, status: sawInspectable ? 'not_found' : 'unverifiable' };
  });
}

/**
 * Validate one dependency declaration against a normalized specification.
 *
 * @param {{ method: string, path: string, sends: string[], reads: string[] }} declaration
 * @param {{ operations: object[] }} normalizedSpec
 * @returns {{
 *   operation: { status: 'exact'|'mismatch'|'missing', matchedPath: string | null },
 *   fields: { request: Array<{path, status}>, response: Array<{path, status}> },
 * }}
 */
export function validateDeclaration(declaration, normalizedSpec) {
  const operations = normalizedSpec.operations ?? [];
  const match = matchDeclaredOperation(declaration.method, declaration.path, operations);

  const fields = { request: [], response: [] };
  if (match.status !== 'missing') {
    fields.request = validateDeclaredFields(declaration.sends ?? [], match.operation, 'request');
    fields.response = validateDeclaredFields(declaration.reads ?? [], match.operation, 'response');
  }

  return {
    operation: {
      status: match.status,
      matchedPath: match.operation ? match.operation.path : null,
    },
    fields,
  };
}
