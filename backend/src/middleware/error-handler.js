// Centralised error handling. Emits the consistent JSON error envelope:
// { "error": { "code", "message", "details?" } }
import { env } from '../config/env.js';

export function errorHandler(err, req, res, next) {
  // next is unused; the 4-arg signature marks this as Express error middleware.
  const status = Number.isInteger(err.status) ? err.status : 500;
  const isServerError = status >= 500;
  const exposeMessage = !isServerError || env.nodeEnv !== 'production';

  if (isServerError) {
    console.error(`[error] ${req.method} ${req.path}:`, err);
  }

  const bodyParseFailed = err.type === 'entity.parse.failed';

  res.status(status).json({
    error: {
      code: err.code || (bodyParseFailed ? 'INVALID_JSON' : 'INTERNAL_ERROR'),
      message: bodyParseFailed
        ? 'Request body is not valid JSON'
        : exposeMessage
          ? err.message || 'Internal server error'
          : 'Internal server error',
      ...(Array.isArray(err.details) ? { details: err.details } : {}),
    },
  });
}
