import type { Request, Response } from 'express';
import { appointmentService } from '../services/appointments/appointment.service';
import { availabilityService } from '../services/appointments/availability.service';
import { created, ok, paginated } from '../utils/http';
import { UnauthorizedError } from '../utils/errors';
import type { CreateAppointmentBody, ListAppointmentsQuery, UpdateAppointmentBody } from '../validators/appointment.validators';

/** Appointment controllers. Thin — all rules live in the service layer. */
export const appointmentController = {
  /**
   * `GET /api/appointments/availability?date=YYYY-MM-DD`
   *
   * Public: the booking calendar must work before sign-in.
   */
  async availability(req: Request, res: Response): Promise<Response> {
    const { date } = req.query as unknown as { date: string };
    return ok(res, await availabilityService.getDayAvailability(date));
  },

  /** `GET /api/appointments/availability/range?from=…&days=…` */
  async availabilityRange(req: Request, res: Response): Promise<Response> {
    const { from, days } = req.query as unknown as { from: string; days: number };
    return ok(res, { days: await availabilityService.getRangeAvailability(from, days) });
  },

  /** `GET /api/appointments/next-available` */
  async nextAvailable(_req: Request, res: Response): Promise<Response> {
    return ok(res, { next: await availabilityService.findNextAvailableDay() });
  },

  /**
   * `POST /api/appointments`
   *
   * Works signed in or out (`optionalAuth`). When a user is attached the
   * service fills any missing patient details from their profile and links the
   * appointment to their account.
   */
  async create(req: Request, res: Response): Promise<Response> {
    const body = req.body as CreateAppointmentBody;
    const appointment = await appointmentService.create(body, {
      user: req.user,
      source: 'WEB',
    });
    return created(res, { appointment }, 'Your appointment is confirmed.');
  },

  /**
   * `GET /api/appointments`
   *
   * Returns the caller's own appointments. Admins wanting the full list use
   * `/api/admin/appointments`, which is a separate, role-guarded route — this
   * one never widens beyond the authenticated patient.
   */
  async list(req: Request, res: Response): Promise<Response> {
    if (!req.user) throw new UnauthorizedError();
    const query = req.query as unknown as ListAppointmentsQuery;

    const result = await appointmentService.listForUser(req.user, query);
    return paginated(res, result.items, {
      page: result.page,
      pageSize: result.pageSize,
      total: result.total,
    });
  },

  /** `GET /api/appointments/:id` — ownership enforced in the service. */
  async getById(req: Request, res: Response): Promise<Response> {
    const { id } = req.params as { id: string };
    return ok(res, { appointment: await appointmentService.getByIdForActor(id, req.user) });
  },

  /**
   * `GET /api/appointments/lookup?id=…&email=…`
   *
   * Lets a guest retrieve the booking they just made without an account. The
   * email must match the one on the appointment, so a bare id is not enough.
   */
  async guestLookup(req: Request, res: Response): Promise<Response> {
    const { id, email } = req.query as unknown as { id: string; email: string };
    return ok(res, { appointment: await appointmentService.getByIdForGuest(id, email) });
  },

  /** `PATCH /api/appointments/:id` — patient reschedule (time only). */
  async reschedule(req: Request, res: Response): Promise<Response> {
    if (!req.user) throw new UnauthorizedError();
    const { id } = req.params as { id: string };
    const body = req.body as { appointmentDate: string; startTime: string };

    const appointment = await appointmentService.reschedule(id, body, req.user);
    return ok(res, { appointment }, 'Your appointment has been moved.');
  },

  /**
   * `DELETE /api/appointments/:id`
   *
   * Cancels rather than deletes: the record is kept for the audit trail and the
   * slot is released because availability ignores CANCELLED rows.
   */
  async cancel(req: Request, res: Response): Promise<Response> {
    if (!req.user) throw new UnauthorizedError();
    const { id } = req.params as { id: string };

    const appointment = await appointmentService.cancel(id, req.user);
    return ok(res, { appointment }, 'Your appointment has been cancelled.');
  },
};

/**
 * Admin appointment controllers.
 *
 * Mounted under `/api/admin`, behind `requireAuth` + `requireAdmin`. Kept in a
 * separate object so the privileged surface is obvious when reading the file.
 */
export const adminAppointmentController = {
  /** `GET /api/admin/appointments` — full list with filters and search. */
  async list(req: Request, res: Response): Promise<Response> {
    const query = req.query as unknown as ListAppointmentsQuery;
    const result = await appointmentService.listAll(query);
    return paginated(res, result.items, {
      page: result.page,
      pageSize: result.pageSize,
      total: result.total,
    });
  },

  /** `GET /api/admin/appointments/stats` — dashboard counters. */
  async stats(_req: Request, res: Response): Promise<Response> {
    return ok(res, await appointmentService.getStats());
  },

  /** `GET /api/admin/appointments/:id` */
  async getById(req: Request, res: Response): Promise<Response> {
    const { id } = req.params as { id: string };
    return ok(res, { appointment: await appointmentService.getById(id) });
  },

  /** `POST /api/admin/appointments` — book on a patient's behalf. */
  async create(req: Request, res: Response): Promise<Response> {
    const body = req.body as CreateAppointmentBody;
    const appointment = await appointmentService.create(body, { user: undefined, source: 'ADMIN' });
    return created(res, { appointment }, 'Appointment created.');
  },

  /** `PATCH /api/admin/appointments/:id` — edit any field, including status. */
  async update(req: Request, res: Response): Promise<Response> {
    const { id } = req.params as { id: string };
    const body = req.body as UpdateAppointmentBody;
    return ok(res, { appointment: await appointmentService.update(id, body) }, 'Appointment updated.');
  },

  /**
   * `PATCH /api/admin/appointments/:id/complete`
   *
   * The completed slot stays occupied — availability excludes only CANCELLED —
   * so it correctly disappears from the patient-facing calendar.
   */
  async complete(req: Request, res: Response): Promise<Response> {
    const { id } = req.params as { id: string };
    return ok(res, { appointment: await appointmentService.complete(id) }, 'Appointment marked as completed.');
  },

  /** `PATCH /api/admin/appointments/:id/cancel` — frees the slot. */
  async cancel(req: Request, res: Response): Promise<Response> {
    const { id } = req.params as { id: string };
    return ok(res, { appointment: await appointmentService.cancel(id, req.user) }, 'Appointment cancelled.');
  },

  /** `DELETE /api/admin/appointments/:id` — permanent removal. */
  async remove(req: Request, res: Response): Promise<Response> {
    const { id } = req.params as { id: string };
    await appointmentService.remove(id);
    return ok(res, { deleted: true }, 'Appointment deleted.');
  },
};
