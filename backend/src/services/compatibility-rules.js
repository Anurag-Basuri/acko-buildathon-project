// Compatibility rules — the initial, product-owner-proposed rule set.
//
// Each rule is a small deterministic object:
//   ruleId         machine-readable identifier of the rule
//   classification BREAKING | NON_BREAKING | UNKNOWN
//   applies        predicate over one comparator change (all context:
//                  changeType, request/response location, requiredness,
//                  enum values, types)
//   reason         plain-language, change-specific explanation
//
// Rules are evaluated in order and the first applicable rule wins. The list
// is a plain in-code configuration: revising or adding a rule after
// product-owner confirmation means editing this file, not a database
// migration or a rules service.
//
// Direction of travel is part of the decision: a change that makes the
// contract MORE restrictive for existing clients (fewer accepted inputs,
// fewer returned fields, stricter fields) is BREAKING; a change that only
// makes it MORE permissive (new optional input, new optional output) is
// NON_BREAKING. Where the initial rule set is deliberately conservative —
// response-side changes consumers may not anticipate, and anything without
// an explicit rule — the classification is UNKNOWN with a reason that says
// manual review is required. The classifier NEVER classifies an unmatched
// change type as NON_BREAKING.

// Compatibility values returned for every classified change.
export const COMPATIBILITY = {
  BREAKING: 'BREAKING',
  NON_BREAKING: 'NON_BREAKING',
  UNKNOWN: 'UNKNOWN',
};

// ---------------------------------------------------------------------------
// Helpers (change-specific phrasing for reasons)
// ---------------------------------------------------------------------------

export function wherePhrase(change) {
  return change.method ? `${change.method} ${change.path}` : change.path ?? 'the specification';
}

// Last field segment: request.premium -> premium, response.200.items[].amount
// -> amount.
export function fieldLeaf(fieldPath) {
  const leaf = String(fieldPath ?? '').split('.').pop();
  return leaf.endsWith('[]') ? leaf.slice(0, -2) : leaf;
}

function isResponseLocation(location) {
  return typeof location === 'string' && location.startsWith('response.');
}

// The response status a change refers to (from the fieldPath or location).
function statusOf(change) {
  if (typeof change.fieldPath === 'string' && change.fieldPath.startsWith('response.')) {
    return change.fieldPath.slice('response.'.length).split(/[.[\]]/)[0];
  }
  if (isResponseLocation(change.location)) {
    return change.location.slice('response.'.length);
  }
  return 'unknown';
}

function typePhrase(descriptor) {
  if (!descriptor || typeof descriptor !== 'object') return 'unknown';
  const type = descriptor.type ?? 'any';
  return descriptor.format ? `${type} (${descriptor.format})` : type;
}

// Symmetric difference of two enum value lists.
function enumDiff(before, after) {
  const beforeValues = new Set(before ?? []);
  const afterValues = new Set(after ?? []);
  return {
    removed: [...beforeValues].filter((value) => !afterValues.has(value)),
    added: [...afterValues].filter((value) => !beforeValues.has(value)),
  };
}

function valuesPhrase(values) {
  return values.length === 0 ? 'none' : `[${values.join(', ')}]`;
}

// The comparator puts the parameter name in `fieldPath`
// (parameters.<name>); before/after carry schema descriptors for the
// *_CHANGED change types and full parameter descriptors for ADDED/REMOVED.
function paramName(change) {
  return (
    change.before?.name ??
    change.after?.name ??
    (typeof change.fieldPath === 'string' && change.fieldPath.startsWith('parameters.')
      ? change.fieldPath.slice('parameters.'.length)
      : '')
  );
}

function paramIn(change) {
  return change.before?.in ?? change.after?.in ?? '';
}

function paramPhrase(change) {
  const inLocation = paramIn(change);
  return inLocation ? `"${paramName(change)}" (${inLocation})` : `"${paramName(change)}"`;
}

function responsePhrase(change) {
  return `the ${statusOf(change)} response of ${wherePhrase(change)}`;
}

// ---------------------------------------------------------------------------
// Rules, in evaluation order
// ---------------------------------------------------------------------------

export const RULES = [
  // ------------------------------------------------------------------
  // Operations
  // ------------------------------------------------------------------
  {
    ruleId: 'ENDPOINT_REMOVED',
    classification: COMPATIBILITY.BREAKING,
    applies: (c) => c.changeType === 'ENDPOINT_REMOVED',
    reason: (c) =>
      `Endpoint ${c.path} (methods: ${c.before.methods.join(', ')}) was removed. ` +
      'Existing clients that call this endpoint will no longer reach it.',
  },
  {
    ruleId: 'ENDPOINT_ADDED',
    classification: COMPATIBILITY.NON_BREAKING,
    applies: (c) => c.changeType === 'ENDPOINT_ADDED',
    reason: (c) =>
      `Endpoint ${c.path} (methods: ${c.after.methods.join(', ')}) was added. ` +
      'Adding new surface cannot affect existing clients.',
  },
  {
    ruleId: 'METHOD_REMOVED',
    classification: COMPATIBILITY.BREAKING,
    applies: (c) => c.changeType === 'METHOD_REMOVED',
    reason: (c) =>
      `${c.method} ${c.path} was removed. Existing clients that call this operation will no longer be served.`,
  },
  {
    ruleId: 'METHOD_ADDED',
    classification: COMPATIBILITY.NON_BREAKING,
    applies: (c) => c.changeType === 'METHOD_ADDED',
    reason: (c) =>
      `${c.method} ${c.path} was added. Adding a new operation cannot affect existing clients.`,
  },
  {
    ruleId: 'OPERATION_ID_CHANGED',
    classification: COMPATIBILITY.UNKNOWN,
    applies: (c) => c.changeType === 'OPERATION_ID_CHANGED',
    reason: (c) =>
      `operationId changed from "${c.before.operationId}" to "${c.after.operationId}" on ${wherePhrase(c)}. ` +
      'Generated clients and internal tooling may reference the old identifier; ' +
      'the initial rule set has no rule for this, so it needs manual review.',
  },

  // ------------------------------------------------------------------
  // Request parameters
  // ------------------------------------------------------------------
  {
    ruleId: 'PARAMETER_REMOVED',
    classification: COMPATIBILITY.BREAKING,
    applies: (c) => c.changeType === 'PARAMETER_REMOVED',
    reason: (c) =>
      `Parameter ${paramPhrase(c)} was removed from ${wherePhrase(c)}. ` +
      'Clients that still send this parameter may be rejected or have it silently ignored.',
  },
  {
    ruleId: 'PARAMETER_ADDED_REQUIRED',
    classification: COMPATIBILITY.BREAKING,
    applies: (c) => c.changeType === 'PARAMETER_ADDED' && c.after?.required === true,
    reason: (c) =>
      `Required parameter ${paramPhrase(c)} was added to ${wherePhrase(c)}. ` +
      'Existing clients that do not send it will be rejected.',
  },
  {
    ruleId: 'PARAMETER_ADDED_OPTIONAL',
    classification: COMPATIBILITY.NON_BREAKING,
    applies: (c) => c.changeType === 'PARAMETER_ADDED' && c.after?.required !== true,
    reason: (c) =>
      `Optional parameter ${paramPhrase(c)} was added to ${wherePhrase(c)}. ` +
      'Clients that do not send it are unaffected.',
  },
  {
    ruleId: 'PARAMETER_OPTIONAL_TO_REQUIRED',
    classification: COMPATIBILITY.BREAKING,
    applies: (c) =>
      c.changeType === 'PARAMETER_REQUIREDNESS_CHANGED' &&
      c.after.required === true &&
      c.before.required !== true,
    reason: (c) =>
      `Parameter ${paramPhrase(c)} on ${wherePhrase(c)} became required. ` +
      'Existing clients that omit it will be rejected.',
  },
  {
    ruleId: 'PARAMETER_REQUIRED_TO_OPTIONAL',
    classification: COMPATIBILITY.NON_BREAKING,
    applies: (c) =>
      c.changeType === 'PARAMETER_REQUIREDNESS_CHANGED' &&
      c.before.required === true &&
      c.after.required !== true,
    reason: (c) =>
      `Parameter ${paramPhrase(c)} on ${wherePhrase(c)} became optional. ` +
      'Clients that do send it are unaffected.',
  },
  {
    ruleId: 'PARAMETER_TYPE_CHANGED',
    classification: COMPATIBILITY.BREAKING,
    applies: (c) => c.changeType === 'PARAMETER_TYPE_CHANGED',
    reason: (c) =>
      `Parameter ${paramPhrase(c)} on ${wherePhrase(c)} changed type from ` +
      `${typePhrase(c.before)} to ${typePhrase(c.after)}. ` +
      'Clients sending the previous type may no longer be accepted.',
  },
  {
    ruleId: 'PARAMETER_ENUM_VALUES_REMOVED',
    classification: COMPATIBILITY.BREAKING,
    applies: (c) =>
      c.changeType === 'PARAMETER_ENUM_CHANGED' && enumDiff(c.before?.enum, c.after?.enum).removed.length > 0,
    reason: (c) =>
      `Request enum value(s) ${valuesPhrase(enumDiff(c.before?.enum, c.after?.enum).removed)} for ` +
      `parameter ${paramPhrase(c)} on ${wherePhrase(c)} were removed. ` +
      'Clients that send those values will be rejected.',
  },
  {
    ruleId: 'PARAMETER_ENUM_VALUES_ADDED',
    classification: COMPATIBILITY.NON_BREAKING,
    applies: (c) =>
      c.changeType === 'PARAMETER_ENUM_CHANGED' &&
      enumDiff(c.before?.enum, c.after?.enum).removed.length === 0 &&
      enumDiff(c.before?.enum, c.after?.enum).added.length > 0,
    reason: (c) =>
      `Request enum value(s) ${valuesPhrase(enumDiff(c.before?.enum, c.after?.enum).added)} were added to ` +
      `parameter ${paramPhrase(c)} on ${wherePhrase(c)}. ` +
      'Values accepted before are still accepted.',
  },
  {
    ruleId: 'PARAMETER_RENAMED',
    classification: COMPATIBILITY.UNKNOWN,
    applies: (c) => c.changeType === 'PARAMETER_RENAMED',
    reason: (c) =>
      `Path parameter "${c.before.name}" was renamed to "${c.after.name}" on ${wherePhrase(c)}. ` +
      'Clients that build requests by name (or use generated clients) may be affected; ' +
      'the initial rule set has no rule for parameter renames, so manual review is recommended.',
  },

  // ------------------------------------------------------------------
  // Request body
  // ------------------------------------------------------------------
  {
    ruleId: 'REQUEST_BODY_REMOVED',
    classification: COMPATIBILITY.BREAKING,
    applies: (c) => c.changeType === 'REQUEST_BODY_REMOVED',
    reason: (c) =>
      `The request body on ${wherePhrase(c)} was removed. ` +
      'Clients that still send a body may be rejected or have it ignored.',
  },
  {
    ruleId: 'REQUEST_BODY_BECAME_REQUIRED',
    classification: COMPATIBILITY.BREAKING,
    applies: (c) =>
      c.changeType === 'REQUEST_BODY_REQUIREDNESS_CHANGED' &&
      c.after.required === true &&
      c.before.required !== true,
    reason: (c) =>
      `The request body on ${wherePhrase(c)} became required. Clients that call it without a body will be rejected.`,
  },
  {
    ruleId: 'REQUEST_BODY_BECAME_OPTIONAL',
    classification: COMPATIBILITY.NON_BREAKING,
    applies: (c) =>
      c.changeType === 'REQUEST_BODY_REQUIREDNESS_CHANGED' &&
      c.before.required === true &&
      c.after.required !== true,
    reason: (c) =>
      `The request body on ${wherePhrase(c)} became optional. Clients that do send a body are unaffected.`,
  },
  {
    ruleId: 'REQUEST_BODY_ADDED',
    classification: COMPATIBILITY.UNKNOWN,
    applies: (c) => c.changeType === 'REQUEST_BODY_ADDED',
    reason: (c) =>
      `A request body was added to ${wherePhrase(c)}. ` +
      'The initial rule set has no rule for adding a request body to an operation that previously had none; ' +
      'existing clients may not send a body, so manual review is recommended.',
  },
  {
    ruleId: 'REQUEST_CONTENT_TYPE_ADDED',
    classification: COMPATIBILITY.UNKNOWN,
    applies: (c) => c.changeType === 'REQUEST_CONTENT_TYPE_ADDED',
    reason: (c) =>
      `Content type "${c.after.contentType}" was added to the request body of ${wherePhrase(c)}. ` +
      'The initial rule set has no rule for request content type changes, so manual review is recommended.',
  },
  {
    ruleId: 'REQUEST_CONTENT_TYPE_REMOVED',
    classification: COMPATIBILITY.UNKNOWN,
    applies: (c) => c.changeType === 'REQUEST_CONTENT_TYPE_REMOVED',
    reason: (c) =>
      `Content type "${c.before.contentType}" was removed from the request body of ${wherePhrase(c)}. ` +
      'Clients that send that content type may no longer be accepted; ' +
      'the initial rule set has no rule for request content type changes, so manual review is recommended.',
  },

  // ------------------------------------------------------------------
  // Response status codes and content types
  // ------------------------------------------------------------------
  {
    ruleId: 'RESPONSE_STATUS_ADDED',
    classification: COMPATIBILITY.NON_BREAKING,
    applies: (c) => c.changeType === 'RESPONSE_STATUS_ADDED',
    reason: (c) =>
      `Response status ${statusOf(c)} was added to ${wherePhrase(c)}. ` +
      'Clients that handle the statuses they already know are unaffected.',
  },
  {
    ruleId: 'RESPONSE_STATUS_REMOVED',
    classification: COMPATIBILITY.UNKNOWN,
    applies: (c) => c.changeType === 'RESPONSE_STATUS_REMOVED',
    reason: (c) =>
      `Response status ${statusOf(c)} was removed from ${wherePhrase(c)}. ` +
      'Clients that handle or rely on this status may be affected; ' +
      'the initial rule set defaults removed status codes to UNKNOWN, so manual review is recommended.',
  },
  {
    ruleId: 'RESPONSE_CONTENT_TYPE_ADDED',
    classification: COMPATIBILITY.UNKNOWN,
    applies: (c) => c.changeType === 'RESPONSE_CONTENT_TYPE_ADDED',
    reason: (c) =>
      `Content type "${c.after.contentType}" was added to ${responsePhrase(c)}. ` +
      'Consumers may not handle the new representation; ' +
      'the initial rule set defaults added response content types to UNKNOWN, so manual review is recommended.',
  },
  {
    ruleId: 'RESPONSE_CONTENT_TYPE_REMOVED',
    classification: COMPATIBILITY.UNKNOWN,
    applies: (c) => c.changeType === 'RESPONSE_CONTENT_TYPE_REMOVED',
    reason: (c) =>
      `Content type "${c.before.contentType}" was removed from ${responsePhrase(c)}. ` +
      'Consumers that requested that representation may break; ' +
      'the initial rule set defaults removed response content types to UNKNOWN, so manual review is recommended.',
  },

  // ------------------------------------------------------------------
  // Request fields
  // ------------------------------------------------------------------
  {
    ruleId: 'REQUEST_FIELD_ADDED_REQUIRED',
    classification: COMPATIBILITY.BREAKING,
    applies: (c) => c.changeType === 'FIELD_ADDED' && c.location === 'request' && c.after?.required === true,
    reason: (c) =>
      `Required request field "${fieldLeaf(c.fieldPath)}" was added to ${wherePhrase(c)}. ` +
      'Existing clients that do not send it will be rejected.',
  },
  {
    ruleId: 'REQUEST_FIELD_ADDED_OPTIONAL',
    classification: COMPATIBILITY.NON_BREAKING,
    applies: (c) => c.changeType === 'FIELD_ADDED' && c.location === 'request' && c.after?.required !== true,
    reason: (c) =>
      `Optional request field "${fieldLeaf(c.fieldPath)}" was added to ${wherePhrase(c)}. ` +
      'Clients that do not send it are unaffected.',
  },
  {
    ruleId: 'REQUEST_FIELD_REMOVED',
    classification: COMPATIBILITY.BREAKING,
    applies: (c) => c.changeType === 'FIELD_REMOVED' && c.location === 'request',
    reason: (c) =>
      `Request field "${fieldLeaf(c.fieldPath)}" was removed from ${wherePhrase(c)}. ` +
      'Clients that still send it may be rejected or have it ignored.',
  },
  {
    ruleId: 'REQUEST_FIELD_TYPE_CHANGED',
    classification: COMPATIBILITY.BREAKING,
    applies: (c) => c.changeType === 'FIELD_TYPE_CHANGED' && c.location === 'request',
    reason: (c) =>
      `Request field "${fieldLeaf(c.fieldPath)}" on ${wherePhrase(c)} changed type from ` +
      `${typePhrase(c.before)} to ${typePhrase(c.after)}. ` +
      'Clients that send or parse the previous type may fail.',
  },
  {
    ruleId: 'REQUEST_FIELD_OPTIONAL_TO_REQUIRED',
    classification: COMPATIBILITY.BREAKING,
    applies: (c) =>
      c.changeType === 'FIELD_REQUIREDNESS_CHANGED' &&
      c.location === 'request' &&
      c.after.required === true &&
      c.before.required !== true,
    reason: (c) =>
      `Request field "${fieldLeaf(c.fieldPath)}" on ${wherePhrase(c)} became required. ` +
      'Existing clients that omit it will be rejected.',
  },
  {
    ruleId: 'REQUEST_FIELD_REQUIRED_TO_OPTIONAL',
    classification: COMPATIBILITY.NON_BREAKING,
    applies: (c) =>
      c.changeType === 'FIELD_REQUIREDNESS_CHANGED' &&
      c.location === 'request' &&
      c.before.required === true &&
      c.after.required !== true,
    reason: (c) =>
      `Request field "${fieldLeaf(c.fieldPath)}" on ${wherePhrase(c)} became optional. ` +
      'Clients that do send it are unaffected.',
  },
  {
    ruleId: 'REQUEST_ENUM_VALUES_REMOVED',
    classification: COMPATIBILITY.BREAKING,
    applies: (c) =>
      c.changeType === 'ENUM_CHANGED' && c.location === 'request' &&
      enumDiff(c.before?.enum, c.after?.enum).removed.length > 0,
    reason: (c) =>
      `Request enum field "${fieldLeaf(c.fieldPath)}" on ${wherePhrase(c)} no longer accepts ` +
      `value(s) ${valuesPhrase(enumDiff(c.before?.enum, c.after?.enum).removed)}. ` +
      'Clients that send those values will be rejected.',
  },
  {
    ruleId: 'REQUEST_ENUM_VALUES_ADDED',
    classification: COMPATIBILITY.NON_BREAKING,
    applies: (c) =>
      c.changeType === 'ENUM_CHANGED' && c.location === 'request' &&
      enumDiff(c.before?.enum, c.after?.enum).removed.length === 0 &&
      enumDiff(c.before?.enum, c.after?.enum).added.length > 0,
    reason: (c) =>
      `Request enum field "${fieldLeaf(c.fieldPath)}" on ${wherePhrase(c)} now accepts ` +
      `value(s) ${valuesPhrase(enumDiff(c.before?.enum, c.after?.enum).added)} in addition to the existing ones. ` +
      'Previously accepted requests are still accepted.',
  },

  // ------------------------------------------------------------------
  // Response fields
  // ------------------------------------------------------------------
  {
    ruleId: 'RESPONSE_FIELD_REMOVED',
    classification: COMPATIBILITY.BREAKING,
    applies: (c) => c.changeType === 'FIELD_REMOVED' && isResponseLocation(c.location),
    reason: (c) =>
      `Response field "${fieldLeaf(c.fieldPath)}" is no longer returned in ${responsePhrase(c)}. ` +
      'Consumers that read this field will no longer receive it.',
  },
  {
    ruleId: 'RESPONSE_FIELD_ADDED_OPTIONAL',
    classification: COMPATIBILITY.NON_BREAKING,
    applies: (c) =>
      c.changeType === 'FIELD_ADDED' && isResponseLocation(c.location) && c.after?.required !== true,
    reason: (c) =>
      `Optional response field "${fieldLeaf(c.fieldPath)}" was added to ${responsePhrase(c)}. ` +
      'Consumers that ignore unknown fields are unaffected.',
  },
  {
    ruleId: 'RESPONSE_FIELD_ADDED_REQUIRED',
    classification: COMPATIBILITY.UNKNOWN,
    applies: (c) => c.changeType === 'FIELD_ADDED' && isResponseLocation(c.location) && c.after?.required === true,
    reason: (c) =>
      `Required response field "${fieldLeaf(c.fieldPath)}" was added to ${responsePhrase(c)}. ` +
      'The schema alone does not establish that existing consumers can handle a new required member, ' +
      'so the initial rule set classifies this as UNKNOWN; manual review is recommended.',
  },
  {
    ruleId: 'RESPONSE_FIELD_TYPE_CHANGED',
    classification: COMPATIBILITY.BREAKING,
    applies: (c) => c.changeType === 'FIELD_TYPE_CHANGED' && isResponseLocation(c.location),
    reason: (c) =>
      `Response field "${fieldLeaf(c.fieldPath)}" in ${responsePhrase(c)} changed type from ` +
      `${typePhrase(c.before)} to ${typePhrase(c.after)}. ` +
      'Consumers that parse the previous type will fail.',
  },
  {
    ruleId: 'RESPONSE_FIELD_OPTIONAL_TO_REQUIRED',
    classification: COMPATIBILITY.UNKNOWN,
    applies: (c) =>
      c.changeType === 'FIELD_REQUIREDNESS_CHANGED' &&
      isResponseLocation(c.location) &&
      c.after.required === true &&
      c.before.required !== true,
    reason: (c) =>
      `Response field "${fieldLeaf(c.fieldPath)}" in ${responsePhrase(c)} became required. ` +
      'The initial rule set has no rule for response requiredness changes; consumers that read this field ' +
      'will now always receive it, so manual review is recommended.',
  },
  {
    ruleId: 'RESPONSE_FIELD_REQUIRED_TO_OPTIONAL',
    classification: COMPATIBILITY.UNKNOWN,
    applies: (c) =>
      c.changeType === 'FIELD_REQUIREDNESS_CHANGED' &&
      isResponseLocation(c.location) &&
      c.before.required === true &&
      c.after.required !== true,
    reason: (c) =>
      `Response field "${fieldLeaf(c.fieldPath)}" in ${responsePhrase(c)} became optional. ` +
      'The initial rule set has no rule for response requiredness changes; consumers that read this field ' +
      'may now receive undefined, so manual review is recommended.',
  },
  {
    ruleId: 'RESPONSE_ENUM_VALUES_REMOVED',
    classification: COMPATIBILITY.UNKNOWN,
    applies: (c) =>
      c.changeType === 'ENUM_CHANGED' && isResponseLocation(c.location) &&
      enumDiff(c.before?.enum, c.after?.enum).removed.length > 0,
    reason: (c) =>
      `Response enum field "${fieldLeaf(c.fieldPath)}" in ${responsePhrase(c)} no longer returns ` +
      `value(s) ${valuesPhrase(enumDiff(c.before?.enum, c.after?.enum).removed)}. ` +
      'Consumers that branch on these values may be affected; the initial rule set defaults response ' +
      'enum changes to UNKNOWN, so manual review is recommended.',
  },
  {
    ruleId: 'RESPONSE_ENUM_VALUES_ADDED',
    classification: COMPATIBILITY.UNKNOWN,
    applies: (c) =>
      c.changeType === 'ENUM_CHANGED' && isResponseLocation(c.location) &&
      enumDiff(c.before?.enum, c.after?.enum).removed.length === 0 &&
      enumDiff(c.before?.enum, c.after?.enum).added.length > 0,
    reason: (c) =>
      `Response enum field "${fieldLeaf(c.fieldPath)}" in ${responsePhrase(c)} may now return ` +
      `value(s) ${valuesPhrase(enumDiff(c.before?.enum, c.after?.enum).added)}. ` +
      'Consumers with exhaustive handling may encounter values they do not expect; the initial rule set ' +
      'defaults response enum changes to UNKNOWN, so manual review is recommended.',
  },

  // ------------------------------------------------------------------
  // Conservative fallbacks (no rule in the initial set -> UNKNOWN)
  // ------------------------------------------------------------------
  {
    ruleId: 'NULLABLE_CHANGED',
    classification: COMPATIBILITY.UNKNOWN,
    applies: (c) => c.changeType === 'NULLABLE_CHANGED',
    reason: (c) =>
      `Field "${fieldLeaf(c.fieldPath)}" on ${wherePhrase(c)} changed from ` +
      `${c.before.nullable ? 'nullable' : 'non-nullable'} to ${c.after.nullable ? 'nullable' : 'non-nullable'}. ` +
      'The initial rule set has no rule for nullability changes; consumers may not expect null, ' +
      'so manual review is recommended.',
  },
  {
    ruleId: 'CONSTRAINT_CHANGED',
    classification: COMPATIBILITY.UNKNOWN,
    applies: (c) => c.changeType === 'CONSTRAINT_CHANGED',
    reason: (c) => {
      const key = Object.keys(c.before ?? {})[0];
      return (
        `Field "${fieldLeaf(c.fieldPath)}" on ${wherePhrase(c)} changed constraint "${key}" from ` +
        `${JSON.stringify(c.before?.[key])} to ${JSON.stringify(c.after?.[key])}. ` +
        'The initial rule set has no rule for constraint changes, so manual review is recommended.'
      );
    },
  },
];

export default RULES;
