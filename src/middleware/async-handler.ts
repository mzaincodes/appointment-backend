import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * Wraps an async route handler so a rejected promise reaches Express's error
 * pipeline instead of becoming an unhandled rejection.
 *
 * Express 4 does not await handlers, so without this every controller would
 * need its own try/catch that does nothing but call `next(error)`. Wrapping
 * once here is what lets the controllers stay thin and simply throw.
 */
export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}
