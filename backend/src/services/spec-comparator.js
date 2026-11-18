// Structural comparison of two normalized OpenAPI representations.
//
// Pure module — no database access, no Express. Accepts the output of
// spec-normalizer (two normalized specs belonging to the same service) and
// returns a deterministic list of structural changes. It answers WHAT
// changed — not WHETHER the change is safe; compatibility classification
// lives in compatibility-classifier.
//
// Matching semantics (what is NOT a change):
//   - Path parameter names: /users/{id} and /users/{userId} are the same
//     path template (canonicalPath). Path parameters are paired by position
//     in the path template, so renaming a path parameter alone produces no
//     changes; original names are preserved on the descriptors.
//   - $ref layout: both inputs are already $ref-resolved, so inlining a
//     schema or moving it into a component produces no changes.
//   - Property order, formatting, descriptions, deprecated/x-* flags:
//     not part of the normalized representation.
//
// Change report structure — every change is an object with:
//   changeType  UPPER_SNAKE_CASE identifier (see CHANGE_TYPES below)
//   method      HTTP method (uppercase), null for endpoint-level changes
//   path        endpoint path (baseline path when the operation exists in
//               both specs; the new path for added operations/endpoints)
//   fieldPath   where applicable; dot notation with `[]` for array items,
//               e.g. request.premium or response.200.items[].amount
//   location    coarse area: endpoint | method | operation | parameter |
//               requestBody | request | response.<status>
//   before      state in the baseline (from) spec, null when not applicable
//   after       state in the proposed (to) spec, null when not applicable
//   description plain-language sentence
//
// before/after shapes per change type:
//   ENDPOINT_*                       { methods: [...] }
//   METHOD_*, PARAMETER_REQUIREDNESS_CHANGED, REQUEST_BODY_REQUIREDNESS_CHANGED,
//   FIELD_REQUIREDNESS_CHANGED       { required: boolean }
//   ENUM_CHANGED, PARAMETER_ENUM_CHANGED  { enum: [...] }
//   NULLABLE_CHANGED                 { nullable: boolean }
//   CONSTRAINT_CHANGED               { <constraintKey>: value } (changed keys only)
//   FIELD_TYPE_CHANGED, PARAMETER_TYPE_CHANGED, FIELD_ADDED (schema part),
//   FIELD_REMOVED (schema part)      the normalized schema descriptor
//   FIELD_ADDED / FIELD_REMOVED      the normalized schema descriptor PLUS a
//                                    top-level `required` flag (the field's
//                                    requiredness in that version)
//   PARAMETER_ADDED / PARAMETER_REMOVED  full parameter descriptor
//   RESPONSE_STATUS_*                { contentTypes: [...] }
//   RESPONSE/REQUEST_CONTENT_TYPE_*  { contentType }
//
// The returned array is deterministically sorted by
// (path, method, location, changeType, fieldPath).

const CHANGE_TYPES = [
  'ENDPOINT_ADDED',
  'ENDPOINT_REMOVED',
  'METHOD_ADDED',
  'METHOD_REMOVED',
  'OPERATION_ID_CHANGED',
  'PARAMETER_ADDED',
  'PARAMETER_REMOVED',
  'PARAMETER_RENAMED',
  'PARAMETER_REQUIREDNESS_CHANGED',
  'PARAMETER_TYPE_CHANGED',
  'PARAMETER_ENUM_CHANGED',
  'REQUEST_BODY_ADDED',
  'REQUEST_BODY_REMOVED',
  'REQUEST_BODY_REQUIREDNESS_CHANGED',
  'REQUEST_CONTENT_TYPE_ADDED',
  'REQUEST_CONTENT_TYPE_REMOVED',
  'RESPONSE_STATUS_ADDED',
  'RESPONSE_STATUS_REMOVED',
  'RESPONSE_CONTENT_TYPE_ADDED',
  'RESPONSE_CONTENT_TYPE_REMOVED',
  'FIELD_ADDED',
  'FIELD_REMOVED',
  'FIELD_TYPE_CHANGED',
  'FIELD_REQUIREDNESS_CHANGED',
  'ENUM_CHANGED',
  'NULLABLE_CHANGED',
  'CONSTRAINT_CHANGED',
];

const METHOD_ORDER = ['GET', 'PUT', 'POST', 'DELETE', 'OPTIONS', 'HEAD', 'PATCH', 'TRACE'];

const CONSTRAINT_KEYS = [
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'minLength',
  'maxLength',
  'pattern',
  'minItems',
  'maxItems',
  'uniqueItems',
  'multipleOf',
  'minProperties',
  'maxProperties',
  'additionalProperties',
];

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

// Normalized values are plain JSON, so stringified comparison is a
// well-defined semantic equality check (arrays are stably sorted by the
// normalizer).
function jsonEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function omitKeys(value, keys) {
  if (typeof value !== 'object' || value === null) return value;
  const rest = { ...value };
  for (const key of keys) delete rest[key];
  return rest;
}

function compareStrings(a, b) {
  const keyA = a ?? '\u0000';
  const keyB = b ?? '\u0000';
  return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
}

// Union of the key sets of two (possibly undefined) plain objects, sorted.
function unionSortedKeys(a, b) {
  return [...new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])].sort();
}

// Original parameter names in the order they appear in the path template.
function pathParameterNames(path) {
  return (String(path).match(/\{[^}]*\}/g) ?? []).map((segment) => segment.slice(1, -1));
}

// The last segment of a field path, e.g. request.premium -> premium,
// response.200.items[].amount -> amount.
function leafOf(fieldPath) {
  const leaf = String(fieldPath).split('.').pop();
  return leaf.endsWith('[]') ? leaf.slice(0, -2) : leaf;
}

function methodRank(method) {
  const index = METHOD_ORDER.indexOf(method);
  return index === -1 ? METHOD_ORDER.length : index;
}

// ---------------------------------------------------------------------------
// Indexing
// ---------------------------------------------------------------------------

// canonicalPath -> { originalPath, methods: Map(method -> operation) }
function indexByPath(spec) {
  const map = new Map();
  for (const operation of spec.operations) {
    let entry = map.get(operation.canonicalPath);
    if (!entry) {
      entry = { originalPath: operation.path, methods: new Map() };
      map.set(operation.canonicalPath, entry);
    }
    if (!entry.methods.has(operation.method)) {
      entry.methods.set(operation.method, operation);
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// Change emission
// ---------------------------------------------------------------------------

function makeChange(changeType, { method = null, path = null, fieldPath, location, before, after }) {
  const change = {
    changeType,
    method,
    path,
  };
  if (fieldPath !== undefined) change.fieldPath = fieldPath;
  if (location !== undefined) change.location = location;
  change.before = before;
  change.after = after;
  return change;
}

// ---------------------------------------------------------------------------
// Schema diffing (request bodies and response bodies)
// ---------------------------------------------------------------------------

function withRequiredFlag(descriptor, required) {
  return { required, ...descriptor };
}

function constraintDiff(fromSchema, toSchema, ctx, changes) {
  for (const key of unionSortedKeys(fromSchema, toSchema)) {
    if (!CONSTRAINT_KEYS.includes(key)) continue;
    if (fromSchema[key] !== undefined || toSchema[key] !== undefined) {
      if (!jsonEqual(fromSchema[key], toSchema[key])) {
        changes.push(
          makeChange('CONSTRAINT_CHANGED', {
            ...ctx,
            fieldPath: ctx.basePath,
            before: { [key]: fromSchema[key] },
            after: { [key]: toSchema[key] },
          })
        );
      }
    }
  }
}

/**
 * Recursively diffs two normalized schema descriptors, emitting FIELD_*
 * (plus ENUM/NULLABLE/CONSTRAINT) changes.
 *
 * @param {object|null} fromSchema baseline schema descriptor
 * @param {object|null} toSchema   proposed schema descriptor
 * @param {{ location: string, basePath: string }} ctx
 *   location  'request' or 'response.<status>'
 *   basePath  dot-path prefix, e.g. 'request.premium' or 'response.200[].amount'
 */
function diffSchema(fromSchema, toSchema, ctx, changes) {
  if (fromSchema === null && toSchema === null) return;
  if (fromSchema === null) {
    changes.push(
      makeChange('FIELD_ADDED', {
        ...ctx,
        before: null,
        after: toSchema,
      })
    );
    return;
  }
  if (toSchema === null) {
    changes.push(
      makeChange('FIELD_REMOVED', {
        ...ctx,
        before: fromSchema,
        after: null,
      })
    );
    return;
  }

  if (fromSchema.type !== toSchema.type) {
    changes.push(
      makeChange('FIELD_TYPE_CHANGED', {
        ...ctx,
        fieldPath: ctx.basePath,
        before: { type: fromSchema.type, format: fromSchema.format },
        after: { type: toSchema.type, format: toSchema.format },
      })
    );
    return; // different shapes are not meaningfully comparable deeper
  }

  if (fromSchema.format !== toSchema.format) {
    changes.push(
      makeChange('FIELD_TYPE_CHANGED', {
        ...ctx,
        fieldPath: ctx.basePath,
        before: { type: fromSchema.type, format: fromSchema.format },
        after: { type: toSchema.type, format: toSchema.format },
      })
    );
  }

  if (fromSchema.nullable !== toSchema.nullable) {
    changes.push(
      makeChange('NULLABLE_CHANGED', {
        ...ctx,
        fieldPath: ctx.basePath,
        before: { nullable: fromSchema.nullable === true },
        after: { nullable: toSchema.nullable === true },
      })
    );
  }

  if (!jsonEqual(fromSchema.enum, toSchema.enum)) {
    changes.push(
      makeChange('ENUM_CHANGED', {
        ...ctx,
        fieldPath: ctx.basePath,
        before: { enum: fromSchema.enum ?? null },
        after: { enum: toSchema.enum ?? null },
      })
    );
  }

  constraintDiff(fromSchema, toSchema, ctx, changes);

  // Object properties.
  const fromProps = fromSchema.properties ?? {};
  const toProps = toSchema.properties ?? {};
  if (fromSchema.type === 'object' || toSchema.type === 'object') {
    const fromRequired = new Set(fromSchema.required ?? []);
    const toRequired = new Set(toSchema.required ?? []);
    for (const name of unionSortedKeys(fromProps, toProps)) {
      const fieldPath = `${ctx.basePath}.${name}`;
      if (name in toProps && name in fromProps) {
        if (fromRequired.has(name) !== toRequired.has(name)) {
          changes.push(
            makeChange('FIELD_REQUIREDNESS_CHANGED', {
              ...ctx,
              fieldPath,
              before: { required: fromRequired.has(name) },
              after: { required: toRequired.has(name) },
            })
          );
        }
        diffSchema(fromProps[name], toProps[name], { ...ctx, basePath: fieldPath }, changes);
      } else if (name in fromProps) {
        changes.push(
          makeChange('FIELD_REMOVED', {
            ...ctx,
            fieldPath,
            before: withRequiredFlag(fromProps[name], fromRequired.has(name)),
            after: null,
          })
        );
      } else {
        changes.push(
          makeChange('FIELD_ADDED', {
            ...ctx,
            fieldPath,
            before: null,
            after: withRequiredFlag(toProps[name], toRequired.has(name)),
          })
        );
      }
    }
  }

  // Array items.
  if (fromSchema.type === 'array' || toSchema.type === 'array') {
    diffSchema(
      fromSchema.items ?? { type: 'any' },
      toSchema.items ?? { type: 'any' },
      { ...ctx, basePath: `${ctx.basePath}[]` },
      changes
    );
  }
}

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

function findParameter(operation, name, location) {
  return operation.parameters.find((p) => p.in === location && p.name === name) ?? null;
}

// Emits PARAMETER_TYPE_CHANGED / PARAMETER_ENUM_CHANGED for a matched pair.
function diffParameterSchema(fromSchema, toSchema, paramCtx, changes) {
  const from = fromSchema ?? { type: 'any' };
  const to = toSchema ?? { type: 'any' };
  if (!jsonEqual(omitKeys(from, ['enum']), omitKeys(to, ['enum']))) {
    changes.push(
      makeChange('PARAMETER_TYPE_CHANGED', { ...paramCtx, before: from, after: to })
    );
  }
  if (!jsonEqual(from.enum, to.enum)) {
    changes.push(
      makeChange('PARAMETER_ENUM_CHANGED', {
        ...paramCtx,
        before: { enum: from.enum ?? null },
        after: { enum: to.enum ?? null },
      })
    );
  }
}

function compareParameterPair(fromParam, toParam, paramCtx, changes) {
  if (fromParam.required !== toParam.required) {
    changes.push(
      makeChange('PARAMETER_REQUIREDNESS_CHANGED', {
        ...paramCtx,
        before: { required: fromParam.required },
        after: { required: toParam.required },
      })
    );
  }
  diffParameterSchema(fromParam.schema, toParam.schema, paramCtx, changes);
}

function compareParameters(fromOp, toOp, opCtx, changes) {
  // Path parameters: paired by position in the path template — the names may
  // differ between versions without that being a contract change.
  const fromNames = pathParameterNames(fromOp.path);
  const toNames = pathParameterNames(toOp.path);
  const count = Math.max(fromNames.length, toNames.length);
  for (let i = 0; i < count; i += 1) {
    const fromName = fromNames[i] ?? null;
    const toName = toNames[i] ?? null;
    const fromParam = fromName !== null ? findParameter(fromOp, fromName, 'path') : null;
    const toParam = toName !== null ? findParameter(toOp, toName, 'path') : null;
    const display = toName ?? fromName ?? `param_${i}`;
    const paramCtx = {
      ...opCtx,
      location: 'parameter',
      fieldPath: `parameters.${fromName ?? display}`,
    };
    if (fromParam === null && toParam === null) continue;
    // The position is the same, but the name changed: a path parameter
    // rename. Reported explicitly (rather than silently) so downstream
    // consumers and impact analysis can see it.
    if (fromName !== null && toName !== null && fromName !== toName) {
      changes.push(
        makeChange('PARAMETER_RENAMED', {
          ...paramCtx,
          before: { name: fromName, in: 'path' },
          after: { name: toName, in: 'path' },
        })
      );
    }
    if (fromParam === null) {
      changes.push(makeChange('PARAMETER_ADDED', { ...paramCtx, before: null, after: toParam }));
      continue;
    }
    if (toParam === null) {
      changes.push(makeChange('PARAMETER_REMOVED', { ...paramCtx, before: fromParam, after: null }));
      continue;
    }
    compareParameterPair(fromParam, toParam, paramCtx, changes);
  }

  // Non-path parameters: the name is part of the wire contract, so match by
  // (in, name).
  const fromOthers = fromOp.parameters.filter((p) => p.in !== 'path');
  const toOthers = toOp.parameters.filter((p) => p.in !== 'path');
  const keys = new Set();
  for (const p of fromOthers) keys.add(`${p.in}:${p.name}`);
  for (const p of toOthers) keys.add(`${p.in}:${p.name}`);
  for (const key of [...keys].sort()) {
    const [, name] = key.split(':');
    const fromParam = fromOthers.find((p) => `${p.in}:${p.name}` === key) ?? null;
    const toParam = toOthers.find((p) => `${p.in}:${p.name}` === key) ?? null;
    const paramCtx = {
      ...opCtx,
      location: 'parameter',
      fieldPath: `parameters.${name}`,
    };
    if (fromParam === null) {
      changes.push(makeChange('PARAMETER_ADDED', { ...paramCtx, before: null, after: toParam }));
      continue;
    }
    if (toParam === null) {
      changes.push(makeChange('PARAMETER_REMOVED', { ...paramCtx, before: fromParam, after: null }));
      continue;
    }
    compareParameterPair(fromParam, toParam, paramCtx, changes);
  }
}

// ---------------------------------------------------------------------------
// Request body / responses
// ---------------------------------------------------------------------------

function compareContentMaps(fromContent, toContent, location, basePath, opCtx, changes, types) {
  for (const contentType of unionSortedKeys(fromContent, toContent)) {
    const fromEntry = fromContent[contentType];
    const toEntry = toContent[contentType];
    if (fromEntry === undefined) {
      changes.push(
        makeChange(types.added, {
          ...opCtx,
          location,
          fieldPath: `${basePath}[${contentType}]`,
          before: null,
          after: { contentType },
        })
      );
      continue;
    }
    if (toEntry === undefined) {
      changes.push(
        makeChange(types.removed, {
          ...opCtx,
          location,
          fieldPath: `${basePath}[${contentType}]`,
          before: { contentType },
          after: null,
        })
      );
      continue;
    }
    diffSchema(fromEntry.schema, toEntry.schema, { ...opCtx, location, basePath }, changes);
  }
}

function compareRequestBodies(fromBody, toBody, opCtx, changes) {
  if (fromBody === null && toBody === null) return;
  if (fromBody === null) {
    changes.push(
      makeChange('REQUEST_BODY_ADDED', {
        ...opCtx,
        location: 'requestBody',
        before: null,
        after: { required: toBody.required, contentTypes: Object.keys(toBody.content) },
      })
    );
    return;
  }
  if (toBody === null) {
    changes.push(
      makeChange('REQUEST_BODY_REMOVED', {
        ...opCtx,
        location: 'requestBody',
        before: { required: fromBody.required, contentTypes: Object.keys(fromBody.content) },
        after: null,
      })
    );
    return;
  }
  if (fromBody.required !== toBody.required) {
    changes.push(
      makeChange('REQUEST_BODY_REQUIREDNESS_CHANGED', {
        ...opCtx,
        location: 'requestBody',
        before: { required: fromBody.required },
        after: { required: toBody.required },
      })
    );
  }
  compareContentMaps(
    fromBody.content,
    toBody.content,
    'request',
    'request',
    opCtx,
    changes,
    {
      added: 'REQUEST_CONTENT_TYPE_ADDED',
      removed: 'REQUEST_CONTENT_TYPE_REMOVED',
    }
  );
}

function compareResponses(fromResponses, toResponses, opCtx, changes) {
  for (const status of unionSortedKeys(fromResponses, toResponses)) {
    const fromResponse = fromResponses[status];
    const toResponse = toResponses[status];

    if (fromResponse === undefined) {
      changes.push(
        makeChange('RESPONSE_STATUS_ADDED', {
          ...opCtx,
          location: 'response',
          fieldPath: `response.${status}`,
          before: null,
          after: { contentTypes: Object.keys(toResponse.content) },
        })
      );
      continue;
    }
    if (toResponse === undefined) {
      changes.push(
        makeChange('RESPONSE_STATUS_REMOVED', {
          ...opCtx,
          location: 'response',
          fieldPath: `response.${status}`,
          before: { contentTypes: Object.keys(fromResponse.content) },
          after: null,
        })
      );
      continue;
    }

    const fromContent = fromResponse.content;
    const toContent = toResponse.content;
    // When more than one content type carries a schema, the content type is
    // part of the field path so changes stay unambiguous.
    const multi = Object.keys(fromContent).length > 1 || Object.keys(toContent).length > 1;
    const location = `response.${status}`;
    for (const contentType of unionSortedKeys(fromContent, toContent)) {
      const fromEntry = fromContent[contentType];
      const toEntry = toContent[contentType];
      if (fromEntry === undefined) {
        changes.push(
          makeChange('RESPONSE_CONTENT_TYPE_ADDED', {
            ...opCtx,
            location,
            fieldPath: `response.${status}[${contentType}]`,
            before: null,
            after: { contentType },
          })
        );
        continue;
      }
      if (toEntry === undefined) {
        changes.push(
          makeChange('RESPONSE_CONTENT_TYPE_REMOVED', {
            ...opCtx,
            location,
            fieldPath: `response.${status}[${contentType}]`,
            before: { contentType },
            after: null,
          })
        );
        continue;
      }
      const basePath = multi ? `response.${status}[${contentType}]` : `response.${status}`;
      diffSchema(fromEntry.schema, toEntry.schema, { ...opCtx, location, basePath }, changes);
    }
  }
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

function compareOperations(fromOp, toOp, changes) {
  const opCtx = {
    method: fromOp.method,
    // Baseline path: the endpoint is the same operation, reported from the
    // baseline's point of view.
    path: fromOp.path,
  };

  if (fromOp.operationId !== toOp.operationId) {
    changes.push(
      makeChange('OPERATION_ID_CHANGED', {
        ...opCtx,
        location: 'operation',
        before: { operationId: fromOp.operationId },
        after: { operationId: toOp.operationId },
      })
    );
  }

  compareParameters(fromOp, toOp, opCtx, changes);
  compareRequestBodies(fromOp.requestBody, toOp.requestBody, opCtx, changes);
  compareResponses(fromOp.responses, toOp.responses, opCtx, changes);
}

// ---------------------------------------------------------------------------
// Descriptions
// ---------------------------------------------------------------------------

function schemaTypePhrase(descriptor) {
  if (!descriptor || typeof descriptor !== 'object') return 'unknown';
  if (descriptor.type === 'object') return 'object';
  if (descriptor.type === 'array') return 'array';
  const type = descriptor.type ?? 'any';
  return descriptor.format ? `${type} (${descriptor.format})` : type;
}

function enumPhrase(values) {
  if (values === undefined || values === null) return 'none';
  return `[${values.join(', ')}]`;
}

function locationPhrase(location) {
  if (location === 'request') return 'the request schema';
  if (typeof location === 'string' && location.startsWith('response.')) {
    const detail = location.slice('response.'.length);
    if (detail.includes('[')) {
      const status = detail.slice(0, detail.indexOf('['));
      const contentType = detail.slice(detail.indexOf('[') + 1, -1);
      return `the response (${status}, ${contentType}) schema`;
    }
    return `the response (${detail}) schema`;
  }
  return 'the operation';
}

export function describeChange(change) {
  const where = change.method ? `${change.method} ${change.path}` : change.path ?? 'the specification';
  const name = change.fieldPath ? leafOf(change.fieldPath) : '';
  const status = change.fieldPath?.startsWith('response.')
    ? change.fieldPath.slice('response.'.length).split('.')[0].replace('[', '').replace(']', '')
    : null;

  switch (change.changeType) {
    case 'ENDPOINT_ADDED':
      return `Endpoint ${change.path} was added (methods: ${change.after.methods.join(', ')}).`;
    case 'ENDPOINT_REMOVED':
      return `Endpoint ${change.path} was removed (methods: ${change.before.methods.join(', ')}).`;
    case 'METHOD_ADDED':
      return `${change.method} ${change.path} was added.`;
    case 'METHOD_REMOVED':
      return `${change.method} ${change.path} was removed.`;
    case 'OPERATION_ID_CHANGED':
      return `operationId changed from "${change.before.operationId}" to "${change.after.operationId}" on ${where}.`;
    case 'PARAMETER_ADDED':
      return `Parameter "${change.after.name}" (${change.after.in}) was added to ${where}.`;
    case 'PARAMETER_REMOVED':
      return `Parameter "${change.before.name}" (${change.before.in}) was removed from ${where}.`;
    case 'PARAMETER_RENAMED':
      return `Path parameter "${change.before.name}" was renamed to "${change.after.name}" on ${where}.`;
    case 'PARAMETER_REQUIREDNESS_CHANGED':
      return `Parameter "${name}" changed from ${change.before.required ? 'required' : 'optional'} to ${change.after.required ? 'required' : 'optional'} on ${where}.`;
    case 'PARAMETER_TYPE_CHANGED':
      return `Parameter "${name}" changed type from ${schemaTypePhrase(change.before)} to ${schemaTypePhrase(change.after)} on ${where}.`;
    case 'PARAMETER_ENUM_CHANGED':
      return `Parameter "${name}" changed enum values from ${enumPhrase(change.before.enum)} to ${enumPhrase(change.after.enum)} on ${where}.`;
    case 'REQUEST_BODY_ADDED':
      return `A request body (required: ${change.after.required}; content types: ${change.after.contentTypes.join(', ') || 'none'}) was added to ${where}.`;
    case 'REQUEST_BODY_REMOVED':
      return `The request body was removed from ${where}.`;
    case 'REQUEST_BODY_REQUIREDNESS_CHANGED':
      return `The request body on ${where} changed from ${change.before.required ? 'required' : 'optional'} to ${change.after.required ? 'required' : 'optional'}.`;
    case 'REQUEST_CONTENT_TYPE_ADDED':
      return `Content type "${change.after.contentType}" was added to the request body of ${where}.`;
    case 'REQUEST_CONTENT_TYPE_REMOVED':
      return `Content type "${change.before.contentType}" was removed from the request body of ${where}.`;
    case 'RESPONSE_STATUS_ADDED':
      return `Response status ${status} was added to ${where}.`;
    case 'RESPONSE_STATUS_REMOVED':
      return `Response status ${status} was removed from ${where}.`;
    case 'RESPONSE_CONTENT_TYPE_ADDED':
      return `Content type "${change.after.contentType}" was added to response ${status} of ${where}.`;
    case 'RESPONSE_CONTENT_TYPE_REMOVED':
      return `Content type "${change.before.contentType}" was removed from response ${status} of ${where}.`;
    case 'FIELD_ADDED':
      return `Field "${name}" was added to ${locationPhrase(change.location)} of ${where}.`;
    case 'FIELD_REMOVED':
      return `Field "${name}" was removed from ${locationPhrase(change.location)} of ${where}.`;
    case 'FIELD_TYPE_CHANGED':
      return `Field "${name}" changed type from ${schemaTypePhrase(change.before)} to ${schemaTypePhrase(change.after)} in ${locationPhrase(change.location)} of ${where}.`;
    case 'FIELD_REQUIREDNESS_CHANGED':
      return `Field "${name}" changed from ${change.before.required ? 'required' : 'optional'} to ${change.after.required ? 'required' : 'optional'} in ${locationPhrase(change.location)} of ${where}.`;
    case 'ENUM_CHANGED':
      return `Field "${name}" changed enum values from ${enumPhrase(change.before.enum)} to ${enumPhrase(change.after.enum)} in ${locationPhrase(change.location)} of ${where}.`;
    case 'NULLABLE_CHANGED':
      return `Field "${name}" changed from ${change.before.nullable ? 'nullable' : 'non-nullable'} to ${change.after.nullable ? 'nullable' : 'non-nullable'} in ${locationPhrase(change.location)} of ${where}.`;
    case 'CONSTRAINT_CHANGED': {
      const key = Object.keys(change.before)[0];
      return `Field "${name}" constraint "${key}" changed from ${JSON.stringify(change.before[key])} to ${JSON.stringify(change.after[key])} in ${locationPhrase(change.location)} of ${where}.`;
    }
    default:
      return `${change.changeType} on ${where}.`;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function sortChanges(changes) {
  changes.sort(
    (a, b) =>
      compareStrings(a.path, b.path) ||
      compareStrings(a.method, b.method) ||
      compareStrings(a.location, b.location) ||
      compareStrings(a.changeType, b.changeType) ||
      compareStrings(a.fieldPath, b.fieldPath)
  );
}

/**
 * Compare two normalized OpenAPI representations and return the structural
 * changes from `fromSpec` (baseline) to `toSpec` (proposed).
 *
 * @param {object} fromSpec  output of normalizeSpec (ok: true)
 * @param {object} toSpec    output of normalizeSpec (ok: true)
 * @returns {object[]} deterministically sorted change list (empty when the
 *   two specifications are semantically equivalent)
 */
export function compareSpecs(fromSpec, toSpec) {
  const changes = [];
  const fromIndex = indexByPath(fromSpec);
  const toIndex = indexByPath(toSpec);

  const canonicalPaths = [...new Set([...fromIndex.keys(), ...toIndex.keys()])].sort();
  for (const canonicalPath of canonicalPaths) {
    const fromEntry = fromIndex.get(canonicalPath);
    const toEntry = toIndex.get(canonicalPath);

    if (!fromEntry) {
      changes.push(
        makeChange('ENDPOINT_ADDED', {
          path: toEntry.originalPath,
          location: 'endpoint',
          before: null,
          after: {
            methods: [...toEntry.methods.keys()].sort((a, b) => methodRank(a) - methodRank(b)),
          },
        })
      );
      continue;
    }
    if (!toEntry) {
      changes.push(
        makeChange('ENDPOINT_REMOVED', {
          path: fromEntry.originalPath,
          location: 'endpoint',
          before: {
            methods: [...fromEntry.methods.keys()].sort((a, b) => methodRank(a) - methodRank(b)),
          },
          after: null,
        })
      );
      continue;
    }

    const methods = new Set([...fromEntry.methods.keys(), ...toEntry.methods.keys()]);
    for (const method of [...methods].sort((a, b) => methodRank(a) - methodRank(b))) {
      const fromOp = fromEntry.methods.get(method);
      const toOp = toEntry.methods.get(method);
      if (!fromOp && toOp) {
        changes.push(
          makeChange('METHOD_ADDED', {
            method,
            path: toEntry.originalPath,
            location: 'method',
            before: null,
            after: null,
          })
        );
        continue;
      }
      if (fromOp && !toOp) {
        changes.push(
          makeChange('METHOD_REMOVED', {
            method,
            path: fromEntry.originalPath,
            location: 'method',
            before: null,
            after: null,
          })
        );
        continue;
      }
      compareOperations(fromOp, toOp, changes);
    }
  }

  for (const change of changes) {
    change.description = describeChange(change);
  }
  sortChanges(changes);
  return changes;
}

export { CHANGE_TYPES };
export default compareSpecs;
