import { Router } from 'express';
import {
  registerService,
  listAllServices,
  getSingleService,
  getServiceVersions,
} from '../controllers/service-registry.controller.js';
import { getProviderConsumers } from '../controllers/consumers.controller.js';

const router = Router();

router.post('/', registerService);
router.get('/', listAllServices);
router.get('/:id', getSingleService);
router.get('/:id/versions', getServiceVersions);
// Registered consumers that depend on this service as a provider.
router.get('/:id/consumers', getProviderConsumers);

export default router;
