// Application wiring (framework configuration only).
// src/server.js is responsible for listening and process lifecycle, so the
// app can be imported by tests without opening a port.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import routes from './routes/index.js';
import { notFoundHandler } from './middleware/not-found.js';
import { errorHandler } from './middleware/error-handler.js';

// The build-free static frontend (no framework, no build step) lives in
// <project root>/frontend and is served from the API origin, so the SPA can
// call /api/* with same-origin fetch.
const frontendDir = path.resolve(fileURLToPath(new URL('..', import.meta.url)), '..', '..', 'frontend');

export function createApp() {
  const app = express();

  app.use(express.json({ limit: '1mb' }));
  app.use(express.static(frontendDir));
  app.use(routes);
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

export default createApp();
