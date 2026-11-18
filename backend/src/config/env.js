// Centralised environment configuration.
// Loaded once at startup; the process fails fast when a required variable is missing.

const REQUIRED_VARS = ['DATABASE_URL'];

function readRequired(name) {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function loadEnv() {
  for (const name of REQUIRED_VARS) {
    readRequired(name);
  }

  const portRaw = process.env.PORT;
  const port =
    portRaw === undefined || portRaw === '' ? 3000 : Number.parseInt(portRaw, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT: ${portRaw}`);
  }

  return Object.freeze({
    nodeEnv: process.env.NODE_ENV || 'development',
    port,
    databaseUrl: readRequired('DATABASE_URL'),
    webhookTargetUrl: process.env.WEBHOOK_TARGET_URL || 'http://localhost:9900',
  });
}

export const env = loadEnv();
