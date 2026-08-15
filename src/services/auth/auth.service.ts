import bcrypt from 'bcryptjs';
import { userRepository, toPublicUser } from '../../repositories/user.repository';
import { tokenService } from './token.service';
import { ConflictError, UnauthorizedError, NotFoundError, ValidationError } from '../../utils/errors';
import { logger } from '../../utils/logger';
import type { PublicUser, UserRow } from '../../types';

/**
 * Authentication business logic.
 *
 * Controllers call into here; this module owns hashing, credential checking and
 * the rules around them. It never touches `req`/`res`, which makes it directly
 * reusable — the Socket.IO handshake authenticates through the same code path
 * as the REST API.
 */

/**
 * bcrypt cost factor. 10 keeps a login at roughly 60–100 ms on typical
 * hardware — slow enough to make offline cracking expensive, fast enough not to
 * become a request-handling bottleneck.
 */
const BCRYPT_ROUNDS = 10;

/**
 * A pre-computed hash of a throwaway password, compared against when no user
 * matches the supplied email.
 *
 * Without this, a missing account returns in ~1 ms while a wrong password takes
 * ~80 ms, and that timing difference alone tells an attacker which email
 * addresses are registered. Doing the work unconditionally removes the signal.
 */
const TIMING_SAFE_DUMMY_HASH = bcrypt.hashSync('timing-attack-mitigation-placeholder', BCRYPT_ROUNDS);

export interface AuthResult {
  user: PublicUser;
  token: string;
}

export const authService = {
  async register(input: {
    name: string;
    email: string;
    password: string;
    phone?: string | null;
  }): Promise<AuthResult> {
    const email = input.email.trim().toLowerCase();

    // Checked explicitly so the client gets a clear 409 rather than a generic
    // constraint error. The unique index remains the real guarantee — this
    // check is a race away from being stale, and the error middleware maps
    // `users_email_lower_key` to the same message.
    if (await userRepository.emailExists(email)) {
      throw new ConflictError('An account with that email address already exists.');
    }

    const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);
    const row = await userRepository.create({
      name: input.name.trim(),
      email,
      passwordHash,
      phone: input.phone?.trim() || null,
    });

    logger.info('User registered', { userId: row.id });
    return { user: toPublicUser(row), token: tokenService.sign(row) };
  },

  async login(input: { email: string; password: string }): Promise<AuthResult> {
    const row = await userRepository.findByEmail(input.email.trim());

    // Compare against the dummy hash when the account does not exist, so both
    // branches take the same time. See TIMING_SAFE_DUMMY_HASH above.
    const passwordMatches = await bcrypt.compare(
      input.password,
      row?.password_hash ?? TIMING_SAFE_DUMMY_HASH,
    );

    // One message for both "no such account" and "wrong password" — revealing
    // which one failed turns the login form into an account enumerator.
    if (!row || !passwordMatches) {
      throw new UnauthorizedError('That email or password is not correct.');
    }

    logger.info('User signed in', { userId: row.id, role: row.role });
    return { user: toPublicUser(row), token: tokenService.sign(row) };
  },

  /**
   * Resolves the user behind a token.
   *
   * Re-reading from the database on every request is a deliberate cost: it
   * means a deleted account or a changed role takes effect immediately rather
   * than lingering until the token expires.
   */
  async resolveUserFromToken(token: string): Promise<UserRow> {
    const payload = tokenService.verify(token);
    const row = await userRepository.findById(payload.sub);
    if (!row) throw new UnauthorizedError('Your account could no longer be found.');
    return row;
  },

  async getProfile(userId: string): Promise<PublicUser> {
    const row = await userRepository.findById(userId);
    if (!row) throw new NotFoundError('Account not found.');
    return toPublicUser(row);
  },

  async updateProfile(
    userId: string,
    changes: { name?: string; phone?: string | null },
  ): Promise<PublicUser> {
    const row = await userRepository.update(userId, changes);
    if (!row) throw new NotFoundError('Account not found.');
    return toPublicUser(row);
  },

  async changePassword(
    userId: string,
    input: { currentPassword: string; newPassword: string },
  ): Promise<void> {
    const row = await userRepository.findById(userId);
    if (!row) throw new NotFoundError('Account not found.');

    if (!(await bcrypt.compare(input.currentPassword, row.password_hash))) {
      throw new UnauthorizedError('Your current password is not correct.');
    }
    if (await bcrypt.compare(input.newPassword, row.password_hash)) {
      throw new ValidationError('Your new password must be different from the current one.');
    }

    await userRepository.updatePasswordHash(userId, await bcrypt.hash(input.newPassword, BCRYPT_ROUNDS));
    logger.info('Password changed', { userId });
  },
};
