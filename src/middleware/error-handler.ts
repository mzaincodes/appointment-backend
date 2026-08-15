import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { env } from '../config/env';
import { PG_ERROR, isPgError } from '../db/pool';
import { AppError, NotFoundError, isAppError } from '../utils/errors';
import { logger } from '../utils/logger';
import type { ApiFailure } from '../types';

/**
 * Centralised error handling — the single place that decides what a client
 * sees when something goes wrong.
 *
 * Two rules hold throughout:
 *  1. Nothing internal escapes. Stack traces, SQL text and driver messages are
 *     logged, never serialised into a response.
 *  2. Every failure uses the same envelope as every success, so the frontend
 *     has one shape to handle.
 */

/** 404 for unmatched routes. Registered after all other routes. */
export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(new NotFoundError(`Route ${req.method} ${req.originalUrl} does not exist.`));
}

/** Maps a caught value to the AppError the client should see. */
function normalise(error: unknown): AppError {
  if (isAppError(error)) return error;

  // Zod errors raised outside the validation middleware (e.g. inside a service
  // parsing an AI tool argument).
  if (error instanceof ZodError) {
    return new AppError('The submitted information is not valid.', 400, 'VALIDATION_ERROR', {
      issues: error.issues.map((issue) => ({
        field: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }

  if (isPgError(error)) {
    switch (error.code) {
      case PG_ERROR.EXCLUSION_VIOLATION:
        // The double-booking guarantee firing. The appointment service
        // normally catches this first and attaches alternative times; reaching
        // here means it came from another path, so answer generically.
        return new AppError(
          'That appointment slot is no longer available.',
          409,
          'SLOT_UNAVAILABLE',
        );

      case PG_ERROR.UNIQUE_VIOLATION:
        return new AppError(
          error.constraint === 'users_email_lower_key'
            ? 'An account with that email address already exists.'
            : 'That record already exists.',
          409,
          'CONFLICT',
        );

      case PG_ERROR.CHECK_VIOLATION:
        // A constraint the API layer should have caught first. Surface it as a
        // validation problem rather than a 500, but log it — it means a
        // validator is missing a rule the database has.
        logger.warn('Check constraint reached the database', { constraint: error.constraint });
        return new AppError(
          'The submitted information is not valid.',
          400,
          'VALIDATION_ERROR',
          env.isProduction ? undefined : { constraint: error.constraint },
        );

      case PG_ERROR.FOREIGN_KEY_VIOLATION:
        return new AppError('A referenced record does not exist.', 400, 'VALIDATION_ERROR');

      case PG_ERROR.SERIALIZATION_FAILURE:
      case PG_ERROR.DEADLOCK_DETECTED:
        return new AppError(
          'The request could not be completed because of concurrent activity. Please try again.',
          409,
          'CONFLICT',
        );

      default:
        return new AppError(
          'A database error occurred. Please try again.',
          500,
          'DATABASE_ERROR',
        );
    }
  }

  // Malformed JSON body — express.json() raises a SyntaxError with `body` set.
  if (error instanceof SyntaxError && 'body' in error) {
    return new AppError('The request body is not valid JSON.', 400, 'VALIDATION_ERROR');
  }

  return new AppError('Something went wrong on our side. Please try again.', 500, 'INTERNAL_ERROR');
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- Express identifies
// error middleware by its arity, so `next` must stay in the signature.
export function errorHandler(
  error: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const appError = normalise(error);

  const logMeta = {
    requestId: req.id,
    method: req.method,
    path: req.originalUrl.split('?')[0],
    status: appError.statusCode,
    code: appError.code,
    // The original message, which may differ from the sanitised one sent out.
    reason: error instanceof Error ? error.message : String(error),
  };

  if (appError.statusCode >= 500) {
    logger.error(`Unhandled error: ${appError.message}`, {
      ...logMeta,
      stack: error instanceof Error ? error.stack : undefined,
    });
  } else {
    logger.warn(`Request failed: ${appError.message}`, logMeta);
  }

  const body: ApiFailure = {
    success: false,
    message: appError.message,
    code: appError.code,
  };
  if (appError.details !== undefined) body.details = appError.details;

  // Only in development, and only for genuine 500s, include the stack — it is
  // the difference between a fast fix and a guessing game while building.
  if (!env.isProduction && appError.statusCode >= 500 && error instanceof Error) {
    (body as ApiFailure & { stack?: string }).stack = error.stack;
  }

  res.status(appError.statusCode).json(body);
}
