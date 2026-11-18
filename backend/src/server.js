// Server entrypoint: boots the app and owns the process lifecycle.
// dotenv loads .env if present; real environment variables always win.
import 'dotenv/config';
import app from './app.js';
import { env } from './config/env.js';
import prisma from './database/prisma.js';

const server = app.listen(env.port, () => {
  console.log(
    `[contract-guard] API listening on http://localhost:${env.port} (${env.nodeEnv})`
  );
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[contract-guard] ${signal} received, shutting down...`);

  // Force-exit if a graceful shutdown hangs.
  setTimeout(() => process.exit(1), 10_000).unref();

  server.close(async () => {
    await prisma.$disconnect().catch(() => {});
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
