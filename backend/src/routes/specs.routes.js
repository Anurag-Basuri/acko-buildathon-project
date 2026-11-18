import { Router } from 'express';
import {
  validateSpec,
  uploadSpec,
  diffSpecs,
  getSpecVersionById,
} from '../controllers/specs.controller.js';
import { getImpactAnalysis } from '../controllers/impact.controller.js';
import {
  publishSpecVersionEndpoint,
  getPublishHistoryEndpoint,
} from '../controllers/publishing.controller.js';

const router = Router();

router.post('/validate', validateSpec);
router.post('/upload', uploadSpec);
router.post('/publish', publishSpecVersionEndpoint);
// /diff must be registered before /:id, otherwise "diff" would match :id.
router.get('/diff', diffSpecs);
// Parameterized routes before the bare /:id.
router.get('/:id/impact', getImpactAnalysis);
router.get('/:id/publish-history', getPublishHistoryEndpoint);
router.get('/:id', getSpecVersionById);

export default router;
