// Route registry. Feature module routers are mounted here as they land.
import { Router } from 'express';
import healthRoutes from './health.routes.js';

const router = Router();

router.use('/api/health', healthRoutes);

export default router;
