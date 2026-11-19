// Specification Management integration tests.
//
// Brings up a throwaway embedded Postgres on a dedicated port (55433, so it
// never collides with the dev instance on 5432 or the services tests on
// 55432 — test files run concurrently), applies the real migrations, and
// exercises the HTTP API against it. The database must have at least one
// migration in prisma/migrations.

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

const TEST_PORT = 55433;
const TEST_USER = 'contractguard';
const TEST_PASSWORD = 'contractguard';
const TEST_DB = 'contractguard_test_specs';
const testDatabaseUrl = `postgresql://${TEST_USER}:${TEST_PASSWORD}@127.0.0.1:${TEST_PORT}/${TEST_DB}`;

const backendDir = fileURLToPath(new URL('..', import.meta.url));
const testDataDir = path.join(backendDir, '.embedded-pg', 'test-data-specs');
const prismaCli = path.join(backendDir, 'node_modules', 'prisma', 'build', 'index.js');

// The starter-kit fixtures are read-only inputs: read them, never modify.
const readSpec = (p) =>
  readFileSync(fileURLToPath(new URL(`../../specs/${p}`, import.meta.url)), 'utf8');

const policySpec = readSpec('policy-api/1-initial.yaml'); // valid, 3.0.3
const claimsBroken = readSpec('claims-api/2-channel-and-notes.yaml'); // unresolved $ref
const claimsFixed = readSpec('claims-api/3-channel-and-notes-fixed.yaml'); // the fix
const quoteSpec = readSpec('quote-api/1-initial.yaml'); // valid, 3.0.3

const inlineJsonSpec = JSON.stringify({
  openapi: '3.0.3',
  info: { title: 'Inline JSON API', version: '1.0.0' },
  paths: {
    '/widgets': {
      get: {
        operationId: 'listWidgets',
        responses: {
          200: {
            description: 'Widgets',
            content: {
              'application/json': {
                schema: { type: 'array', items: { $ref: '#/components/schemas/Widget' } },
              },
            },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      Widget: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' }, sku: { type: 'string' } },
      },
    },
  },
});

const malformedYaml = 'openapi: 3.0.3\n  info: [broken';

const invalidStructureYaml = [
  'openapi: 3.0.3',
  'paths:',
  '  /a:',
  '    get:',
  '      responses:',
  "        '200':",
  '          description: ok',
  '',
].join('\n');

let pg;
let server;
let baseUrl;
let prisma;
let app;

let policyService;
let v1;
let v2;

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
    console.error('[specs.test] teardown complete');
  } catch (err) {
    teardownFailed = true;
    console.error('[specs.test] teardown error:', err.message);
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

// --- POST /api/specs/validate -------------------------------------------------

test('validate: accepts a valid YAML OpenAPI document (starter-kit fixture)', async () => {
  const { status, body } = await postJson('/api/specs/validate', { content: policySpec });
  assert.equal(status, 200);
  assert.equal(body.success, true);
  assert.equal(body.data.valid, true);
  assert.equal(body.data.format, 'yaml');
  assert.equal(body.data.openApiVersion, '3.0.3');
  assert.deepEqual(body.data.errors, []);
});

test('validate: accepts a valid JSON OpenAPI document', async () => {
  const { status, body } = await postJson('/api/specs/validate', {
    content: inlineJsonSpec,
  });
  assert.equal(status, 200);
  assert.equal(body.data.valid, true);
  assert.equal(body.data.format, 'json');
  assert.equal(body.data.openApiVersion, '3.0.3');
  assert.deepEqual(body.data.errors, []);
});

test('validate: rejects malformed YAML with a parse error', async () => {
  const { status, body } = await postJson('/api/specs/validate', { content: malformedYaml });
  assert.equal(status, 200);
  assert.equal(body.data.valid, false);
  assert.equal(body.data.format, 'yaml');
  assert.equal(body.data.openApiVersion, null);
  assert.equal(body.data.errors.length, 1);
  assert.equal(body.data.errors[0].code, 'PARSE_ERROR');
  assert.match(body.data.errors[0].message, /bad indentation/);
});

test('validate: rejects an invalid OpenAPI structure (missing info)', async () => {
  const { status, body } = await postJson('/api/specs/validate', {
    content: invalidStructureYaml,
  });
  assert.equal(status, 200);
  assert.equal(body.data.valid, false);
  assert.equal(body.data.format, 'yaml');
  assert.equal(body.data.openApiVersion, '3.0.3');
  assert.ok(
    body.data.errors.some((e) => e.code === 'SCHEMA_VALIDATION' && /info/.test(e.message))
  );
});

test('validate: rejects an unresolved internal $ref (starter-kit fixture)', async () => {
  const { status, body } = await postJson('/api/specs/validate', { content: claimsBroken });
  assert.equal(status, 200);
  assert.equal(body.data.valid, false);
  assert.ok(
    body.data.errors.some(
      (e) =>
        e.code === 'UNRESOLVED_REFERENCE' &&
        e.message.includes('ClaimDocumnt') &&
        e.path === '#/components/schemas/ClaimDocumnt'
    )
  );
});

test('validate: accepts the same document after the $ref is fixed', async () => {
  const { status, body } = await postJson('/api/specs/validate', { content: claimsFixed });
  assert.equal(status, 200);
  assert.equal(body.data.valid, true);
  assert.equal(body.data.openApiVersion, '3.0.3');
});

test('validate: rejects a Swagger 2.0 document explicitly', async () => {
  const swagger2 = JSON.stringify({
    swagger: '2.0',
    info: { title: 'Legacy', version: '1.0.0' },
    paths: {},
  });
  const { status, body } = await postJson('/api/specs/validate', { content: swagger2 });
  assert.equal(status, 200);
  assert.equal(body.data.valid, false);
  assert.ok(body.data.errors.some((e) => e.code === 'UNSUPPORTED_VERSION'));
});

test('validate: returns 400 when content is missing', async () => {
  const { status, body } = await postJson('/api/specs/validate', {});
  assert.equal(status, 400);
  assert.equal(body.success, false);
  assert.equal(body.error.code, 'VALIDATION_ERROR');
  assert.ok(body.error.details.some((d) => d.field === 'content'));
});

test('validate: honours an explicit format hint (YAML content as JSON fails)', async () => {
  const { status, body } = await postJson('/api/specs/validate', {
    content: policySpec,
    format: 'json',
  });
  assert.equal(status, 200);
  assert.equal(body.data.valid, false);
  assert.ok(body.data.errors.some((e) => e.code === 'PARSE_ERROR'));
});

// --- POST /api/specs/upload ----------------------------------------------------

test('upload: returns 404 for a nonexistent service', async () => {
  const { status, body } = await postJson('/api/specs/upload', {
    serviceId: '00000000-0000-4000-8000-00000000dead',
    versionLabel: 'v1',
    content: policySpec,
  });
  assert.equal(status, 404);
  assert.equal(body.success, false);
  assert.equal(body.error.code, 'SERVICE_NOT_FOUND');
});

test('upload: stores a first version as PROPOSED with no baseline', async () => {
  const created = await postJson('/api/services', {
    name: 'policy-api',
    owner: 'Policy Team',
    description: 'Manages insurance policies',
  });
  assert.equal(created.status, 201);
  policyService = created.body.data;

  const { status, body } = await postJson('/api/specs/upload', {
    serviceId: policyService.id,
    versionLabel: 'v1',
    content: policySpec,
  });
  assert.equal(status, 201);
  assert.equal(body.success, true);
  assert.equal(body.data.serviceId, policyService.id);
  assert.equal(body.data.versionLabel, 'v1');
  assert.equal(body.data.status, 'PROPOSED');
  assert.equal(body.data.format, 'YAML');
  assert.equal(body.data.openApiVersion, '3.0.3');
  assert.equal(body.data.isInitialVersion, true);
  assert.equal(body.data.baselineVersionId, null);
  assert.match(body.data.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.ok(body.data.createdAt);
  v1 = body.data;
});

test('upload: stores a subsequent proposed version with initial flag cleared', async () => {
  const { status, body } = await postJson('/api/specs/upload', {
    serviceId: policyService.id,
    versionLabel: 'v2',
    content: quoteSpec,
    filename: 'quote-api-2.yaml',
  });
  assert.equal(status, 201);
  assert.equal(body.data.versionLabel, 'v2');
  assert.equal(body.data.status, 'PROPOSED');
  assert.equal(body.data.format, 'YAML');
  assert.equal(body.data.isInitialVersion, false);
  // Publishing is not implemented in this increment, so no published
  // baseline exists yet — the field is present but null, never invented.
  assert.equal(body.data.baselineVersionId, null);
  v2 = body.data;
});

test('upload: returns 409 for a duplicate version label', async () => {
  const { status, body } = await postJson('/api/specs/upload', {
    serviceId: policyService.id,
    versionLabel: 'v1',
    content: quoteSpec,
  });
  assert.equal(status, 409);
  assert.equal(body.success, false);
  assert.equal(body.error.code, 'DUPLICATE_VERSION');
  assert.match(body.error.message, /policy-api/);
  assert.match(body.error.message, /v1/);
});

test('upload: rejects an invalid specification without persisting', async () => {
  const { status, body } = await postJson('/api/specs/upload', {
    serviceId: policyService.id,
    versionLabel: 'v3',
    content: claimsBroken,
  });
  assert.equal(status, 400);
  assert.equal(body.success, false);
  assert.equal(body.error.code, 'INVALID_SPEC');
  assert.ok(
    body.error.details.some((d) => d.code === 'UNRESOLVED_REFERENCE')
  );

  // Nothing was persisted: the service still has exactly two versions.
  const versions = await get(`/api/services/${policyService.id}/versions`);
  assert.equal(versions.body.data.length, 2);
});

test('upload: returns 400 for a malformed serviceId', async () => {
  const { status, body } = await postJson('/api/specs/upload', {
    serviceId: 'not-a-uuid',
    versionLabel: 'v1',
    content: policySpec,
  });
  assert.equal(status, 400);
  assert.equal(body.error.code, 'VALIDATION_ERROR');
  assert.ok(body.error.details.some((d) => d.field === 'serviceId'));
});

test('upload: returns 400 when versionLabel is missing', async () => {
  const { status, body } = await postJson('/api/specs/upload', {
    serviceId: policyService.id,
    content: policySpec,
  });
  assert.equal(status, 400);
  assert.equal(body.error.code, 'VALIDATION_ERROR');
  assert.ok(body.error.details.some((d) => d.field === 'versionLabel'));
});

// --- GET /api/services/:id/versions --------------------------------------------

test('versions: lists a service versions with metadata only', async () => {
  const { status, body } = await get(`/api/services/${policyService.id}/versions`);
  assert.equal(status, 200);
  assert.equal(body.success, true);
  assert.equal(body.data.length, 2);

  // Chronological order (upload order), not label order.
  assert.deepEqual(
    body.data.map((v) => v.versionLabel),
    ['v1', 'v2']
  );

  for (const version of body.data) {
    assert.equal(version.serviceId, policyService.id);
    assert.equal(version.status, 'PROPOSED');
    assert.ok(version.openApiVersion);
    // Large stored content is not exposed in list responses.
    assert.ok(!('originalContent' in version));
    assert.ok(!('parsedContent' in version));
  }
});

test('versions: returns 404 for a nonexistent service', async () => {
  const { status, body } = await get(
    '/api/services/00000000-0000-4000-8000-000000000000/versions'
  );
  assert.equal(status, 404);
  assert.equal(body.error.code, 'SERVICE_NOT_FOUND');
});

// --- GET /api/specs/:id ----------------------------------------------------------

test('spec detail: returns a specific version with its stored content', async () => {
  const { status, body } = await get(`/api/specs/${v1.id}`);
  assert.equal(status, 200);
  assert.equal(body.success, true);
  assert.equal(body.data.id, v1.id);
  assert.equal(body.data.serviceId, policyService.id);
  assert.equal(body.data.versionLabel, 'v1');
  assert.equal(body.data.status, 'PROPOSED');
  assert.equal(body.data.format, 'YAML');
  assert.equal(body.data.openApiVersion, '3.0.3');

  // The original upload is preserved verbatim.
  assert.equal(body.data.originalContent, policySpec);

  // The stored parsed document is the fully $ref-resolved representation:
  // the response schema at /policies used to be a $ref to Policy.
  const items =
    body.data.parsedContent.paths['/policies'].get.responses['200'].content[
      'application/json'
    ].schema.items;
  assert.ok(!('$ref' in items), 'parsedContent must have no $ref at this location');
  assert.equal(items.type, 'object');
  assert.ok(items.properties.policyId);
  assert.ok(items.properties.premiumDue);
});

test('spec detail: returns 404 for an unknown version', async () => {
  const { status, body } = await get(
    '/api/specs/00000000-0000-4000-8000-000000000000'
  );
  assert.equal(status, 404);
  assert.equal(body.success, false);
  assert.equal(body.error.code, 'SPEC_VERSION_NOT_FOUND');
});

test('spec detail: returns 400 for a malformed id', async () => {
  const { status, body } = await get('/api/specs/not-a-uuid');
  assert.equal(status, 400);
  assert.equal(body.success, false);
  assert.equal(body.error.code, 'INVALID_ID');
});
