// Service Registry integration tests.
//
// Brings up a throwaway embedded Postgres on a dedicated port (55432, so it
// never collides with a dev instance on 5432), applies the real migrations,
// and exercises the HTTP API against it. The database must have at least one
// migration in prisma/migrations (run `npm run db:up` + `npm run db:migrate`
// once before the first test run).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { rmSync } from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';

const execFileAsync = promisify(execFile);

const TEST_PORT = 55432;
const TEST_USER = 'contractguard';
const TEST_PASSWORD = 'contractguard';
const TEST_DB = 'contractguard_test';
const testDatabaseUrl = `postgresql://${TEST_USER}:${TEST_PASSWORD}@127.0.0.1:${TEST_PORT}/${TEST_DB}`;

const backendDir = fileURLToPath(new URL('..', import.meta.url));
const testDataDir = path.join(backendDir, '.embedded-pg', 'test-data');
const prismaCli = path.join(backendDir, 'node_modules', 'prisma', 'build', 'index.js');

let pg;
let server;
let baseUrl;
let prisma;
let app;

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
    // Windows "io_worker" fork-children may still hold file handles there
    // (that would wedge the teardown). The directory is wiped on the next
    // run instead.
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

  // 4. Start from a clean table.
  await prisma.service.deleteMany();
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
    console.error('[services.test] teardown error:', err.message);
  }
  if (teardownFailed) {
    // Something is left hanging (postgres child, open sockets). Force-kill
    // this dedicated child so the suite can finish; on a clean teardown the
    // process exits on its own.
    process.exit(1);
  }
});

async function postServices(body) {
  const res = await fetch(`${baseUrl}/api/services`, {
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

let policyApi;

test('GET /api/services returns an empty array when none exist', async () => {
  const { status, body } = await get('/api/services');
  assert.equal(status, 200);
  assert.equal(body.success, true);
  assert.deepEqual(body.data, []);
});

test('POST /api/services creates a service (201)', async () => {
  const { status, body } = await postServices({
    name: 'policy-api',
    owner: 'Policy Team',
    description: 'Manages insurance policies',
  });
  assert.equal(status, 201);
  assert.equal(body.success, true);
  assert.equal(body.data.name, 'policy-api');
  assert.equal(body.data.owner, 'Policy Team');
  assert.equal(body.data.description, 'Manages insurance policies');
  assert.match(body.data.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.ok(body.data.createdAt);
  policyApi = body.data;
});

test('POST /api/services trims string inputs before storing', async () => {
  const { status, body } = await postServices({
    name: '  quote-api  ',
    owner: '  Quotes Team  ',
    description: '  Bike insurance quotes  ',
  });
  assert.equal(status, 201);
  assert.equal(body.data.name, 'quote-api');
  assert.equal(body.data.owner, 'Quotes Team');
  assert.equal(body.data.description, 'Bike insurance quotes');
});

test('GET /api/services lists registered services', async () => {
  const { status, body } = await get('/api/services');
  assert.equal(status, 200);
  assert.equal(body.success, true);
  assert.ok(Array.isArray(body.data));
  assert.equal(body.data.length, 2);
  const names = body.data.map((s) => s.name);
  assert.deepEqual(names, ['policy-api', 'quote-api']);
});

test('POST /api/services rejects a missing name (400)', async () => {
  const { status, body } = await postServices({
    owner: 'Policy Team',
    description: 'no name',
  });
  assert.equal(status, 400);
  assert.equal(body.success, false);
  assert.equal(body.error.code, 'VALIDATION_ERROR');
  assert.ok(body.error.details.some((d) => d.field === 'name'));
});

test('POST /api/services rejects a missing owner (400)', async () => {
  const { status, body } = await postServices({ name: 'claims-api' });
  assert.equal(status, 400);
  assert.equal(body.success, false);
  assert.equal(body.error.code, 'VALIDATION_ERROR');
  assert.ok(body.error.details.some((d) => d.field === 'owner'));
});

test('POST /api/services rejects empty and whitespace-only strings (400)', async () => {
  const { status, body } = await postServices({ name: '   ', owner: '' });
  assert.equal(status, 400);
  assert.equal(body.success, false);
  assert.ok(body.error.details.some((d) => d.field === 'name'));
  assert.ok(body.error.details.some((d) => d.field === 'owner'));
});

test('POST /api/services returns 409 for a duplicate name', async () => {
  const { status, body } = await postServices({
    name: 'policy-api',
    owner: 'Someone Else',
  });
  assert.equal(status, 409);
  assert.equal(body.success, false);
  assert.equal(body.error.code, 'DUPLICATE_SERVICE');
  assert.match(body.error.message, /policy-api/);
});

test('GET /api/services/:id returns an existing service', async () => {
  const { status, body } = await get(`/api/services/${policyApi.id}`);
  assert.equal(status, 200);
  assert.equal(body.success, true);
  assert.equal(body.data.id, policyApi.id);
  assert.equal(body.data.name, 'policy-api');
  assert.equal(body.data.owner, 'Policy Team');
});

test('GET /api/services/:id returns 404 for a nonexistent service', async () => {
  const { status, body } = await get(
    '/api/services/00000000-0000-4000-8000-000000000000'
  );
  assert.equal(status, 404);
  assert.equal(body.success, false);
  assert.equal(body.error.code, 'SERVICE_NOT_FOUND');
});

test('GET /api/services/:id returns 400 for a malformed id', async () => {
  const { status, body } = await get('/api/services/not-a-uuid');
  assert.equal(status, 400);
  assert.equal(body.success, false);
  assert.equal(body.error.code, 'INVALID_ID');
});

test('GET /api/services/:id/versions returns an empty list for an existing service', async () => {
  const { status, body } = await get(`/api/services/${policyApi.id}/versions`);
  assert.equal(status, 200);
  assert.equal(body.success, true);
  assert.deepEqual(body.data, []);
});

test('GET /api/services/:id/versions returns 404 for a nonexistent service', async () => {
  const { status, body } = await get(
    '/api/services/00000000-0000-4000-8000-000000000001/versions'
  );
  assert.equal(status, 404);
  assert.equal(body.success, false);
  assert.equal(body.error.code, 'SERVICE_NOT_FOUND');
});
