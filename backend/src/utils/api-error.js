// Typed application error carrying the HTTP status, a machine-readable code,
// and optional field-level details. Thrown by services and validators,
// rendered by the centralised error handler.
export class ApiError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
