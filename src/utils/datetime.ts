import { CLINIC_TIMEZONE, DAY_NAMES, SLOT_DURATION_MINUTES } from '../config/clinic';

/**
 * Date and time helpers for the booking engine.
 *
 * Everything here works on plain strings — `YYYY-MM-DD` for dates and `HH:mm`
 * for times — which is exactly how the values are stored in PostgreSQL (DATE
 * and TIME columns). Avoiding `Date` objects for the domain logic removes a
 * whole category of timezone-offset bugs: a `Date` for "2026-08-17 09:00"
 * means different instants depending on where the process runs, while the
 * string "09:00" on "2026-08-17" is unambiguous for a single-location clinic.
 *
 * `Date` is used in exactly one place — resolving what "now" is in the clinic's
 * timezone — and it is immediately converted back to strings.
 */

export const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
export const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Minutes since midnight for an `HH:mm` (or `HH:mm:ss`) string. */
export function timeToMinutes(time: string): number {
  const [hours = '0', minutes = '0'] = time.split(':');
  return Number(hours) * 60 + Number(minutes);
}

/** Inverse of {@link timeToMinutes}, always zero-padded to `HH:mm`. */
export function minutesToTime(minutes: number): string {
  const normalised = ((minutes % 1440) + 1440) % 1440;
  const hours = Math.floor(normalised / 60);
  const mins = normalised % 60;
  return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
}

/** Trims a PostgreSQL `TIME` value (`09:00:00`) down to `09:00`. */
export function normaliseTime(time: string): string {
  return time.slice(0, 5);
}

/** Adds minutes to an `HH:mm` string. */
export function addMinutes(time: string, minutes: number): string {
  return minutesToTime(timeToMinutes(time) + minutes);
}

/** The slot that follows `start`, i.e. its end time. */
export function slotEndTime(start: string): string {
  return addMinutes(start, SLOT_DURATION_MINUTES);
}

/**
 * "Now" as wall-clock strings in the clinic's timezone.
 *
 * `en-CA` is used because its short date format is already ISO (`YYYY-MM-DD`),
 * which avoids hand-assembling the parts.
 */
export function clinicNow(): { date: string; time: string; dayOfWeek: number } {
  const now = new Date();

  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone: CLINIC_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);

  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: CLINIC_TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(now);

  return { date, time, dayOfWeek: dayOfWeekFor(date) };
}

/** Today's date in the clinic timezone, as `YYYY-MM-DD`. */
export function clinicToday(): string {
  return clinicNow().date;
}

/**
 * Day of week for a `YYYY-MM-DD` string, 0 = Sunday.
 *
 * Parsed as UTC noon so the result cannot slip a day because of a local offset.
 */
export function dayOfWeekFor(date: string): number {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year!, (month ?? 1) - 1, day ?? 1, 12)).getUTCDay();
}

/** Human-readable weekday, e.g. `"Monday"`. */
export function dayNameFor(date: string): string {
  return DAY_NAMES[dayOfWeekFor(date)] ?? 'Unknown';
}

/** Shifts a `YYYY-MM-DD` string by whole days. */
export function addDays(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number);
  const shifted = new Date(Date.UTC(year!, (month ?? 1) - 1, (day ?? 1) + days, 12));
  return shifted.toISOString().slice(0, 10);
}

/** Whole days from `from` to `to`; negative when `to` is in the past. */
export function daysBetween(from: string, to: string): number {
  const parse = (value: string) => {
    const [year, month, day] = value.split('-').map(Number);
    return Date.UTC(year!, (month ?? 1) - 1, day ?? 1);
  };
  return Math.round((parse(to) - parse(from)) / 86_400_000);
}

/** Structural check only — does not verify the date exists on the calendar. */
export function isValidDateString(date: string): boolean {
  if (!DATE_PATTERN.test(date)) return false;
  const [year, month, day] = date.split('-').map(Number);
  const parsed = new Date(Date.UTC(year!, (month ?? 1) - 1, day ?? 1));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === (month ?? 1) - 1 &&
    parsed.getUTCDate() === day
  );
}

export function isValidTimeString(time: string): boolean {
  return TIME_PATTERN.test(time);
}

/** True when the time sits on the clinic's 30-minute grid. */
export function isAlignedToSlotGrid(time: string): boolean {
  return timeToMinutes(time) % SLOT_DURATION_MINUTES === 0;
}

/**
 * Every slot start between `opensAt` and `closesAt`.
 *
 * The final slot must *end* by closing time, so a 09:00–17:00 day yields
 * 09:00 … 16:30 and 17:00 is correctly excluded as a start time.
 */
export function generateSlots(opensAt: string, closesAt: string): string[] {
  const slots: string[] = [];
  const close = timeToMinutes(closesAt);
  for (
    let minute = timeToMinutes(opensAt);
    minute + SLOT_DURATION_MINUTES <= close;
    minute += SLOT_DURATION_MINUTES
  ) {
    slots.push(minutesToTime(minute));
  }
  return slots;
}

/** `"2026-08-17"` -> `"Monday, 17 August 2026"`. */
export function formatDateLong(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year!, (month ?? 1) - 1, day ?? 1, 12)));
}

/** `"14:30"` -> `"2:30 PM"`. */
export function formatTime12h(time: string): string {
  const [hoursRaw, minutes = '00'] = normaliseTime(time).split(':');
  const hours = Number(hoursRaw);
  const period = hours >= 12 ? 'PM' : 'AM';
  const display = hours % 12 === 0 ? 12 : hours % 12;
  return `${display}:${minutes} ${period}`;
}
