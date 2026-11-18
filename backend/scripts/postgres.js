// Local development Postgres (dev-only tooling).
//
// Runs a real PostgreSQL on this machine using the embedded-postgres package,
// so no system install or container runtime is required. Data lives in
// .embedded-pg/data (git-ignored) and is disposable: delete the folder to
// reset the dev databases.
//
// Usage:
//   npm run db:up        start on port 5432 and keep running (Ctrl+C to stop)
//   PG_PORT=5543 npm run db:up   start on another port
//
// The test suite manages its own throwaway instance on a separate port;
// this script exists for interactive development (migrations, studio, dev server).

import path from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';

const port = Number.parseInt(process.env.PG_PORT || '5432', 10);
const user = 'contractguard';
const password = 'contractguard';

const here = path.dirname(fileURLToPath(import.meta.url));
const databaseDir = path.join(here, '..', '.embedded-pg', 'data');

const pg = new EmbeddedPostgres({
  databaseDir,
  user,
  password,
  port,
  persistent: true,
  autoRehydrateSymlinks: true,
  // Force a UTF-8 cluster regardless of the host machine's locale
  // (specs and consumer declarations may contain non-ASCII text).
  initdbFlags: ['--locale=C', '--encoding=UTF8'],
});

// A cluster from a previous run is reused; initdb only runs on a fresh dir.
const hasExistingCluster =
  existsSync(databaseDir) && readdirSync(databaseDir).length > 0;

try {
  if (!hasExistingCluster) {
    await pg.initialise();
  }
  await pg.start();
} catch (err) {
  console.error('[db] failed to start embedded postgres:', err.message);
  if (hasExistingCluster) {
    console.error(
      '[db] the existing cluster may be corrupted — delete .embedded-pg/data and retry.'
    );
  }
  process.exit(1);
}

async function createDatabaseIfMissing(name) {
  try {
    await pg.createDatabase(name);
  } catch (err) {
    if (!/already exists/i.test(String(err.message ?? err))) throw err;
  }
}

await createDatabaseIfMissing('contractguard');
await createDatabaseIfMissing('contractguard_test');

console.log(`[db] embedded postgres listening on 127.0.0.1:${port}`);
console.log(
  `[db] DATABASE_URL=postgresql://${user}:${password}@127.0.0.1:${port}/contractguard`
);

let stopping = false;
async function stop(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`[db] ${signal} received, stopping embedded postgres...`);
  await pg.stop();
  process.exit(0);
}

process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
