/**
 * Application error taxonomy.
 *
 * Services throw these instead of returning ad-hoc error shapes. The
 * centralised error middleware is then the single place that decides what
 * reaches the client, which is what keeps stack traces and driver messages out
 * of API responses.
 */

export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'SLOT_UNAVAILABLE'
  | 'CLINIC_CLOSED'
  | 'RATE_LIMITED'
  | 'AI_UNAVAILABLE'
  | 'DATABASE_ERROR'
  | 'INTERNAL_ERROR';

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: ErrorCode;
  /** Extra machine-readable context, e.g. the alternative slots we can offer. */
  public readonly details?: unknown;
  /** Distinguishes deliberate, expected failures from genuine bugs. */
  public readonly isOperational = true;

  constructor(message: string, statusCode: number, code: ErrorCode, details?: unknown) {
    super(message);
    this.name = new.target.name;
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    Error.captureStackTrace(this, new.target);
  }
}

/** 400 — the request was understood but its contents are not acceptable. */
export class ValidationError extends AppError {
  constructor(message = 'The submitted information is not valid.', details?: unknown) {
    super(message, 400, 'VALIDATION_ERROR', details);
  }
}

/** 401 — no valid credentials were supplied. */
export class UnauthorizedError extends AppError {
  constructor(message = 'You need to sign in to continue.') {
    super(message, 401, 'UNAUTHORIZED');
  }
}

/** 403 — authenticated, but not allowed to do this. */
export class ForbiddenError extends AppError {
  constructor(message = 'You do not have permission to perform this action.') {
    super(message, 403, 'FORBIDDEN');
  }
}

/** 404 — the addressed resource does not exist (or is not visible to caller). */
export class NotFoundError extends AppError {
  constructor(message = 'The requested item could not be found.') {
    super(message, 404, 'NOT_FOUND');
  }
}

/** 409 — the request conflicts with the current state, e.g. duplicate email. */
export class ConflictError extends AppError {
  constructor(message = 'That action conflicts with existing data.', details?: unknown) {
    super(message, 409, 'CONFLICT', details);
  }
}

/**
 * 409 — the specific slot is taken.
 *
 * Carries the nearest alternatives so the caller (booking form *or* chatbot)
 * can immediately offer a way forward instead of a dead end.
 */
export class SlotUnavailableError extends AppError {
  constructor(
    message = 'That appointment slot is no longer available.',
    alternatives: string[] = [],
  ) {
    super(message, 409, 'SLOT_UNAVAILABLE', { alternatives });
  }
}

/** 422 — the date is valid but the clinic does not open then. */
export class ClinicClosedError extends AppError {
  constructor(message = 'The clinic is closed on the selected date.', details?: unknown) {
    super(message, 422, 'CLINIC_CLOSED', details);
  }
}

/** 503 — the upstream model could not be reached. */
export class AiUnavailableError extends AppError {
  constructor(message = 'The assistant is temporarily unavailable. Please try again shortly.') {
    super(message, 503, 'AI_UNAVAILABLE');
  }
}

/** Narrowing helper used by the error middleware. */
export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
