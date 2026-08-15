import { env } from './env';

/**
 * Clinic scheduling rules.
 *
 * These are the *structural* constants of the booking engine — the slot grid
 * and its granularity. The opening hours themselves live in the `clinic_hours`
 * table so staff can change them without a redeploy; this module only defines
 * how a day is divided once its window is known.
 *
 * Nothing here is duplicated in the frontend. The browser renders whatever the
 * availability endpoint returns.
 */

/** Length of a single bookable appointment, in minutes. */
export const SLOT_DURATION_MINUTES = 30;

/**
 * Fallback opening hours, used only if `clinic_hours` has not been seeded.
 * Index matches JavaScript's `Date#getDay()` — 0 = Sunday.
 */
export const DEFAULT_CLINIC_HOURS: ReadonlyArray<{
  dayOfWeek: number;
  isOpen: boolean;
  opensAt: string | null;
  closesAt: string | null;
}> = [
  { dayOfWeek: 0, isOpen: false, opensAt: null, closesAt: null }, // Sunday — closed
  { dayOfWeek: 1, isOpen: true, opensAt: '09:00', closesAt: '17:00' },
  { dayOfWeek: 2, isOpen: true, opensAt: '09:00', closesAt: '17:00' },
  { dayOfWeek: 3, isOpen: true, opensAt: '09:00', closesAt: '17:00' },
  { dayOfWeek: 4, isOpen: true, opensAt: '09:00', closesAt: '17:00' },
  { dayOfWeek: 5, isOpen: true, opensAt: '09:00', closesAt: '17:00' },
  { dayOfWeek: 6, isOpen: true, opensAt: '09:00', closesAt: '17:00' },
];

export const DAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

/**
 * How far ahead patients may book. Prevents the calendar from accepting a date
 * years out, which would otherwise pass every other validation rule.
 */
export const MAX_BOOKING_DAYS_AHEAD = 120;

/**
 * Minimum notice before an appointment starts. A patient cannot grab a slot
 * that begins in the next few minutes — reception needs time to prepare.
 */
export const MIN_BOOKING_LEAD_MINUTES = 15;

/**
 * The clinic operates in a single timezone.
 *
 * Availability, "today" and past-slot filtering are all resolved against
 * wall-clock time in this zone rather than against UTC, so the API answers the
 * same way no matter where the process runs.
 *
 * It defaults to the host's timezone rather than a hard-coded city. That keeps
 * a local run self-consistent — the seed data (generated with the database's
 * `CURRENT_DATE`), the API's notion of "today", and the browser's calendar all
 * agree. Hard-coding `America/Los_Angeles` while developing in another zone
 * silently shifts "today" by a day, which shows up as an empty
 * "Today's appointments" counter sitting above a table full of them.
 *
 * A real deployment sets `CLINIC_TIMEZONE` explicitly to the clinic's own zone.
 */
export const CLINIC_TIMEZONE =
  env.CLINIC_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
