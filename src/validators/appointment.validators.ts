import { z } from 'zod';
import { isAlignedToSlotGrid, isValidDateString, isValidTimeString } from '../utils/datetime';
import { nameSchema, phoneSchema } from './auth.validators';

/**
 * Appointment request schemas.
 *
 * These validate *shape and format* only. Whether a slot is actually free, whether
 * the clinic opens that day, and whether the time is in the past are business
 * rules — they live in the appointment service, because they depend on database
 * state that a schema cannot see.
 */

export const dateSchema = z
  .string({ required_error: 'Please choose a date.' })
  .trim()
  .refine(isValidDateString, 'Date must be a real calendar date in YYYY-MM-DD format.');

export const timeSchema = z
  .string({ required_error: 'Please choose a time.' })
  .trim()
  // Accept 'HH:mm:ss' from clients that echo a database value back to us.
  .transform((value) => value.slice(0, 5))
  .refine(isValidTimeString, 'Time must be in 24-hour HH:mm format.')
  .refine(isAlignedToSlotGrid, 'Appointments start on the hour or half hour.');

export const appointmentStatusSchema = z.enum(['BOOKED', 'COMPLETED', 'CANCELLED'], {
  errorMap: () => ({ message: 'Status must be BOOKED, COMPLETED or CANCELLED.' }),
});

const patientEmailSchema = z
  .string({ required_error: 'Email address is required.' })
  .trim()
  .min(1, 'Email address is required.')
  .max(255, 'That email address is too long.')
  .email('Please enter a valid email address.')
  .transform((value) => value.toLowerCase());

const reasonSchema = z
  .string({ required_error: 'Please tell us the reason for your visit.' })
  .trim()
  .min(3, 'Please give a reason of at least 3 characters.')
  .max(500, 'Reason must be 500 characters or fewer.');

const notesSchema = z
  .string()
  .trim()
  .max(2000, 'Notes must be 2000 characters or fewer.')
  .nullable()
  .optional()
  .transform((value) => (value ? value : null));

/**
 * Create an appointment.
 *
 * Patient fields are optional here because a signed-in user does not resend
 * details the server already holds — the service fills them from the
 * authenticated profile. For a guest they are mandatory, and the service
 * enforces that once it knows whether a user is attached. Putting the rule
 * there rather than in the schema keeps a single source of truth for it.
 */
export const createAppointmentSchema = z.object({
  patientName: nameSchema.optional(),
  patientEmail: patientEmailSchema.optional(),
  patientPhone: phoneSchema.optional(),
  appointmentDate: dateSchema,
  startTime: timeSchema,
  serviceId: z.string().uuid('That service is not recognised.').nullable().optional(),
  reason: reasonSchema,
  notes: notesSchema,
});

/** Admin edit. Every field optional; at least one must be present. */
export const updateAppointmentSchema = z
  .object({
    patientName: nameSchema.optional(),
    patientEmail: patientEmailSchema.optional(),
    patientPhone: phoneSchema.optional(),
    appointmentDate: dateSchema.optional(),
    startTime: timeSchema.optional(),
    serviceId: z.string().uuid('That service is not recognised.').nullable().optional(),
    reason: reasonSchema.optional(),
    notes: notesSchema,
    status: appointmentStatusSchema.optional(),
  })
  .refine((data) => Object.values(data).some((value) => value !== undefined), {
    message: 'There is nothing to update.',
  });

/** Patient-initiated reschedule — time only, never someone else's details. */
export const rescheduleSchema = z.object({
  appointmentDate: dateSchema,
  startTime: timeSchema,
});

export const availabilityQuerySchema = z.object({
  date: dateSchema,
});

/** Multi-day availability, used by the booking calendar to grey out full days. */
export const availabilityRangeQuerySchema = z
  .object({
    from: dateSchema,
    days: z.coerce.number().int().min(1).max(60).default(14),
  })
  .strict();

export const idParamSchema = z.object({
  id: z.string().uuid('That appointment reference is not valid.'),
});

/**
 * List/filter query.
 *
 * `coerce` is used throughout because query strings arrive as text; this is the
 * boundary where `"2"` becomes `2` and `"BOOKED,COMPLETED"` becomes an array.
 */
export const listAppointmentsQuerySchema = z.object({
  status: z
    .union([appointmentStatusSchema, z.string()])
    .optional()
    .transform((value) => {
      if (!value) return undefined;
      const parts = String(value)
        .split(',')
        .map((part) => part.trim().toUpperCase())
        .filter(Boolean);
      return parts.length > 0 ? parts : undefined;
    })
    .pipe(z.array(appointmentStatusSchema).optional()),
  scope: z.enum(['today', 'upcoming', 'past']).optional(),
  from: dateSchema.optional(),
  to: dateSchema.optional(),
  date: dateSchema.optional(),
  search: z.string().trim().max(120).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  sort: z.enum(['date_asc', 'date_desc', 'created_desc']).default('date_asc'),
});

/** Guest lookup: find my booking by reference + the email used to make it. */
export const guestLookupSchema = z.object({
  id: z.string().uuid('That appointment reference is not valid.'),
  email: patientEmailSchema,
});

export type CreateAppointmentBody = z.infer<typeof createAppointmentSchema>;
export type UpdateAppointmentBody = z.infer<typeof updateAppointmentSchema>;
export type ListAppointmentsQuery = z.infer<typeof listAppointmentsQuerySchema>;
