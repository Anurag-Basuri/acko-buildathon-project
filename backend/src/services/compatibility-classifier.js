// Compatibility Classification — deterministic, rule-based engine.
//
// Pure module — no database, no Express, no LLM. Takes the structural change
// list produced by spec-comparator and classifies each change as
// BREAKING / NON_BREAKING / UNKNOWN.
//
// The classifier itself contains no policy: it walks the ordered rule list
// in compatibility-rules (the initial, product-owner-proposed rule set) and
// uses the first applicable rule. A change that matches no rule is
// classified UNKNOWN with ruleId "NO_RULE" — never silently NON_BREAKING.
// The same input always produces the same output.
//
// Each classified change preserves the original comparator fields and adds:
//   classification  BREAKING | NON_BREAKING | UNKNOWN
//   ruleId          machine-readable identifier of the rule that matched
//   reason          plain-language, change-specific explanation
//
// All rules are deterministic, so no separate confidence value is emitted:
// every rule that matches is the rule that applies, and UNKNOWN results
// always carry a reason that names the gap and recommends manual review.

import { RULES, COMPATIBILITY, wherePhrase } from './compatibility-rules.js';

/**
 * Classify one structural change.
 *
 * @param {object} change a change produced by spec-comparator
 * @returns {{ classification: string, ruleId: string, reason: string }}
 */
export function classifyChange(change) {
  for (const rule of RULES) {
    if (rule.applies(change)) {
      return {
        classification: rule.classification,
        ruleId: rule.ruleId,
        reason: rule.reason(change),
      };
    }
  }

  // No rule in the initial rule set covers this change type. The system
  // cannot determine compatibility with confidence, so the result is
  // UNKNOWN — never NON_BREAKING — and the reason says exactly why.
  return {
    classification: COMPATIBILITY.UNKNOWN,
    ruleId: 'NO_RULE',
    reason:
      `Change type ${change.changeType} on ${wherePhrase(change)} has no rule in the initial rule set. ` +
      'The system cannot determine compatibility with confidence, so the change is ' +
      'classified UNKNOWN; manual review is required.',
  };
}

/**
 * Classify every change in a comparator output and count the results.
 *
 * @param {object[]} changes  output of spec-comparator
 * @returns {{
 *   changes: Array<object & { classification: string, ruleId: string, reason: string }>,
 *   counts: { total: number, breaking: number, nonBreaking: number, unknown: number },
 * }}
 */
export function classifyChanges(changes) {
  const classified = changes.map((change) => ({
    ...change,
    ...classifyChange(change),
  }));

  const counts = { total: classified.length, breaking: 0, nonBreaking: 0, unknown: 0 };
  for (const change of classified) {
    if (change.classification === COMPATIBILITY.BREAKING) counts.breaking += 1;
    else if (change.classification === COMPATIBILITY.NON_BREAKING) counts.nonBreaking += 1;
    else counts.unknown += 1;
  }

  return { changes: classified, counts };
}

export { COMPATIBILITY };
export default classifyChanges;
