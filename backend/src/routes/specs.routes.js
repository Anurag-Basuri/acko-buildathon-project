import { Router } from 'express';
import {
  validateSpec,
  uploadSpec,
  diffSpecs,
  getSpecVersionById,
} from '../controllers/specs.controller.js';

const router = Router();

router.post('/validate', validateSpec);
router.post('/upload', uploadSpec);
// /diff must be registered before /:id, otherwise "diff" would match :id.
router.get('/diff', diffSpecs);
router.get('/:id', getSpecVersionById);

export default router;
