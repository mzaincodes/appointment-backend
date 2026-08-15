import type { NextFunction, Request, Response } from 'express';
import { authService } from '../services/auth/auth.service';
import { ForbiddenError, UnauthorizedError } from '../utils/errors';
import type { PublicUser, UserRole } from '../types';
import { toPublicUser } from '../repositories/user.repository';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by `requireAuth`, or by `optionalAuth` when a valid token exists. */
      user?: PublicUser;
    }
  }
}

/**
 * Reads the bearer token from the Authorization header, falling back to the
 * `token` cookie.
 *
 * The frontend uses the header (it stores the token in localStorage so the tab
 * can restore a session), but supporting the cookie as well means the API can
 * be exercised from a browser address bar during development.
 */
function extractToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    const token = header.slice(7).trim();
    if (token) return token;
  }
  const cookieToken = (req.cookies as Record<string, string> | undefined)?.token;
  return cookieToken?.trim() || null;
}

/**
 * Rejects the request unless a valid token resolves to an existing account.
 *
 * This is the *only* thing that establishes identity. No route trusts a user id
 * from the body, the query string or a header — see the README note on why
 * authorisation never depends on the frontend.
 */
export async function requireAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const token = extractToken(req);
    if (!token) throw new UnauthorizedError('You need to sign in to continue.');

    req.user = toPublicUser(await authService.resolveUserFromToken(token));
    next();
  } catch (error) {
    next(error);
  }
}

/**
 * Attaches the user when a valid token is present, and otherwise continues
 * anonymously.
 *
 * Used by endpoints that serve both audiences — booking works signed out, but
 * a signed-in patient should have the appointment linked to their account.
 * An invalid or expired token is treated as "not signed in" rather than an
 * error, so a stale token cannot block a guest from booking.
 */
export async function optionalAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const token = extractToken(req);
  if (!token) {
    next();
    return;
  }
  try {
    req.user = toPublicUser(await authService.resolveUserFromToken(token));
  } catch {
    req.user = undefined;
  }
  next();
}

/** Restricts a route to the listed roles. Must run after `requireAuth`. */
export function requireRole(...roles: UserRole[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      next(new UnauthorizedError('You need to sign in to continue.'));
      return;
    }
    if (!roles.includes(req.user.role)) {
      next(new ForbiddenError('This area is restricted to clinic administrators.'));
      return;
    }
    next();
  };
}

/**
 * Convenience for the admin surface.
 *
 * Every `/api/admin/*` route is mounted behind `requireAuth` *and* this check,
 * so an ordinary user calling an admin endpoint directly receives a 403
 * regardless of what the frontend chooses to render.
 */
export const requireAdmin = requireRole('ADMIN');
