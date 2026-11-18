// Dashboard & Metrics integration tests (GET /api/metrics,
// /api/metrics/services, /api/metrics/publishing).
//
// Throwaway embedded Postgres on port 55440 (concurrent test files use
// 55432/55433/55434/55435/55436/55438/55439), real migrations, full HTTP
// workflow. The first scenario asserts the empty-database contract BEFORE
// anything is seeded; the rest exercise a full workflow built through the
// real APIs (services -> specs -> consumers -> impact -> publishing).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync, rmSync } from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';

const execFileAsync = promisify(execFile);

const TEST_PORT = 55440;
const TEST_USER = 'contractguard';
const TEST_PASSWORD = 'contractguard';
const TEST_DB = 'contractguard_test_metrics';
const testDatabaseUrl = `postgresql://${TEST_USER}:${TEST_PASSWORD}@127.0.0.1:${TEST_PORT}/${TEST_DB}`;

const backendDir = fileURLToPath(new URL('..', import.meta.url));
const testDataDir = path.join(backendDir, '.embedded-pg', 'test-data-metrics');
const prismaCli = path.join(backendDir, 'node_modules', 'prisma', 'build', 'index.js');

const readSpec = (p) =>
  readFileSync(fileURLToPath(new URL(`../../specs/${p}`, import.meta.url)), 'utf8');

const policyV1 = readSpec('policy-api/1-initial.yaml');
const policyV2 = readSpec('policy-api/2-deprecations.yaml');
const policyV3 = readSpec('policy-api/3-remove-old-fields.yaml');

let pg;
let server;
let baseUrl;
let prisma;

// Captured during the seeding scenario so later assertions can compare
// against the real analysis results.
const seed = {
  policyService: null,
  mobileApp: null,
  versions: {},
  impactReport: null,
};

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
  const { default: app } = await import('../src/app.js');
  ({ default: prisma } = await import('../src/database/prisma.js'));

  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
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
    console.error('[metrics.test] teardown error:', err.message);
  }
  if (teardownFailed) process.exit(1);
});

// --- Scenario 1: empty database ---------------------------------------------

test('metrics: an empty database returns zeros, null rates and empty collections', async () => {
  const { status, body } = await get('/api/metrics');
  assert.equal(status, 200);
  assert.equal(body.success, true);
  assert.ok(body.data.generatedAt);
  assert.deepEqual(body.data.services, { total: 0, consumerCount: 0, providerCount: 0 });
  assert.deepEqual(body.data.specs, { totalVersions: 0, published: 0, proposed: 0 });
  assert.equal(body.data.compatibility.analyzedVersionCount, 0);
  assert.equal(body.data.compatibility.analysisRunCount, 0);
  assert.equal(body.data.compatibility.totalChanges, 0);
  assert.equal(body.data.compatibility.lastAnalyzedAt, null);
  assert.deepEqual(body.data.compatibility.latestRuns, []);
  assert.deepEqual(body.data.impact, {
    affectedConsumerCount: 0,
    affectedDependencyCount: 0,
    affectedChangeCount: 0,
  });
  assert.equal(body.data.publishing.attemptCount, 0);
  assert.equal(body.data.publishing.successRate, null); // no attempts: undefined, not 0
  assert.deepEqual(body.data.publishing.blockedByCode, {});
  assert.equal(body.data.publishing.lastAttemptAt, null);
  assert.deepEqual(body.data.recentActivity, []);

  const services = await get('/api/metrics/services');
  assert.equal(services.status, 200);
  assert.deepEqual(services.body.data, []);

  const publishing = await get('/api/metrics/publishing');
  assert.equal(publishing.status, 200);
  assert.equal(publishing.body.data.attemptCount, 0);
  assert.equal(publishing.body.data.successRate, null);
  assert.deepEqual(publishing.body.data.recentBlocked, []);
});

// --- Scenario 2: seed a full workflow through the real APIs ------------------

test('seed: builds services, specs, consumers, impact and a blocked publish via the API', async () => {
  const provider = await postJson('/api/services', { name: 'policy-api', owner: 'Policy Team' });
  assert.equal(provider.status, 201, provider.body);
  seed.policyService = provider.body.data;

  const consumer = await postJson('/api/services', { name: 'mobile-app', owner: 'Mobile' });
  assert.equal(consumer.status, 201, consumer.body);
  seed.mobileApp = consumer.body.data;

  const v1 = await postJson('/api/specs/upload', {
    serviceId: seed.policyService.id,
    versionLabel: 'v1',
    content: policyV1,
  });
  assert.equal(v1.status, 201, v1.body);
  seed.versions.v1 = v1.body.data;

  const v2 = await postJson('/api/specs/upload', {
    serviceId: seed.policyService.id,
    versionLabel: 'v2',
    content: policyV2,
  });
  assert.equal(v2.status, 201, v2.body);
  seed.versions.v2 = v2.body.data;

  const v3 = await postJson('/api/specs/upload', {
    serviceId: seed.policyService.id,
    versionLabel: 'v3',
    content: policyV3,
  });
  assert.equal(v3.status, 201, v3.body);
  seed.versions.v3 = v3.body.data;

  // The consumer declares a read of legacyCode, which v3 removes.
  const dep = await putJson(`/api/consumers/${seed.mobileApp.id}`, {
    dependencies: [
      {
        providerId: seed.policyService.id,
        method: 'GET',
        path: '/policies/{policyId}',
        sends: ['policyId'],
        reads: ['policyId', 'status', 'legacyCode'],
      },
    ],
  });
  assert.equal(dep.status, 200, dep.body);

  // Publish the initial version (clean — the declaration matches v1).
  const publishV1 = await postJson('/api/specs/publish', { versionId: seed.versions.v1.id });
  assert.equal(publishV1.status, 200, publishV1.body);
  assert.equal(publishV1.body.data.outcome, 'PUBLISHED');

  // Analyze v3 (vs baseline v1): mobile-app is affected (legacyCode removed).
  const impact = await get(`/api/specs/${seed.versions.v3.id}/impact`);
  assert.equal(impact.status, 200, impact.body);
  assert.ok(impact.body.data.affectedConsumerCount >= 1, impact.body.data.impact.summary);
  seed.impactReport = impact.body.data;

  // Attempt to publish v3: breaking + affected registered consumer -> BLOCKED.
  const publishV3 = await postJson('/api/specs/publish', { versionId: seed.versions.v3.id });
  assert.equal(publishV3.status, 200, publishV3.body);
  assert.equal(publishV3.body.data.outcome, 'BLOCKED');
  assert.equal(publishV3.body.data.code, 'BREAKING_CHANGES_AFFECT_CONSUMERS');

  // Re-run the analysis (a second historical run — history must be kept).
  const impactAgain = await get(`/api/specs/${seed.versions.v3.id}/impact`);
  assert.equal(impactAgain.status, 200, impactAgain.body);
});

// --- Scenario 3: service and spec counts --------------------------------------

test('metrics: service and spec counts reflect the seeded registry', async () => {
  const { body } = await get('/api/metrics');
  assert.equal(body.data.services.total, 2);
  assert.equal(body.data.services.consumerCount, 1); // mobile-app has outgoing dependencies
  assert.equal(body.data.services.providerCount, 1); // policy-api has versions + incoming deps
  assert.equal(body.data.specs.totalVersions, 3);
  assert.equal(body.data.specs.published, 1);
  assert.equal(body.data.specs.proposed, 2);
});

// --- Scenario 4: compatibility dedupes to the latest run per version ---------

test('metrics: compatibility aggregates only the latest run per proposed version', async () => {
  const { body } = await get('/api/metrics');
  const c = body.data.compatibility;
  assert.equal(c.analyzedVersionCount, 1); // only v3 was analyzed
  assert.equal(c.analysisRunCount, 2); // two historical runs of v3
  // The same changes are NOT counted twice.
  assert.equal(c.totalChanges, seed.impactReport.changeCount);
  assert.equal(c.breakingChanges, seed.impactReport.breakingChangeCount);
  assert.ok(c.lastAnalyzedAt);
  assert.equal(c.latestRuns.length, 1);
  assert.equal(c.latestRuns[0].versionLabel, 'v3');
});

// --- Scenario 5: publishing never counts a blocked attempt as successful -----

test('metrics: publishing counts blocked attempts separately from successes', async () => {
  const { body } = await get('/api/metrics');
  const p = body.data.publishing;
  assert.equal(p.attemptCount, 2); // v1 published + v3 blocked
  assert.equal(p.publishedCount, 1);
  assert.equal(p.blockedCount, 1);
  assert.equal(p.successRate, 0.5);
  assert.deepEqual(p.blockedByCode, { BREAKING_CHANGES_AFFECT_CONSUMERS: 1 });
  assert.ok(p.lastAttemptAt);
});

// --- Scenario 6: impact aggregates -------------------------------------------

test('metrics: impact aggregates affected consumers from the latest runs', async () => {
  const { body } = await get('/api/metrics');
  assert.equal(body.data.impact.affectedConsumerCount, 1);
  assert.equal(body.data.impact.affectedDependencyCount, 1);
  assert.ok(body.data.impact.affectedChangeCount >= 1);
});

// --- Scenario 7: per-service rows --------------------------------------------

test('metrics: per-service rows carry versions, baselines, dependencies and attempts', async () => {
  const { status, body } = await get('/api/metrics/services');
  assert.equal(status, 200);
  assert.equal(body.data.length, 2);
  const byName = new Map(body.data.map((row) => [row.name, row]));

  const policy = byName.get('policy-api');
  assert.equal(policy.versionCount, 3);
  assert.equal(policy.publishedVersionCount, 1);
  assert.equal(policy.currentBaseline.versionLabel, 'v1');
  assert.equal(policy.dependencyCount, 0);
  assert.equal(policy.consumerDependencyCount, 1);
  assert.equal(policy.latestAnalysis.totalChanges, seed.impactReport.changeCount);
  assert.equal(policy.publishAttemptCount, 2);

  const mobile = byName.get('mobile-app');
  assert.equal(mobile.versionCount, 0);
  assert.equal(mobile.currentBaseline, null);
  assert.equal(mobile.dependencyCount, 1);
  assert.equal(mobile.consumerDependencyCount, 0);
  assert.equal(mobile.publishAttemptCount, 0);
  assert.equal(mobile.latestAnalysis, null);
});

// --- Scenario 8: publishing view lists blocked attempts needing attention ----

test('metrics: the publishing view surfaces recent blocked attempts', async () => {
  const { status, body } = await get('/api/metrics/publishing');
  assert.equal(status, 200);
  assert.equal(body.data.attemptCount, 2);
  assert.equal(body.data.successRate, 0.5);
  assert.equal(body.data.recentBlocked.length, 1);
  const blocked = body.data.recentBlocked[0];
  assert.equal(blocked.versionLabel, 'v3');
  assert.equal(blocked.service.name, 'policy-api');
  assert.match(blocked.reason, /mobile-app/);
  assert.ok(blocked.analysisRun);
  assert.ok(blocked.analysisRun.computedAt);
});

// --- Scenario 9: recent activity feed -----------------------------------------

test('metrics: recent activity is newest first, typed and capped at ten entries', async () => {
  const { body } = await get('/api/metrics');
  const activity = body.data.recentActivity;
  assert.ok(activity.length <= 10);
  for (let i = 1; i < activity.length; i += 1) {
    assert.ok(new Date(activity[i - 1].at) >= new Date(activity[i].at));
  }
  const types = new Set(activity.map((event) => event.type));
  assert.ok(types.has('SPEC_PUBLISHED'));
  assert.ok(types.has('PUBLISH_BLOCKED'));
  assert.ok(types.has('ANALYSIS_COMPLETED'));
  assert.ok(types.has('SPEC_UPLOADED'));
  assert.ok(types.has('SERVICE_REGISTERED'));
});

// --- Scenario 10: more analysis runs add history without double counting ------

test('metrics: re-running the analysis grows history but not the aggregated totals', async () => {
  const impact = await get(`/api/specs/${seed.versions.v3.id}/impact`);
  assert.equal(impact.status, 200, impact.body);

  const { body } = await get('/api/metrics');
  assert.equal(body.data.compatibility.analysisRunCount, 3);
  assert.equal(body.data.compatibility.totalChanges, seed.impactReport.changeCount);
});

// --- Scenario 11: a clean publish advances the baseline and the rates ---------

test('metrics: a successful publish of the zero-change version advances baseline and rates', async () => {
  const impact = await get(`/api/specs/${seed.versions.v2.id}/impact`);
  assert.equal(impact.status, 200, impact.body);
  assert.equal(impact.body.data.changeCount, 0);

  const publish = await postJson('/api/specs/publish', { versionId: seed.versions.v2.id });
  assert.equal(publish.status, 200, publish.body);
  assert.equal(publish.body.data.outcome, 'PUBLISHED');
  assert.equal(publish.body.data.code, 'ALL_CHECKS_PASSED');

  const { body } = await get('/api/metrics');
  assert.equal(body.data.specs.published, 2);
  assert.equal(body.data.specs.proposed, 1);
  assert.equal(body.data.publishing.attemptCount, 3);
  assert.equal(body.data.publishing.publishedCount, 2);
  assert.equal(body.data.publishing.blockedCount, 1);
  assert.equal(body.data.publishing.successRate, 2 / 3);

  const services = await get('/api/metrics/services');
  const policy = services.body.data.find((row) => row.name === 'policy-api');
  assert.equal(policy.currentBaseline.versionLabel, 'v2');
  assert.equal(policy.publishAttemptCount, 3);
});
