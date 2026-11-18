// Consumer Impact Analysis — deterministic, explainable engine.
//
// Pure module — no database access, no LLM. Given the classified structural
// changes of a baseline -> proposed jump and the registered consumer
// dependencies of the provider, it decides which registered consumers are
// affected and why.
//
// Matching rules:
//   - Operation matching: method must be equal (an ENDPOINT_REMOVED change
//     has no method, so it touches every method on that path). Path
//     templates are matched positionally (canonicalPath), so
//     /quotes/{id} and /quotes/{quoteId} are the same operation.
//   - Direction: request-side changes are compared against a consumer's
//     `sends`; response-side changes against its `reads`.
//   - Field matching is token-aware (segments split on ".", "[]" array
//     markers stripped) and uses segment-wise prefix comparison in BOTH
//     directions: removing a parent object affects consumers using nested
//     descendants, and consumers reading a whole object are affected by
//     nested changes. "customer.name" never matches "customer.nameSuffix".
//   - Changes that introduce a REQUIREMENT (new required request field,
//     new required parameter, parameter/field becoming required) affect
//     consumers that do NOT declare that field — the inverse of the
//     usual "declared field changed" rule.
//   - Operation-level changes (endpoint removed, method removed, request
//     body removed, required body/parameter introduced, 2xx response
//     status removed) affect all registered consumers of that operation
//     where the declaration makes the operation unusable.
//
// A consumer with no matching declared dependency is NOT declared safe —
// the registry may not capture every real-world usage. That distinction is
// carried in the summary (`noMatchingDeclaration`).
//
// Findings are deterministic: one finding per (dependency, change) pair,
// never duplicated, each carrying the matched declared field paths and a
// plain-language, consumer-specific reason.

import { canonicalPath } from './spec-normalizer.js';
import { fieldPathMatches, tokenizeFieldPath } from './dependency-validator.js';

// Change types that make a request-side (or parameter) field dangerous for
// consumers that send the field.
const REQUEST_FIELD_BREAKING = new Set([
  'FIELD_REMOVED',
  'FIELD_TYPE_CHANGED',
  'ENUM_CHANGED',
  'NULLABLE_CHANGED',
  'CONSTRAINT_CHANGED',
]);
const RESPONSE_FIELD_BREAKING = new Set([
  'FIELD_REMOVED',
  'FIELD_TYPE_CHANGED',
  'ENUM_CHANGED',
  'NULLABLE_CHANGED',
  'CONSTRAINT_CHANGED',
]);
const PARAMETER_BREAKING = new Set([
  'PARAMETER_REMOVED',
  'PARAMETER_RENAMED',
  'PARAMETER_TYPE_CHANGED',
  'PARAMETER_ENUM_CHANGED',
]);

function notAffected() {
  return { affected: false, direction: null, matchedFields: [], detail: null };
}

// ---------------------------------------------------------------------------
// Change context: which side, which field (if any), which status
// ---------------------------------------------------------------------------

/**
 * Resolve where a change lives:
 *   side    'request' | 'response' | 'operation'
 *   kind    'field' (one schema field) | 'parameter' | 'operation'
 *   relative  schema-relative field path (e.g. "quote.premium"), or the
 *             parameter name for parameters, null for operation-level
 *   status  response status when the change names one (e.g. "200")
 */
export function fieldContext(change) {
  const fp = typeof change.fieldPath === 'string' ? change.fieldPath : null;

  if (change.location === 'parameter' || (fp && fp.startsWith('parameters.'))) {
    return {
      side: 'request',
      kind: 'parameter',
      relative: fp ? fp.slice('parameters.'.length) : null,
      status: null,
    };
  }
  if (change.location === 'requestBody') {
    return { side: 'request', kind: 'operation', relative: null, status: null };
  }
  if (change.location === 'request' || (fp && fp.startsWith('request'))) {
    let relative = null;
    if (fp && fp.startsWith('request.')) relative = fp.slice('request.'.length);
    // "request[<contentType>]" content-type changes stay operation-level.
    return { side: 'request', kind: relative ? 'field' : 'operation', relative, status: null };
  }
  if (typeof change.location === 'string' && change.location.startsWith('response.')) {
    const status = change.location.slice('response.'.length);
    const is2xx = status.startsWith('2');
    if (!fp) {
      return { side: 'response', kind: 'operation', relative: null, status, is2xx };
    }
    if (fp.startsWith('response.')) {
      let rest = fp.slice('response.'.length);
      const match = rest.match(/^[^\.\[]+?(?:\[[^\]]+\])?/);
      if (match) rest = rest.slice(match[0].length).replace(/^\./, '');
      return {
        side: 'response',
        kind: rest ? 'field' : 'operation',
        relative: rest || null,
        status,
        is2xx,
      };
    }
  }
  return { side: 'operation', kind: 'operation', relative: null, status: null, is2xx: false };
}

// ---------------------------------------------------------------------------
// Operation matching
// ---------------------------------------------------------------------------

/**
 * Does a dependency declaration target the operation a change touches?
 */
export function dependencyMatchesOperation(dependency, change) {
  const sameTemplate = canonicalPath(dependency.path) === canonicalPath(change.path);
  if (!sameTemplate) return false;
  return change.method === null || dependency.method === change.method;
}

// ---------------------------------------------------------------------------
// Impact rules
// ---------------------------------------------------------------------------

function allConsumersAffected(detail) {
  return { affected: true, direction: 'OPERATION', matchedFields: [], detail };
}

function operationLevelAffects(dependency, change, ctx) {
  const sends = dependency.sends ?? [];
  const reads = dependency.reads ?? [];

  switch (change.changeType) {
    case 'ENDPOINT_REMOVED':
      return allConsumersAffected(
        `the endpoint ${change.path} no longer exists in the proposed version`
      );
    case 'METHOD_REMOVED':
      return allConsumersAffected(
        `the ${change.method} method on ${change.path} was removed`
      );
    case 'REQUEST_BODY_REMOVED':
      return sends.length > 0
        ? {
            affected: true,
            direction: 'SENDS',
            matchedFields: [...sends],
            detail:
              'the request body was removed, so the declared request fields can no longer be sent',
          }
        : notAffected();
    case 'REQUEST_BODY_ADDED':
      return change.after?.required === true
        ? allConsumersAffected('a required request body was added to this operation')
        : notAffected();
    case 'REQUEST_BODY_REQUIREDNESS_CHANGED':
      return change.after?.required === true
        ? allConsumersAffected('the request body became required for this operation')
        : notAffected();
    case 'PARAMETER_ADDED':
      return change.after?.required === true
        ? allConsumersAffected(
            `required parameter "${change.after.name}" was added to this operation`
          )
        : notAffected();
    case 'PARAMETER_REQUIREDNESS_CHANGED':
      return change.after?.required === true
        ? allConsumersAffected(
            `parameter "${ctx.relative ?? change.fieldPath}" became required for this operation`
          )
        : notAffected();
    case 'RESPONSE_STATUS_REMOVED':
      return ctx.is2xx && reads.length > 0
        ? {
            affected: true,
            direction: 'READS',
            matchedFields: [...reads],
            detail: `response status ${ctx.status} was removed from this operation`,
          }
        : notAffected();
    case 'RESPONSE_CONTENT_TYPE_REMOVED':
      return ctx.is2xx && reads.length > 0
        ? {
            affected: true,
            direction: 'READS',
            matchedFields: [...reads],
            detail: `a successful response content type was removed from this operation`,
          }
        : notAffected();
    case 'REQUEST_CONTENT_TYPE_REMOVED':
      return sends.length > 0
        ? {
            affected: true,
            direction: 'SENDS',
            matchedFields: [...sends],
            detail: 'a request content type was removed from this operation',
          }
        : notAffected();
    default:
      // Additive operation-level changes (ENDPOINT_ADDED, METHOD_ADDED,
      // RESPONSE_STATUS_ADDED, RESPONSE_CONTENT_TYPE_ADDED,
      // REQUEST_CONTENT_TYPE_ADDED, OPERATION_ID_CHANGED) do not affect
      // existing consumers.
      return notAffected();
  }
}

/**
 * Does this change type, on this side, have the potential to break a
 * consumer that declares the affected field?
 */
function isPotentiallyBreaking(change, ctx) {
  const { changeType } = change;
  if (ctx.kind === 'parameter') {
    if (PARAMETER_BREAKING.has(changeType)) return true;
    if (
      changeType === 'PARAMETER_ADDED' ||
      changeType === 'PARAMETER_REQUIREDNESS_CHANGED'
    ) {
      return change.after?.required === true;
    }
    return false;
  }
  if (ctx.side === 'request') {
    if (REQUEST_FIELD_BREAKING.has(changeType)) return true;
    if (changeType === 'FIELD_ADDED') return change.after?.required === true;
    if (changeType === 'FIELD_REQUIREDNESS_CHANGED') return change.after?.required === true;
    return false;
  }
  if (RESPONSE_FIELD_BREAKING.has(changeType)) return true;
  // Response requiredness: becoming optional may remove a value readers
  // rely on; becoming required can only add a guarantee.
  if (changeType === 'FIELD_REQUIREDNESS_CHANGED') return change.after?.required === false;
  return false;
}

// "Introducing a requirement" changes affect consumers that do NOT declare
// the field, the inverse of the usual matching.
function isIntroducingRequirement(change, ctx) {
  if (ctx.kind === 'parameter') {
    if (
      change.changeType === 'PARAMETER_ADDED' ||
      change.changeType === 'PARAMETER_REQUIREDNESS_CHANGED'
    ) {
      return change.after?.required === true;
    }
    return false;
  }
  if (ctx.side !== 'request') return false;
  if (change.changeType === 'FIELD_ADDED') return change.after?.required === true;
  if (change.changeType === 'FIELD_REQUIREDNESS_CHANGED') return change.after?.required === true;
  return false;
}

function fieldLevelAffects(dependency, change, ctx) {
  const direction = ctx.side === 'request' ? 'SENDS' : 'READS';
  const declared = direction === 'SENDS' ? dependency.sends ?? [] : dependency.reads ?? [];
  const matched = declared.filter((field) => fieldPathMatches(field, ctx.relative));

  if (isIntroducingRequirement(change, ctx)) {
    return matched.length === 0
      ? {
          affected: true,
          direction,
          matchedFields: [],
          detail: `the proposed version makes ${ctx.relative} required, and this consumer does not declare that it sends it`,
        }
      : notAffected();
  }

  if (!isPotentiallyBreaking(change, ctx)) return notAffected();
  if (matched.length === 0) return notAffected();
  return { affected: true, direction, matchedFields: matched, detail: null };
}

// ---------------------------------------------------------------------------
// Reasons (plain-language, consumer-specific)
// ---------------------------------------------------------------------------

function operationPhrase(change) {
  return change.method ? `${change.method} ${change.path}` : `endpoint ${change.path}`;
}

function buildReason(consumerName, dependency, change, ctx, result) {
  const op = `${dependency.method} ${dependency.path}`;

  if (result.detail !== null && result.detail !== undefined) {
    // Operation-level detail, or requirement introduction.
    return `${consumerName} declares that it calls ${op}; ${result.detail} in the proposed version.`;
  }

  const matched = result.matchedFields;
  const declared = matched[0];
  const changed = ctx.relative;
  const sidePhrase = ctx.side === 'request' ? 'sends' : 'reads';
  const verb =
    change.changeType === 'FIELD_REMOVED' || change.changeType === 'PARAMETER_REMOVED'
      ? 'removes'
      : 'changes';

  if (ctx.kind === 'parameter' && change.changeType === 'PARAMETER_RENAMED') {
    const from = change.before?.name ?? ctx.relative;
    const to = change.after?.name ?? 'the new name';
    return `${consumerName} sends parameter "${from}" with ${op}, but the proposed version renames it to "${to}".`;
  }

  if (ctx.kind === 'parameter') {
    return `${consumerName} declares that it sends ${sidePhrase} parameter "${declared}" with ${op}, but the proposed version ${verb} it.`;
  }

  // Field changes: which direction of the prefix relationship holds?
  const declaredTokens = tokenizeFieldPath(declared);
  const changedTokens = tokenizeFieldPath(changed);
  if (declaredTokens.length > changedTokens.length) {
    // The changed field is a parent of the declared field.
    return `${consumerName} declares that it ${sidePhrase} ${declared}, but the proposed version ${verb} its parent field ${changed} on ${operationPhrase(change)}.`;
  }
  if (declaredTokens.length < changedTokens.length) {
    // The changed field is nested inside the declared field.
    return `${consumerName} declares that it ${sidePhrase} ${declared}, which includes the changed field ${changed} on ${operationPhrase(change)}.`;
  }
  return `${consumerName} declares that it ${sidePhrase} ${declared}, but the proposed version ${verb} this field on ${operationPhrase(change)}.`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Analyze impact of classified changes on registered consumer dependencies.
 *
 * @param {{
 *   changes: object[],            // classified comparator changes
 *   dependencies: Array<{         // ConsumerDependency rows
 *     id: string,
 *     consumerServiceId: string,
 *     method: string,
 *     path: string,
 *     sends: string[],
 *     reads: string[],
 *     consumer: { id: string, name: string },
 *   }>,
 *   provider: { id: string, name: string },
 *   proposedVersionId: string,
 *   baselineVersionId: string,
 * }} input
 * @returns {{ summary: object, findings: object[] }}
 */
export function analyzeImpact({
  changes,
  dependencies,
  provider,
  proposedVersionId,
  baselineVersionId,
}) {
  const findings = [];
  const affectedChangeIndexes = new Set();

  const consumersDeclaringAffectedOps = new Map(); // consumerId -> { consumer, operations:Set, dependencies:Set }
  const registeredConsumers = new Map(); // consumerId -> { id, name }

  for (const dependency of dependencies) {
    registeredConsumers.set(dependency.consumerServiceId, {
      id: dependency.consumerServiceId,
      name: dependency.consumer.name,
    });
  }

  changes.forEach((change, changeIndex) => {
    for (const dependency of dependencies) {
      if (!dependencyMatchesOperation(dependency, change)) continue;

      // This consumer declares an operation the change touches.
      const tracked = consumersDeclaringAffectedOps.get(dependency.consumerServiceId) ?? {
        consumer: { id: dependency.consumerServiceId, name: dependency.consumer.name },
        operations: new Set(),
      };
      tracked.operations.add(`${dependency.method} ${dependency.path}`);
      consumersDeclaringAffectedOps.set(dependency.consumerServiceId, tracked);

      const ctx = fieldContext(change);
      const result =
        ctx.kind === 'operation'
          ? operationLevelAffects(dependency, change, ctx)
          : fieldLevelAffects(dependency, change, ctx);
      if (!result.affected) continue;

      affectedChangeIndexes.add(changeIndex);
      findings.push({
        id: `${dependency.id}::change-${changeIndex}`,
        changeIndex,
        consumer: { id: dependency.consumerServiceId, name: dependency.consumer.name },
        provider: { id: provider.id, name: provider.name },
        operation: { method: dependency.method, path: dependency.path },
        change: {
          changeIndex,
          changeType: change.changeType,
          method: change.method ?? null,
          path: change.path,
          fieldPath: typeof change.fieldPath === 'string' ? change.fieldPath : null,
          classification: change.classification,
          ruleId: change.ruleId,
          description: change.description,
        },
        dependency: {
          id: dependency.id,
          direction: result.direction,
          declaredFieldPath: result.matchedFields[0] ?? null,
          matchedDeclaredFields: result.matchedFields,
        },
        reason: buildReason(dependency.consumer.name, dependency, change, ctx, result),
      });
    }
  });

  // Deterministic finding order: by change index, then dependency id.
  findings.sort((a, b) =>
    a.changeIndex === b.changeIndex
      ? a.dependency.id < b.dependency.id
        ? -1
        : a.dependency.id > b.dependency.id
          ? 1
          : 0
      : a.changeIndex - b.changeIndex
  );

  const affectedConsumers = new Map();
  const affectedDependencies = new Set();
  for (const finding of findings) {
    const entry = affectedConsumers.get(finding.consumer.id) ?? {
      id: finding.consumer.id,
      name: finding.consumer.name,
      findingCount: 0,
      operations: new Set(),
    };
    entry.findingCount += 1;
    entry.operations.add(`${finding.operation.method} ${finding.operation.path}`);
    affectedConsumers.set(finding.consumer.id, entry);
    affectedDependencies.add(finding.dependency.id);
  }

  const noMatching = [...registeredConsumers.values()]
    .filter((consumer) => !consumersDeclaringAffectedOps.has(consumer.id))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const summary = {
    providerServiceId: provider.id,
    providerServiceName: provider.name,
    proposedVersionId,
    baselineVersionId,
    basedOn: 'registered consumer declarations',
    registeredConsumerCount: registeredConsumers.size,
    consumersDeclaringAffectedOperations: consumersDeclaringAffectedOps.size,
    affectedConsumerCount: affectedConsumers.size,
    affectedDependencyCount: affectedDependencies.size,
    affectedChangeCount: affectedChangeIndexes.size,
    affectedConsumers: [...affectedConsumers.values()]
      .map((entry) => ({
        id: entry.id,
        name: entry.name,
        findingCount: entry.findingCount,
        operations: [...entry.operations].sort(),
      }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    noMatchingDeclaration: {
      consumers: noMatching,
      note:
        'These registered consumers of the provider do not declare any affected operation. ' +
        'A missing declaration is NOT proof of safety: the registry may not capture every real-world usage.',
    },
  };

  return { summary, findings };
}

export default analyzeImpact;
