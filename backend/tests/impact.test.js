// Consumer Impact Analysis integration tests (GET /api/specs/:id/impact).
//
// Throwaway embedded Postgres on port 55438 (concurrent test files use
// 55432/55433/55434/55435/55436), real migrations, full HTTP workflow:
// services -> specs -> consumers -> impact analysis.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync, rmSync } from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';

const execFileAsync = promisify(execFile);

const TEST_PORT = 55438;
const TEST_USER = 'contractguard';
const TEST_PASSWORD = 'contractguard';
const TEST_DB = 'contractguard_test_impact';
const testDatabaseUrl = `postgresql://${TEST_USER}:${TEST_PASSWORD}@127.0.0.1:${TEST_PORT}/${TEST_DB}`;

const backendDir = fileURLToPath(new URL('..', import.meta.url));
const testDataDir = path.join(backendDir, '.embedded-pg', 'test-data-impact');
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

let pg;
let server;
let baseUrl;
let prisma;
let app;

let policyService;
let quoteService;
let soloService;
const policyVersions = [];
const quoteVersions = [];

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
    // best effort
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

  await prisma.analysisRun.deleteMany();
  await prisma.apiVersion.deleteMany();
  await prisma.consumerDependency.deleteMany();
  await prisma.service.deleteMany();

  // Providers with fixture histories; policy v1 and quote v1 published.
  const policyCreated = await postJson('/api/services', { name: 'policy-api', owner: 'Policy Team' });
  policyService = policyCreated.body.data;
  const quoteCreated = await postJson('/api/services', { name: 'quote-api', owner: 'Quotes Team' });
  quoteService = quoteCreated.body.data;
  const soloCreated = await postJson('/api/services', { name: 'solo-api', owner: 'Solo Team' });
  soloService = soloCreated.body.data;

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
  const soloUploaded = await postJson('/api/specs/upload', {
    serviceId: soloService.id,
    versionLabel: 'v1',
    content: quoteSpecs[0],
  });
  assert.equal(soloUploaded.status, 201);

  await prisma.apiVersion.update({ where: { id: policyVersions[0].id }, data: { status: 'PUBLISHED' } });
  await prisma.apiVersion.update({ where: { id: quoteVersions[0].id }, data: { status: 'PUBLISHED' } });

  // Starter-kit consumer declarations (mobile-app, partner-portal,
  // payments-svc, notifications-svc — 10 dependencies).
  const imported = await postJson('/api/consumers/import', {});
  assert.equal(imported.status, 200, imported.body);
  assert.equal(imported.body.data.dependenciesUpserted, 10);
});

after(async () => {
  let teardownFailed = false;
  try {
    if (server) {
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
    console.error('[impact.test] teardown error:', err.message);
  }
  if (teardownFailed) process.exit(1);
});

// --- Error handling ---------------------------------------------------------

test('impact: initial version without a published baseline is a 400 NO_PUBLISHED_BASELINE', async () => {
  const versions = (await get(`/api/services/${soloService.id}/versions`)).body.data;
  const soloV1 = versions[0];
  const { status, body } = await get(`/api/specs/${soloV1.id}/impact`);
  assert.equal(status, 400);
  assert.equal(body.error.code, 'NO_PUBLISHED_BASELINE');
});

test('impact: analyzing the current baseline itself is a 400 INVALID_ANALYSIS', async () => {
  const { status, body } = await get(`/api/specs/${policyVersions[0].id}/impact`);
  assert.equal(status, 400);
  assert.equal(body.error.code, 'INVALID_ANALYSIS');
});

test('impact: unknown version id is a 404', async () => {
  const { status, body } = await get(
    '/api/specs/00000000-0000-4000-8000-000000000000/impact'
  );
  assert.equal(status, 404);
  assert.equal(body.error.code, 'SPEC_VERSION_NOT_FOUND');
});

test('impact: malformed id is a 400', async () => {
  const { status, body } = await get('/api/specs/not-a-uuid/impact');
  assert.equal(status, 400);
  assert.equal(body.error.code, 'INVALID_ID');
});

// --- Analysis results --------------------------------------------------------

test('impact: a parameter rename produces UNKNOWN findings for consumers sending the old name', async () => {
  const { status, body } = await get(`/api/specs/${quoteVersions[1].id}/impact`);
  assert.equal(status, 200, body);

  const { data } = body;
  assert.equal(data.changeCount, 1);
  assert.equal(data.breakingChangeCount, 0);
  assert.equal(data.unknownChangeCount, 1);

  // mobile-app and notifications-svc both declare GET /quotes/{id} and send
  // the "id" parameter; partner-portal declares POST /quotes (unaffected).
  assert.equal(data.affectedConsumerCount, 2);
  const names = data.impact.summary.affectedConsumers.map((c) => c.name).sort();
  assert.deepEqual(names, ['mobile-app', 'notifications-svc']);
  assert.equal(data.impact.findings.length, 2);
  for (const finding of data.impact.findings) {
    assert.equal(finding.change.classification, 'UNKNOWN');
    assert.equal(finding.change.changeType, 'PARAMETER_RENAMED');
    assert.equal(finding.dependency.direction, 'SENDS');
    assert.equal(finding.dependency.declaredFieldPath, 'id');
  }
  // partner-portal declares an operation, but an unaffected one.
  assert.deepEqual(data.impact.summary.noMatchingDeclaration.consumers.map((c) => c.name), [
    'partner-portal',
    'payments-svc',
  ]);
});

test('impact: removed response fields produce BREAKING findings for readers only', async () => {
  // policy v3 (baseline v1): legacyCode and holder.phone removed.
  const { status, body } = await get(`/api/specs/${policyVersions[2].id}/impact`);
  assert.equal(status, 200, body);
  const { data } = body;

  assert.equal(data.breakingChangeCount, data.changeCount); // all removals
  const findings = data.impact.findings;

  const legacyCodeFinding = findings.find(
    (f) => f.change.fieldPath === 'response.200.legacyCode'
  );
  assert.ok(legacyCodeFinding, 'expected a finding for the removed legacyCode field');
  assert.equal(legacyCodeFinding.consumer.name, 'payments-svc');
  assert.equal(legacyCodeFinding.change.classification, 'BREAKING');
  assert.equal(legacyCodeFinding.dependency.direction, 'READS');
  assert.deepEqual(legacyCodeFinding.dependency.matchedDeclaredFields, ['legacyCode']);
  assert.match(legacyCodeFinding.reason, /payments-svc declares that it reads legacyCode/);

  // notifications-svc reads holder.email — the sibling field holder.phone
  // removal must NOT produce a finding for it.
  const holderFindings = findings.filter((f) => (f.change.fieldPath ?? '').includes('holder.'));
  for (const finding of holderFindings) {
    assert.notEqual(finding.consumer.name, 'notifications-svc');
  }
  assert.equal(data.impact.summary.affectedConsumerCount, 1);
});

test('impact: array field removals match declared array paths', async () {
  // quote v3 (baseline v1) removes premium.breakdown[].amount.
  const { status, body } = await get(`/api/specs/${quoteVersions[2].id}/impact`);
  assert.equal(status, 200, body);
  const { data } = body;

  const amountFindings = data.impact.findings.filter(
    (f) =>
      f.change.fieldPath === 'response.201.premium.breakdown[].amount' ||
      f.change.fieldPath === 'response.200.premium.breakdown[].amount'
  );
  assert.equal(amountFindings.length, 2); // POST /quotes (201) + GET /quotes/{id} (200)
  for (const finding of amountFindings) {
    assert.equal(finding.consumer.name, 'mobile-app');
    assert.deepEqual(finding.dependency.matchedDeclaredFields, ['premium.breakdown[].amount']);
    assert.equal(finding.change.classification, 'BREAKING');
  }

  // partner-portal declares the operations but does not read .amount.
  const partnerFindings = data.impact.findings.filter((f) => f.consumer.name === 'partner-portal');
  assert.equal(partnerFindings.length, 0);
  assert.ok(
    data.impact.summary.noMatchingDeclaration.consumers.some((c) => c.name === 'partner-portal')
  );
});

test('impact: the result is deterministic across repeated calls', async () => {
  const a = await get(`/api/specs/${quoteVersions[2].id}/impact`);
  const b = await get(`/api/specs/${quoteVersions[2].id}/impact`);
  assert.equal(a.status, 200);
  assert.deepEqual(a.body.data.impact.findings, b.body.data.impact.findings);
  assert.deepEqual(a.body.data.impact.summary, b.body.data.impact.summary);
  // Each call persists a fresh historical run.
  assert.notEqual(a.body.data.analysisRunId, b.body.data.analysisRunId);
  const runs = await prisma.analysisRun.count({
    where: { proposedVersionId: quoteVersions[2].id },
  });
  assert.ok(runs >= 2);
});

test('impact: changing a dependency after analysis changes the fingerprint and keeps history', async () => {
  const first = await get(`/api/specs/${policyVersions[2].id}/impact`);
  assert.equal(first.status, 200);
  const firstFingerprint = first.body.data.dependencyFingerprint;

  // payments-svc starts reading holder.email too.
  const payments = await prisma.service.findUnique({ where: { name: 'payments-svc' } });
  const updated = await putJson(`/api/consumers/${payments.id}`, {
    dependencies: [
      {
        providerId: policyService.id,
        method: 'GET',
        path: '/policies/{policyId}',
        sends: ['policyId'],
        reads: ['policyId', 'status', 'premiumDue.amount', 'premiumDue.dueDate', 'legacyCode', 'holder.email'],
      },
    ],
  });
  assert.equal(updated.status, 200);

  const second = await get(`/api/specs/${policyVersions[2].id}/impact`);
  assert.equal(second.status, 200);
  assert.notEqual(second.body.data.dependencyFingerprint, firstFingerprint);
  assert.notEqual(second.body.data.analysisRunId, first.body.data.analysisRunId);

  // Both historical runs are preserved (the first was computed against the
  // older dependency state and is not rewritten).
  const runs = await prisma.analysisRun.findMany({
    where: { proposedVersionId: policyVersions[2].id },
    orderBy: { createdAt: 'asc' },
  });
  assert.ok(runs.length >= 2);
  assert.equal(runs[0].dependencyFingerprint, firstFingerprint);
});

test('impact: response carries version metadata, counts, changes and findings', async () => {
  const { status, body } = await get(`/api/specs/${quoteVersions[2].id}/impact`);
  assert.equal(status, 200);
  const { data } = body;
  assert.equal(data.serviceId, quoteService.id);
  assert.equal(data.service.name, 'quote-api');
  assert.equal(data.proposedVersion.id, quoteVersions[2].id);
  assert.equal(data.baselineVersion.id, quoteVersions[0].id);
  assert.equal(data.baselineVersion.versionLabel, 'v1');
  assert.ok(data.analysisRunId);
  assert.equal(typeof data.dependencyFingerprint, 'string');
  assert.equal(data.dependencyFingerprint.length, 64); // sha256 hex
  assert.equal(data.changeCount, data.changes.length);
  assert.equal(data.breakingChangeCount + data.nonBreakingChangeCount + data.unknownChangeCount, data.changeCount);
  for (const change of data.changes) {
    assert.ok(change.classification);
    assert.ok(change.ruleId);
    assert.ok(change.reason);
  }
  assert.equal(data.impact.summary.basedOn, 'registered consumer declarations');
});
