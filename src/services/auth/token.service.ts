import jwt, { type SignOptions } from 'jsonwebtoken';
import { env } from '../../config/env';
import { UnauthorizedError } from '../../utils/errors';
import type { JwtPayload, UserRow } from '../../types';

/**
 * JWT issuing and verification.
 *
 * Isolated from the rest of auth so that the token strategy can change — to
 * refresh tokens, or to an external identity provider — without touching the
 * middleware or the controllers that depend on it.
 *
 * The payload deliberately carries only `sub`, `email` and `role`. Anything
 * else would be a copy of database state that goes stale the moment the record
 * changes; the auth middleware re-reads the user on each request instead.
 */

export const tokenService = {
  sign(user: Pick<UserRow, 'id' | 'email' | 'role'>): string {
    const payload: Omit<JwtPayload, 'iat' | 'exp'> = {
      sub: user.id,
      email: user.email,
      role: user.role,
    };
    const options: SignOptions = {
      expiresIn: env.JWT_EXPIRES_IN as SignOptions['expiresIn'],
      issuer: 'bright-smile-dental',
    };
    return jwt.sign(payload, env.JWT_SECRET, options);
  },

  /**
   * Verifies signature and expiry.
   *
   * Every failure mode collapses to the same generic 401 — telling a caller
   * whether a token was malformed, expired or forged is information they do not
   * need and an attacker can use.
   */
  verify(token: string): JwtPayload {
    try {
      const decoded = jwt.verify(token, env.JWT_SECRET, { issuer: 'bright-smile-dental' });
      if (typeof decoded === 'string') throw new Error('Unexpected token payload');
      return decoded as JwtPayload;
    } catch (error) {
      if (error instanceof jwt.TokenExpiredError) {
        throw new UnauthorizedError('Your session has expired. Please sign in again.');
      }
      throw new UnauthorizedError('Your session is not valid. Please sign in again.');
    }
  },

  /** Verification that returns null instead of throwing, for optional auth. */
  safeVerify(token: string): JwtPayload | null {
    try {
      return this.verify(token);
    } catch {
      return null;
    }
  },
};
