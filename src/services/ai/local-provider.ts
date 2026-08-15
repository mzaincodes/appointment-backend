import { randomUUID } from 'node:crypto';
import type { AiProvider, LlmMessage, LlmResponse, LlmToolCall, ProviderSession } from './provider';
import type { ToolDefinition } from './tools';
import { parseTimePhrase, resolveDatePhrase } from './tools';
import { formatDateLong, formatTime12h } from '../../utils/datetime';

/**
 * Offline provider — used when no `AI_API_KEY` is configured.
 *
 * ## What this is
 *
 * A deterministic intent classifier and dialogue manager that speaks the *same*
 * protocol as a hosted model: it receives the conversation and returns either
 * text or tool calls. It plugs into the identical agent loop, calls the
 * identical tools, and books through the identical appointment service.
 *
 * So the booking it performs is entirely real — availability comes from the
 * database, the exclusion constraint still guards double booking, and the
 * appointment it creates is the same row the booking form would have created.
 *
 * ## What this is not
 *
 * It is not a language model, and it is not pretending to be one. It handles
 * the intents a dental receptionist actually gets — book, reschedule, cancel,
 * opening hours, prices, services, location — and routes anything else to
 * knowledge retrieval. Genuinely open-ended conversation is where it stops and
 * a real model earns its place.
 *
 * ## Why it exists
 *
 * Two reasons. It makes the project runnable and reviewable without anyone
 * having to obtain an API key, and it is the graceful-degradation path: if the
 * provider is down mid-conversation, patients can still book instead of hitting
 * an error. The chat UI labels the mode so nobody mistakes it for the hosted
 * model.
 *
 * Set `AI_API_KEY` and this class is never constructed.
 */
export class LocalRuleBasedProvider implements AiProvider {
  readonly name = 'local';
  readonly model = 'rule-based-offline';
  readonly isLive = false;

  async chat(
    messages: LlmMessage[],
    _tools: ToolDefinition[],
    session?: ProviderSession,
  ): Promise<LlmResponse> {
    const last = messages[messages.length - 1];

    // A tool has just run: turn its structured result into a reply.
    if (last?.role === 'tool') {
      return this.respondToToolResult(last, messages, session);
    }

    const userText = lastUserMessage(messages);
    if (!userText) return text(GREETING);

    return this.routeUserMessage(userText, messages, session);
  }

  // -------------------------------------------------------------------------
  //  Intent routing
  // -------------------------------------------------------------------------
  private routeUserMessage(
    userText: string,
    messages: LlmMessage[],
    session?: ProviderSession,
  ): LlmResponse {
    const normalised = userText.toLowerCase().trim();

    // Details accumulate across turns, so "Monday" said three messages ago is
    // still in play when the patient finally names a time.
    const collected = collectDetails(messages, session);

    if (isGreeting(normalised)) return text(GREETING);
    if (matches(normalised, ['thank', 'thanks', 'cheers', 'appreciate'])) {
      return text("You're very welcome! Is there anything else I can help you with? 😊");
    }
    if (matches(normalised, ['bye', 'goodbye', 'see you'])) {
      return text('Thanks for chatting — take care, and we look forward to seeing you! 👋');
    }

    if (matches(normalised, ['my appointment', 'my booking', 'upcoming appointment', 'do i have'])) {
      return toolCall('get_my_appointments', {});
    }

    // "Cancel my appointment" is an action; "what is the cancellation policy"
    // is a question that happens to contain the word. Requiring an object
    // ("my appointment", "it") separates the two — without it, every policy
    // question would be answered by starting a cancellation.
    if (isCancelRequest(normalised)) return this.handleCancel(collected, session);
    if (isRescheduleRequest(normalised)) return toolCall('get_my_appointments', {});

    if (matches(normalised, ['service', 'treatment', 'what do you offer', 'what do you do', 'procedure'])) {
      return toolCall('get_services', {});
    }
    if (matches(normalised, ['earliest', 'soonest', 'next available', 'asap', 'as soon as'])) {
      return toolCall('find_next_available', {});
    }

    // Booking is inferred from an explicit request, or from the patient
    // supplying booking information while one is already under way.
    //
    // The second condition deliberately requires the message to *carry*
    // something the flow needs — a date, a time, contact details, a reason or
    // a plain yes. Treating any message as a booking answer just because a
    // booking is open means an unrelated question ("do you sell used cars?")
    // gets answered with the previous step of the booking instead.
    const explicitBooking = matches(normalised, [
      'book', 'appointment', 'schedule', 'see the dentist', 'come in', 'slot', 'visit',
    ]);
    const continuesBooking = collected.stage === 'booking' && advancesBooking(userText, normalised);

    if (explicitBooking || continuesBooking) return this.handleBooking(collected, session);

    // Anything factual goes to retrieval rather than being answered from
    // memory — the same guardrail a hosted model operates under.
    return toolCall('get_clinic_information', { question: userText });
  }

  /**
   * Booking flow.
   *
   * Asks for exactly one missing thing at a time, in the order a receptionist
   * would, and never re-asks for something already supplied.
   */
  private handleBooking(collected: CollectedDetails, session?: ProviderSession): LlmResponse {
    if (!collected.date) {
      return text(
        "I'd be happy to book that for you. Which day would suit you? We're open Monday to Saturday, 9:00 AM to 5:00 PM.",
      );
    }

    if (!collected.time) {
      return toolCall('check_available_slots', {
        date: collected.date,
        time_preference: collected.timePreference ?? 'any',
      });
    }

    // Signed-in patients never get asked for details already on their profile.
    const needsName = !session?.signedIn && !collected.patientName;
    const needsEmail = !session?.signedIn && !collected.patientEmail;
    const needsPhone = !session?.signedIn && !collected.patientPhone;

    if (needsName || needsEmail || needsPhone) {
      const missing = [
        needsName ? 'your full name' : null,
        needsEmail ? 'your email address' : null,
        needsPhone ? 'a contact phone number' : null,
      ].filter(Boolean);

      return text(
        `Great — ${formatTime12h(collected.time)} on ${formatDateLong(collected.date)} it is. ` +
          `To confirm the booking I just need ${joinWithAnd(missing as string[])}.\n\n` +
          'You can send it all in one message, for example: `Jane Doe, jane@example.com, +1 415 555 0123`',
      );
    }

    if (!collected.reason) {
      return text(
        "Thank you. Last thing — what's the reason for your visit? For example a check-up, a cleaning, or a specific problem like toothache.",
      );
    }

    return toolCall('create_appointment', {
      date: collected.date,
      time: collected.time,
      reason: collected.reason,
      ...(collected.patientName ? { patient_name: collected.patientName } : {}),
      ...(collected.patientEmail ? { patient_email: collected.patientEmail } : {}),
      ...(collected.patientPhone ? { patient_phone: collected.patientPhone } : {}),
    });
  }

  private handleCancel(collected: CollectedDetails, session?: ProviderSession): LlmResponse {
    if (collected.appointmentId) {
      return toolCall('cancel_appointment', { appointment_id: collected.appointmentId });
    }
    if (!session?.signedIn) {
      return text(
        'I can help with that. Please sign in so I can find your appointment, or call reception on +1 (415) 555-0142 and they will cancel it straight away.',
      );
    }
    return toolCall('get_my_appointments', {});
  }

  // -------------------------------------------------------------------------
  //  Rendering tool results
  // -------------------------------------------------------------------------
  private respondToToolResult(
    toolMessage: LlmMessage,
    messages: LlmMessage[],
    session?: ProviderSession,
  ): LlmResponse {
    const result = safeParse(toolMessage.content);
    const toolName = toolMessage.name ?? '';

    switch (toolName) {
      case 'check_available_slots':
        return this.renderSlots(result, messages, session);
      case 'get_clinic_information':
        return this.renderKnowledge(result);
      case 'get_services':
        return this.renderServices(result);
      case 'create_appointment':
      case 'reschedule_appointment':
        return this.renderBookingOutcome(result);
      case 'get_my_appointments':
        return this.renderMyAppointments(result);
      case 'cancel_appointment':
        return this.renderCancellation(result);
      case 'find_next_available':
        return this.renderNextAvailable(result);
      default:
        return text("Here's what I found. Is there anything else I can help with?");
    }
  }

  private renderSlots(result: Record<string, unknown>, messages: LlmMessage[], session?: ProviderSession): LlmResponse {
    if (result.is_open === false) {
      const next = result.next_available_day as { date: string; day: string; slots: string[] } | null;
      const base = String(result.message ?? 'We are closed that day.');
      if (!next) return text(`${base} Could you choose another day?`);
      // formatDateLong already leads with the weekday.
      return text(
        `${base}\n\nOur next opening is **${formatDateLong(next.date)}**. ` +
          `Would any of these times work?`,
      );
    }

    const slots = (result.available_slots as string[] | undefined) ?? [];
    const day = String(result.day ?? '');
    const date = String(result.date ?? '');

    // `formatDateLong` already begins with the weekday, so `day` is not
    // repeated alongside it.
    if (slots.length === 0) {
      return text(
        `I'm sorry — there's nothing free on ${formatDateLong(date)}. Would you like me to check another day?`,
      );
    }

    // A time already named earlier: confirm it if it survived the availability
    // check, otherwise offer what is genuinely free.
    const collected = collectDetails(messages, session);
    if (collected.time && !slots.includes(collected.time)) {
      return text(
        `I'm sorry, ${formatTime12h(collected.time)} is no longer available on ${day}.\n\n` +
          `Here are the closest times I can offer — just tap one:`,
      );
    }

    return text(`Here's what's available on **${formatDateLong(date)}**. Tap a time to choose it:`);
  }

  private renderKnowledge(result: Record<string, unknown>): LlmResponse {
    if (result.found === false) {
      // The explicit "I can't confirm that" guardrail.
      return text(
        "I'm not able to confirm that information. Let me help you with what I do have — I can tell you about our opening hours, services, prices, location and booking, or I can book an appointment for you right now.\n\n" +
          'For anything else, reception will be glad to help on +1 (415) 555-0142.',
      );
    }

    const documents = (result.information as Array<{ title: string; content: string }> | undefined) ?? [];
    if (documents.length === 0) return text("I'm not able to confirm that information.");

    // Answers are the retrieved text verbatim — nothing is generated, so
    // nothing can be invented.
    const primary = documents[0]!;
    const body = documents
      .slice(0, 2)
      .map((doc) => doc.content)
      .join('\n\n');

    return text(`${body}\n\nIs there anything else I can help you with? _(${primary.title})_`);
  }

  private renderServices(result: Record<string, unknown>): LlmResponse {
    const services = (result.services as Array<{ name: string; price_from: number | null }> | undefined) ?? [];
    const list = services
      .map((service) => `• **${service.name}**${service.price_from ? ` — from $${service.price_from}` : ''}`)
      .join('\n');

    return text(
      `Here's what we offer at Bright Smile Dental Studio:\n\n${list}\n\n` +
        'Every appointment is a 30-minute slot. Would you like me to book one for you?',
    );
  }

  private renderBookingOutcome(result: Record<string, unknown>): LlmResponse {
    if (result.success === false) {
      const alternatives = result.alternative_times as string[] | undefined;
      const message = String(result.error ?? 'I could not complete that booking.');
      if (alternatives?.length) {
        return text(
          `${message}\n\nHere are the closest available times — tap one and I'll book it:\n\n` +
            alternatives.map((time) => `• ${formatTime12h(time)}`).join('\n'),
        );
      }
      return text(`${message}\n\nWould you like to try a different day or time?`);
    }

    const appointment = result.appointment as
      | { formatted_date: string; formatted_time: string; reason: string; patient_name: string }
      | undefined;

    if (!appointment) return text('Your appointment is confirmed. 🎉');

    if (result.already_booked) {
      return text(
        `You're already booked in for **${appointment.formatted_date} at ${appointment.formatted_time}**. ` +
          'Is there anything else I can help with?',
      );
    }

    return text(
      `Perfect — you're all booked! 🎉\n\n` +
        `**${appointment.formatted_date}**\n` +
        `**${appointment.formatted_time}** · 30 minutes\n` +
        `Reason: ${appointment.reason}\n\n` +
        `We've reserved that slot for ${appointment.patient_name}. Please arrive five minutes early. ` +
        'Is there anything else I can help you with?',
    );
  }

  private renderMyAppointments(result: Record<string, unknown>): LlmResponse {
    if (result.signed_in === false) {
      return text(
        'Please sign in and I can pull up your appointments right away. If you booked as a guest, reception can find it for you on +1 (415) 555-0142.',
      );
    }

    const appointments =
      (result.appointments as Array<{ formatted_date: string; formatted_time: string; reason: string }> | undefined) ?? [];

    if (appointments.length === 0) {
      return text(
        "You don't have any upcoming appointments at the moment. Would you like me to book one for you?",
      );
    }

    const list = appointments
      .map((appointment) => `• **${appointment.formatted_date}** at **${appointment.formatted_time}** — ${appointment.reason}`)
      .join('\n');

    return text(
      `Here are your upcoming appointments:\n\n${list}\n\nWould you like to reschedule or cancel any of them?`,
    );
  }

  private renderCancellation(result: Record<string, unknown>): LlmResponse {
    if (result.success === false) {
      return text(`${String(result.error ?? 'I could not cancel that appointment.')}`);
    }
    return text(
      'That appointment has been cancelled and the slot is free again. If you would like to rebook, just let me know a day that suits you.',
    );
  }

  private renderNextAvailable(result: Record<string, unknown>): LlmResponse {
    if (result.found === false) {
      return text(
        "I couldn't find any availability in the next three weeks. Please call reception on +1 (415) 555-0142 and they will find you something.",
      );
    }
    return text(
      `Our soonest availability is **${String(result.day)}, ${String(result.formatted_date)}**. Tap a time to book it:`,
    );
  }
}

// ---------------------------------------------------------------------------
//  Conversation parsing
// ---------------------------------------------------------------------------

interface CollectedDetails {
  date: string | null;
  time: string | null;
  timePreference: 'morning' | 'afternoon' | 'any' | null;
  patientName: string | null;
  patientEmail: string | null;
  patientPhone: string | null;
  reason: string | null;
  appointmentId: string | null;
  stage: 'booking' | null;
}

/**
 * Walks the transcript and reconstructs everything the patient has said.
 *
 * This is the multi-turn memory. Scanning the whole history — newest first, so
 * a correction wins — means "Monday" from three messages back still applies
 * when the patient finally names a time. The persisted `bookingContext` seeds
 * it, so state also survives a reload or a socket reconnect.
 */
function collectDetails(messages: LlmMessage[], session?: ProviderSession): CollectedDetails {
  const context = session?.bookingContext ?? {};

  // Once a booking has completed, its date, time and reason describe a finished
  // transaction — carrying them forward would make the next request ("actually,
  // can I come Saturday instead?") look like a repeat of the one just made.
  // Identity details stay, because they are still the same patient.
  const finished = context.stage === 'completed';

  // Start empty and fill from the transcript first, newest message first. The
  // persisted context is applied afterwards, as a *fallback* only.
  //
  // The order matters. Seeding from the context first would let a stale value
  // win over a newer correction: a patient who says "tomorrow", is told the
  // clinic is closed, and then says "Monday" would keep the Sunday date the
  // context recorded, and every later step would reason about the wrong day.
  const collected: CollectedDetails = {
    date: null,
    time: null,
    timePreference: null,
    patientName: null,
    patientEmail: null,
    patientPhone: null,
    reason: null,
    appointmentId: context.appointmentId ?? null,
    stage: null,
  };

  const allUserMessages = messages.filter((message) => message.role === 'user');

  // After a completed booking, only the newest turn is scanned. Replaying the
  // whole transcript would resurrect the time and reason of the booking that
  // just finished and apply them to the new request.
  const userMessages = finished ? allUserMessages.slice(-1) : allUserMessages;

  const assistantTexts = messages
    .filter((message) => message.role === 'assistant')
    .map((message) => message.content.toLowerCase());

  // A booking is under way if the assistant has already asked a booking
  // question, even when the latest user turn is just "Monday".
  if (
    assistantTexts.some(
      (content) =>
        content.includes('which day') ||
        content.includes("what's the reason") ||
        content.includes('tap a time') ||
        content.includes('to confirm the booking'),
    )
  ) {
    collected.stage = 'booking';
  }

  for (let index = userMessages.length - 1; index >= 0; index -= 1) {
    const raw = userMessages[index]!.content;
    const lower = raw.toLowerCase();

    if (!collected.patientEmail) {
      const email = raw.match(/[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+/)?.[0];
      if (email) collected.patientEmail = email.toLowerCase();
    }

    if (!collected.patientPhone) {
      // Requires a leading + or at least 10 digits, so a time ("2:30") or a
      // date ("17") can never be mistaken for a phone number.
      const phone = raw.match(/\+?\d[\d\s()\-]{8,}\d/)?.[0];
      if (phone && phone.replace(/\D/g, '').length >= 10) collected.patientPhone = phone.trim();
    }

    if (!collected.time) {
      const time = extractTime(lower);
      if (time) collected.time = time;
    }

    if (!collected.timePreference) {
      if (lower.includes('morning')) collected.timePreference = 'morning';
      else if (lower.includes('afternoon') || lower.includes('evening')) collected.timePreference = 'afternoon';
    }

    if (!collected.date) {
      const date = extractDate(lower);
      if (date) collected.date = date;
    }

    if (!collected.patientName) {
      const name = extractName(raw);
      if (name) collected.patientName = name;
    }

    if (!collected.reason) {
      const reason = extractReason(lower);
      if (reason) collected.reason = reason;
    }
  }

  // Fallback: anything the transcript did not supply comes from the persisted
  // context, which survives reloads and reaches further back than the replayed
  // window. Details belonging to a finished booking are not carried forward.
  collected.patientName ??= context.patientName ?? null;
  collected.patientEmail ??= context.patientEmail ?? null;
  collected.patientPhone ??= context.patientPhone ?? null;

  if (!finished) {
    collected.date ??= context.date ?? null;
    collected.time ??= context.time ?? null;
    collected.timePreference ??= context.timePreference ?? null;
    collected.reason ??= context.reason ?? null;
  }

  return collected;
}

const REASON_KEYWORDS: Array<[RegExp, string]> = [
  [/\b(check[- ]?up|checkup|examination|exam)\b/, 'Check-up'],
  [/\b(clean(ing)?|scal(e|ing)|polish|hygien)\b/, 'Professional cleaning'],
  [/\b(whiten|bleach)\b/, 'Teeth whitening'],
  [/\b(filling|cavity|cavities|decay)\b/, 'Filling'],
  [/\b(root canal|endodont)\b/, 'Root canal treatment'],
  [/\b(crown|bridge)\b/, 'Crown or bridge'],
  [/\b(implant)\b/, 'Dental implant consultation'],
  [/\b(brace|aligner|invisalign|straighten)\b/, 'Orthodontic consultation'],
  [/\b(toothache|tooth ache|pain|hurt|sore|ache|emergency|broken|chipped|swollen|swelling)\b/, 'Dental pain / emergency'],
  [/\b(wisdom tooth|wisdom teeth|extraction|remove)\b/, 'Extraction consultation'],
  [/\b(child|kid|son|daughter)\b/, "Children's dentistry"],
  [/\b(consultation|advice|second opinion)\b/, 'Consultation'],
];

function extractReason(lower: string): string | null {
  for (const [pattern, label] of REASON_KEYWORDS) {
    if (pattern.test(lower)) return label;
  }
  return null;
}

const MONTHS: Record<string, number> = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4,
  may: 5, june: 6, jun: 6, july: 7, jul: 7, august: 8, aug: 8,
  september: 9, sep: 9, sept: 9, october: 10, oct: 10, november: 11, nov: 11,
  december: 12, dec: 12,
};

function extractDate(lower: string): string | null {
  const iso = lower.match(/\b(\d{4}-\d{2}-\d{2})\b/)?.[1];
  if (iso) return resolveDatePhrase(iso);

  if (/\bday after tomorrow\b/.test(lower)) return resolveDatePhrase('day after tomorrow');
  if (/\btomorrow\b/.test(lower)) return resolveDatePhrase('tomorrow');
  if (/\btoday\b/.test(lower)) return resolveDatePhrase('today');

  // "17 August" / "August 17th"
  const dayMonth = lower.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([a-z]+)\b/);
  const monthDay = lower.match(/\b([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?\b/);
  for (const [dayPart, monthPart] of [
    [dayMonth?.[1], dayMonth?.[2]],
    [monthDay?.[2], monthDay?.[1]],
  ] as Array<[string | undefined, string | undefined]>) {
    const month = monthPart ? MONTHS[monthPart] : undefined;
    if (month && dayPart) {
      const day = Number(dayPart);
      if (day >= 1 && day <= 31) {
        const today = resolveDatePhrase('today')!;
        const year = Number(today.slice(0, 4));
        const candidate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        // A date already past this year means they mean next year.
        return candidate >= today ? candidate : `${year + 1}-${candidate.slice(5)}`;
      }
    }
  }

  const weekday = lower.match(
    /\b(?:this\s+|next\s+|on\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|tues|wed|thu|thurs|fri|sat|sun)\b/,
  );
  if (weekday?.[1]) {
    const prefix = /\bnext\b/.test(lower) ? 'next ' : '';
    return resolveDatePhrase(`${prefix}${weekday[1]}`);
  }

  return null;
}

function extractTime(lower: string): string | null {
  // "2:30 pm", "2 pm", "14:30" — the meridiem or colon is required so a bare
  // number in "book 2 people" cannot become a time.
  const match = lower.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)\b/) ?? lower.match(/\b(\d{1,2}):(\d{2})\b/);
  if (!match) return null;

  const raw = match[3]
    ? `${match[1]}:${match[2] ?? '00'} ${match[3].replace(/\./g, '')}`
    : `${match[1]}:${match[2]}`;
  return parseTimePhrase(raw);
}

const NON_NAME_WORDS = new Set([
  'yes', 'no', 'ok', 'okay', 'sure', 'thanks', 'thank', 'please', 'hi', 'hello',
  'book', 'appointment', 'morning', 'afternoon', 'monday', 'tuesday', 'wednesday',
  'thursday', 'friday', 'saturday', 'sunday', 'today', 'tomorrow', 'check', 'cleaning',
]);

function extractName(raw: string): string | null {
  const explicit = raw.match(/\b(?:my name is|i am|i'm|this is|name:)\s+([A-Za-z][A-Za-z'\-]+(?:\s+[A-Za-z][A-Za-z'\-]+){0,3})/i)?.[1];
  if (explicit) return titleCase(explicit.trim());

  // "Jane Doe, jane@example.com, +1 415 555 0123" — the field before the email.
  if (raw.includes('@')) {
    const candidate = raw.split(/[,\n]/)[0]?.trim();
    if (candidate && isNameLike(candidate)) return titleCase(candidate);
  }

  // A bare message that is only a name, e.g. answering "what is your name?".
  const trimmed = raw.trim().replace(/[.!]$/, '');
  if (isNameLike(trimmed) && trimmed.split(/\s+/).length >= 2) return titleCase(trimmed);

  return null;
}

function isNameLike(value: string): boolean {
  const words = value.trim().split(/\s+/);
  if (words.length < 2 || words.length > 4) return false;
  return words.every(
    (word) => /^[A-Za-z][A-Za-z'\-]{1,}$/.test(word) && !NON_NAME_WORDS.has(word.toLowerCase()),
  );
}

function titleCase(value: string): string {
  return value
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

// ---------------------------------------------------------------------------
//  Small helpers
// ---------------------------------------------------------------------------

const GREETING =
  'Hello! 👋 Welcome to Bright Smile Dental Studio. I can help you book an appointment, check available times, or answer questions about our clinic and services.\n\nHow can I help you today?';

function isGreeting(lower: string): boolean {
  return /^(hi|hey|hello|good (morning|afternoon|evening)|yo|hiya|howdy)\b[\s!.,]*$/.test(lower);
}

/**
 * Distinguishes "cancel my appointment" (an action) from "what is the
 * cancellation policy" (a question). The action needs an object; a bare
 * "cancel" on its own also counts.
 */
function isCancelRequest(lower: string): boolean {
  if (/^cancel( it| that| please)?[\s!.?]*$/.test(lower)) return true;
  return /\bcancel(?:ling)?\b/.test(lower) && /\b(my|this|that|the)\s+(appointment|booking|visit|slot)\b/.test(lower);
}

/** Same distinction for rescheduling. */
function isRescheduleRequest(lower: string): boolean {
  if (/^(reschedule|move it)[\s!.?]*$/.test(lower)) return true;
  return (
    /\b(reschedule|rearrange|move|change)\b/.test(lower) &&
    /\b(my|this|that|the)\s+(appointment|booking|visit|slot|time)\b/.test(lower)
  );
}

/**
 * Does this message actually carry information the booking flow is waiting on?
 *
 * Used to decide whether an in-progress booking should absorb the message.
 * Without it, any message at all is treated as a booking answer once the flow
 * has started, and an off-topic question gets the previous booking step
 * repeated back at it.
 */
function advancesBooking(raw: string, lower: string): boolean {
  if (/^(yes|yeah|yep|sure|ok|okay|please|go ahead|that works|sounds good)\b/.test(lower)) return true;
  if (extractDate(lower) !== null) return true;
  if (extractTime(lower) !== null) return true;
  if (/\b(morning|afternoon|evening)\b/.test(lower)) return true;
  if (extractReason(lower) !== null) return true;
  if (/[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+/.test(raw)) return true;
  if (/\+?\d[\d\s()\-]{8,}\d/.test(raw)) return true;
  if (extractName(raw) !== null) return true;
  return false;
}

function matches(haystack: string, needles: string[]): boolean {
  return needles.some((needle) => haystack.includes(needle));
}

function lastUserMessage(messages: LlmMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]!.role === 'user') return messages[index]!.content;
  }
  return null;
}

function text(content: string): LlmResponse {
  return { content, toolCalls: [] };
}

function toolCall(name: string, args: Record<string, unknown>): LlmResponse {
  const call: LlmToolCall = { id: randomUUID(), name, arguments: JSON.stringify(args) };
  return { content: '', toolCalls: [call] };
}

function safeParse(content: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(content);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function joinWithAnd(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}
