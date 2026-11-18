import { Router } from 'express';
import {
  listAllConsumers,
  registerConsumerEndpoint,
  getConsumerById,
  updateConsumerDependencies,
  importConsumerDeclarations,
} from '../controllers/consumers.controller.js';

const router = Router();

// /import must be registered before /:id, otherwise "import" would match :id.
router.post('/import', importConsumerDeclarations);
router.post('/', registerConsumerEndpoint);
router.get('/', listAllConsumers);
router.put('/:id', updateConsumerDependencies);
router.get('/:id', getConsumerById);

export default router;
