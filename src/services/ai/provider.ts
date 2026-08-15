import { env } from '../../config/env';
import { logger } from '../../utils/logger';
import { AiUnavailableError } from '../../utils/errors';
import type { ToolDefinition } from './tools';
import type { BookingContext } from '../../types';

/**
 * LLM provider abstraction.
 *
 * The agent loop talks to this interface and never to a vendor SDK, so
 * switching model providers is a config change plus one small class. Mistral
 * and OpenAI both expose an OpenAI-compatible chat-completions API, so a single
 * implementation covers them; only the base URL and model name differ.
 */

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: LlmToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface LlmToolCall {
  id: string;
  name: string;
  /** Raw JSON string from the model; parsed and validated by the tool layer. */
  arguments: string;
}

export interface LlmResponse {
  content: string;
  toolCalls: LlmToolCall[];
  usage?: { promptTokens?: number; completionTokens?: number };
}

/**
 * Session facts passed alongside the conversation.
 *
 * A hosted model reads these from the system prompt and ignores the parameter.
 * The offline provider uses it directly — it has no language model to infer
 * "the patient is already signed in, so do not ask for their email" from prose.
 */
export interface ProviderSession {
  signedIn: boolean;
  name?: string | undefined;
  email?: string | undefined;
  phone?: string | undefined;
  bookingContext: BookingContext;
}

export interface AiProvider {
  readonly name: string;
  readonly model: string;
  /** True when this provider calls a real model over the network. */
  readonly isLive: boolean;
  chat(
    messages: LlmMessage[],
    tools: ToolDefinition[],
    session?: ProviderSession,
  ): Promise<LlmResponse>;
}

/**
 * Chat completions over any OpenAI-compatible endpoint (Mistral, OpenAI).
 *
 * Implemented with `fetch` rather than a vendor SDK: the surface used here is
 * one POST, and avoiding the dependency keeps the provider swap genuinely cheap.
 */
export class OpenAiCompatibleProvider implements AiProvider {
  readonly isLive = true;

  constructor(
    readonly name: string,
    readonly model: string,
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  async chat(messages: LlmMessage[], tools: ToolDefinition[]): Promise<LlmResponse> {
    // An unbounded request would hold a socket open and leave the patient
    // watching a typing indicator forever.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), env.AI_TIMEOUT_MS);

    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.model,
          messages: messages.map(serialiseMessage),
          tools: tools.map((tool) => ({
            type: 'function',
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
            },
          })),
          tool_choice: 'auto',
          // Low but not zero: the assistant should sound natural while staying
          // firmly anchored to retrieved facts and tool results.
          temperature: 0.3,
          max_tokens: 800,
        }),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        // Log the status and a short body excerpt; never the Authorization header.
        logger.error('AI provider returned an error', {
          provider: this.name,
          status: response.status,
          body: body.slice(0, 300),
        });
        throw new AiUnavailableError(
          response.status === 429
            ? 'The assistant is busy right now. Please try again in a moment.'
            : 'The assistant is temporarily unavailable.',
        );
      }

      const data = (await response.json()) as ChatCompletionResponse;
      const message = data.choices?.[0]?.message;

      return {
        content: message?.content ?? '',
        toolCalls: (message?.tool_calls ?? []).map((call) => ({
          id: call.id,
          name: call.function.name,
          arguments: call.function.arguments,
        })),
        usage: {
          promptTokens: data.usage?.prompt_tokens,
          completionTokens: data.usage?.completion_tokens,
        },
      };
    } catch (error) {
      if (error instanceof AiUnavailableError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        logger.error('AI provider timed out', { provider: this.name, timeoutMs: env.AI_TIMEOUT_MS });
        throw new AiUnavailableError('The assistant took too long to respond. Please try again.');
      }
      logger.error('AI provider request failed', {
        provider: this.name,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new AiUnavailableError();
    } finally {
      clearTimeout(timeout);
    }
  }
}

/** Maps our message shape onto the wire format. */
function serialiseMessage(message: LlmMessage): Record<string, unknown> {
  if (message.role === 'tool') {
    return {
      role: 'tool',
      content: message.content,
      tool_call_id: message.tool_call_id,
      name: message.name,
    };
  }
  if (message.role === 'assistant' && message.tool_calls?.length) {
    return {
      role: 'assistant',
      content: message.content || '',
      tool_calls: message.tool_calls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: call.arguments },
      })),
    };
  }
  return { role: message.role, content: message.content };
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
    };
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/**
 * Builds the provider from configuration.
 *
 * When no API key is configured this returns the offline provider, so the
 * application remains fully usable — including real, database-backed booking —
 * without credentials. See `local-provider.ts` for exactly what that does and
 * does not do.
 */
export function createProvider(): AiProvider {
  if (!env.hasAiCredentials) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires -- required
    // lazily to avoid a cycle: the local provider imports the tool definitions,
    // which import the services, which import config.
    const { LocalRuleBasedProvider } = require('./local-provider') as typeof import('./local-provider');
    logger.warn(
      'No AI_API_KEY configured — the assistant is running on the offline rule-based provider. ' +
        'Booking, availability and knowledge retrieval all still work against the real database.',
    );
    return new LocalRuleBasedProvider();
  }

  logger.info('AI provider configured', { provider: env.AI_PROVIDER, model: env.AI_MODEL });
  return new OpenAiCompatibleProvider(env.AI_PROVIDER, env.AI_MODEL, env.AI_BASE_URL, env.AI_API_KEY);
}
