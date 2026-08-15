import rateLimit, { type Options } from 'express-rate-limit';
import type { Request, Response } from 'express';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import type { ApiFailure } from '../types';

/**
 * Rate limiting.
 *
 * Three tiers, because the endpoints have very different costs and risks:
 *
 *  - `apiLimiter`   — a broad ceiling on the whole API.
 *  - `authLimiter`  — tight, and counts only *failed* attempts, so it slows
 *                     credential stuffing without locking out a legitimate user
 *                     who is simply signing in repeatedly.
 *  - `chatLimiter`  — protects the AI endpoints, which are the only ones that
 *                     cost real money per call.
 *
 * All three answer with the same envelope as the rest of the API.
 */

function buildHandler(scope: string) {
  return (req: Request, res: Response): void => {
    logger.warn('Rate limit exceeded', {
      requestId: req.id,
      scope,
      ip: req.ip,
      path: req.originalUrl.split('?')[0],
    });
    const body: ApiFailure = {
      success: false,
      message: 'Too many requests. Please wait a moment and try again.',
      code: 'RATE_LIMITED',
    };
    res.status(429).json(body);
  };
}

const shared: Partial<Options> = {
  standardHeaders: 'draft-7', // RateLimit-* headers so the client can back off
  legacyHeaders: false,
  // Rate limiting is a nuisance while developing against the API by hand.
  skip: () => env.isTest,
};

/** Broad ceiling applied to every /api route. */
export const apiLimiter = rateLimit({
  ...shared,
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  limit: env.RATE_LIMIT_MAX,
  handler: buildHandler('api'),
});

/**
 * Login and registration.
 *
 * `skipSuccessfulRequests` means a correct password does not consume budget;
 * only failures do. That is the behaviour you want — it targets guessing,
 * not usage.
 */
export const authLimiter = rateLimit({
  ...shared,
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  limit: env.AUTH_RATE_LIMIT_MAX,
  skipSuccessfulRequests: true,
  handler: buildHandler('auth'),
});

/** AI/chat endpoints — the expensive ones. Short window, low ceiling. */
export const chatLimiter = rateLimit({
  ...shared,
  windowMs: 60_000,
  limit: env.CHAT_RATE_LIMIT_MAX,
  handler: buildHandler('chat'),
});

/**
 * Socket.IO bypasses Express middleware, so chat messages arriving over the
 * websocket need their own limiter. This is a small fixed-window counter keyed
 * by socket id — enough to stop a runaway client without pulling in a store.
 */
export class SocketRateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {
    // Drop expired buckets periodically so the map cannot grow unbounded across
    // a long-running process. `unref` keeps this timer from holding the event
    // loop open during shutdown.
    const timer = setInterval(() => this.prune(), windowMs);
    timer.unref();
  }

  /** Returns true when the caller is within budget. */
  consume(key: string): boolean {
    const now = Date.now();
    const bucket = this.hits.get(key);

    if (!bucket || bucket.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    if (bucket.count >= this.limit) return false;

    bucket.count += 1;
    return true;
  }

  /** Called on disconnect so a socket's bucket does not outlive it. */
  release(key: string): void {
    this.hits.delete(key);
  }

  private prune(): void {
    const now = Date.now();
    for (const [key, bucket] of this.hits) {
      if (bucket.resetAt <= now) this.hits.delete(key);
    }
  }
}

/** Message budget for a single socket. */
export const socketChatLimiter = new SocketRateLimiter(env.CHAT_RATE_LIMIT_MAX, 60_000);
