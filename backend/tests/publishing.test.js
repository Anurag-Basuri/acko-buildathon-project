// Publishing Governance integration tests (POST /api/specs/publish,
// GET /api/specs/:id/publish-history).
//
// Throwaway embedded Postgres on port 55439 (concurrent test files use
// 55432/55433/55434/55435/55436/55438), real migrations, full HTTP workflow:
// services -> specs -> consumers -> impact analysis -> publishing.
//
// A blocked publish is a business outcome: HTTP 200 with outcome "BLOCKED".
// Only unknown versions, malformed bodies and malformed ids are HTTP errors.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync, rmSync } from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';

const execFileAsync = promisify(execFile);

const TEST_PORT = 55439;
const TEST_USER = 'contractguard';
const TEST_PASSWORD = 'contractguard';
const TEST_DB = 'contractguard_test_publishing';
const testDatabaseUrl = `postgresql://${TEST_USER}:${TEST_PASSWORD}@127.0.0.1:${TEST_PORT}/${TEST_DB}`;

const backendDir = fileURLToPath(new URL('..', import.meta.url));
const testDataDir = path.join(backendDir, '.embedded-pg', 'test-data-publishing');
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
const claimsInitial = readSpec('claims-api/1-initial.yaml');
const claimsNonBreaking = readSpec('claims-api/3-channel-and-notes-fixed.yaml');
const breakingContent = readSpec('policy-api/3-remove-old-fields.yaml');
const quoteInitial = readSpec('quote-api/1-initial.yaml');

// Minimal hand-built specs for the concurrent-publish race: v1 is the
// baseline, v2 and v3 each add one OPTIONAL response field, so both are
// publishable non-breaking versions relative to v1.
const raceSpecBase = `openapi: 3.0.3
info:
  title: Race API
  version: 1.0.0
  description: 'Concurrent publish fixture.'
paths:
  /widgets:
    get:
      operationId: listWidgets
      responses:
        '200':
          description: The widgets
          content:
            application/json:
              schema:
                type: object
                required:
                - id
                properties:
                  id:
                    type: string
`;
const raceSpecV2 = raceSpecBase + `                  name:
                    type: string
`;
const raceSpecV3 = raceSpecBase + `                  color:
                    type: string
`;

let pg;
let server;
let baseUrl;
let prisma;
let app;

const services = {};
const versions = { policy: [], quote: [], ledger: [], race: [] };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function killStrayTestPostgres() {
  if (process.platform !== 'win32') return;
  try {
    const script =
      "Get-CimInstance Win32_Process -Filter \\\"Name='postgres.exe'\\\" |" +
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

async function impact(versionId) {
  const result = await get(`/api/specs/${versionId}/impact`);
  assert.equal(result.status, 200, result.body);
  return result.body.data;
}

async function publish(versionId) {
  const result = await postJson('/api/specs/publish', { versionId });
  return result;
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

  // Provider services.
  services.policy = await createService('policy-api', 'Policy Team');
  services.quote = await createService('quote-api', 'Quotes Team');
  services.claims = await createService('claims-api', 'Claims Team');
  services.ledger = await createService('ledger-api', 'Ledger Team');
  services.fresh = await createService('fresh-api', 'Fresh Team');
  services.solo = await createService('solo-api', 'Solo Team');
  services.race = await createService('race-api', 'Race Team');

  // Policy history (v1 baseline; v3 is breaking with a registered reader;
  // v4 is used for the staleness scenarios).
  for (let i = 0; i < policySpecs.length; i += 1) {
    versions.policy.push(await uploadSpec(services.policy.id, `v${i + 1}`, policySpecs[i]));
  }
  for (let i = 0; i < quoteSpecs.length; i += 1) {
    versions.quote.push(await uploadSpec(services.quote.id, `v${i + 1}`, quoteSpecs[i]));
  }

  // Claims baseline (starter-kit import validates claims uses against it).
  await uploadSpec(services.claims.id, 'v1', claimsInitial);

  // Ledger: v1 = claims initial, v2 = non-breaking jump, v3 = unrelated
  // breaking content (no registered consumers of ledger-api).
  versions.ledger.push(await uploadSpec(services.ledger.id, 'v1', claimsInitial));
  versions.ledger.push(await uploadSpec(services.ledger.id, 'v2', claimsNonBreaking));
  versions.ledger.push(await uploadSpec(services.ledger.id, 'v3', breakingContent));

  // Fresh (initial-version declaration mismatch) and solo (clean initial).
  await uploadSpec(services.fresh.id, 'v1', quoteInitial);
  await uploadSpec(services.solo.id, 'v1', quoteInitial);

  // Race fixture for concurrent publishes.
  versions.race.push(await uploadSpec(services.race.id, 'v1', raceSpecBase));
  versions.race.push(await uploadSpec(services.race.id, 'v2', raceSpecV2));
  versions.race.push(await uploadSpec(services.race.id, 'v3', raceSpecV3));

  // Baselines: policy v1, quote v1, claims v1, ledger v1.
  await markPublished(versions.policy[0].id);
  await markPublished(versions.quote[0].id);
  await markPublished(
    (await prisma.apiVersion.findFirst({ where: { serviceId: services.claims.id } })).id
  );
  await markPublished(versions.ledger[0].id);

  // Registered consumers (starter kit: mobile-app, partner-portal,
  // payments-svc, notifications-svc — 10 dependencies).
  const imported = await postJson('/api/consumers/import', {});
  assert.equal(imported.status, 200, imported.body);
  assert.equal(imported.body.data.dependenciesUpserted, 10);

  // A consumer declaring an operation absent from fresh-api v1.
  const freshClient = await createService('fresh-client', 'QA');
  const dep = await putJson(`/api/consumers/${freshClient.id}`, {
    dependencies: [
      {
        providerId: services.fresh.id,
        method: 'GET',
        path: '/ghost',
        sends: ['ghostId'],
        reads: ['ghostValue'],
      },
    ],
  });
  assert.equal(dep.status, 200, dep.body);
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
    console.error('[publishing.test] teardown error:', err.message);
  }
  if (teardownFailed) process.exit(1);
});

// --- Scenario 1: analysis not completed -------------------------------------

test('publish: a version without a completed analysis is BLOCKED ANALYSIS_NOT_COMPLETED', async () => {
  const { status, body } = await publish(versions.policy[1].id); // policy v2
  assert.equal(status, 200, body);
  assert.equal(body.success, true);
  assert.equal(body.data.outcome, 'BLOCKED');
  assert.equal(body.data.code, 'ANALYSIS_NOT_COMPLETED');
  assert.ok(body.data.attemptId);
  assert.equal(body.data.analysisRunId, null);

  // Nothing changed: the version is still PROPOSED and the attempt is stored.
  const stored = await prisma.apiVersion.findUnique({ where: { id: versions.policy[1].id } });
  assert.equal(stored.status, 'PROPOSED');
  const attempts = await prisma.publishAttempt.findMany({
    where: { versionId: versions.policy[1].id },
  });
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].outcome, 'BLOCKED');
});

// --- Scenario 2: breaking + affected registered consumer --------------------

test('publish: breaking changes affecting registered consumers are BLOCKED with details', async () => {
  const impactReport = await impact(versions.policy[2].id); // policy v3 vs v1
  assert.equal(impactReport.impact.summary.affectedConsumerCount, 1);

  const { status, body } = await publish(versions.policy[2].id);
  assert.equal(status, 200, body);
  assert.equal(body.data.outcome, 'BLOCKED');
  assert.equal(body.data.code, 'BREAKING_CHANGES_AFFECT_CONSUMERS');
  assert.match(body.data.reason, /payments-svc/);
  assert.equal(body.data.affectedConsumers.length, 1);
  assert.equal(body.data.affectedConsumers[0].name, 'payments-svc');
  assert.equal(body.data.analysisRunId, impactReport.analysisRunId);

  // A blocked publish never changes the published baseline.
  const baseline = await prisma.apiVersion.findFirst({
    where: { serviceId: services.policy.id, status: 'PUBLISHED' },
    orderBy: { createdAt: 'desc' },
  });
  assert.equal(baseline.id, versions.policy[0].id);
});

// --- Scenario 3: UNKNOWN changes block --------------------------------------

test('publish: UNKNOWN changes are BLOCKED until reviewed', async () => {
  const impactReport = await impact(versions.quote[1].id); // quote v2: PARAMETER_RENAMED
  assert.equal(impactReport.unknownChangeCount, 1);

  const { status, body } = await publish(versions.quote[1].id);
  assert.equal(status, 200, body);
  assert.equal(body.data.outcome, 'BLOCKED');
  assert.equal(body.data.code, 'UNKNOWN_CHANGES');
  assert.match(body.data.reason, /UNKNOWN/);
  assert.equal(body.data.decisionDetails.unknownChanges.length, 1);
});

// --- Scenario 4: stale analysis (dependencies changed) ----------------------

test('publish: changed consumer dependencies make the analysis stale', async () => {
  await impact(versions.policy[3].id); // policy v4 vs v1

  // payments-svc starts reading one more field -> dependency state changed.
  const payments = await prisma.service.findUnique({ where: { name: 'payments-svc' } });
  const updated = await putJson(`/api/consumers/${payments.id}`, {
    dependencies: [
      {
        providerId: services.policy.id,
        method: 'GET',
        path: '/policies/{policyId}',
        sends: ['policyId'],
        reads: ['policyId', 'status', 'legacyCode', 'holder.email'],
      },
    ],
  });
  assert.equal(updated.status, 200, updated.body);

  const { status, body } = await publish(versions.policy[3].id);
  assert.equal(status, 200, body);
  assert.equal(body.data.outcome, 'BLOCKED');
  assert.equal(body.data.code, 'STALE_ANALYSIS');
  assert.match(body.data.reason, /consumer dependency declarations changed/);
});

// --- Scenario 5: stale analysis (baseline changed) --------------------------

test('publish: a changed published baseline makes the analysis stale', async () => {
  await impact(versions.policy[3].id); // fresh run, still against baseline v1

  // Publish policy v2 (zero changes) to advance the baseline.
  await impact(versions.policy[1].id);
  const published = await publish(versions.policy[1].id);
  assert.equal(published.status, 200, published.body);
  assert.equal(published.body.data.outcome, 'PUBLISHED');
  assert.equal(published.body.data.code, 'ALL_CHECKS_PASSED');

  // The latest policy-v4 run was computed against the old baseline.
  const { status, body } = await publish(versions.policy[3].id);
  assert.equal(status, 200, body);
  assert.equal(body.data.outcome, 'BLOCKED');
  assert.equal(body.data.code, 'STALE_ANALYSIS');
  assert.match(body.data.reason, /published baseline changed/);
});

// --- Scenario 6: stale analysis (content changed) ---------------------------

test('publish: specification content drift makes the analysis stale', async () => {
  await impact(versions.policy[3].id); // fresh run against baseline v2

  // The stored content is immutable through the API; simulate external
  // drift (still valid YAML, different bytes).
  const version = await prisma.apiVersion.findUnique({ where: { id: versions.policy[3].id } });
  await prisma.apiVersion.update({
    where: { id: version.id },
    data: { originalContent: `${version.originalContent}\n# touched after analysis\n` },
  });

  const { status, body } = await publish(versions.policy[3].id);
  assert.equal(status, 200, body);
  assert.equal(body.data.outcome, 'BLOCKED');
  assert.equal(body.data.code, 'STALE_ANALYSIS');
  assert.match(body.data.reason, /specification content changed/);
});

// --- Scenario 7: clean non-breaking publish ---------------------------------

test('publish: a clean non-breaking change publishes and advances the baseline', async () => {
  const impactReport = await impact(versions.ledger[1].id); // ledger v2 vs v1
  assert.equal(impactReport.breakingChangeCount, 0);
  assert.equal(impactReport.unknownChangeCount, 0);
  assert.equal(impactReport.changeCount, 3);

  const { status, body } = await publish(versions.ledger[1].id);
  assert.equal(status, 200, body);
  assert.equal(body.data.outcome, 'PUBLISHED');
  assert.equal(body.data.code, 'ALL_CHECKS_PASSED');
  assert.equal(body.data.warnings.length, 0);

  const stored = await prisma.apiVersion.findUnique({ where: { id: versions.ledger[1].id } });
  assert.equal(stored.status, 'PUBLISHED');
  const baseline = await prisma.apiVersion.findFirst({
    where: { serviceId: services.ledger.id, status: 'PUBLISHED' },
    orderBy: { createdAt: 'desc' },
  });
  assert.equal(baseline.id, versions.ledger[1].id);
});

// --- Scenario 8: breaking without registered impact -> warning --------------

test('publish: breaking changes without registered impact publish WITH a warning', async () => {
  const impactReport = await impact(versions.ledger[2].id); // ledger v3 vs v2
  assert.ok(impactReport.breakingChangeCount > 0);
  assert.equal(impactReport.impact.summary.affectedConsumerCount, 0);

  const { status, body } = await publish(versions.ledger[2].id);
  assert.equal(status, 200, body);
  assert.equal(body.data.outcome, 'PUBLISHED');
  assert.equal(body.data.code, 'ALL_CHECKS_PASSED');
  assert.equal(body.data.warnings.length, 1);
  assert.match(body.data.warnings[0], /BREAKING_NO_REGISTERED_IMPACT/);
  assert.match(body.data.warnings[0], /NOT guaranteed safe/);
});

// --- Scenario 9: clean initial version ---------------------------------------

test('publish: a clean initial version publishes without any comparison', async () => {
  const { status, body } = await publish(versions.solo.id === undefined ? 'nope' : null);
  void status;
  void body;
  // (placeholder kept out; real assertion below)
});

test('publish: a clean initial version publishes without any comparison (real)', async () => {
  const soloVersion = await prisma.apiVersion.findFirst({
    where: { serviceId: services.solo.id },
  });
  const { status, body } = await publish(soloVersion.id);
  assert.equal(status, 200, body);
  assert.equal(body.data.outcome, 'PUBLISHED');
  assert.equal(body.data.code, 'INITIAL_VERSION_PUBLISHED');
  assert.equal(body.data.warnings.length, 0);
  assert.equal(body.data.analysisRunId, null);
});

// --- Scenario 10: initial version with declaration mismatch -----------------

test('publish: an initial version with mismatched declarations publishes with warnings', async () => {
  const freshVersion = await prisma.apiVersion.findFirst({
    where: { serviceId: services.fresh.id },
  });
  const { status, body } = await publish(freshVersion.id);
  assert.equal(status, 200, body);
  assert.equal(body.data.outcome, 'PUBLISHED');
  assert.equal(body.data.code, 'INITIAL_VERSION_PUBLISHED');
  assert.ok(body.data.warnings.length >= 1);
  assert.match(body.data.warnings[0], /fresh-client/);
});

// --- Scenario 11: duplicate publish ------------------------------------------

test('publish: publishing an already published version is a 409 ALREADY_PUBLISHED', async () => {
  const first = await publish(versions.policy[1].id); // policy v2 was published above
  assert.equal(first.status, 409);
  assert.equal(first.body.error.code, 'ALREADY_PUBLISHED');
  const second = await publish(versions.policy[1].id);
  assert.equal(second.status, 409);
  assert.equal(second.body.error.code, 'ALREADY_PUBLISHED');
});

// --- Scenario 12: publish history shape and ordering -------------------------

test('publish: history lists attempts newest first with outcome, reason, warnings and analysis ref', async () => {
  const { status, body } = await get(`/api/specs/${versions.policy[3].id}/publish-history`);
  assert.equal(status, 200, body);
  assert.equal(body.data.version.id, versions.policy[3].id);
  assert.equal(body.data.version.versionLabel, 'v4');
  const attempts = body.data.attempts;
  assert.ok(attempts.length >= 3);
  for (const attempt of attempts) {
    assert.ok(attempt.id);
    assert.ok(['PUBLISHED', 'BLOCKED'].includes(attempt.outcome));
    assert.equal(typeof attempt.reason, 'string');
    assert.ok(Array.isArray(attempt.warnings));
    assert.equal(typeof attempt.decisionDetails, 'object');
    assert.ok(
      attempt.analysisRun === null ||
        (typeof attempt.analysisRun === 'object' && attempt.analysisRun.id)
    );
    assert.equal(typeof attempt.createdAt, 'string');
  }
  // Newest first: createdAt is non-increasing.
  for (let i = 1; i < attempts.length; i += 1) {
    assert.ok(new Date(attempts[i - 1].createdAt) >= new Date(attempts[i].createdAt));
  }
});

// --- Scenario 13: blocked attempts are persisted, history never rewritten ----

test('publish: blocked attempts are persisted alongside successful ones and never deleted', async () => {
  const v4Attempts = await prisma.publishAttempt.findMany({
    where: { versionId: versions.policy[3].id },
  });
  // One blocked attempt each from the staleness scenarios.
  assert.ok(v4Attempts.length >= 3);
  assert.ok(v4Attempts.every((attempt) => attempt.outcome === 'BLOCKED'));
  const codes = new Set(v4Attempts.map((attempt) => attempt.decisionDetails?.code ?? null));
  assert.ok(codes.has('STALE_ANALYSIS'));

  const v2Attempts = await prisma.publishAttempt.findMany({
    where: { versionId: versions.policy[1].id },
  });
  assert.ok(v2Attempts.some((attempt) => attempt.outcome === 'PUBLISHED'));

  // The blocked v4 never became the baseline.
  const baseline = await prisma.apiVersion.findFirst({
    where: { serviceId: services.policy.id, status: 'PUBLISHED' },
    orderBy: { createdAt: 'desc' },
  });
  assert.equal(baseline.id, versions.policy[1].id);
});

// --- Scenario 14: error handling ---------------------------------------------

test('publish: unknown version is 404, malformed bodies are 400, malformed id is 400', async () => {
  const unknown = await postJson('/api/specs/publish', {
    versionId: '00000000-0000-4000-8000-000000000000',
  });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.error.code, 'SPEC_VERSION_NOT_FOUND');

  const empty = await postJson('/api/specs/publish', {});
  assert.equal(empty.status, 400);
  assert.equal(empty.body.error.code, 'VALIDATION_ERROR');

  const badId = await postJson('/api/specs/publish', { versionId: 'not-a-uuid' });
  assert.equal(badId.status, 400);
  assert.equal(badId.body.error.code, 'VALIDATION_ERROR');

  const history = await get('/api/specs/not-a-uuid/publish-history');
  assert.equal(history.status, 400);
  assert.equal(history.body.error.code, 'INVALID_ID');
});

// --- Scenario 15: concurrent publishes -----------------------------------------

test('publish: concurrent publishes of two analyzed versions — exactly one wins', async () => {
  // Publish the race baseline (initial version).
  const raceV1 = await publish(versions.race[0].id);
  assert.equal(raceV1.status, 200, raceV1.body);
  assert.equal(raceV1.body.data.outcome, 'PUBLISHED');
  assert.equal(raceV1.body.data.code, 'INITIAL_VERSION_PUBLISHED');

  // Both versions analyzed against the same baseline (race v1).
  await impact(versions.race[1].id);
  await impact(versions.race[2].id);

  // Fire both publishes at the same time.
  const [first, second] = await Promise.all([
    publish(versions.race[1].id),
    publish(versions.race[2].id),
  ]);
  assert.equal(first.status, 200, first.body);
  assert.equal(second.status, 200, second.body);

  const outcomes = [first.body.data.outcome, second.body.data.outcome].sort();
  assert.deepEqual(outcomes, ['BLOCKED', 'PUBLISHED']);

  const winner = first.body.data.outcome === 'PUBLISHED' ? first.body.data : second.body.data;
  const loser = first.body.data.outcome === 'BLOCKED' ? first.body.data : second.body.data;
  assert.equal(winner.code, 'ALL_CHECKS_PASSED');
  assert.equal(loser.code, 'STALE_ANALYSIS');
  assert.match(loser.reason, /published baseline changed/);

  // Exactly one PUBLISHED attempt exists; the loser stayed PROPOSED.
  const attempts = await prisma.publishAttempt.findMany({
    where: {
      versionId: { in: [versions.race[1].id, versions.race[2].id] },
    },
  });
  assert.equal(attempts.filter((attempt) => attempt.outcome === 'PUBLISHED').length, 1);
  assert.equal(attempts.length, 2);

  const winnerVersion = await prisma.apiVersion.findUnique({
    where: { id: winner.versionId },
  });
  const loserVersion = await prisma.apiVersion.findUnique({
    where: { id: loser.versionId },
  });
  assert.equal(winnerVersion.status, 'PUBLISHED');
  assert.equal(loserVersion.status, 'PROPOSED');

  // The published baseline is the winner.
  const baseline = await prisma.apiVersion.findFirst({
    where: { serviceId: services.race.id, status: 'PUBLISHED' },
    orderBy: { createdAt: 'desc' },
  });
  assert.equal(baseline.id, winnerVersion.id);
});

// --- Scenario 16: history of a version with no attempts ------------------------

test('publish: history for a version with no attempts is an empty list', async () => {
  const { status, body } = await get(`/api/specs/${versions.policy[0].id}/publish-history`);
  assert.equal(status, 200, body);
  assert.deepEqual(body.data.attempts, []);
});
