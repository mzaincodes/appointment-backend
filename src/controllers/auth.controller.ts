import type { Request, Response } from 'express';
import { authService } from '../services/auth/auth.service';
import { appointmentService } from '../services/appointments/appointment.service';
import { env } from '../config/env';
import { created, ok } from '../utils/http';
import { UnauthorizedError } from '../utils/errors';
import type { ChangePasswordInput, LoginInput, RegisterInput, UpdateProfileInput } from '../validators/auth.validators';

/**
 * Auth controllers.
 *
 * Thin by design: read the (already validated) request, call a service, shape
 * the response. No business rules, no SQL, no error handling — a thrown
 * AppError is caught by the central error middleware.
 */

/**
 * The token is returned in the body *and* set as a cookie.
 *
 * The frontend uses the body value (kept in localStorage so a refreshed tab can
 * restore its session and attach the header to API calls). The cookie is
 * `httpOnly`, so it is not readable from JavaScript, and exists so the API can
 * also be exercised directly from a browser during development.
 */
function setAuthCookie(res: Response, token: string): void {
  res.cookie('token', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.isProduction,
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/',
  });
}

export const authController = {
  async register(req: Request, res: Response): Promise<Response> {
    const body = req.body as RegisterInput;
    const result = await authService.register(body);

    // Someone who booked as a guest and then signs up with the same address
    // should find that appointment already in their account.
    const claimed = await appointmentService.claimGuestBookings(result.user.id, result.user.email);

    setAuthCookie(res, result.token);
    return created(
      res,
      { ...result, claimedAppointments: claimed },
      claimed > 0
        ? `Welcome! We also linked ${claimed} existing appointment${claimed === 1 ? '' : 's'} to your account.`
        : 'Your account has been created.',
    );
  },

  async login(req: Request, res: Response): Promise<Response> {
    const body = req.body as LoginInput;
    const result = await authService.login(body);
    setAuthCookie(res, result.token);
    return ok(res, result, 'Signed in successfully.');
  },

  /** Returns the caller's profile. `requireAuth` guarantees `req.user`. */
  async me(req: Request, res: Response): Promise<Response> {
    if (!req.user) throw new UnauthorizedError();
    return ok(res, { user: await authService.getProfile(req.user.id) });
  },

  /**
   * Sign out.
   *
   * Clears the cookie; the client discards its stored token. JWTs are
   * stateless, so a token that has leaked stays valid until it expires — a
   * server-side denylist would be the production answer, and that trade-off is
   * recorded in the README under Assumptions and Limitations.
   */
  async logout(_req: Request, res: Response): Promise<Response> {
    res.clearCookie('token', { path: '/' });
    return ok(res, { loggedOut: true }, 'You have been signed out.');
  },

  async updateProfile(req: Request, res: Response): Promise<Response> {
    if (!req.user) throw new UnauthorizedError();
    const body = req.body as UpdateProfileInput;
    return ok(res, { user: await authService.updateProfile(req.user.id, body) }, 'Profile updated.');
  },

  async changePassword(req: Request, res: Response): Promise<Response> {
    if (!req.user) throw new UnauthorizedError();
    const body = req.body as ChangePasswordInput;
    await authService.changePassword(req.user.id, body);
    return ok(res, { changed: true }, 'Your password has been updated.');
  },
};
