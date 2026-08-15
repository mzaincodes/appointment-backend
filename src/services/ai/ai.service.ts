import { env } from '../../config/env';
import { logger } from '../../utils/logger';
import { AiUnavailableError } from '../../utils/errors';
import { knowledgeService } from './knowledge.service';
import { buildSystemPrompt } from './prompt';
import { createProvider, type AiProvider, type LlmMessage } from './provider';
import { TOOL_DEFINITIONS, executeTool, type ToolContext } from './tools';
import type { BookingContext, ChatMessage, MessagePayload, PublicUser } from '../../types';

/**
 * The AI service — the agent loop.
 *
 * Responsibilities, in order:
 *   1. Retrieve relevant clinic documents for the incoming message (RAG).
 *   2. Build the system prompt from those documents plus session state.
 *   3. Ask the provider for a response.
 *   4. Execute any tools it requests, feed the results back, and repeat.
 *   5. Return the final text, any UI payload, and telemetry for logging.
 *
 * The loop is bounded by `AI_MAX_TOOL_ROUNDS`. That cap is the entire "agent
 * framework" — deliberately, because the alternative is an orchestration layer
 * that is far harder to reason about than the four tool calls this application
 * ever actually needs.
 *
 * Nothing here decides business questions. Tools call services; services own
 * the rules.
 */

export interface AiReply {
  content: string;
  /** Structured attachment for the chat UI (slot chips, confirmation card). */
  payload: MessagePayload | null;
  /** Booking details discovered this turn, merged into the session. */
  contextUpdates: Partial<BookingContext>;
  telemetry: {
    provider: string;
    model: string;
    toolsUsed: string[];
    retrievedDocs: string[];
    latencyMs: number;
    promptTokens?: number;
    outputTokens?: number;
    wasFallback: boolean;
    error?: string;
  };
}

export interface GenerateInput {
  message: string;
  history: ChatMessage[];
  user: PublicUser | undefined;
  sessionId: string;
  bookingContext: BookingContext;
}

/**
 * How many prior turns to send.
 *
 * Enough for a booking conversation to stay coherent, small enough to keep the
 * prompt cheap. The persisted `bookingContext` carries the facts that matter
 * beyond this window, so trimming loses phrasing rather than information.
 */
const HISTORY_TURNS = 12;

let provider: AiProvider | null = null;

function getProvider(): AiProvider {
  provider ??= createProvider();
  return provider;
}

export const aiService = {
  /** Exposed so the chat UI can label which mode is running. */
  getProviderInfo(): { name: string; model: string; isLive: boolean } {
    const active = getProvider();
    return { name: active.name, model: active.model, isLive: active.isLive };
  },

  async generateReply(input: GenerateInput): Promise<AiReply> {
    const startedAt = Date.now();
    const active = getProvider();

    const toolsUsed: string[] = [];
    const contextUpdates: Partial<BookingContext> = {};
    let payload: MessagePayload | null = null;

    // ---- 1. Retrieval ----------------------------------------------------
    const [retrieved, coreContext] = await Promise.all([
      knowledgeService.retrieve(input.message),
      knowledgeService.getCoreContext(),
    ]);

    // ---- 2. Prompt -------------------------------------------------------
    const systemPrompt = buildSystemPrompt({
      user: input.user,
      bookingContext: input.bookingContext,
      retrievedContext: retrieved.contextText,
      coreContext,
    });

    const messages: LlmMessage[] = [
      { role: 'system', content: systemPrompt },
      ...toLlmHistory(input.history),
      { role: 'user', content: input.message },
    ];

    const toolContext: ToolContext = {
      user: input.user,
      sessionId: input.sessionId,
      bookingContext: input.bookingContext,
      contextUpdates,
    };

    const session = {
      signedIn: Boolean(input.user),
      name: input.user?.name,
      email: input.user?.email,
      phone: input.user?.phone ?? undefined,
      bookingContext: input.bookingContext,
    };

    try {
      // ---- 3-4. Provider + tool loop ------------------------------------
      for (let round = 0; round < env.AI_MAX_TOOL_ROUNDS; round += 1) {
        const response = await active.chat(messages, TOOL_DEFINITIONS, session);

        if (response.toolCalls.length === 0) {
          return {
            content: response.content.trim() || FALLBACK_REPLY,
            payload,
            contextUpdates,
            telemetry: {
              provider: active.name,
              model: active.model,
              toolsUsed,
              retrievedDocs: retrieved.sources,
              latencyMs: Date.now() - startedAt,
              promptTokens: response.usage?.promptTokens,
              outputTokens: response.usage?.completionTokens,
              wasFallback: !active.isLive,
            },
          };
        }

        // Record the assistant's tool-call turn before appending results, so
        // the provider sees a well-formed exchange on the next round.
        messages.push({
          role: 'assistant',
          content: response.content,
          tool_calls: response.toolCalls,
        });

        for (const call of response.toolCalls) {
          toolsUsed.push(call.name);

          let args: unknown = {};
          try {
            args = call.arguments ? JSON.parse(call.arguments) : {};
          } catch {
            // Models occasionally emit malformed JSON. Hand the problem back
            // rather than failing the turn — it retries with valid arguments.
            logger.warn('Model produced unparseable tool arguments', { tool: call.name });
            messages.push({
              role: 'tool',
              tool_call_id: call.id,
              name: call.name,
              content: JSON.stringify({ error: 'Arguments were not valid JSON. Send valid JSON.' }),
            });
            continue;
          }

          const outcome = await executeTool(call.name, args, toolContext);
          // The last payload wins: a booking confirmation should replace the
          // slot list that preceded it in the same turn.
          if (outcome.payload) payload = outcome.payload;

          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            name: call.name,
            content: JSON.stringify(outcome.result),
          });
        }
      }

      // Loop exhausted — the model kept calling tools without concluding.
      logger.warn('AI tool loop hit its round limit', {
        sessionId: input.sessionId,
        toolsUsed,
      });
      return {
        content:
          "I'm having a little trouble completing that. Could you tell me the day and time you'd like, and I'll take it from there?",
        payload,
        contextUpdates,
        telemetry: {
          provider: active.name,
          model: active.model,
          toolsUsed,
          retrievedDocs: retrieved.sources,
          latencyMs: Date.now() - startedAt,
          wasFallback: !active.isLive,
          error: 'max_tool_rounds_exceeded',
        },
      };
    } catch (error) {
      // ---- 5. Provider failure ------------------------------------------
      // The patient still gets a useful reply and a route to the booking form,
      // rather than a dead chat window.
      const message = error instanceof Error ? error.message : String(error);
      logger.error('AI generation failed', { sessionId: input.sessionId, error: message });

      return {
        content:
          error instanceof AiUnavailableError
            ? "I'm having trouble reaching our assistant service right now. You can still book directly using the Book Appointment button, or call us on +1 (415) 555-0142."
            : "Sorry — something went wrong on my side. Please try again, or use the Book Appointment button to book directly.",
        payload,
        contextUpdates,
        telemetry: {
          provider: active.name,
          model: active.model,
          toolsUsed,
          retrievedDocs: retrieved.sources,
          latencyMs: Date.now() - startedAt,
          wasFallback: !active.isLive,
          error: message,
        },
      };
    }
  },
};

const FALLBACK_REPLY =
  "I'm here to help with appointments and questions about the clinic. Could you tell me a little more about what you need?";

/**
 * Converts stored transcript rows into provider messages.
 *
 * Only user and assistant turns are replayed. Tool messages from earlier turns
 * are dropped: their results are stale (availability especially), and replaying
 * them invites the model to answer from an old snapshot rather than calling the
 * tool again.
 */
function toLlmHistory(history: ChatMessage[]): LlmMessage[] {
  return history
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .slice(-HISTORY_TURNS)
    .map((message) => ({
      role: message.role as 'user' | 'assistant',
      content: message.content,
    }));
}
