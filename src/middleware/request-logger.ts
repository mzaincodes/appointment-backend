import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { logger } from '../utils/logger';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Correlates every log line produced while handling this request. */
      id: string;
      startedAt: number;
    }
  }
}

/** Health checks would otherwise dominate the log during development. */
const QUIET_PATHS = new Set(['/health', '/api/health', '/favicon.ico']);

/**
 * Request logging.
 *
 * Assigns a request id, echoes it back as `X-Request-Id` so a report from the
 * frontend can be traced to a server log line, and logs one line per completed
 * request with its status and duration. Failures log at `warn`/`error` so they
 * stand out without having to grep for status codes.
 */
export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  req.id = (req.headers['x-request-id'] as string | undefined) ?? randomUUID();
  req.startedAt = Date.now();
  res.setHeader('X-Request-Id', req.id);

  if (QUIET_PATHS.has(req.path)) {
    next();
    return;
  }

  // 'finish' fires once the response has been flushed, so the duration and
  // status are final by the time we read them.
  res.on('finish', () => {
    const duration = Date.now() - req.startedAt;
    const meta = {
      requestId: req.id,
      method: req.method,
      path: req.originalUrl.split('?')[0],
      status: res.statusCode,
      duration,
      ip: req.ip,
    };

    const message = `${req.method} ${meta.path} ${res.statusCode} ${duration}ms`;
    if (res.statusCode >= 500) logger.error(message, meta);
    else if (res.statusCode >= 400) logger.warn(message, meta);
    else logger.info(message, meta);
  });

  next();
}
