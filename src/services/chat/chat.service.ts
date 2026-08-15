import { chatRepository } from '../../repositories/chat.repository';
import { aiService } from '../ai/ai.service';
import { NotFoundError, ForbiddenError } from '../../utils/errors';
import { logger } from '../../utils/logger';
import type { ChatMessage, ChatSession, MessagePayload, PublicUser } from '../../types';

/**
 * Chat orchestration.
 *
 * Sits between the transport (Socket.IO or REST) and the AI service, and owns
 * everything about a conversation *except* how a reply is produced:
 * session lifecycle, ownership, persistence and telemetry.
 *
 * Keeping this transport-agnostic is what lets the websocket and the HTTP
 * fallback share one implementation — the socket gateway is a thin adapter over
 * these methods.
 */

export interface SendMessageResult {
  userMessage: ChatMessage;
  assistantMessage: ChatMessage;
}

export const chatService = {
  /**
   * Finds or creates the session for this connection.
   *
   * An anonymous visitor who later signs in keeps their conversation: the
   * session is adopted rather than replaced.
   */
  async resolveSession(sessionId: string | undefined, user: PublicUser | undefined): Promise<ChatSession> {
    if (sessionId) {
      const existing = await chatRepository.findSessionById(sessionId);
      if (existing) {
        const belongsToSomeoneElse =
          existing.userId !== null && (!user || existing.userId !== user.id);

        // A conversation owned by another account is never handed over. This is
        // not an error the visitor can act on, though — a stale id in their
        // browser is not their fault — so fall through to their own session
        // rather than failing the chat outright.
        if (!belongsToSomeoneElse) {
          // A guest who chats and then signs in keeps the conversation.
          if (!existing.userId && user) {
            await chatRepository.attachUser(existing.id, user.id);
            return { ...existing, userId: user.id };
          }
          return existing;
        }
      }
    }

    // No usable id. A signed-in patient resumes their most recent conversation,
    // so the assistant still has the context of what they asked last time —
    // including from another device, since the transcript lives in PostgreSQL
    // rather than in the browser.
    if (user) {
      const [mostRecent] = await chatRepository.listSessionsForUser(user.id, 1);
      if (mostRecent) return mostRecent;
    }

    return chatRepository.createSession(user?.id ?? null);
  },

  async getSession(sessionId: string, user: PublicUser | undefined): Promise<ChatSession> {
    const session = await chatRepository.findSessionById(sessionId);
    if (!session) throw new NotFoundError('That conversation could not be found.');
    if (session.userId && session.userId !== user?.id && user?.role !== 'ADMIN') {
      throw new ForbiddenError('That conversation belongs to another account.');
    }
    return session;
  },

  async getMessages(sessionId: string, user: PublicUser | undefined): Promise<ChatMessage[]> {
    await this.getSession(sessionId, user);
    return chatRepository.getMessages(sessionId);
  },

  async listSessions(user: PublicUser): Promise<ChatSession[]> {
    return chatRepository.listSessionsForUser(user.id);
  },

  /**
   * Handles one turn: persist the patient's message, generate a reply, persist
   * it, and record telemetry.
   *
   * The patient's message is stored *before* the model runs, so a provider
   * failure cannot lose what they said.
   */
  async sendMessage(input: {
    sessionId: string;
    content: string;
    user: PublicUser | undefined;
  }): Promise<SendMessageResult> {
    const session = await this.getSession(input.sessionId, input.user);

    const userMessage = await chatRepository.addMessage({
      sessionId: session.id,
      role: 'user',
      content: input.content,
    });

    // The first thing a patient says makes a good conversation title.
    if (!session.title) {
      await chatRepository.setTitle(session.id, input.content.slice(0, 80));
    }

    const history = await chatRepository.getMessages(session.id);

    const reply = await aiService.generateReply({
      message: input.content,
      // Exclude the message just stored — it is passed separately as the
      // current turn, and sending it twice makes the model see a repeat.
      history: history.filter((message) => message.id !== userMessage.id),
      user: input.user,
      sessionId: session.id,
      bookingContext: session.bookingContext,
    });

    const assistantMessage = await chatRepository.addMessage({
      sessionId: session.id,
      role: 'assistant',
      content: reply.content,
      payload: reply.payload,
    });

    // Booking details discovered this turn are merged into the session so the
    // next turn does not re-ask for them.
    await chatRepository.mergeBookingContext(session.id, reply.contextUpdates);
    await chatRepository.touchSession(session.id);

    // Telemetry must never break a conversation that otherwise succeeded.
    try {
      await chatRepository.logInteraction({
        sessionId: session.id,
        userId: input.user?.id ?? null,
        userMessage: input.content,
        aiResponse: reply.content,
        provider: reply.telemetry.provider,
        model: reply.telemetry.model,
        intent: inferIntent(reply.telemetry.toolsUsed),
        toolsUsed: reply.telemetry.toolsUsed,
        retrievedDocs: reply.telemetry.retrievedDocs,
        latencyMs: reply.telemetry.latencyMs,
        promptTokens: reply.telemetry.promptTokens,
        outputTokens: reply.telemetry.outputTokens,
        wasFallback: reply.telemetry.wasFallback,
        error: reply.telemetry.error ?? null,
      });
    } catch (error) {
      logger.error('Failed to record AI interaction', {
        sessionId: session.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return { userMessage, assistantMessage };
  },

  /** The opening message, shown when a conversation is first opened. */
  getWelcomeMessage(user: PublicUser | undefined): { content: string; payload: MessagePayload } {
    const greeting = user ? `Hello ${user.name.split(' ')[0]}! 👋` : 'Hello! 👋';
    return {
      content: `${greeting} Welcome to Bright Smile Dental Studio. I can help you book an appointment, check available times, or answer questions about our clinic and services.\n\nHow can I help you today?`,
      payload: {
        type: 'quick_replies',
        options: ['📅 Book an appointment', '🕐 Clinic hours', '🦷 Our services', '📍 Clinic information'],
      },
    };
  },
};

/** Coarse intent label for analytics, derived from which tools ran. */
function inferIntent(toolsUsed: string[]): string {
  if (toolsUsed.includes('create_appointment')) return 'appointment_booking';
  if (toolsUsed.includes('cancel_appointment')) return 'appointment_cancellation';
  if (toolsUsed.includes('reschedule_appointment')) return 'appointment_reschedule';
  if (toolsUsed.includes('check_available_slots') || toolsUsed.includes('find_next_available')) {
    return 'availability_check';
  }
  if (toolsUsed.includes('get_my_appointments')) return 'appointment_lookup';
  if (toolsUsed.includes('get_services')) return 'services_enquiry';
  if (toolsUsed.includes('get_clinic_information')) return 'clinic_information';
  return 'general_conversation';
}
