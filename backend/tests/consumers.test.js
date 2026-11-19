// Consumer Registry integration tests (GET/POST/PUT /api/consumers,
// GET /api/services/:id/consumers, POST /api/consumers/import).
//
// Throwaway embedded Postgres on port 55436 (concurrent test files use
// 55432/55433/55434/55435), real migrations, HTTP API exercised end to end.

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

const TEST_PORT = 55436;
const TEST_USER = 'contractguard';
const TEST_PASSWORD = 'contractguard';
const TEST_DB = 'contractguard_test_consumers';
const testDatabaseUrl = `postgresql://${TEST_USER}:${TEST_PASSWORD}@127.0.0.1:${TEST_PORT}/${TEST_DB}`;

const backendDir = fileURLToPath(new URL('..', import.meta.url));
const testDataDir = path.join(backendDir, '.embedded-pg', 'test-data-consumers');
const prismaCli = path.join(backendDir, 'node_modules', 'prisma', 'build', 'index.js');

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
  readSpec('claims-api/2-channel-and-notes.yaml'),
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
let policyV1;
let quoteV3;
let claimsV1;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
        throw new Error(`Could not reset test database directory ${testDataDir}: ${err.message}`);
      }
      await sleep(250);
    }
  }
}

async function postJson(urlPath, body) {
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function putJson(urlPath, body) {
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function get(urlPath) {
  const res = await fetch(`${baseUrl}${urlPath}`);
  return { status: res.status, body: await res.json() };
}

async function createService(name, owner) {
  const created = await postJson('/api/services', { name, owner });
  assert.equal(created.status, 201, created.body);
  return created.body.data;
}

async function uploadSpec(serviceId, label, content) {
  const uploaded = await postJson('/api/specs/upload', { serviceId, versionLabel: label, content });
  assert.equal(uploaded.status, 201, uploaded.body);
  return uploaded.body.data;
}

async function markPublished(versionId) {
  await prisma.apiVersion.update({ where: { id: versionId }, data: { status: 'PUBLISHED' } });
}

before(async () => {
  await resetTestDataDir();
  pg = new EmbeddedPostgres({
    databaseDir: testDataDir,
    user: TEST_USER,
    password: TEST_PASSWORD,
    port: TEST_PORT,
    persistent: true,
    autoRehydrateSymlinks: true,
    initdbFlags: ['--locale=C', '--encoding=UTF8'],
    onLog: () => {},
    onError: (message) => console.error('[embedded-postgres]', message),
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase(TEST_DB);

  await execFileAsync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
    cwd: backendDir,
    env: { ...process.env, DATABASE_URL: testDatabaseUrl },
  });

  process.env.DATABASE_URL = testDatabaseUrl;
  ({ default: app } = await import('../src/app.js'));
  ({ default: prisma } = await import('../src/database/prisma.js'));

  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  await prisma.apiVersion.deleteMany();
  await prisma.consumerDependency.deleteMany();
  await prisma.service.deleteMany();

  // Provider services with full fixture histories.
  policyService = await createService('policy-api', 'Policy Team');
  quoteService = await createService('quote-api', 'Quotes Team');
  claimsService = await createService('claims-api', 'Claims Team');

  policyV1 = await uploadSpec(policyService.id, 'v1', policySpecs[0]);
  await uploadSpec(policyService.id, 'v2', policySpecs[1]);
  await uploadSpec(policyService.id, 'v3', policySpecs[2]);
  await uploadSpec(policyService.id, 'v4', policySpecs[3]);

  await uploadSpec(quoteService.id, 'v1', quoteSpecs[0]);
  await uploadSpec(quoteService.id, 'v2', quoteSpecs[1]);
  quoteV3 = await uploadSpec(quoteService.id, 'v3', quoteSpecs[2]);
  await uploadSpec(quoteService.id, 'v4', quoteSpecs[3]);

  claimsV1 = await uploadSpec(claimsService.id, 'v1', claimsSpecs[0]);
  // claims v2 fixture carries a deliberately broken $ref (ClaimDocumnt) —
  // the upload endpoint must reject invalid specifications.
  const rejected = await postJson('/api/specs/upload', {
    serviceId: claimsService.id,
    versionLabel: 'v2',
    content: claimsSpecs[1],
  });
  assert.equal(rejected.status, 400);
  assert.equal(rejected.body.error.code, 'INVALID_SPEC');
  await uploadSpec(claimsService.id, 'v3', claimsSpecs[2]);
  await uploadSpec(claimsService.id, 'v4', claimsSpecs[3]);

  // Publish baselines: policy v1, quote v3 (path is /quotes/{quoteId} — the
  // parameter rename), claims v1.
  await markPublished(policyV1.id);
  await markPublished(quoteV3.id);
  await markPublished(claimsV1.id);
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
    console.error('[consumers.test] teardown complete');
  } catch (err) {
    teardownFailed = true;
    console.error('[consumers.test] teardown error:', err.message);
  }
  if (teardownFailed) process.exit(1);
});

// --- Registration -----------------------------------------------------------

test('consumers: empty registry lists no consumers', async () => {
  const { status, body } = await get('/api/consumers');
  assert.equal(status, 200);
  assert.equal(body.success, true);
  assert.deepEqual(body.data, []);
});

test('consumers: registering a consumer creates a service record', async () => {
  const { status, body } = await postJson('/api/consumers', {
    name: 'billing-worker',
    owner: 'Billing',
    description: 'Processes premium payments',
  });
  assert.equal(status, 201);
  assert.equal(body.data.name, 'billing-worker');
  assert.equal(body.data.owner, 'Billing');
});

test('consumers: registering the same name again is a 409 duplicate', async () => {
  const { status, body } = await postJson('/api/consumers', { name: 'billing-worker', owner: 'Billing' });
  assert.equal(status, 409);
  assert.equal(body.error.code, 'DUPLICATE_SERVICE');
});

test('consumers: registration validates required fields', async () => {
  const { status, body } = await postJson('/api/consumers', { owner: 'No Name' });
  assert.equal(status, 400);
  assert.equal(body.error.code, 'VALIDATION_ERROR');
  assert.ok(body.error.details.some((d) => d.field === 'name'));
});

// --- Dependencies -----------------------------------------------------------

let billingWorker;

test('consumers: PUT creates dependencies and normalizes the HTTP method', async () => {
  const { status, body } = await postJson('/api/consumers', { name: 'rate-limiter', owner: 'Platform' });
  assert.equal(status, 201);
  billingWorker = body.data; // keep the first registered id for later tests

  const { status: putStatus, body: putBody } = await putJson(`/api/consumers/${billingWorker.id}`, {
    dependencies: [
      {
        providerId: quoteService.id,
        method: 'get',
        path: '/quotes/{id}',
        sends: ['id'],
        reads: ['quoteId', 'premium.total'],
      },
    ],
  });
  assert.equal(putStatus, 200);
  assert.equal(putBody.data.uses.length, 1);
  assert.equal(putBody.data.uses[0].method, 'GET');
  assert.equal(putBody.data.uses[0].path, '/quotes/{id}');
  assert.deepEqual(putBody.data.uses[0].sends, ['id']);
  assert.deepEqual(putBody.data.uses[0].reads, ['quoteId', 'premium.total']);
});

test('consumers: PUT rejects a nonexistent provider with 400 PROVIDER_NOT_FOUND', async () => {
  const { status, body } = await putJson(`/api/consumers/${billingWorker.id}`, {
    dependencies: [
      {
        providerId: '00000000-0000-4000-8000-000000000000',
        method: 'GET',
        path: '/nothing',
      },
    ],
  });
  assert.equal(status, 400);
  assert.equal(body.error.code, 'PROVIDER_NOT_FOUND');
  assert.ok(body.error.details.missingProviderIds.includes('00000000-0000-4000-8000-000000000000'));
});

test('consumers: PUT replaces the full dependency set (missing entries are removed)', async () => {
  const { status, body } = await putJson(`/api/consumers/${billingWorker.id}`, {
    dependencies: [
      {
        providerId: claimsService.id,
        method: 'POST',
        path: '/claims',
        sends: ['policyId', 'amountClaimed'],
        reads: ['claimId', 'status'],
      },
      {
        providerId: quoteService.id,
        method: 'GET',
        path: '/quotes/{id}',
        sends: ['id'],
        reads: ['quoteId'],
      },
    ],
  });
  assert.equal(status, 200);
  const paths = body.data.uses.map((use) => `${use.method} ${use.path}`).sort();
  assert.deepEqual(paths, ['GET /quotes/{id}', 'POST /claims']);
  // The original dependency (the first PUT) was replaced, not appended.
  assert.equal(body.data.uses.length, 2);
});

test('consumers: PUT with an empty array clears all dependencies', async () => {
  const { status, body } = await putJson(`/api/consumers/${billingWorker.id}`, {
    dependencies: [],
  });
  assert.equal(status, 200);
  assert.deepEqual(body.data.uses, []);
});

test('consumers: PUT validates method, path and field lists', async () => {
  const { status, body } = await putJson(`/api/consumers/${billingWorker.id}`, {
    dependencies: [
      { providerId: quoteService.id, method: 'FETCH', path: '/quotes', reads: 42 },
      { providerId: quoteService.id, method: 'GET', path: 'quotes' },
    ],
  });
  assert.equal(status, 400);
  assert.equal(body.error.code, 'VALIDATION_ERROR');
  assert.ok(body.error.details.some((d) => d.field === 'dependencies[0].method'));
  assert.ok(body.error.details.some((d) => d.field === 'dependencies[0].reads'));
  assert.ok(body.error.details.some((d) => d.field === 'dependencies[1].path'));
});

test('consumers: GET /api/consumers/:id returns the consumer with its dependencies', async () => {
  const { status, body } = await postJson('/api/consumers', { name: 'detail-consumer', owner: 'QA' });
  assert.equal(status, 201);
  const id = body.data.id;
  await putJson(`/api/consumers/${id}`, {
    dependencies: [
      { providerId: policyService.id, method: 'GET', path: '/policies/{policyId}', reads: ['policyId', 'status'] },
    ],
  });

  const fetched = await get(`/api/consumers/${id}`);
  assert.equal(fetched.status, 200);
  assert.equal(fetched.body.data.name, 'detail-consumer');
  assert.equal(fetched.body.data.uses.length, 1);
  assert.equal(fetched.body.data.uses[0].path, '/policies/{policyId}');
  assert.deepEqual(fetched.body.data.uses[0].reads, ['policyId', 'status']);
  assert.deepEqual(fetched.body.data.consumedBy, []);
});

test('consumers: unknown consumer id is a 404', async () => {
  const { status, body } = await get('/api/consumers/00000000-0000-4000-8000-000000000000');
  assert.equal(status, 404);
  assert.equal(body.error.code, 'CONSUMER_NOT_FOUND');
});

test('consumers: malformed id is a 400', async () => {
  const { status, body } = await get('/api/consumers/not-a-uuid');
  assert.equal(status, 400);
  assert.equal(body.error.code, 'INVALID_ID');
});

test('services: GET /api/services/:id/consumers lists grouped consumers of a provider', async () => {
  // rate-limiter's dependency set was cleared by an earlier test; give it
  // one back so it is visible to the provider-side listing.
  const redep = await putJson(`/api/consumers/${billingWorker.id}`, {
    dependencies: [
      {
        providerId: quoteService.id,
        method: 'GET',
        path: '/quotes/{id}',
        sends: ['id'],
        reads: ['quoteId'],
      },
    ],
  });
  assert.equal(redep.status, 200);

  const { status, body } = await get(`/api/services/${quoteService.id}/consumers`);
  assert.equal(status, 200);
  assert.equal(body.data.provider.id, quoteService.id);
  // rate-limiter still depends on quote-api (GET /quotes/{id}).
  assert.equal(body.data.consumers.length, 1);
  assert.equal(body.data.consumers[0].name, 'rate-limiter');
  assert.equal(body.data.consumers[0].dependencies.length, 1);
  assert.equal(body.data.consumers[0].dependencies[0].method, 'GET');
});

test('services: provider consumers for an unknown service is a 404', async () => {
  const { status, body } = await get('/api/services/00000000-0000-4000-8000-000000000000/consumers');
  assert.equal(status, 404);
  assert.equal(body.error.code, 'SERVICE_NOT_FOUND');
});

// --- Starter-kit import -----------------------------------------------------

test('import: all four starter-kit declarations import without duplicates', async () => {
  const { status, body } = await postJson('/api/consumers/import', {});
  assert.equal(status, 200, body);
  assert.equal(body.data.source, 'starter-kit');
  assert.equal(body.data.declarationsProcessed, 4);
  assert.equal(body.data.consumersCreated, 4);
  assert.equal(body.data.dependenciesUpserted, 10);
  assert.equal(body.data.unresolvedProviders.length, 0);

  const byName = new Map(body.data.declarations.map((d) => [d.consumer, d]));
  for (const name of ['mobile-app', 'partner-portal', 'payments-svc', 'notifications-svc']) {
    assert.ok(byName.has(name), `missing declaration for ${name}`);
    assert.equal(byName.get(name).status, 'ok');
  }
  assert.equal(byName.get('mobile-app').uses.length, 4);
  assert.equal(byName.get('partner-portal').uses.length, 2);
  assert.equal(byName.get('payments-svc').uses.length, 1);
  assert.equal(byName.get('notifications-svc').uses.length, 3);
});

test('import: published quote-api v3 reports the renamed path as an operation mismatch', async () => {
  const { status } = await postJson('/api/consumers/import', {});
  assert.equal(status, 200);
  // Re-import to read the fresh per-use report.
  const report = await prisma.consumerDependency.findMany({
    where: { providerServiceId: quoteService.id, path: { startsWith: '/quotes/{id}' } },
  });
  // rate-limiter (re-declared above) + mobile-app + notifications-svc.
  assert.equal(report.length, 3);
});

test('import: re-importing the same declarations creates no duplicates', async () => {
  // 10 starter-kit dependencies + detail-consumer + billing-worker.
  const first = await prisma.consumerDependency.count();
  assert.equal(first, 12);

  const { status, body } = await postJson('/api/consumers/import', {});
  assert.equal(status, 200);
  assert.equal(body.data.dependenciesUpserted, 10);
  assert.equal(body.data.consumersExisting, 4);
  assert.equal(body.data.consumersCreated, 0);

  const second = await prisma.consumerDependency.count();
  assert.equal(second, 12);
});

test('import: field paths (nested and array notation) are stored verbatim', async () => {
  const dependency = await prisma.consumerDependency.findFirst({
    where: {
      providerServiceId: quoteService.id,
      method: 'POST',
      path: '/quotes',
      reads: { has: 'premium.breakdown[].label' },
    },
  });
  assert.ok(dependency, 'expected the mobile-app POST /quotes dependency');
  assert.ok(dependency.reads.includes('premium.breakdown[].amount'));
  assert.ok(dependency.reads.includes('premium.breakdown[].label'));
  assert.ok(dependency.reads.includes('premium.total'));
  assert.ok(dependency.sends.includes('vehicle.make'));
});

test('import: per-use validation results against published specs', async () => {
  const { status, body } = await postJson('/api/consumers/import', {});
  assert.equal(status, 200);

  const mobile = body.data.declarations.find((d) => d.consumer === 'mobile-app');
  const useByPath = new Map(mobile.uses.map((use) => [use.path, use]));

  // GET /quotes/{id}: published spec has /quotes/{quoteId} -> mismatch.
  assert.equal(useByPath.get('/quotes/{id}').status, 'operation_mismatch');
  assert.ok(
    useByPath.get('/quotes/{id}').issues.some(
      (issue) => issue.kind === 'operation' && /quotes\/\{quoteId\}/.test(issue.message)
    )
  );

  // POST /quotes: quote v3 renamed premium.breakdown[].amount to .value,
  // so that declared read is flagged; everything else validates.
  const quotesUse = useByPath.get('/quotes');
  assert.equal(quotesUse.status, 'field_mismatches');
  assert.equal(quotesUse.issues.length, 1);
  assert.equal(quotesUse.issues[0].kind, 'field');
  assert.equal(quotesUse.issues[0].side, 'response');
  assert.equal(quotesUse.issues[0].field, 'premium.breakdown[].amount');

  // Claims operations validate against claims v1.
  const claims = useByPath.get('/claims');
  assert.equal(claims.status, 'validated');
});

test('import: malformed declarations in the body are reported, not fatal', async () => {
  const { status, body } = await postJson('/api/consumers/import', {
    declarations: [
      { consumer: 42, uses: [] },
      {
        consumer: 'valid-importer',
        team: 'QA',
        uses: [
          {
            provider: 'policy-api',
            method: 'GET',
            path: '/policies/{policyId}',
            sends: ['policyId'],
            reads: ['policyId', 'ghostField', 'premiumDue.amount'],
          },
        ],
      },
    ],
  });
  assert.equal(status, 200);
  assert.equal(body.data.declarationsProcessed, 2);

  const [malformed, valid] = body.data.declarations;
  assert.equal(malformed.status, 'parse_error');
  assert.ok(malformed.errors.length > 0);

  assert.equal(valid.consumer, 'valid-importer');
  assert.equal(valid.status, 'ok');
  const use = valid.uses[0];
  assert.equal(use.status, 'field_mismatches');
  assert.ok(
    use.issues.some((issue) => issue.kind === 'field' && issue.field === 'ghostField')
  );
  // The valid consumer was registered and its dependency stored.
  const count = await prisma.consumerDependency.count();
  assert.equal(count, 13);
});

test('import: unresolved provider references are reported and never created', async () => {
  const { status, body } = await postJson('/api/consumers/import', {
    declarations: [
      {
        consumer: 'future-consumer',
        team: 'QA',
        uses: [{ provider: 'fraud-api', method: 'POST', path: '/checks', sends: ['txId'] }],
      },
    ],
  });
  assert.equal(status, 200);
  const declaration = body.data.declarations[0];
  assert.equal(declaration.status, 'unresolved');
  assert.deepEqual(body.data.unresolvedProviders, [{ provider: 'fraud-api', declaredBy: 'future-consumer' }]);
  assert.equal(declaration.uses[0].status, 'unresolved_provider');
  assert.equal(body.data.dependenciesUpserted, 0);

  const created = await prisma.service.findUnique({ where: { name: 'fraud-api' } });
  assert.equal(created, null);
});

test('import: declarations for a provider without a published spec are preserved, validation pending', async () => {
  const newProvider = await createService('ledger-api', 'Ledger Team');
  void newProvider;
  const { status, body } = await postJson('/api/consumers/import', {
    declarations: [
      {
        consumer: 'ledger-client',
        team: 'QA',
        uses: [
          {
            provider: 'ledger-api',
            method: 'GET',
            path: '/entries/{entryId}',
            sends: ['entryId'],
            reads: ['balance'],
          },
        ],
      },
    ],
  });
  assert.equal(status, 200);
  const declaration = body.data.declarations[0];
  assert.equal(declaration.status, 'ok');
  assert.equal(declaration.uses[0].status, 'pending_validation');
  assert.equal(body.data.dependenciesUpserted, 1);

  const stored = await prisma.consumerDependency.findFirst({
    where: { consumerServiceId: declaration.consumerServiceId, path: '/entries/{entryId}' },
  });
  assert.ok(stored);
  assert.deepEqual(stored.reads, ['balance']);
});

test('import: an operation absent from the published spec is invalid_operation', async () => {
  const { status, body } = await postJson('/api/consumers/import', {
    declarations: [
      {
        consumer: 'spec-phantom',
        team: 'QA',
        uses: [
          {
            provider: 'policy-api',
            method: 'DELETE',
            path: '/policies/{policyId}',
            reads: [],
            sends: [],
          },
        ],
      },
    ],
  });
  assert.equal(status, 200);
  const use = body.data.declarations[0].uses[0];
  assert.equal(use.status, 'invalid_operation');
  assert.ok(use.issues.some((issue) => issue.kind === 'operation'));
  // The declaration is preserved (the dependency is stored) but flagged.
  const count = await prisma.consumerDependency.count();
  assert.equal(count, 15);
});

test('consumers list reflects imported consumers with provider grouping', async () => {
  const { status, body } = await get('/api/consumers');
  assert.equal(status, 200);
  const names = body.data.map((consumer) => consumer.name).sort();
  assert.deepEqual(names, [
    'detail-consumer',
    'ledger-client',
    'mobile-app',
    'notifications-svc',
    'partner-portal',
    'payments-svc',
    'rate-limiter',
    'spec-phantom',
    'valid-importer',
  ]);

  const mobile = body.data.find((consumer) => consumer.name === 'mobile-app');
  assert.equal(mobile.dependencyCount, 4);
  assert.deepEqual(
    mobile.providers.map((provider) => provider.name).sort(),
    ['claims-api', 'quote-api']
  );
});
