// Input validation for the Consumer Registry endpoints.
// Pure functions: no I/O, no Prisma.

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MAX_NAME_LENGTH = 200;
const MAX_OWNER_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 1000;
const MAX_PATH_LENGTH = 500;
const MAX_FIELD_PATH_LENGTH = 300;
const MAX_FIELD_PATHS_PER_DEPENDENCY = 200;
const MAX_DEPENDENCIES_PER_REQUEST = 200;

// Methods the registry accepts. Everything else is rejected explicitly rather
// than stored, so downstream matching can rely on the normalized value.
const SUPPORTED_HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

export function isValidUuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/**
 * Normalize an HTTP method to uppercase. Returns null when the value is not a
 * supported method (the caller reports the error).
 */
export function normalizeHttpMethod(value) {
  if (typeof value !== 'string') return null;
  const method = value.trim().toUpperCase();
  return SUPPORTED_HTTP_METHODS.includes(method) ? method : null;
}

/**
 * Validates the POST /api/consumers body (consumer registration reuses the
 * Service Registry model, so the fields mirror service registration).
 */
export function validateConsumerRegistration(body) {
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
      errors.push({ field: 'name', message: `name must be at most ${MAX_NAME_LENGTH} characters` });
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
      errors.push({ field: 'owner', message: `owner must be at most ${MAX_OWNER_LENGTH} characters` });
    }
  }

  let description = null;
  if (body.description !== undefined && body.description !== null) {
    if (typeof body.description !== 'string') {
      errors.push({ field: 'description', message: 'description must be a string' });
    } else {
      description = body.description.trim() || null;
      if (description !== null && description.length > MAX_DESCRIPTION_LENGTH) {
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

// Validates one `sends`/`reads` list: optional, but when present it must be an
// array of non-empty strings (the dot-notation field paths are preserved
// verbatim apart from trimming surrounding whitespace).
function validateFieldPaths(value, fieldName, errors, index) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    errors.push({
      field: `dependencies[${index}].${fieldName}`,
      message: `${fieldName} must be an array of field-path strings`,
    });
    return [];
  }
  const paths = [];
  for (let i = 0; i < value.length; i += 1) {
    const entry = `dependencies[${index}].${fieldName}[${i}]`;
    if (typeof value[i] !== 'string' || value[i].trim() === '') {
      errors.push({ field: entry, message: 'each field path must be a non-empty string' });
    } else {
      const trimmed = value[i].trim();
      if (trimmed.length > MAX_FIELD_PATH_LENGTH) {
        errors.push({ field: entry, message: `field path must be at most ${MAX_FIELD_PATH_LENGTH} characters` });
      } else {
        paths.push(trimmed);
      }
    }
  }
  if (value.length > MAX_FIELD_PATHS_PER_DEPENDENCY) {
    errors.push({
      field: `dependencies[${index}].${fieldName}`,
      message: `at most ${MAX_FIELD_PATHS_PER_DEPENDENCY} field paths per list`,
    });
  }
  return paths;
}

/**
 * Validates the PUT /api/consumers/:id body, which is a COMPLETE REPLACEMENT
 * of the consumer's dependency declarations:
 *
 *   { dependencies: [ { providerId, method, path, sends?, reads? }, ... ] }
 *
 * providerId references an existing Service record (checked by the service
 * layer). `dependencies: []` means "no dependencies".
 */
export function validateDependencyList(body) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return {
      ok: false,
      errors: [{ field: 'body', message: 'Request body must be a JSON object' }],
    };
  }
  if (!('dependencies' in body)) {
    return {
      ok: false,
      errors: [{ field: 'dependencies', message: 'dependencies array is required (use [] to clear)' }],
    };
  }

  const errors = [];
  const dependencies = [];

  if (!Array.isArray(body.dependencies)) {
    return { ok: false, errors: [{ field: 'dependencies', message: 'dependencies must be an array' }] };
  }
  if (body.dependencies.length > MAX_DEPENDENCIES_PER_REQUEST) {
    errors.push({
      field: 'dependencies',
      message: `at most ${MAX_DEPENDENCIES_PER_REQUEST} dependencies per request`,
    });
  }

  body.dependencies.forEach((dependency, index) => {
    const prefix = `dependencies[${index}]`;
    if (typeof dependency !== 'object' || dependency === null || Array.isArray(dependency)) {
      errors.push({ field: prefix, message: 'each dependency must be a JSON object' });
      return;
    }

    if (!isValidUuid(dependency.providerId)) {
      errors.push({
        field: `${prefix}.providerId`,
        message: 'providerId must be a valid UUID of a registered service',
      });
    }

    const method = normalizeHttpMethod(dependency.method);
    if (method === null) {
      errors.push({
        field: `${prefix}.method`,
        message: `method must be one of: ${SUPPORTED_HTTP_METHODS.join(', ')}`,
      });
    }

    let path;
    if (typeof dependency.path !== 'string' || dependency.path.trim() === '') {
      errors.push({ field: `${prefix}.path`, message: 'path is required and must be a non-empty string' });
    } else {
      path = dependency.path.trim();
      if (!path.startsWith('/')) {
        errors.push({ field: `${prefix}.path`, message: 'path must start with "/"' });
      } else if (path.length > MAX_PATH_LENGTH) {
        errors.push({ field: `${prefix}.path`, message: `path must be at most ${MAX_PATH_LENGTH} characters` });
      }
    }

    const sends = validateFieldPaths(dependency.sends, 'sends', errors, index);
    const reads = validateFieldPaths(dependency.reads, 'reads', errors, index);

    if (errors.length === 0 || errors.every((e) => !e.field.startsWith(prefix))) {
      dependencies.push({
        providerId: isValidUuid(dependency.providerId) ? dependency.providerId : null,
        method,
        path,
        sends: sends ?? [],
        reads: reads ?? [],
      });
    }
  });

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, data: { dependencies } };
}

/**
 * Validates the POST /api/consumers/import body. An empty/absent body means
 * "import the starter-kit declaration files from disk".
 */
export function validateImportBody(body) {
  if (body === undefined || body === null || (typeof body === 'object' && Object.keys(body).length === 0)) {
    return { ok: true, data: { declarations: null } };
  }
  if (typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, errors: [{ field: 'body', message: 'Request body must be a JSON object' }] };
  }
  if (!('declarations' in body)) {
    return {
      ok: false,
      errors: [{ field: 'declarations', message: 'provide a "declarations" array of consumer declarations' }],
    };
  }
  if (!Array.isArray(body.declarations) || body.declarations.length === 0) {
    return {
      ok: false,
      errors: [{ field: 'declarations', message: 'declarations must be a non-empty array' }],
    };
  }
  return { ok: true, data: { declarations: body.declarations } };
}
