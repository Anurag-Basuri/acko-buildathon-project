// Compatibility Classification integration tests, exercised through the
// extended comparison endpoint (GET /api/specs/diff).
//
// Brings up a throwaway embedded Postgres on a dedicated port (55435, so it
// never collides with the dev instance on 5432, the services tests on
// 55432, the specs tests on 55433, or the comparison tests on 55434 — test
// files run concurrently), applies the real migrations, and exercises the
// HTTP API against it.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync, rmSync } from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';

const execFileAsync = promisify(execFile);

const TEST_PORT = 55435;
const TEST_USER = 'contractguard';
const TEST_PASSWORD = 'contractguard';
const TEST_DB = 'contractguard_test_compatibility';
const testDatabaseUrl = `postgresql://${TEST_USER}:${TEST_PASSWORD}@127.0.0.1:${TEST_PORT}/${TEST_DB}`;

const backendDir = fileURLToPath(new URL('..', import.meta.url));
const testDataDir = path.join(backendDir, '.embedded-pg', 'test-data-compatibility');
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
const claimsSpecs = [
  readSpec('claims-api/1-initial.yaml'),
  readSpec('claims-api/3-channel-and-notes-fixed.yaml'),
  readSpec('claims-api/4-approval-later.yaml'),
];

let pg;
let server;
let baseUrl;
let prisma;
let app;

let policyService;
let quoteService;
let claimsService;
let policyVersions = [];
let quoteVersions = [];
let claimsVersions = [];

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

  // 5. Seed three services with their fixture version histories.
  const seed = async (name, owner, description, specs) => {
    const created = await postJson('/api/services', { name, owner, description });
    assert.equal(created.status, 201);
    const service = created.body.data;
    const versions = [];
    for (let i = 0; i < specs.length; i += 1) {
      const uploaded = await postJson('/api/specs/upload', {
        serviceId: service.id,
        versionLabel: `v${i + 1}`,
        content: specs[i],
      });
      assert.equal(uploaded.status, 201, uploaded.body);
      versions.push(uploaded.body.data);
    }
    return { service, versions };
  };

  ({ service: policyService, versions: policyVersions } = await seed(
    'policy-api',
    'Policy Team',
    'Manages insurance policies',
    policySpecs
  ));
  ({ service: quoteService, versions: quoteVersions } = await seed(
    'quote-api',
    'Quotes Team',
    'Bike insurance quotes',
    quoteSpecs
  ));
  ({ service: claimsService, versions: claimsVersions } = await seed(
    'claims-api',
    'Claims Team',
    'Insurance claims',
    claimsSpecs
  ));
});

after(async () => {
  // Best-effort, time-bounded teardown. This file runs in its own child
  // process under `node --test`, so a forced exit here cannot cut other test
  // files short; the exit code still reflects a teardown failure.
  let teardownFailed = false;
  try {
    if (server) {
      // closeAllConnections drops undici keep-alive sockets, which would
      // otherwise keep server.close() waiting forever.
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    if (prisma) await prisma.$disconnect();
    if (pg) {
      await Promise.race([
        pg.stop(),
        sleep(15_000).then(() => {
          throw new Error('embedded postgres did not stop within 15s');
        }),
      ]);
    }
  } catch (err) {
    teardownFailed = true;
    console.error('[compatibility.test] teardown error:', err.message);
  }
  if (teardownFailed) {
    process.exit(1);
  }
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
    '/api/specs/diff?fromVersionId=nope&toVersionId=also-nope'
  );
  assert.equal(status, 400);
  assert.equal(body.error.code, 'VALIDATION_ERROR');
  assert.ok(body.error.details.some((d) => d.field === 'fromVersionId'));
});

test('diff: returns 404 for an unknown version', async () => {
  const { status, body } = await get(
    diffPath('00000000-0000-4000-8000-000000000000', policyVersions[1].id)
  );
  assert.equal(status, 404);
  assert.equal(body.error.code, 'SPEC_VERSION_NOT_FOUND');
});

test('diff: returns 400 INVALID_COMPARISON for versions of different services', async () => {
  const { status, body } = await get(diffPath(policyVersions[0].id, claimsVersions[0].id));
  assert.equal(status, 400);
  assert.equal(body.error.code, 'INVALID_COMPARISON');
  assert.equal(body.error.details.fromServiceId, policyService.id);
  assert.equal(body.error.details.toServiceId, claimsService.id);
});

// --- Classification results against the starter-kit history --------------------

test('diff: identical versions classify as zero counts', async () => {
  const { status, body } = await get(diffPath(policyVersions[0].id, policyVersions[0].id));
  assert.equal(status, 200);
  assert.equal(body.success, true);
  assert.equal(body.data.serviceId, policyService.id);
  assert.equal(body.data.changeCount, 0);
  assert.equal(body.data.breakingChangeCount, 0);
  assert.equal(body.data.nonBreakingChangeCount, 0);
  assert.equal(body.data.unknownChangeCount, 0);
  assert.deepEqual(body.data.changes, []);
});

test('diff: non-structural changes keep zero counts', async () => {
  // policy v1 -> v2 adds deprecation metadata only.
  const { status, body } = await get(diffPath(policyVersions[0].id, policyVersions[1].id));
  assert.equal(status, 200);
  assert.equal(body.data.changeCount, 0);
  assert.deepEqual(body.data.changes, []);
});

test('diff: removed response fields classify as BREAKING', async () => {
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
    assert.match(change.reason, /no longer returned/);
  }
});

test('diff: enum value removal plus a new required request field are BREAKING', async () => {
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

  const added = body.data.changes.find((c) => c.changeType === 'FIELD_ADDED');
  assert.equal(added.classification, 'BREAKING');
  assert.equal(added.ruleId, 'REQUEST_FIELD_ADDED_REQUIRED');
  assert.match(added.reason, /required request field/i);
});

test('diff: a path parameter rename alone is UNKNOWN (needs manual review)', async () => {
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
});

test('diff: a mixed jump counts each classification exactly', async () => {
  // quote v2 -> v3: required query parameter (BREAKING), response enum
  // expansion x2 (UNKNOWN), required response field removed x2 (BREAKING),
  // required response field added x2 (UNKNOWN).
  const { status, body } = await get(diffPath(quoteVersions[1].id, quoteVersions[2].id));
  assert.equal(status, 200);
  assert.equal(body.data.changeCount, 7);
  assert.equal(body.data.breakingChangeCount, 3);
  assert.equal(body.data.nonBreakingChangeCount, 0);
  assert.equal(body.data.unknownChangeCount, 4);

  const param = body.data.changes.find((c) => c.changeType === 'PARAMETER_ADDED');
  assert.equal(param.classification, 'BREAKING');
  assert.equal(param.ruleId, 'PARAMETER_ADDED_REQUIRED');
  assert.match(param.reason, /region/);

  const removedAmount = body.data.changes.filter((c) => c.changeType === 'FIELD_REMOVED');
  assert.equal(removedAmount.length, 2);
  for (const change of removedAmount) {
    assert.equal(change.classification, 'BREAKING');
    assert.equal(change.ruleId, 'RESPONSE_FIELD_REMOVED');
  }

  const addedValue = body.data.changes.filter((c) => c.changeType === 'FIELD_ADDED');
  assert.equal(addedValue.length, 2);
  for (const change of addedValue) {
    assert.equal(change.classification, 'UNKNOWN');
    assert.equal(change.ruleId, 'RESPONSE_FIELD_ADDED_REQUIRED');
  }

  const enums = body.data.changes.filter((c) => c.changeType === 'ENUM_CHANGED');
  assert.equal(enums.length, 2);
  for (const change of enums) {
    assert.equal(change.classification, 'UNKNOWN');
    assert.equal(change.ruleId, 'RESPONSE_ENUM_VALUES_ADDED');
  }
});

test('diff: optional additions only are all NON_BREAKING', async () => {
  const { status, body } = await get(diffPath(quoteVersions[2].id, quoteVersions[3].id));
  assert.equal(status, 200);
  assert.equal(body.data.changeCount, 3);
  assert.equal(body.data.breakingChangeCount, 0);
  assert.equal(body.data.nonBreakingChangeCount, 3);
  assert.equal(body.data.unknownChangeCount, 0);
  for (const change of body.data.changes) {
    assert.equal(change.changeType, 'FIELD_ADDED');
    assert.equal(change.classification, 'NON_BREAKING');
    assert.ok(change.ruleId);
    assert.ok(change.reason.length > 0);
  }
});

test('diff: optional request field plus optional response fields are NON_BREAKING', async () => {
  const { status, body } = await get(diffPath(claimsVersions[0].id, claimsVersions[1].id));
  assert.equal(status, 200);
  assert.equal(body.data.changeCount, 3);
  assert.equal(body.data.breakingChangeCount, 0);
  assert.equal(body.data.nonBreakingChangeCount, 3);
  assert.equal(body.data.unknownChangeCount, 0);
});

test('diff: new response status (non-breaking) plus response requiredness change (unknown)', async () => {
  const { status, body } = await get(diffPath(claimsVersions[1].id, claimsVersions[2].id));
  assert.equal(status, 200);
  assert.equal(body.data.changeCount, 3);
  assert.equal(body.data.breakingChangeCount, 0);
  assert.equal(body.data.nonBreakingChangeCount, 1);
  assert.equal(body.data.unknownChangeCount, 2);

  const statusAdded = body.data.changes.find((c) => c.changeType === 'RESPONSE_STATUS_ADDED');
  assert.equal(statusAdded.classification, 'NON_BREAKING');
  assert.equal(statusAdded.ruleId, 'RESPONSE_STATUS_ADDED');
  assert.match(statusAdded.reason, /202/);

  const requiredness = body.data.changes.filter((c) => c.changeType === 'FIELD_REQUIREDNESS_CHANGED');
  assert.equal(requiredness.length, 2);
  for (const change of requiredness) {
    assert.equal(change.classification, 'UNKNOWN');
    assert.equal(change.ruleId, 'RESPONSE_FIELD_REQUIRED_TO_OPTIONAL');
  }
});

// --- Response shape -------------------------------------------------------------

test('diff: response carries version metadata, counts and classified changes', async () => {
  const { status, body } = await get(diffPath(quoteVersions[1].id, quoteVersions[2].id));
  assert.equal(status, 200);
  const { data } = body;

  assert.equal(data.serviceId, quoteService.id);
  assert.equal(data.fromVersion.id, quoteVersions[1].id);
  assert.equal(data.fromVersion.versionLabel, 'v2');
  assert.equal(data.toVersion.versionLabel, 'v3');
  // Stored content is never included.
  assert.ok(!('parsedContent' in data.fromVersion));
  assert.ok(!('originalContent' in data.toVersion));

  assert.equal(data.changeCount, data.changes.length);
  assert.equal(
    data.changeCount,
    data.breakingChangeCount + data.nonBreakingChangeCount + data.unknownChangeCount
  );

  // Every change keeps the comparator fields and gains classification.
  for (const change of data.changes) {
    assert.ok(change.changeType);
    assert.ok(['BREAKING', 'NON_BREAKING', 'UNKNOWN'].includes(change.classification));
    assert.ok(typeof change.ruleId === 'string' && change.ruleId.length > 0);
    assert.ok(typeof change.reason === 'string' && change.reason.length > 0);
    assert.ok(typeof change.description === 'string' && change.description.length > 0);
  }
});

test('diff: the result is deterministic across repeated calls', async () => {
  const first = await get(diffPath(policyVersions[2].id, policyVersions[3].id));
  const second = await get(diffPath(policyVersions[2].id, policyVersions[3].id));
  assert.deepEqual(first.body.data, second.body.data);
});
