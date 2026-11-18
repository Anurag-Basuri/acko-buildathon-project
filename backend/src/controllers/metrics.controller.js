// HTTP handling for Dashboard & Metrics.
//
// All data is read from the database at request time — no caching, no mock
// data. Every endpoint returns the API success envelope and degrades
// gracefully on an empty database (zeros and null timestamps).
import {
  getMetrics,
  getRecentActivity,
  getServiceMetrics,
  getPublishingMetrics,
} from '../services/metrics.service.js';

// GET /api/metrics — the dashboard overview payload.
export async function getMetricsEndpoint(req, res) {
  const metrics = await getMetrics();
  const activity = await getRecentActivity();
  res.json({ success: true, data: { ...metrics, recentActivity: activity } });
}

// GET /api/metrics/services — per-service overview rows.
export async function getServiceMetricsEndpoint(req, res) {
  const services = await getServiceMetrics();
  res.json({ success: true, data: services });
}

// GET /api/metrics/publishing — publishing-focused metrics.
export async function getPublishingMetricsEndpoint(req, res) {
  const publishing = await getPublishingMetrics();
  res.json({ success: true, data: publishing });
}
