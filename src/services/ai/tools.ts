import { z } from 'zod';
import { appointmentService } from '../appointments/appointment.service';
import { availabilityService } from '../appointments/availability.service';
import { clinicRepository } from '../../repositories/clinic.repository';
import { knowledgeService } from './knowledge.service';
import { AppError } from '../../utils/errors';
import { logger } from '../../utils/logger';
import {
  addDays,
  clinicNow,
  dayNameFor,
  formatDateLong,
  formatTime12h,
  isValidDateString,
} from '../../utils/datetime';
import type { BookingContext, MessagePayload, PublicUser } from '../../types';

/**
 * The assistant's tool layer.
 *
 * ## The rule this file exists to enforce
 *
 * The model never touches the database, and it never decides business
 * questions. It chooses *which* tool to call and with what arguments; every
 * tool then delegates to the same services the REST API uses.
 *
 * So the model cannot:
 *   - declare a slot free                 → availabilityService decides
 *   - bypass double-booking               → the EXCLUDE constraint decides
 *   - read another patient's appointment  → appointmentService decides
 *   - invent clinic facts                 → answers come from retrieval
 *
 * The worst a confused model can do is call the wrong tool with wrong
 * arguments, and get a validation error back. Arguments are parsed with Zod
 * before any service sees them, because an LLM will occasionally produce
 * `"tomorrow"` where a date was specified.
 *
 * Every tool returns a plain object that is fed back to the model as the tool
 * result, plus an optional `payload` the chat UI renders as a rich element
 * (slot chips, a confirmation card) instead of plain text.
 */

export interface ToolContext {
  user: PublicUser | undefined;
  sessionId: string;
  bookingContext: BookingContext;
  /** Merged into the session's persisted booking context after the call. */
  contextUpdates: Partial<BookingContext>;
}

export interface ToolResult {
  /** JSON-serialisable result handed back to the model. */
  result: unknown;
  /** Structured attachment for the chat UI. */
  payload?: MessagePayload;
}

/** JSON Schema definitions advertised to the model. */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
//  Shared argument helpers
// ---------------------------------------------------------------------------

/**
 * Accepts either an ISO date or a natural phrase and resolves it against the
 * clinic's "today".
 *
 * Models are inconsistent here: told to send `YYYY-MM-DD`, they still emit
 * "tomorrow" or "next Monday" a fair share of the time. Resolving those
 * server-side is more robust than hoping the prompt holds, and it keeps date
 * arithmetic — which decides what gets booked — in deterministic code.
 */
const WEEKDAYS: Record<string, number> = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3,
  thursday: 4, thu: 4, thurs: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
};

export function resolveDatePhrase(input: string): string | null {
  const value = input.trim().toLowerCase();
  if (isValidDateString(value)) return value;

  const today = clinicNow().date;
  if (value === 'today') return today;
  if (value === 'tomorrow') return addDays(today, 1);
  if (value === 'day after tomorrow') return addDays(today, 2);

  // "monday", "next monday", "this friday" -> the next occurrence of that
  // weekday. "next X" always means the following week's X when today already
  // is X, which matches how people actually use the phrase.
  const weekdayMatch = value.match(/^(?:this\s+|next\s+|on\s+)?([a-z]+)$/);
  const target = weekdayMatch?.[1] ? WEEKDAYS[weekdayMatch[1]] : undefined;
  if (target !== undefined) {
    const wantsNextWeek = value.startsWith('next');
    const todayDow = new Date(`${today}T12:00:00Z`).getUTCDay();
    let delta = (target - todayDow + 7) % 7;
    if (delta === 0) delta = 7; // "monday" said on a Monday means next Monday
    if (wantsNextWeek && delta < 7) delta += 0;
    return addDays(today, delta);
  }

  return null;
}

const dateArg = z
  .string()
  .transform((value, ctx) => {
    const resolved = resolveDatePhrase(value);
    if (!resolved) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Could not understand the date "${value}". Use YYYY-MM-DD.`,
      });
      return z.NEVER;
    }
    return resolved;
  });

const timeArg = z
  .string()
  .transform((value, ctx) => {
    const parsed = parseTimePhrase(value);
    if (!parsed) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Could not understand the time "${value}". Use 24-hour HH:mm.`,
      });
      return z.NEVER;
    }
    return parsed;
  });

/** Accepts "14:30", "2:30 PM", "2pm", "1430". */
export function parseTimePhrase(input: string): string | null {
  const value = input.trim().toLowerCase().replace(/\./g, '');

  const match = value.match(/^(\d{1,2})(?::?(\d{2}))?\s*(am|pm)?$/);
  if (!match) return null;

  let hours = Number(match[1]);
  const minutes = Number(match[2] ?? 0);
  const meridiem = match[3];

  if (meridiem === 'pm' && hours < 12) hours += 12;
  if (meridiem === 'am' && hours === 12) hours = 0;
  // "2:30" with no meridiem, in a clinic open 09:00–17:00, means the afternoon.
  if (!meridiem && hours >= 1 && hours <= 8) hours += 12;

  if (hours > 23 || minutes > 59) return null;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
//  Tool schemas
// ---------------------------------------------------------------------------

const checkAvailabilityArgs = z.object({
  date: dateArg,
  time_preference: z.enum(['morning', 'afternoon', 'any']).optional().default('any'),
});

const createAppointmentArgs = z.object({
  date: dateArg,
  time: timeArg,
  patient_name: z.string().trim().min(2).max(120).optional(),
  patient_email: z.string().trim().email().max(255).optional(),
  patient_phone: z.string().trim().regex(/^\+?[0-9 ()\-]{7,25}$/).optional(),
  reason: z.string().trim().min(3).max(500),
  notes: z.string().trim().max(2000).optional(),
});

const appointmentIdArgs = z.object({
  appointment_id: z.string().uuid('That appointment reference is not valid.'),
});

const rescheduleArgs = z.object({
  appointment_id: z.string().uuid('That appointment reference is not valid.'),
  date: dateArg,
  time: timeArg,
});

const knowledgeArgs = z.object({
  question: z.string().trim().min(2).max(500),
});

// ---------------------------------------------------------------------------
//  Tool definitions advertised to the model
// ---------------------------------------------------------------------------

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'check_available_slots',
    description:
      'Check which 30-minute appointment slots are actually free on a given date. Always call this before offering or confirming any time — never state availability from memory. Returns the real, live list from the clinic calendar.',
    parameters: {
      type: 'object',
      properties: {
        date: {
          type: 'string',
          description: 'Date in YYYY-MM-DD format. Relative words like "tomorrow" are also accepted.',
        },
        time_preference: {
          type: 'string',
          enum: ['morning', 'afternoon', 'any'],
          description: 'Filter to the part of day the patient asked for.',
        },
      },
      required: ['date'],
    },
  },
  {
    name: 'get_clinic_information',
    description:
      'Look up clinic facts — opening hours, location, parking, policies, pricing, dentists, cancellation rules, what to bring. Call this for ANY factual question about the clinic and answer only from what it returns. Never answer such questions from memory.',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: "The patient's question, in their own words." },
      },
      required: ['question'],
    },
  },
  {
    name: 'get_services',
    description: 'List the treatments the clinic offers, with indicative starting prices.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'create_appointment',
    description:
      'Book an appointment. Only call this once you have the date, the time, and the patient\'s name, email, phone and reason for visiting. For a signed-in patient the contact details are filled in automatically and may be omitted. The booking is validated and may still be rejected if the slot was taken meanwhile.',
    parameters: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'Date in YYYY-MM-DD format.' },
        time: { type: 'string', description: 'Start time in 24-hour HH:mm format, e.g. "14:30".' },
        patient_name: { type: 'string', description: 'Full name. Omit if the patient is signed in.' },
        patient_email: { type: 'string', description: 'Email address. Omit if the patient is signed in.' },
        patient_phone: { type: 'string', description: 'Phone number. Omit if the patient is signed in.' },
        reason: { type: 'string', description: 'Reason for the visit, e.g. "check-up" or "toothache".' },
        notes: { type: 'string', description: 'Anything else the clinic should know. Optional.' },
      },
      required: ['date', 'time', 'reason'],
    },
  },
  {
    name: 'get_my_appointments',
    description:
      "List the signed-in patient's upcoming appointments. Only works when the patient is signed in.",
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'get_appointment',
    description: 'Fetch the details of one appointment by its reference.',
    parameters: {
      type: 'object',
      properties: { appointment_id: { type: 'string', description: 'The appointment UUID.' } },
      required: ['appointment_id'],
    },
  },
  {
    name: 'cancel_appointment',
    description:
      "Cancel an appointment. Confirm with the patient before calling. Only the patient's own appointments can be cancelled.",
    parameters: {
      type: 'object',
      properties: { appointment_id: { type: 'string', description: 'The appointment UUID.' } },
      required: ['appointment_id'],
    },
  },
  {
    name: 'reschedule_appointment',
    description:
      'Move an existing appointment to a different date and time. Check availability first.',
    parameters: {
      type: 'object',
      properties: {
        appointment_id: { type: 'string', description: 'The appointment UUID.' },
        date: { type: 'string', description: 'New date in YYYY-MM-DD format.' },
        time: { type: 'string', description: 'New start time in 24-hour HH:mm format.' },
      },
      required: ['appointment_id', 'date', 'time'],
    },
  },
  {
    name: 'find_next_available',
    description:
      'Find the soonest day with free appointments. Use when the patient asks for the earliest or soonest opening.',
    parameters: { type: 'object', properties: {} },
  },
];

// ---------------------------------------------------------------------------
//  Tool implementations
// ---------------------------------------------------------------------------

type ToolHandler = (args: unknown, ctx: ToolContext) => Promise<ToolResult>;

const handlers: Record<string, ToolHandler> = {
  async check_available_slots(rawArgs, ctx) {
    const { date, time_preference } = checkAvailabilityArgs.parse(rawArgs);
    const availability = await availabilityService.getDayAvailability(date);

    ctx.contextUpdates.date = date;
    if (time_preference !== 'any') ctx.contextUpdates.timePreference = time_preference;

    if (!availability.isOpen) {
      // The model is told the clinic is closed and given a concrete
      // alternative, so it can move the conversation forward instead of
      // dead-ending the patient.
      const next = await availabilityService.findNextAvailableDay(date);
      return {
        result: {
          date,
          day: availability.dayName,
          is_open: false,
          message: availability.message,
          next_available_day: next ? { date: next.date, day: next.dayName, slots: next.slots.slice(0, 6) } : null,
        },
      };
    }

    const filtered = availability.available.filter((time) => {
      if (time_preference === 'morning') return time < '12:00';
      if (time_preference === 'afternoon') return time >= '12:00';
      return true;
    });

    return {
      result: {
        date,
        day: availability.dayName,
        is_open: true,
        available_slots: filtered,
        total_available: filtered.length,
        message:
          filtered.length === 0
            ? `No ${time_preference === 'any' ? '' : `${time_preference} `}slots are free on ${availability.dayName}.`
            : undefined,
      },
      payload:
        filtered.length > 0
          ? {
              type: 'slots',
              date,
              dayName: availability.dayName,
              slots: filtered,
            }
          : undefined,
    };
  },

  async get_clinic_information(rawArgs) {
    const { question } = knowledgeArgs.parse(rawArgs);
    const context = await knowledgeService.retrieve(question);

    if (context.documents.length === 0) {
      // Explicitly telling the model that nothing was found is what makes the
      // "I can't confirm that" guardrail fire, instead of it filling the gap.
      return {
        result: {
          found: false,
          message:
            'No clinic document covers this. Tell the patient you cannot confirm that information and offer to help with something you do know, or to put them in touch with reception.',
        },
      };
    }

    return {
      result: {
        found: true,
        sources: context.sources,
        information: context.documents.map((doc) => ({ title: doc.title, content: doc.content })),
      },
    };
  },

  async get_services() {
    const services = await clinicRepository.getServices();
    return {
      result: {
        services: services.map((service) => ({
          name: service.name,
          description: service.description,
          price_from: service.priceFrom,
          duration_minutes: service.durationMin,
        })),
      },
      payload: { type: 'services', services },
    };
  },

  async create_appointment(rawArgs, ctx) {
    const args = createAppointmentArgs.parse(rawArgs);

    // Guard against a model that loops and calls the tool twice for the same
    // request. The session records the appointment it just created.
    if (ctx.bookingContext.appointmentId) {
      const existing = await appointmentService.getById(ctx.bookingContext.appointmentId).catch(() => null);
      if (
        existing &&
        existing.status === 'BOOKED' &&
        existing.appointmentDate === args.date &&
        existing.startTime === args.time
      ) {
        return {
          result: {
            success: true,
            already_booked: true,
            message: 'This appointment is already booked — do not book it again.',
            appointment: summarise(existing),
          },
        };
      }
    }

    try {
      const appointment = await appointmentService.create(
        {
          patientName: args.patient_name,
          patientEmail: args.patient_email,
          patientPhone: args.patient_phone,
          appointmentDate: args.date,
          startTime: args.time,
          reason: args.reason,
          notes: args.notes ?? null,
        },
        { user: ctx.user, source: 'CHATBOT' },
      );

      ctx.contextUpdates.appointmentId = appointment.id;
      ctx.contextUpdates.stage = 'completed';

      logger.info('Appointment created via chatbot', {
        appointmentId: appointment.id,
        sessionId: ctx.sessionId,
      });

      return {
        result: {
          success: true,
          message: 'The appointment was created successfully. Confirm the details back to the patient.',
          appointment: summarise(appointment),
        },
        payload: { type: 'booking_confirmed', appointment },
      };
    } catch (error) {
      // Failures are returned *to the model* as structured data rather than
      // thrown, so it can recover conversationally — offering the alternative
      // times the service supplied instead of the request simply failing.
      return { result: toolFailure(error) };
    }
  },

  async get_my_appointments(_rawArgs, ctx) {
    if (!ctx.user) {
      return {
        result: {
          signed_in: false,
          message:
            'The patient is not signed in. Ask them to sign in to see their appointments, or offer to look one up using its reference.',
        },
      };
    }

    const { items } = await appointmentService.listForUser(ctx.user, {
      status: ['BOOKED'],
      scope: 'upcoming',
      sort: 'date_asc',
      pageSize: 10,
    });

    return {
      result: {
        signed_in: true,
        count: items.length,
        appointments: items.map(summarise),
      },
      payload: items.length > 0 ? { type: 'appointment_list', appointments: items } : undefined,
    };
  },

  async get_appointment(rawArgs, ctx) {
    const { appointment_id } = appointmentIdArgs.parse(rawArgs);
    try {
      // Ownership is checked by the service — the model cannot widen access by
      // supplying an arbitrary id.
      const appointment = await appointmentService.getByIdForActor(appointment_id, ctx.user);
      return { result: { found: true, appointment: summarise(appointment) } };
    } catch (error) {
      return { result: toolFailure(error) };
    }
  },

  async cancel_appointment(rawArgs, ctx) {
    const { appointment_id } = appointmentIdArgs.parse(rawArgs);
    try {
      const appointment = await appointmentService.cancel(appointment_id, ctx.user);
      return {
        result: {
          success: true,
          message: 'The appointment was cancelled and the slot is free again.',
          appointment: summarise(appointment),
        },
        payload: { type: 'appointment_cancelled', appointmentId: appointment.id },
      };
    } catch (error) {
      return { result: toolFailure(error) };
    }
  },

  async reschedule_appointment(rawArgs, ctx) {
    const args = rescheduleArgs.parse(rawArgs);
    try {
      const appointment = await appointmentService.reschedule(
        args.appointment_id,
        { appointmentDate: args.date, startTime: args.time },
        ctx.user,
      );
      return {
        result: {
          success: true,
          message: 'The appointment was moved.',
          appointment: summarise(appointment),
        },
        payload: { type: 'booking_confirmed', appointment },
      };
    } catch (error) {
      return { result: toolFailure(error) };
    }
  },

  async find_next_available() {
    const next = await availabilityService.findNextAvailableDay();
    if (!next) {
      return { result: { found: false, message: 'No availability in the next three weeks.' } };
    }
    return {
      result: {
        found: true,
        date: next.date,
        day: next.dayName,
        formatted_date: formatDateLong(next.date),
        available_slots: next.slots.slice(0, 8),
      },
      payload: { type: 'slots', date: next.date, dayName: next.dayName, slots: next.slots.slice(0, 8) },
    };
  },
};

// ---------------------------------------------------------------------------
//  Dispatch
// ---------------------------------------------------------------------------

/**
 * Executes a tool call by name.
 *
 * Unknown names and malformed arguments come back as structured errors rather
 * than exceptions, because the model can act on those — it retries with
 * corrected arguments. Only genuine faults propagate.
 */
export async function executeTool(name: string, args: unknown, ctx: ToolContext): Promise<ToolResult> {
  const handler = handlers[name];
  if (!handler) {
    logger.warn('Model requested an unknown tool', { tool: name });
    return { result: { error: `Unknown tool "${name}".`, available: Object.keys(handlers) } };
  }

  const startedAt = Date.now();
  try {
    const result = await handler(args, ctx);
    logger.debug('Tool executed', { tool: name, duration: Date.now() - startedAt });
    return result;
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        result: {
          error: 'Invalid arguments.',
          issues: error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
        },
      };
    }
    logger.error('Tool execution failed', {
      tool: name,
      error: error instanceof Error ? error.message : String(error),
    });
    return { result: toolFailure(error) };
  }
}

/**
 * Converts a thrown error into something the model can reason about.
 *
 * `AppError`s carry patient-safe messages by construction, so they pass
 * through; anything else is replaced with a generic line so an internal detail
 * cannot reach the model and from there the patient.
 */
function toolFailure(error: unknown): Record<string, unknown> {
  if (error instanceof AppError) {
    const details = error.details as { alternatives?: string[] } | undefined;
    return {
      success: false,
      error: error.message,
      code: error.code,
      ...(details?.alternatives?.length
        ? {
            alternative_times: details.alternatives,
            hint: 'Offer these alternative times to the patient.',
          }
        : {}),
    };
  }
  logger.error('Unexpected tool failure', {
    error: error instanceof Error ? error.message : String(error),
  });
  return { success: false, error: 'Something went wrong. Ask the patient to try again shortly.' };
}

/** Compact appointment shape for the model — full objects waste context. */
function summarise(appointment: {
  id: string;
  appointmentDate: string;
  startTime: string;
  endTime: string;
  patientName: string;
  reason: string;
  status: string;
}) {
  return {
    id: appointment.id,
    date: appointment.appointmentDate,
    day: dayNameFor(appointment.appointmentDate),
    formatted_date: formatDateLong(appointment.appointmentDate),
    time: appointment.startTime,
    formatted_time: formatTime12h(appointment.startTime),
    ends_at: appointment.endTime,
    patient_name: appointment.patientName,
    reason: appointment.reason,
    status: appointment.status,
  };
}
