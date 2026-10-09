// Typed application errors. `status` is the HTTP status the API layer returns;
// `message` must be safe to show to clients (no secrets, no stack traces).
export class AppError extends Error {
  constructor(code, message, status = 500, details = undefined) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export const validationError = (message, details) => new AppError('VALIDATION_ERROR', message, 400, details);

export function toErrorResponse(err) {
  if (err instanceof AppError) {
    const body = { success: false, error: err.code, message: err.message };
    if (err.details !== undefined) body.details = err.details;
    return { status: err.status, body };
  }
  return {
    status: 500,
    body: { success: false, error: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' },
  };
}
