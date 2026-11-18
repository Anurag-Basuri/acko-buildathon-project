// Input validation for the Service Registry endpoints.
// Pure functions: no I/O, no Prisma.

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MAX_NAME_LENGTH = 200;
const MAX_OWNER_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 1000;

export function isValidUuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

// Validates the POST /api/services body.
// Returns { ok: true, data } with trimmed values, or
// { ok: false, errors: [{ field, message }] }.
export function validateCreateService(body) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return {
      ok: false,
      errors: [{ field: 'body', message: 'Request body must be a JSON object' }],
    };
  }

  const errors = [];

  let name;
  if (body.name === undefined || typeof body.name !== 'string') {
    errors.push({ field: 'name', message: 'name is required and must be a string' });
  } else {
    name = body.name.trim();
    if (name === '') {
      errors.push({ field: 'name', message: 'name must not be empty' });
    } else if (name.length > MAX_NAME_LENGTH) {
      errors.push({
        field: 'name',
        message: `name must be at most ${MAX_NAME_LENGTH} characters`,
      });
    }
  }

  let owner;
  if (body.owner === undefined || typeof body.owner !== 'string') {
    errors.push({ field: 'owner', message: 'owner is required and must be a string' });
  } else {
    owner = body.owner.trim();
    if (owner === '') {
      errors.push({ field: 'owner', message: 'owner must not be empty' });
    } else if (owner.length > MAX_OWNER_LENGTH) {
      errors.push({
        field: 'owner',
        message: `owner must be at most ${MAX_OWNER_LENGTH} characters`,
      });
    }
  }

  let description = null;
  if (body.description !== undefined) {
    if (typeof body.description !== 'string') {
      errors.push({ field: 'description', message: 'description must be a string' });
    } else {
      description = body.description.trim();
      if (description.length > MAX_DESCRIPTION_LENGTH) {
        errors.push({
          field: 'description',
          message: `description must be at most ${MAX_DESCRIPTION_LENGTH} characters`,
        });
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, data: { name, owner, description } };
}
