// HTTP handling for Publishing Governance.
//
// A blocked publication is a BUSINESS DECISION, not a server error: it is
// returned with HTTP 200 and outcome "BLOCKED" (consistent with the API's
// success envelope), carrying the reason, warnings and affected consumers.
// Only unexpected problems (unknown version, invalid request body) are HTTP
// errors.
import { publishVersion, getPublishHistory } from '../services/publishing.service.js';
import { isValidUuid } from '../validators/service.validators.js';
import { ApiError } from '../utils/api-error.js';

// POST /api/specs/publish — body: { versionId }.
export async function publishSpecVersionEndpoint(req, res) {
  if (
    typeof req.body !== 'object' ||
    req.body === null ||
    Array.isArray(req.body) ||
    !isValidUuid(req.body.versionId)
  ) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Request body failed validation', [
      { field: 'versionId', message: 'versionId must be a valid UUID of a specification version' },
    ]);
  }

  const decision = await publishVersion(req.body.versionId);
  res.json({ success: true, data: decision });
}

// GET /api/specs/:id/publish-history — all publish attempts for the version,
// newest first (both PUBLISHED and BLOCKED are kept).
export async function getPublishHistoryEndpoint(req, res) {
  const { id } = req.params;
  if (!isValidUuid(id)) {
    throw new ApiError(400, 'INVALID_ID', 'id must be a valid UUID');
  }
  const history = await getPublishHistory(id);
  res.json({ success: true, data: history });
}
