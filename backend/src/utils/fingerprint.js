// Stable content fingerprints for analysis freshness checks.
// Pure module — no I/O.

import { createHash } from 'node:crypto';

/**
 * SHA-256 over the current consumer dependency rows of a provider service.
 * The input shape is the prisma ConsumerDependency row list (any subset of
 * fields is fine as long as the same fields are always passed).
 *
 * The canonical form is a sorted list of [consumer, method, path, sorted
 * sends, sorted reads] tuples, so the fingerprint is insensitive to row
 * order and to the order of sends/reads within a row.
 */
export function dependencyFingerprint(dependencies) {
  const canonical = dependencies
    .map((dependency) => [
      dependency.consumerServiceId,
      dependency.method,
      dependency.path,
      [...(dependency.sends ?? [])].sort(),
      [...(dependency.reads ?? [])].sort(),
    ])
    .sort((a, b) => {
      const keyA = JSON.stringify(a);
      const keyB = JSON.stringify(b);
      return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
    });
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/**
 * SHA-256 of a specification version's originalContent.
 */
export function contentHash(content) {
  return createHash('sha256').update(content).digest('hex');
}
