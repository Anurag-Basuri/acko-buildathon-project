// Semantic normalization of OpenAPI documents.
//
// Pure module — no database access, no Express. Transforms a *resolved*
// OpenAPI 3.x document (all internal $ref pointers already dereferenced —
// e.g. the `parsedContent` stored by Specification Management, or the output
// of SwaggerParser.parse/validate) into a deterministic internal
// representation that the comparison engine can diff without being affected
// by YAML/JSON formatting, property order, $ref layout, or path parameter
// names.
//
// The normalized representation captures the contract-relevant surface:
//   - operations: method (uppercase), original path, canonical path template,
//     operationId, parameters, request body, responses
//   - parameters: name, location, requiredness, schema descriptor
//   - request/response schemas: types, nested objects, array items, required
//     fields, enums, formats, nullability, numeric/length constraints
//
// Documented limitations (constructs that are NEVER silently dropped):
//   - Schema composition (allOf/oneOf/anyOf/not), discriminators,
//     patternProperties, schema-valued additionalProperties, and OpenAPI 3.1
//     union types are reported as UNSUPPORTED_CONSTRUCT.
//   - A document that still contains $ref is reported as
//     UNRESOLVED_REFERENCE: the normalizer expects a resolved document.
//   - Intentionally ignored (not part of the compared contract surface in
//     this module): deprecated/x-* flags, descriptions, summaries, security,
//     servers, tags.
//
// Path parameter names are normalized for matching: /users/{id} and
// /users/{userId} canonicalise to the same template, while the original
// names are preserved on each parameter descriptor.

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

// Schema constraint keywords extracted onto the descriptor.
const CONSTRAINT_KEYS = [
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'minLength',
  'maxLength',
  'pattern',
  'minItems',
  'maxItems',
  'uniqueItems',
  'multipleOf',
  'minProperties',
  'maxProperties',
];

// Escapes a segment for use inside a JSON pointer.
function escapePointerSegment(segment) {
  return String(segment).replace(/~/g, '~0').replace(/\//g, '~1');
}

function childPointer(pointer, segment) {
  return `${pointer}/${escapePointerSegment(segment)}`;
}

// /users/{id}/roles -> /users/{param_0}/roles. Parameter names are replaced
// by positional placeholders so that different names at the same position
// canonicalise identically, while static segments stay intact.
export function canonicalPath(path) {
  let position = 0;
  return String(path).replace(/\{[^}]*\}/g, () => `{param_${position++}}`);
}

// Deterministic ordering for values compared as sets (required lists, enum
// values). Values are scalar (or scalar-like), so JSON key comparison is a
// stable total order.
function stableSort(values) {
  return values.slice().sort((a, b) => {
    const keyA = JSON.stringify(a);
    const keyB = JSON.stringify(b);
    return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
  });
}

// Transforms one OpenAPI schema into a normalized descriptor. Collects
// issues (unsupported/malformed constructs) instead of throwing, so a single
// report can list every problem in the document.
function normalizeSchema(schema, pointer, issues) {
  if (schema === null || schema === undefined) {
    // A media type without a schema (e.g. an empty response body) is "any".
    return { type: 'any' };
  }
  if (typeof schema !== 'object' || Array.isArray(schema)) {
    issues.push({
      code: 'INVALID_SCHEMA',
      message: `Schema must be an object (mapping) at ${pointer}`,
      path: pointer,
    });
    return { type: 'any' };
  }
  if ('$ref' in schema) {
    issues.push({
      code: 'UNRESOLVED_REFERENCE',
      message: `Found $ref "${schema.$ref}" at ${pointer}: the normalizer expects a fully $ref-resolved document`,
      path: pointer,
    });
    return { type: 'any' };
  }

  for (const construct of ['allOf', 'oneOf', 'anyOf', 'not', 'discriminator', 'patternProperties']) {
    if (construct in schema) {
      issues.push({
        code: 'UNSUPPORTED_CONSTRUCT',
        message: `Schema construct "${construct}" at ${pointer} is not supported by the normalizer`,
        path: pointer,
      });
    }
  }
  if (
    schema.additionalProperties !== undefined &&
    typeof schema.additionalProperties === 'object' &&
    schema.additionalProperties !== null
  ) {
    issues.push({
      code: 'UNSUPPORTED_CONSTRUCT',
      message: `Schema-valued additionalProperties at ${pointer} is not supported by the normalizer`,
      path: pointer,
    });
  }

  let type;
  if (typeof schema.type === 'string') {
    type = schema.type;
  } else if (Array.isArray(schema.type)) {
    issues.push({
      code: 'UNSUPPORTED_CONSTRUCT',
      message: `OpenAPI 3.1 union type ${JSON.stringify(schema.type)} at ${pointer} is not supported by the normalizer`,
      path: pointer,
    });
    type = 'any';
  } else if (schema.type !== undefined) {
    issues.push({
      code: 'INVALID_SCHEMA',
      message: `Schema "type" must be a string at ${pointer}`,
      path: pointer,
    });
    type = 'any';
  } else {
    type = 'any';
  }

  // Keys are emitted in a fixed order so that equivalent schemas
  // serialise identically.
  const descriptor = { type };
  if (typeof schema.format === 'string') descriptor.format = schema.format;
  if (schema.nullable === true) descriptor.nullable = true;
  if (Array.isArray(schema.enum)) descriptor.enum = stableSort(schema.enum);

  for (const key of CONSTRAINT_KEYS) {
    if (key in schema) descriptor[key] = schema[key];
  }
  if (typeof schema.additionalProperties === 'boolean') {
    descriptor.additionalProperties = schema.additionalProperties;
  }

  const isObject =
    type === 'object' ||
    (schema.properties !== undefined && typeof schema.properties === 'object');
  if (isObject) {
    descriptor.required = stableSort(
      [...new Set(Array.isArray(schema.required) ? schema.required : [])]
    );
    descriptor.properties = {};
    const properties =
      schema.properties !== undefined && typeof schema.properties === 'object'
        ? schema.properties
        : {};
    for (const name of Object.keys(properties)) {
      descriptor.properties[name] = normalizeSchema(
        properties[name],
        childPointer(pointer, name),
        issues
      );
    }
  }

  if (type === 'array' || schema.items !== undefined) {
    descriptor.items = normalizeSchema(schema.items, childPointer(pointer, 'items'), issues);
  }

  return descriptor;
}

// Normalizes one parameter object. Path parameters are always required per
// the OpenAPI 3.0 specification, so a missing/false `required` on a path
// parameter is normalised to true.
function normalizeParameter(parameter, pointer, issues) {
  const descriptor = {
    name: typeof parameter.name === 'string' ? parameter.name : '',
    in: typeof parameter.in === 'string' ? parameter.in : '',
    required: parameter.in === 'path' ? true : parameter.required === true,
    schema: null,
  };
  if (parameter.content !== undefined) {
    issues.push({
      code: 'UNSUPPORTED_CONSTRUCT',
      message: `Parameter declared with "content" instead of "schema" at ${pointer} is not supported`,
      path: pointer,
    });
  }
  if (parameter.schema !== undefined) {
    descriptor.schema = normalizeSchema(parameter.schema, childPointer(pointer, 'schema'), issues);
  }
  return descriptor;
}

// Normalizes a requestBody object.
function normalizeRequestBody(requestBody, pointer, issues) {
  const content = {};
  if (requestBody.content !== undefined && typeof requestBody.content === 'object') {
    for (const [contentType, mediaType] of Object.entries(requestBody.content)) {
      content[contentType] =
        mediaType !== null && mediaType !== undefined && mediaType.schema !== undefined
          ? { schema: normalizeSchema(mediaType.schema, childPointer(childPointer(pointer, 'content'), contentType), issues) }
          : { schema: null };
    }
  }
  return { required: requestBody.required === true, content };
}

// Normalizes the responses map: status -> { content: { type -> { schema } } }.
function normalizeResponses(responses, pointer, issues) {
  const normalised = {};
  if (responses !== undefined && responses !== null && typeof responses === 'object') {
    for (const [status, response] of Object.entries(responses)) {
      const content = {};
      if (
        response !== null &&
        response !== undefined &&
        response.content !== undefined &&
        typeof response.content === 'object'
      ) {
        for (const [contentType, mediaType] of Object.entries(response.content)) {
          content[contentType] =
            mediaType !== null && mediaType !== undefined && mediaType.schema !== undefined
              ? {
                  schema: normalizeSchema(
                    mediaType.schema,
                    childPointer(childPointer(childPointer(pointer, 'responses'), status), contentType),
                    issues
                  ),
                }
              : { schema: null };
        }
      }
      normalised[status] = { content };
    }
  }
  return normalised;
}

/**
 * Normalize a resolved OpenAPI 3.x document into the internal representation
 * used by the comparison engine.
 *
 * @param {object} document  Resolved OpenAPI 3.x document object (no $ref
 *   pointers remaining). Typically the stored `parsedContent`.
 * @returns {{ ok: true, spec: {
 *   openApiVersion: string,
 *   title: string | null,
 *   version: string | null,
 *   operations: Array<{
 *     method: string,            // uppercase
 *     path: string,              // original path
 *     canonicalPath: string,     // positional path parameter names
 *     operationId: string | null,
 *     parameters: Array<{ name: string, in: string, required: boolean, schema: object | null }>,
 *     requestBody: { required: boolean, content: object } | null,
 *     responses: { [status: string]: { content: { [type: string]: { schema: object | null } } } },
 *   }>,
 * } } | { ok: false, errors: Array<{ code: string, message: string, path: string }> }}
 */
export function normalizeSpec(document) {
  const issues = [];

  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    return {
      ok: false,
      errors: [
        { code: 'INVALID_DOCUMENT', message: 'OpenAPI document must be an object (mapping)' },
      ],
    };
  }

  if (typeof document.openapi !== 'string' || !document.openapi.startsWith('3.')) {
    return {
      ok: false,
      errors: [
        {
          code: 'UNSUPPORTED_VERSION',
          message: `This normalizer supports OpenAPI 3.x documents (found openapi: ${JSON.stringify(
            document.openapi
          )})`,
        },
      ],
    };
  }

  const paths =
    document.paths !== undefined &&
    document.paths !== null &&
    typeof document.paths === 'object' &&
    !Array.isArray(document.paths)
      ? document.paths
      : {};

  const operations = [];

  for (const [rawPath, pathItem] of Object.entries(paths)) {
    if (pathItem === null || pathItem === undefined || typeof pathItem !== 'object') continue;
    const pathPointer = childPointer('/paths', rawPath);
    const pathLevelParameters = Array.isArray(pathItem.parameters) ? pathItem.parameters : [];

    for (const method of METHODS) {
      const operation = pathItem[method];
      if (operation === undefined || operation === null || typeof operation !== 'object') continue;
      const opPointer = childPointer(pathPointer, method);

      // Merge operation-level and path-level parameters. The same (in, name)
      // declared at both levels is defined once, with the operation-level
      // declaration winning.
      const merged = [];
      const seen = new Set();
      const ordered = [
        ...(Array.isArray(operation.parameters) ? operation.parameters : []),
        ...pathLevelParameters,
      ];
      for (const parameter of ordered) {
        if (parameter === null || parameter === undefined || typeof parameter !== 'object') continue;
        if (typeof parameter.name !== 'string' || typeof parameter.in !== 'string') {
          issues.push({
            code: 'INVALID_DOCUMENT',
            message: `Parameter without a string name/in at ${opPointer}`,
            path: opPointer,
          });
          continue;
        }
        const key = `${parameter.in}:${parameter.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(normalizeParameter(parameter, childPointer(opPointer, `parameters/${merged.length}`), issues));
      }

      operations.push({
        method: method.toUpperCase(),
        path: rawPath,
        canonicalPath: canonicalPath(rawPath),
        operationId: typeof operation.operationId === 'string' ? operation.operationId : null,
        parameters: merged,
        requestBody:
          operation.requestBody !== undefined &&
          operation.requestBody !== null &&
          typeof operation.requestBody === 'object'
            ? normalizeRequestBody(operation.requestBody, opPointer, issues)
            : null,
        responses: normalizeResponses(operation.responses, opPointer, issues),
      });
    }
  }

  // Deterministic operation order: canonical path, then method.
  operations.sort((a, b) =>
    a.canonicalPath === b.canonicalPath
      ? a.method < b.method
        ? -1
        : a.method > b.method
          ? 1
          : 0
      : a.canonicalPath < b.canonicalPath
        ? -1
        : 1
  );

  if (issues.length > 0) {
    return { ok: false, errors: issues };
  }

  const info =
    document.info !== undefined && document.info !== null && typeof document.info === 'object'
      ? document.info
      : {};

  return {
    ok: true,
    spec: {
      openApiVersion: document.openapi,
      title: typeof info.title === 'string' ? info.title : null,
      version: typeof info.version === 'string' ? info.version : null,
      operations,
    },
  };
}

export default normalizeSpec;
