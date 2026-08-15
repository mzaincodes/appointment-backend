import { MAX_BOOKING_DAYS_AHEAD, MIN_BOOKING_LEAD_MINUTES, SLOT_DURATION_MINUTES } from '../../config/clinic';
import { appointmentRepository } from '../../repositories/appointment.repository';
import { clinicRepository } from '../../repositories/clinic.repository';
import {
  addDays,
  clinicNow,
  dayNameFor,
  dayOfWeekFor,
  daysBetween,
  formatTime12h,
  generateSlots,
  slotEndTime,
  timeToMinutes,
} from '../../utils/datetime';
import { ValidationError } from '../../utils/errors';
import type { DayAvailability, SlotView } from '../../types';

/**
 * Availability engine.
 *
 * The single authority on which slots can be booked. Both the booking form and
 * the chatbot read from here, so the two can never disagree about what is free.
 *
 * The frontend contains no slot logic at all — it renders whatever this
 * returns. That is deliberate: availability depends on database state the
 * browser does not have, and any duplicated copy of the rules would eventually
 * drift out of sync with the ones the backend actually enforces.
 *
 * A slot is bookable when all of the following hold:
 *
 *   1. The clinic opens that weekday          (clinic_hours)
 *   2. The slot fits inside the opening window and ends by closing time
 *   3. No non-cancelled appointment holds it  (BOOKED and COMPLETED both hold)
 *   4. It is not in the past, and is at least MIN_BOOKING_LEAD_MINUTES away
 *   5. The date is within MAX_BOOKING_DAYS_AHEAD
 */

export interface SlotCheck {
  bookable: boolean;
  reason: 'BOOKED' | 'PAST' | 'CLOSED' | 'OUT_OF_RANGE' | 'NOT_A_SLOT' | null;
  message: string | null;
}

export const availabilityService = {
  /**
   * Full availability for one date.
   *
   * Returns both `available` (bookable start times, the shape the API
   * specifies) and `slots` (the complete grid with a reason attached to each
   * unavailable entry) so the UI can grey out taken slots instead of hiding
   * them — a calendar that silently omits slots looks broken.
   */
  async getDayAvailability(date: string): Promise<DayAvailability> {
    const now = clinicNow();
    const dayOfWeek = dayOfWeekFor(date);
    const dayName = dayNameFor(date);
    const hours = await clinicRepository.getHoursForDay(dayOfWeek);

    const closed = (message: string): DayAvailability => ({
      date,
      dayName,
      isOpen: false,
      opensAt: null,
      closesAt: null,
      slotDurationMinutes: SLOT_DURATION_MINUTES,
      available: [],
      slots: [],
      message,
    });

    // Dates outside the booking window are reported as unbookable rather than
    // rejected, so the calendar can render the day greyed out with a reason.
    const offset = daysBetween(now.date, date);
    if (offset < 0) return closed('That date has already passed.');
    if (offset > MAX_BOOKING_DAYS_AHEAD) {
      return closed(`Appointments can be booked up to ${MAX_BOOKING_DAYS_AHEAD} days ahead.`);
    }
    if (!hours?.isOpen || !hours.opensAt || !hours.closesAt) {
      return closed(`The clinic is closed on ${dayName}s.`);
    }

    const occupied = new Set(await appointmentRepository.findOccupiedTimes(date));
    const isToday = date === now.date;
    const earliestBookableMinute = timeToMinutes(now.time) + MIN_BOOKING_LEAD_MINUTES;

    const slots: SlotView[] = generateSlots(hours.opensAt, hours.closesAt).map((time) => {
      // Order matters: a slot that is both past and booked reads better as
      // "past", because that is the reason the patient cannot act on it.
      let reason: SlotView['reason'] = null;
      if (isToday && timeToMinutes(time) < earliestBookableMinute) reason = 'PAST';
      else if (occupied.has(time)) reason = 'BOOKED';

      return {
        time,
        endTime: slotEndTime(time),
        label: formatTime12h(time),
        available: reason === null,
        reason,
      };
    });

    const available = slots.filter((slot) => slot.available).map((slot) => slot.time);

    return {
      date,
      dayName,
      isOpen: true,
      opensAt: hours.opensAt,
      closesAt: hours.closesAt,
      slotDurationMinutes: SLOT_DURATION_MINUTES,
      available,
      slots,
      message:
        available.length === 0
          ? isToday
            ? 'There are no appointments left today. Please try tomorrow.'
            : 'This day is fully booked. Please choose another date.'
          : undefined,
    };
  },

  /**
   * Availability summary across a range of days.
   *
   * Backs the booking calendar strip, which needs to show at a glance which
   * days are open, busy or full. Occupied times for the whole range are fetched
   * in one query rather than one per day.
   */
  async getRangeAvailability(
    from: string,
    days: number,
  ): Promise<
    Array<{
      date: string;
      dayName: string;
      isOpen: boolean;
      availableCount: number;
      totalSlots: number;
      isPast: boolean;
    }>
  > {
    const now = clinicNow();
    const to = addDays(from, days - 1);
    const [hoursByDay, occupiedByDate] = await Promise.all([
      clinicRepository.getHours(),
      appointmentRepository.findOccupiedTimesInRange(from, to),
    ]);

    const results = [];
    for (let index = 0; index < days; index += 1) {
      const date = addDays(from, index);
      const hours = hoursByDay.find((entry) => entry.dayOfWeek === dayOfWeekFor(date));
      const isPast = daysBetween(now.date, date) < 0;

      if (!hours?.isOpen || !hours.opensAt || !hours.closesAt) {
        results.push({
          date,
          dayName: dayNameFor(date),
          isOpen: false,
          availableCount: 0,
          totalSlots: 0,
          isPast,
        });
        continue;
      }

      const allSlots = generateSlots(hours.opensAt, hours.closesAt);
      const occupied = new Set(occupiedByDate.get(date) ?? []);
      const isToday = date === now.date;
      const earliest = timeToMinutes(now.time) + MIN_BOOKING_LEAD_MINUTES;

      const availableCount = isPast
        ? 0
        : allSlots.filter(
            (time) => !occupied.has(time) && !(isToday && timeToMinutes(time) < earliest),
          ).length;

      results.push({
        date,
        dayName: dayNameFor(date),
        isOpen: true,
        availableCount,
        totalSlots: allSlots.length,
        isPast,
      });
    }
    return results;
  },

  /**
   * Can this exact slot be booked right now?
   *
   * Used as a pre-flight check by the booking service and by the chatbot's
   * `check_available_slots` tool. It is *not* the double-booking guarantee —
   * that is the database exclusion constraint. This produces a helpful message
   * in the ordinary case; the constraint handles the race.
   */
  async checkSlot(date: string, startTime: string, excludeAppointmentId?: string): Promise<SlotCheck> {
    const now = clinicNow();
    const dayName = dayNameFor(date);

    const offset = daysBetween(now.date, date);
    if (offset < 0) {
      return { bookable: false, reason: 'PAST', message: 'That date has already passed.' };
    }
    if (offset > MAX_BOOKING_DAYS_AHEAD) {
      return {
        bookable: false,
        reason: 'OUT_OF_RANGE',
        message: `Appointments can only be booked up to ${MAX_BOOKING_DAYS_AHEAD} days ahead.`,
      };
    }

    const hours = await clinicRepository.getHoursForDay(dayOfWeekFor(date));
    if (!hours?.isOpen || !hours.opensAt || !hours.closesAt) {
      return {
        bookable: false,
        reason: 'CLOSED',
        message: `The clinic is closed on ${dayName}s. We are open Monday to Saturday, 9:00 AM to 5:00 PM.`,
      };
    }

    // Must sit on the generated grid — this rejects both out-of-hours times and
    // anything that would end after closing.
    if (!generateSlots(hours.opensAt, hours.closesAt).includes(startTime)) {
      return {
        bookable: false,
        reason: 'NOT_A_SLOT',
        message: `${formatTime12h(startTime)} is not an available appointment time on ${dayName}s.`,
      };
    }

    if (date === now.date && timeToMinutes(startTime) < timeToMinutes(now.time) + MIN_BOOKING_LEAD_MINUTES) {
      return {
        bookable: false,
        reason: 'PAST',
        message: `${formatTime12h(startTime)} has already passed or is too soon to book today.`,
      };
    }

    if (await appointmentRepository.isSlotTaken(date, startTime, excludeAppointmentId ?? null)) {
      return {
        bookable: false,
        reason: 'BOOKED',
        message: `${formatTime12h(startTime)} on ${dayName} is already booked.`,
      };
    }

    return { bookable: true, reason: null, message: null };
  },

  /**
   * The bookable times nearest to a preferred one, ranked by closeness.
   *
   * When a slot is taken, offering "the next three closest times" is far more
   * useful than a bare rejection. Both the REST error payload and the chatbot's
   * fallback reply are built from this.
   */
  async findNearestAvailable(date: string, preferredTime: string, limit = 3): Promise<string[]> {
    const availability = await this.getDayAvailability(date);
    const target = timeToMinutes(preferredTime);

    const sameDay = [...availability.available]
      .sort((a, b) => Math.abs(timeToMinutes(a) - target) - Math.abs(timeToMinutes(b) - target))
      .slice(0, limit);

    if (sameDay.length > 0) return sameDay;

    // Nothing left that day — look forward for the next open day with capacity.
    // Capped so a fully-booked stretch cannot turn this into a long scan.
    for (let offset = 1; offset <= 7; offset += 1) {
      const nextDate = addDays(date, offset);
      const next = await this.getDayAvailability(nextDate);
      if (next.available.length > 0) return next.available.slice(0, limit);
    }
    return [];
  },

  /**
   * The next open day at or after `from` that still has a free slot.
   *
   * Used by the chatbot when a patient asks for the "earliest" or "soonest"
   * appointment.
   */
  async findNextAvailableDay(
    from?: string,
  ): Promise<{ date: string; dayName: string; slots: string[] } | null> {
    const start = from ?? clinicNow().date;
    for (let offset = 0; offset <= 21; offset += 1) {
      const date = addDays(start, offset);
      const availability = await this.getDayAvailability(date);
      if (availability.available.length > 0) {
        return { date, dayName: availability.dayName, slots: availability.available };
      }
    }
    return null;
  },

  /** Guards a date before it is used for anything expensive. */
  assertBookableDate(date: string): void {
    const offset = daysBetween(clinicNow().date, date);
    if (offset < 0) throw new ValidationError('That date has already passed.');
    if (offset > MAX_BOOKING_DAYS_AHEAD) {
      throw new ValidationError(
        `Appointments can only be booked up to ${MAX_BOOKING_DAYS_AHEAD} days ahead.`,
      );
    }
  },
};
