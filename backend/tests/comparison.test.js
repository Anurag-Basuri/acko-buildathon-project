// Comparison engine integration tests (GET /api/specs/diff).
//
// Brings up a throwaway embedded Postgres on a dedicated port (55434, so it
// never collides with the dev instance on 5432, the services tests on
// 55432, or the specs tests on 55433 — test files run concurrently), applies
// the real migrations, and exercises the HTTP API against it.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync, rmSync } from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import { killOrphanedEmbeddedPostgres } from './helpers/postgres-cleanup.js';

const execFileAsync = promisify(execFile);

const TEST_PORT = 55434;
const TEST_USER = 'contractguard';
const TEST_PASSWORD = 'contractguard';
const TEST_DB = 'contractguard_test_comparison';
const testDatabaseUrl = `postgresql://${TEST_USER}:${TEST_PASSWORD}@127.0.0.1:${TEST_PORT}/${TEST_DB}`;

const backendDir = fileURLToPath(new URL('..', import.meta.url));
const testDataDir = path.join(backendDir, '.embedded-pg', 'test-data-comparison');
const prismaCli = path.join(backendDir, 'node_modules', 'prisma', 'build', 'index.js');

// The starter-kit fixtures are read-only inputs: read them, never modify.
const readSpec = (p) =>
  readFileSync(fileURLToPath(new URL(`../../specs/${p}`, import.meta.url)), 'utf8');

const policySpecs = [
  readSpec('policy-api/1-initial.yaml'),
  readSpec('policy-api/2-deprecations.yaml'),
  readSpec('policy-api/3-remove-old-fields.yaml'),
  readSpec('policy-api/4-endorsement-rules.yaml'),
];
const quoteSpecs = [
  readSpec('quote-api/1-initial.yaml'),
  readSpec('quote-api/2-reorganised.yaml'),
  readSpec('quote-api/3-price-lines.yaml'),
  readSpec('quote-api/4-ncb-and-taxes.yaml'),
];

let pg;
let server;
let baseUrl;
let prisma;
let app;

let policyService;
let quoteService;
const policyVersions = [];
const quoteVersions = [];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Windows: taskkill /t can leave postgres "io_worker" fork-children behind,
// and those hold file handles inside the test data directory, which makes the
// next run's wipe fail. Kill anything still referencing it first.
function killStrayTestPostgres() {
  if (process.platform !== 'win32') return;
  try {
    const script =
      "Get-CimInstance Win32_Process -Filter \"Name='postgres.exe'\" |" +
      ` Where-Object { $_.CommandLine -match [regex]::Escape('${testDataDir}') } |` +
      ' Select-Object -ExpandProperty ProcessId';
    const out = execFileSync('powershell', ['-NoProfile', '-Command', script], {
      encoding: 'utf8',
    });
    for (const pid of out.trim().split(/\s+/).filter(Boolean)) {
      execFileSync('taskkill', ['/PID', pid, '/F']);
    }
  } catch {
    // best effort — resetTestDataDir below surfaces a real problem
  }
}

async function resetTestDataDir() {
  killStrayTestPostgres();
  for (let attempt = 0; ; attempt += 1) {
    try {
      rmSync(testDataDir, { recursive: true, force: true });
      return;
    } catch (err) {
      if (attempt >= 4) {
        throw new Error(
          `Could not reset test database directory ${testDataDir}: ${err.message}`
        );
      }
      await sleep(250);
    }
  }
}

before(async () => {
  // 1. Throwaway Postgres instance. The test cluster is disposable:
  //    wipe it so initdb always starts from an empty directory.
  await resetTestDataDir();
  pg = new EmbeddedPostgres({
    databaseDir: testDataDir,
    user: TEST_USER,
    password: TEST_PASSWORD,
    port: TEST_PORT,
    // persistent: true keeps stop() from deleting the data directory while
    // Windows "io_worker" fork-children may still hold file handles there.
    persistent: true,
    autoRehydrateSymlinks: true,
    initdbFlags: ['--locale=C', '--encoding=UTF8'],
    onLog: () => {},
    onError: (message) => console.error('[embedded-postgres]', message),
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase(TEST_DB);

  // 2. Apply the real migrations to the test database.
  await execFileAsync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
    cwd: backendDir,
    env: { ...process.env, DATABASE_URL: testDatabaseUrl },
  });

  // 3. Boot the app pointed at the test database.
  process.env.DATABASE_URL = testDatabaseUrl;
  ({ default: app } = await import('../src/app.js'));
  ({ default: prisma } = await import('../src/database/prisma.js'));

  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  // 4. Start from a clean database (child table first).
  await prisma.apiVersion.deleteMany();
  await prisma.service.deleteMany();

  // 5. Seed two services, each with the full fixture version history.
  const policyCreated = await postJson('/api/services', {
    name: 'policy-api',
    owner: 'Policy Team',
    description: 'Manages insurance policies',
  });
  assert.equal(policyCreated.status, 201);
  policyService = policyCreated.body.data;

  const quoteCreated = await postJson('/api/services', {
    name: 'quote-api',
    owner: 'Quotes Team',
    description: 'Bike insurance quotes',
  });
  assert.equal(quoteCreated.status, 201);
  quoteService = quoteCreated.body.data;

  for (let i = 0; i < policySpecs.length; i += 1) {
    const uploaded = await postJson('/api/specs/upload', {
      serviceId: policyService.id,
      versionLabel: `v${i + 1}`,
      content: policySpecs[i],
    });
    assert.equal(uploaded.status, 201, uploaded.body);
    policyVersions.push(uploaded.body.data);
  }
  for (let i = 0; i < quoteSpecs.length; i += 1) {
    const uploaded = await postJson('/api/specs/upload', {
      serviceId: quoteService.id,
      versionLabel: `v${i + 1}`,
      content: quoteSpecs[i],
    });
    assert.equal(uploaded.status, 201, uploaded.body);
    quoteVersions.push(uploaded.body.data);
  }
});

after(async () => {
  // Time-bounded, self-diagnosing teardown. Every step gets a hard deadline;
  // if one stalls, the hook names it and forces an exit so a stuck child
  // process can never hang the whole `node --test` run.
  let teardownFailed = false;
  const withDeadline = (label, promise, ms) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        }
      );
    });
  try {
    if (server) {
      // closeAllConnections drops undici keep-alive sockets, which would
      // otherwise keep server.close() waiting forever.
      server.closeAllConnections();
      await withDeadline('server.close', new Promise((resolve) => server.close(resolve)), 10_000);
    }
    if (prisma) await withDeadline('prisma.$disconnect', prisma.$disconnect(), 10_000);
    if (pg) await withDeadline('pg.stop', pg.stop(), 20_000);
    if (pg) {
      // Windows: taskkill can leave postgres forkchild workers behind; the
      // orphans hold the stdio pipes and keep this process alive.
      killOrphanedEmbeddedPostgres();
    }
    console.error('[comparison.test] teardown complete');
  } catch (err) {
    teardownFailed = true;
    console.error('[comparison.test] teardown error:', err.message);
  }
  if (teardownFailed) process.exit(1);
});

async function postJson(path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function get(path) {
  const res = await fetch(`${baseUrl}${path}`);
  return { status: res.status, body: await res.json() };
}

function diffPath(fromId, toId) {
  return `/api/specs/diff?fromVersionId=${fromId}&toVersionId=${toId}`;
}

// --- Validation and error handling --------------------------------------------

test('diff: returns 400 when a version id is missing', async () => {
  const { status, body } = await get(`/api/specs/diff?fromVersionId=${policyVersions[0].id}`);
  assert.equal(status, 400);
  assert.equal(body.success, false);
  assert.equal(body.error.code, 'VALIDATION_ERROR');
  assert.ok(body.error.details.some((d) => d.field === 'toVersionId'));
});

test('diff: returns 400 for malformed UUIDs', async () => {
  const { status, body } = await get(
    '/api/specs/diff?fromVersionId=not-a-uuid&toVersionId=also-not-a-uuid'
  );
  assert.equal(status, 400);
  assert.equal(body.error.code, 'VALIDATION_ERROR');
  assert.ok(body.error.details.some((d) => d.field === 'fromVersionId'));
  assert.ok(body.error.details.some((d) => d.field === 'toVersionId'));
});

test('diff: the /diff route wins over /:id (no query = VALIDATION_ERROR, not INVALID_ID)', async () => {
  const { status, body } = await get('/api/specs/diff');
  assert.equal(status, 400);
  assert.equal(body.error.code, 'VALIDATION_ERROR');
});

test('diff: returns 404 for an unknown fromVersionId', async () => {
  const { status, body } = await get(
    diffPath('00000000-0000-4000-8000-000000000000', policyVersions[1].id)
  );
  assert.equal(status, 404);
  assert.equal(body.success, false);
  assert.equal(body.error.code, 'SPEC_VERSION_NOT_FOUND');
});

test('diff: returns 404 for an unknown toVersionId', async () => {
  const { status, body } = await get(
    diffPath(policyVersions[0].id, '00000000-0000-4000-8000-000000000000')
  );
  assert.equal(status, 404);
  assert.equal(body.error.code, 'SPEC_VERSION_NOT_FOUND');
});

test('diff: returns 400 INVALID_COMPARISON for versions of different services', async () => {
  const { status, body } = await get(diffPath(policyVersions[0].id, quoteVersions[0].id));
  assert.equal(status, 400);
  assert.equal(body.success, false);
  assert.equal(body.error.code, 'INVALID_COMPARISON');
  assert.deepEqual(body.error.details, {
    fromVersionId: policyVersions[0].id,
    toVersionId: quoteVersions[0].id,
    fromServiceId: policyService.id,
    toServiceId: quoteService.id,
  });
});

// --- Comparison results ---------------------------------------------------------

test('diff: identical versions produce an empty change list', async () => {
  const { status, body } = await get(diffPath(policyVersions[0].id, policyVersions[0].id));
  assert.equal(status, 200);
  assert.equal(body.success, true);
  assert.equal(body.data.changeCount, 0);
  assert.equal(body.data.breakingChangeCount, 0);
  assert.equal(body.data.nonBreakingChangeCount, 0);
  assert.equal(body.data.unknownChangeCount, 0);
  assert.deepEqual(body.data.changes, []);
});

test('diff: formatting-only and deprecation changes are not structural', async () => {
  // v1 -> v2 of the policy API adds `deprecated`/`x-sunset` metadata only.
  const { status, body } = await get(diffPath(policyVersions[0].id, policyVersions[1].id));
  assert.equal(status, 200);
  assert.equal(body.data.serviceId, policyService.id);
  assert.equal(body.data.changeCount, 0);
  assert.equal(body.data.breakingChangeCount, 0);
  assert.equal(body.data.nonBreakingChangeCount, 0);
  assert.equal(body.data.unknownChangeCount, 0);
  assert.deepEqual(body.data.changes, []);

  // Version metadata (without stored content) is included in the response.
  assert.equal(body.data.fromVersion.id, policyVersions[0].id);
  assert.equal(body.data.fromVersion.versionLabel, 'v1');
  assert.equal(body.data.toVersion.versionLabel, 'v2');
  assert.ok(!('parsedContent' in body.data.fromVersion));
  assert.ok(!('originalContent' in body.data.toVersion));
});

test('diff: removed response fields are reported across both endpoints', async () => {
  const { status, body } = await get(diffPath(policyVersions[1].id, policyVersions[2].id));
  assert.equal(status, 200);
  assert.equal(body.data.changeCount, 4);
  assert.equal(body.data.breakingChangeCount, 4);
  assert.equal(body.data.nonBreakingChangeCount, 0);
  assert.equal(body.data.unknownChangeCount, 0);
  for (const change of body.data.changes) {
    assert.equal(change.changeType, 'FIELD_REMOVED');
    assert.equal(change.classification, 'BREAKING');
    assert.equal(change.ruleId, 'RESPONSE_FIELD_REMOVED');
  }
  assert.deepEqual(
    body.data.changes.map((c) => `${c.method} ${c.path} ${c.fieldPath}`).sort(),
    [
      'GET /policies response.200[].holder.phone',
      'GET /policies response.200[].legacyCode',
      'GET /policies/{policyId} response.200.holder.phone',
      'GET /policies/{policyId} response.200.legacyCode',
    ]
  );
  // Every change carries a plain-language description.
  for (const change of body.data.changes) assert.match(change.description, /was removed/);
});

test('diff: enum removal plus a new required request field', async () => {
  const { status, body } = await get(diffPath(policyVersions[2].id, policyVersions[3].id));
  assert.equal(status, 200);
  assert.equal(body.data.changeCount, 2);
  assert.equal(body.data.breakingChangeCount, 2);
  assert.equal(body.data.nonBreakingChangeCount, 0);
  assert.equal(body.data.unknownChangeCount, 0);

  const enumChange = body.data.changes.find((c) => c.changeType === 'ENUM_CHANGED');
  assert.equal(enumChange.classification, 'BREAKING');
  assert.equal(enumChange.ruleId, 'REQUEST_ENUM_VALUES_REMOVED');
  assert.match(enumChange.reason, /VEHICLE/);
  assert.equal(enumChange.method, 'POST');
  assert.equal(enumChange.path, '/policies/{policyId}/endorsements');
  assert.equal(enumChange.fieldPath, 'request.type');
  assert.deepEqual(enumChange.before, { enum: ['ADDRESS', 'NOMINEE', 'VEHICLE'] });
  assert.deepEqual(enumChange.after, { enum: ['ADDRESS', 'NOMINEE'] });

  const added = body.data.changes.find((c) => c.changeType === 'FIELD_ADDED');
  assert.equal(added.classification, 'BREAKING');
  assert.equal(added.ruleId, 'REQUEST_FIELD_ADDED_REQUIRED');
  assert.equal(added.fieldPath, 'request.requestedBy');
  assert.equal(added.after.required, true);
});

test('diff: a path parameter rename is visible; $ref reorganisation is not', async () => {
  const { status, body } = await get(diffPath(quoteVersions[0].id, quoteVersions[1].id));
  assert.equal(status, 200);
  assert.equal(body.data.changeCount, 1);
  assert.equal(body.data.breakingChangeCount, 0);
  assert.equal(body.data.nonBreakingChangeCount, 0);
  assert.equal(body.data.unknownChangeCount, 1);
  const change = body.data.changes[0];
  assert.equal(change.changeType, 'PARAMETER_RENAMED');
  assert.equal(change.classification, 'UNKNOWN');
  assert.equal(change.ruleId, 'PARAMETER_RENAMED');
  assert.match(change.reason, /manual review/);
  assert.equal(change.method, 'GET');
  assert.deepEqual(change.before, { name: 'id', in: 'path' });
  assert.deepEqual(change.after, { name: 'quoteId', in: 'path' });
});

test('diff: multiple change kinds in one version jump', async () => {
  // quote v2 -> v3: required query parameter, enum expansion on two
  // endpoints, and a price-line field rename on two endpoints.
  const { status, body } = await get(diffPath(quoteVersions[1].id, quoteVersions[2].id));
  assert.equal(status, 200);
  assert.equal(body.data.changeCount, 7);
  assert.equal(body.data.breakingChangeCount, 3);
  assert.equal(body.data.nonBreakingChangeCount, 0);
  assert.equal(body.data.unknownChangeCount, 4);

  const byType = {};
  for (const change of body.data.changes) {
    byType[change.changeType] = byType[change.changeType] ?? [];
    byType[change.changeType].push(change);
  }
  assert.equal(byType.PARAMETER_ADDED.length, 1);
  assert.equal(byType.PARAMETER_ADDED[0].after.required, true);
  assert.equal(byType.PARAMETER_ADDED[0].after.name, 'region');
  assert.equal(byType.ENUM_CHANGED.length, 2);
  assert.equal(byType.FIELD_REMOVED.length, 2);
  assert.equal(byType.FIELD_ADDED.length, 2);
});

test('diff: optional additions only', async () => {
  const { status, body } = await get(diffPath(quoteVersions[2].id, quoteVersions[3].id));
  assert.equal(status, 200);
  assert.equal(body.data.changeCount, 3);
  assert.equal(body.data.breakingChangeCount, 0);
  assert.equal(body.data.nonBreakingChangeCount, 3);
  assert.equal(body.data.unknownChangeCount, 0);
  for (const change of body.data.changes) {
    assert.equal(change.changeType, 'FIELD_ADDED');
    assert.equal(change.after.required, false);
    assert.equal(change.classification, 'NON_BREAKING');
    assert.ok(change.ruleId);
    assert.ok(change.reason.length > 0);
  }
  assert.deepEqual(
    body.data.changes.map((c) => c.fieldPath).sort(),
    ['request.rider.ncbPercent', 'response.200.premium.taxes', 'response.201.premium.taxes']
  );
});

test('diff: reversed comparison reports the inverse changes', async () => {
  const forward = await get(diffPath(policyVersions[1].id, policyVersions[2].id));
  const reversed = await get(diffPath(policyVersions[2].id, policyVersions[1].id));
  assert.equal(reversed.status, 200);
  assert.equal(reversed.body.data.changeCount, forward.body.data.changeCount);
  for (const change of reversed.body.data.changes) {
    assert.equal(change.changeType, 'FIELD_ADDED');
    assert.equal(change.before, null);
    assert.ok(change.after.type);
  }
});

test('diff: the result is deterministic across repeated calls', async () => {
  const first = await get(diffPath(quoteVersions[1].id, quoteVersions[2].id));
  const second = await get(diffPath(quoteVersions[1].id, quoteVersions[2].id));
  assert.deepEqual(first.body.data, second.body.data);
});
