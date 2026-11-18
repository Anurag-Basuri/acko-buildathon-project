import { Router } from 'express';
import {
  getMetricsEndpoint,
  getServiceMetricsEndpoint,
  getPublishingMetricsEndpoint,
} from '../controllers/metrics.controller.js';

const router = Router();

router.get('/', getMetricsEndpoint);
router.get('/services', getServiceMetricsEndpoint);
router.get('/publishing', getPublishingMetricsEndpoint);

export default router;
