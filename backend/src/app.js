// Application wiring (framework configuration only).
// src/server.js is responsible for listening and process lifecycle, so the
// app can be imported by tests without opening a port.
import express from 'express';
import routes from './routes/index.js';
import { notFoundHandler } from './middleware/not-found.js';
import { errorHandler } from './middleware/error-handler.js';

export function createApp() {
  const app = express();

  app.use(express.json({ limit: '1mb' }));
  app.use(routes);
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

export default createApp();
