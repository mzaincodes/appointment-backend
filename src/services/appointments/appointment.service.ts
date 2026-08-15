import { PG_ERROR, isPgError, withTransaction } from '../../db/pool';
import { appointmentRepository } from '../../repositories/appointment.repository';
import { availabilityService } from './availability.service';
import {
  ClinicClosedError,
  ForbiddenError,
  NotFoundError,
  SlotUnavailableError,
  ValidationError,
} from '../../utils/errors';
import { clinicNow, formatDateLong, formatTime12h, slotEndTime, timeToMinutes } from '../../utils/datetime';
import { logger } from '../../utils/logger';
import type {
  Appointment,
  AppointmentFilters,
  AppointmentSource,
  AppointmentStats,
  PublicUser,
  UpdateAppointmentInput,
} from '../../types';

/**
 * Appointment business logic.
 *
 * This is the single service behind *every* way an appointment can be created
 * or changed — the booking form, the chatbot's `create_appointment` tool and the
 * admin panel all call these methods. There is deliberately no second booking
 * path anywhere in the codebase.
 *
 * Authorisation lives here too, rather than in the controllers, so that the
 * chatbot cannot reach an appointment the requesting user is not entitled to
 * simply because it enters through a different door.
 */

export interface BookingActor {
  user?: PublicUser | undefined;
  source?: AppointmentSource;
}

export interface CreateBookingInput {
  patientName?: string;
  patientEmail?: string;
  patientPhone?: string;
  appointmentDate: string;
  startTime: string;
  serviceId?: string | null;
  reason: string;
  notes?: string | null;
}

export const appointmentService = {
  /**
   * Creates an appointment.
   *
   * ## How double booking is prevented
   *
   * The check-then-insert sequence below is *not* what makes this safe. Two
   * concurrent requests can both pass `checkSlot` before either inserts.
   *
   * Safety comes from the `appointments_no_overlap` EXCLUDE constraint in
   * PostgreSQL: the second INSERT to touch an overlapping time range fails with
   * SQLSTATE 23P01 no matter how the race is timed. This method catches that
   * code and converts it into a friendly 409 carrying nearby alternatives.
   *
   * The pre-flight check is still worth doing — it produces a precise message
   * ("the clinic is closed on Sundays") in the overwhelmingly common
   * uncontended case, rather than a generic conflict.
   */
  async create(input: CreateBookingInput, actor: BookingActor = {}): Promise<Appointment> {
    const { user, source = 'WEB' } = actor;

    // A signed-in patient does not resend details we already hold; anything
    // they do send wins, so they can book on behalf of a family member.
    const patientName = input.patientName?.trim() || user?.name;
    const patientEmail = (input.patientEmail?.trim() || user?.email)?.toLowerCase();
    const patientPhone = input.patientPhone?.trim() || user?.phone || undefined;

    const missing: string[] = [];
    if (!patientName) missing.push('name');
    if (!patientEmail) missing.push('email address');
    if (!patientPhone) missing.push('phone number');
    if (missing.length > 0) {
      throw new ValidationError(
        `Please provide your ${missing.join(', ')} to complete the booking.`,
        { missingFields: missing },
      );
    }

    const check = await availabilityService.checkSlot(input.appointmentDate, input.startTime);
    if (!check.bookable) {
      if (check.reason === 'CLOSED') throw new ClinicClosedError(check.message ?? undefined);
      if (check.reason === 'BOOKED') {
        const alternatives = await availabilityService.findNearestAvailable(
          input.appointmentDate,
          input.startTime,
        );
        throw new SlotUnavailableError(check.message ?? undefined, alternatives);
      }
      throw new ValidationError(check.message ?? 'That appointment time is not available.');
    }

    try {
      const appointment = await withTransaction((client) =>
        appointmentRepository.create(
          {
            userId: user?.id ?? null,
            patientName: patientName!,
            patientEmail: patientEmail!,
            patientPhone: patientPhone!,
            appointmentDate: input.appointmentDate,
            startTime: input.startTime,
            endTime: slotEndTime(input.startTime),
            serviceId: input.serviceId ?? null,
            reason: input.reason.trim(),
            notes: input.notes?.trim() || null,
            source,
          },
          client,
        ),
      );

      logger.info('Appointment created', {
        appointmentId: appointment.id,
        date: appointment.appointmentDate,
        time: appointment.startTime,
        source,
        userId: user?.id ?? null,
      });
      return appointment;
    } catch (error) {
      // The race actually happening. Re-read availability so the alternatives
      // we offer reflect the state *after* whoever beat us committed.
      if (isPgError(error) && error.code === PG_ERROR.EXCLUSION_VIOLATION) {
        logger.warn('Concurrent booking rejected by exclusion constraint', {
          date: input.appointmentDate,
          time: input.startTime,
        });
        const alternatives = await availabilityService.findNearestAvailable(
          input.appointmentDate,
          input.startTime,
        );
        throw new SlotUnavailableError(
          `${formatTime12h(input.startTime)} was just booked by someone else.`,
          alternatives,
        );
      }
      throw error;
    }
  },

  async getById(id: string): Promise<Appointment> {
    const appointment = await appointmentRepository.findById(id);
    if (!appointment) throw new NotFoundError('That appointment could not be found.');
    return appointment;
  },

  /**
   * Fetches an appointment the actor is allowed to see.
   *
   * Admins see everything. A patient sees appointments linked to their account,
   * and — because guest bookings have no `user_id` — also any booking made with
   * their email address. A 404 rather than a 403 is returned for someone else's
   * appointment, so the endpoint cannot be used to probe which ids exist.
   */
  async getByIdForActor(id: string, user: PublicUser | undefined): Promise<Appointment> {
    const appointment = await this.getById(id);
    if (user?.role === 'ADMIN') return appointment;

    const owns =
      (appointment.userId !== null && appointment.userId === user?.id) ||
      (user?.email !== undefined &&
        appointment.patientEmail.toLowerCase() === user.email.toLowerCase());

    if (!owns) throw new NotFoundError('That appointment could not be found.');
    return appointment;
  },

  /** Guest lookup by reference + the email used to book. */
  async getByIdForGuest(id: string, email: string): Promise<Appointment> {
    const appointment = await this.getById(id);
    if (appointment.patientEmail.toLowerCase() !== email.trim().toLowerCase()) {
      throw new NotFoundError('No appointment matches that reference and email address.');
    }
    return appointment;
  },

  /**
   * A patient's own appointments.
   *
   * The ownership filter is applied *last* and overwrites anything the caller
   * passed, so a crafted query string cannot widen the result set to another
   * patient's bookings.
   */
  async listForUser(user: PublicUser, filters: AppointmentFilters = {}) {
    return appointmentRepository.findMany({
      ...filters,
      userId: undefined,
      email: undefined,
      owner: { userId: user.id, email: user.email },
    });
  },

  /** Admin listing — no ownership restriction, full filter surface. */
  async listAll(filters: AppointmentFilters = {}) {
    return appointmentRepository.findMany(filters);
  },

  async getStats(): Promise<AppointmentStats> {
    return appointmentRepository.getStats();
  },

  /**
   * Admin edit.
   *
   * Moving an appointment revalidates the destination slot exactly as a fresh
   * booking would, so an admin cannot place one on a Sunday, outside opening
   * hours or on top of another patient. The exclusion constraint backs this up
   * for the concurrent case, just as it does on create.
   */
  async update(id: string, changes: UpdateAppointmentInput): Promise<Appointment> {
    const existing = await this.getById(id);

    const targetDate = changes.appointmentDate ?? existing.appointmentDate;
    const targetTime = changes.startTime ?? existing.startTime;
    const isMoving = targetDate !== existing.appointmentDate || targetTime !== existing.startTime;

    if (isMoving) {
      const check = await availabilityService.checkSlot(targetDate, targetTime, id);
      if (!check.bookable) {
        if (check.reason === 'CLOSED') throw new ClinicClosedError(check.message ?? undefined);
        if (check.reason === 'BOOKED') {
          const alternatives = await availabilityService.findNearestAvailable(targetDate, targetTime);
          throw new SlotUnavailableError(check.message ?? undefined, alternatives);
        }
        // An admin may legitimately need to record an appointment in the past
        // (e.g. a walk-in seen an hour ago), so PAST is allowed here while every
        // other reason is not.
        if (check.reason !== 'PAST') {
          throw new ValidationError(check.message ?? 'That appointment time is not available.');
        }
      }
    }

    try {
      const updated = await withTransaction((client) =>
        appointmentRepository.update(
          id,
          { ...changes, ...(isMoving ? { endTime: slotEndTime(targetTime) } : {}) },
          client,
        ),
      );
      if (!updated) throw new NotFoundError('That appointment could not be found.');

      logger.info('Appointment updated', { appointmentId: id, changes: Object.keys(changes) });
      return updated;
    } catch (error) {
      if (isPgError(error) && error.code === PG_ERROR.EXCLUSION_VIOLATION) {
        const alternatives = await availabilityService.findNearestAvailable(targetDate, targetTime);
        throw new SlotUnavailableError(
          `${formatTime12h(targetTime)} on ${formatDateLong(targetDate)} is already booked.`,
          alternatives,
        );
      }
      throw error;
    }
  },

  /**
   * Cancels an appointment, freeing its slot.
   *
   * Cancelling rather than deleting keeps the audit trail, and the exclusion
   * constraint's `WHERE status <> 'CANCELLED'` predicate makes the slot
   * immediately bookable again — no extra bookkeeping.
   */
  async cancel(id: string, actor: PublicUser | undefined): Promise<Appointment> {
    const appointment = await this.getByIdForActor(id, actor);

    if (appointment.status === 'CANCELLED') return appointment;
    if (appointment.status === 'COMPLETED') {
      throw new ValidationError('A completed appointment cannot be cancelled.');
    }

    // Patients cannot cancel an appointment that has already started; staff can.
    if (actor?.role !== 'ADMIN' && this.hasStarted(appointment)) {
      throw new ValidationError(
        'This appointment has already started. Please call the clinic on +1 (415) 555-0142.',
      );
    }

    const updated = await appointmentRepository.update(id, { status: 'CANCELLED' });
    if (!updated) throw new NotFoundError('That appointment could not be found.');

    logger.info('Appointment cancelled', { appointmentId: id, by: actor?.id ?? 'guest' });
    return updated;
  },

  /**
   * Marks an appointment completed.
   *
   * A completed appointment keeps its slot — availability excludes only
   * CANCELLED — so the time correctly stays off the calendar for patients. That
   * rule is enforced in the availability query and the exclusion constraint,
   * not in the UI.
   */
  async complete(id: string): Promise<Appointment> {
    const appointment = await this.getById(id);

    if (appointment.status === 'CANCELLED') {
      throw new ValidationError('A cancelled appointment cannot be marked as completed.');
    }
    if (appointment.status === 'COMPLETED') return appointment;

    const updated = await appointmentRepository.update(id, { status: 'COMPLETED' });
    if (!updated) throw new NotFoundError('That appointment could not be found.');

    logger.info('Appointment completed', { appointmentId: id });
    return updated;
  },

  /** Hard delete. Admin only — cancelling is preferred and keeps the record. */
  async remove(id: string): Promise<void> {
    const deleted = await appointmentRepository.delete(id);
    if (!deleted) throw new NotFoundError('That appointment could not be found.');
    logger.info('Appointment deleted', { appointmentId: id });
  },

  /**
   * Patient-initiated reschedule.
   *
   * Implemented as an update rather than cancel-and-rebook so the appointment
   * keeps its identity, and so the move is atomic — a patient can never end up
   * having released their old slot without securing a new one.
   */
  async reschedule(
    id: string,
    input: { appointmentDate: string; startTime: string },
    actor: PublicUser | undefined,
  ): Promise<Appointment> {
    const appointment = await this.getByIdForActor(id, actor);

    if (appointment.status !== 'BOOKED') {
      throw new ValidationError(
        `This appointment is ${appointment.status.toLowerCase()} and can no longer be moved.`,
      );
    }
    return this.update(id, input);
  },

  /** Links guest bookings made with this email to a newly created account. */
  async claimGuestBookings(userId: string, email: string): Promise<number> {
    const claimed = await appointmentRepository.claimGuestAppointments(userId, email);
    if (claimed > 0) logger.info('Guest appointments claimed', { userId, claimed });
    return claimed;
  },

  /** True once the appointment's start time has passed. */
  hasStarted(appointment: Appointment): boolean {
    const now = clinicNow();
    if (appointment.appointmentDate < now.date) return true;
    if (appointment.appointmentDate > now.date) return false;
    return timeToMinutes(appointment.startTime) <= timeToMinutes(now.time);
  },

  /** Guards an admin-only operation reached through a shared code path. */
  assertAdmin(user: PublicUser | undefined): asserts user is PublicUser {
    if (!user || user.role !== 'ADMIN') {
      throw new ForbiddenError('This action is restricted to clinic administrators.');
    }
  },
};
