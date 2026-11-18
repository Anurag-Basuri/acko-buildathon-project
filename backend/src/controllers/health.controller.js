// Reports the API's own liveness. Intentionally independent of the database;
// connectivity is verified separately via verifyConnection() in database/prisma.js.
import { env } from '../config/env.js';

export function getHealth(req, res) {
  res.status(200).json({
    success: true,
    data: {
      status: 'ok',
      service: 'contract-guard-api',
      environment: env.nodeEnv,
      uptimeSeconds: Math.round(process.uptime() * 10) / 10,
      timestamp: new Date().toISOString(),
    },
  });
}
