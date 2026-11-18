// Import mechanism for the starter-kit consumer declarations.
//
// The starter kit ships hand-written YAML declaration files (read-only
// inputs, never modified). This module locates them, parses them, and hands
// them to the consumer service layer, which upserts services and
// dependencies and reports per-declaration validation results.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as loadYaml } from 'js-yaml';
import { parseConsumerDeclaration } from './consumer-declarations.js';
import { importDeclarations } from './consumer.service.js';

// The declaration files live in <repo-root>/consumers, three levels above
// this file (backend/src/services -> backend -> repo root).
export function defaultDeclarationsDir() {
  return path.resolve(fileURLToPath(new URL('../../../consumers', import.meta.url)));
}

/**
 * Load and parse every *.yaml consumer declaration in a directory.
 *
 * @returns {Array<{ file: string, ok: boolean, declaration?: object,
 *                   errors?: Array<{field, message}> }>}
 */
export function loadDeclarationsFromDir(dir = defaultDeclarationsDir()) {
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (err) {
    throw new Error(`Could not read consumer declarations directory "${dir}": ${err.message}`);
  }

  const results = [];
  for (const file of entries.sort()) {
    if (!file.endsWith('.yaml') && !file.endsWith('.yml')) continue;
    const filePath = path.join(dir, file);
    let document;
    try {
      document = loadYaml(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
      results.push({
        file,
        ok: false,
        errors: [{ field: file, message: `YAML parse error: ${err.message.split('\n')[0]}` }],
      });
      continue;
    }
    const parsed = parseConsumerDeclaration(document, file);
    if (!parsed.ok) {
      results.push({ file, ok: false, errors: parsed.errors });
      continue;
    }
    results.push({ file, ok: true, declaration: { ...parsed.declaration, source: file } });
  }
  return results;
}

/**
 * Import all starter-kit declarations from disk. Malformed files are
 * reported in the result without aborting the import of the others.
 */
export async function importStarterKitDeclarations(dir = defaultDeclarationsDir()) {
  const loaded = loadDeclarationsFromDir(dir);

  const report = {
    source: 'starter-kit',
    declarationsProcessed: loaded.length,
    consumersCreated: 0,
    consumersExisting: 0,
    dependenciesUpserted: 0,
    unresolvedProviders: [],
    declarations: [],
  };

  const valid = [];
  for (const result of loaded) {
    if (result.ok) {
      valid.push(result.declaration);
    } else {
      report.declarations.push({
        source: result.file,
        consumer: null,
        team: null,
        consumerServiceId: null,
        status: 'parse_error',
        errors: result.errors,
        uses: [],
      });
    }
  }

  if (valid.length > 0) {
    const imported = await importDeclarations(valid, { source: 'starter-kit' });
    report.consumersCreated = imported.consumersCreated;
    report.consumersExisting = imported.consumersExisting;
    report.dependenciesUpserted = imported.dependenciesUpserted;
    report.unresolvedProviders = imported.unresolvedProviders;
    report.declarations.push(...imported.declarations);
  }

  // Deterministic order by source.
  report.declarations.sort((a, b) => String(a.source ?? '').localeCompare(String(b.source ?? '')));
  return report;
}
