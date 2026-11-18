// Route registry. Feature module routers are mounted here as they land.
import { Router } from 'express';
import healthRoutes from './health.routes.js';
import servicesRoutes from './services.routes.js';
import specsRoutes from './specs.routes.js';
import consumersRoutes from './consumers.routes.js';
import metricsRoutes from './metrics.routes.js';

const router = Router();

router.use('/api/health', healthRoutes);
router.use('/api/services', servicesRoutes);
router.use('/api/specs', specsRoutes);
router.use('/api/consumers', consumersRoutes);
router.use('/api/metrics', metricsRoutes);

export default router;
