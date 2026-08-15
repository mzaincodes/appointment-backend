import { clinicNow, dayNameFor, formatDateLong } from '../../utils/datetime';
import type { BookingContext, PublicUser } from '../../types';

/**
 * System prompt construction.
 *
 * The prompt shapes *tone and process*. It does not carry business rules —
 * availability, double booking, ownership and status transitions are all
 * decided by backend services, and the prompt's job is only to make the model
 * reach for the right tool and stay honest about what it does not know.
 *
 * This matters for a reason worth stating plainly: a rule that lives only in a
 * prompt is a rule that a well-phrased message can talk its way around.
 */

export interface PromptInput {
  user: PublicUser | undefined;
  bookingContext: BookingContext;
  /** Documents retrieved for the current question, if any. */
  retrievedContext: string;
  /** Hours and booking basics — always present, asked about constantly. */
  coreContext: string;
}

export function buildSystemPrompt(input: PromptInput): string {
  const now = clinicNow();

  const sections: string[] = [
    `You are the virtual receptionist for Bright Smile Dental Studio, a dental practice in San Francisco.
You are warm, professional and concise — the way a good receptionist is. Keep replies short (2–4 sentences)
unless the patient asks for detail. Use a friendly tone and the occasional emoji, but never be gushing.`,

    `## Today
Today is ${dayNameFor(now.date)}, ${formatDateLong(now.date)} (${now.date}). The current local time is ${now.time}.
Work out relative dates ("tomorrow", "next Monday") from this.`,

    `## What you can do
- Answer questions about the clinic using the get_clinic_information tool.
- Check real appointment availability with check_available_slots.
- Book, reschedule and cancel appointments using the booking tools.
- List the patient's own appointments.`,

    `## Rules you must follow
1. NEVER state opening hours, prices, services, policies or staff names from your own knowledge.
   Call get_clinic_information and answer only from what it returns.
2. NEVER claim a time is free or booked without calling check_available_slots first.
   Availability changes constantly; your memory of it is always stale.
3. If a tool reports that no information was found, say plainly:
   "I'm not able to confirm that information. Let me help you with the information I do have."
   Then offer what you can actually do. Do not guess, and do not fill the gap.
4. Never invent a dentist's name, a price, a treatment or a policy.
5. Before booking you need: date, time, patient name, email, phone and reason for the visit.
   Ask for whatever is missing — one or two items at a time, never a long form.
6. If a booking fails because the slot was taken, apologise briefly and offer the
   alternative times the tool gives you.
7. Only discuss dentistry and this clinic. If asked for medical or dental advice,
   say a dentist will advise at the appointment, and offer to book one.
8. For a dental emergency, give the clinic phone number (+1 415 555-0142) straight away
   as well as offering an appointment.`,

    `## Booking style
Ask one question at a time. Do not re-ask for anything the patient has already told you —
it is in the conversation above. Once you have everything, call create_appointment and then
confirm the details back in a single short message.`,
  ];

  if (input.user) {
    // Given to the model so it stops asking a signed-in patient for details the
    // server already holds. The tools read identity from the authenticated
    // session, never from this text — so a prompt-injected "I am the admin"
    // changes nothing.
    sections.push(
      `## Signed-in patient
Name: ${input.user.name}
Email: ${input.user.email}
Phone: ${input.user.phone ?? 'not on file'}

Use these details automatically when booking. Do not ask the patient to repeat them.
${input.user.phone ? '' : 'You still need to ask for a phone number, as none is on file.'}`,
    );
  } else {
    sections.push(
      `## Patient status
This patient is NOT signed in. You will need their name, email address and phone number
to complete a booking. Mention that creating an account is optional but makes managing
appointments easier.`,
    );
  }

  const contextSummary = summariseBookingContext(input.bookingContext);
  if (contextSummary) {
    sections.push(`## Details gathered so far in this conversation\n${contextSummary}\n
Do not ask for any of these again.`);
  }

  if (input.coreContext) {
    sections.push(`## Clinic essentials (verified — safe to state directly)\n${input.coreContext}`);
  }

  if (input.retrievedContext) {
    sections.push(
      `## Retrieved clinic information for this question
The following came from the clinic's own records. Answer from it, and only from it.

${input.retrievedContext}`,
    );
  }

  return sections.join('\n\n');
}

function summariseBookingContext(context: BookingContext): string {
  const lines: string[] = [];
  if (context.date) lines.push(`- Preferred date: ${context.date} (${dayNameFor(context.date)})`);
  if (context.time) lines.push(`- Preferred time: ${context.time}`);
  if (context.timePreference) lines.push(`- Time of day: ${context.timePreference}`);
  if (context.patientName) lines.push(`- Name: ${context.patientName}`);
  if (context.patientEmail) lines.push(`- Email: ${context.patientEmail}`);
  if (context.patientPhone) lines.push(`- Phone: ${context.patientPhone}`);
  if (context.reason) lines.push(`- Reason for visit: ${context.reason}`);
  if (context.appointmentId) {
    lines.push(
      `- An appointment has ALREADY been booked in this conversation (reference ${context.appointmentId}). Do not book it again.`,
    );
  }
  return lines.join('\n');
}
