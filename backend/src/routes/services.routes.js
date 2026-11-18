import { Router } from 'express';
import {
  registerService,
  listAllServices,
  getSingleService,
  getServiceVersions,
} from '../controllers/service-registry.controller.js';

const router = Router();

router.post('/', registerService);
router.get('/', listAllServices);
router.get('/:id', getSingleService);
router.get('/:id/versions', getServiceVersions);

export default router;
