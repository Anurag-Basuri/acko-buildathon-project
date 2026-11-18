// HTTP handling for the Service Registry. Delegates all business logic and
// database access to the service layer.
import {
  createService,
  listServices,
  getService,
  listServiceVersions,
} from '../services/service-registry.service.js';
import {
  validateCreateService,
  isValidUuid,
} from '../validators/service.validators.js';
import { ApiError } from '../utils/api-error.js';

export async function registerService(req, res) {
  const result = validateCreateService(req.body);
  if (!result.ok) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Request body failed validation', result.errors);
  }

  const service = await createService(result.data);
  res.status(201).json({ success: true, data: service });
}

export async function listAllServices(req, res) {
  const services = await listServices();
  res.json({ success: true, data: services });
}

export async function getSingleService(req, res) {
  const { id } = req.params;
  if (!isValidUuid(id)) {
    throw new ApiError(400, 'INVALID_ID', 'id must be a valid UUID');
  }
  const service = await getService(id);
  res.json({ success: true, data: service });
}

export async function getServiceVersions(req, res) {
  const { id } = req.params;
  if (!isValidUuid(id)) {
    throw new ApiError(400, 'INVALID_ID', 'id must be a valid UUID');
  }
  const versions = await listServiceVersions(id);
  res.json({ success: true, data: versions });
}
