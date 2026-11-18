import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const backendDir = fileURLToPath(new URL('..', import.meta.url));

test('env.js fails fast when DATABASE_URL is missing', async () => {
  const cleanEnv = { ...process.env };
  delete cleanEnv.DATABASE_URL;
  await assert.rejects(
    execFileAsync(
      process.execPath,
      ['--input-type=module', '-e', "await import('./src/config/env.js');"],
      { cwd: backendDir, env: cleanEnv }
    ),
    /Missing required environment variable: DATABASE_URL/
  );
});

test('env.js loads with a valid configuration', async () => {
  const cleanEnv = {
    ...process.env,
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  };
  delete cleanEnv.PORT;
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "const { env } = await import('./src/config/env.js'); console.log(JSON.stringify(env));",
    ],
    { cwd: backendDir, env: cleanEnv }
  );
  const parsed = JSON.parse(stdout.trim().split('\n').pop());
  assert.equal(parsed.port, 3000);
  assert.equal(parsed.databaseUrl, 'postgresql://user:pass@localhost:5432/db');
  assert.equal(parsed.webhookTargetUrl, 'http://localhost:9900');
});

test('env.js rejects an invalid PORT', async () => {
  const cleanEnv = {
    ...process.env,
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
    PORT: 'not-a-port',
  };
  await assert.rejects(
    execFileAsync(
      process.execPath,
      ['--input-type=module', '-e', "await import('./src/config/env.js');"],
      { cwd: backendDir, env: cleanEnv }
    ),
    /Invalid PORT/
  );
});
