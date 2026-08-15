import { query, queryOne } from '../db/pool';
import type { BookingContext, ChatMessage, ChatRole, ChatSession, MessagePayload } from '../types';

/** Chat session and transcript persistence. */

interface ChatSessionRow {
  id: string;
  user_id: string | null;
  title: string | null;
  booking_context: BookingContext;
  created_at: Date;
  last_message_at: Date;
}

interface ChatMessageRow {
  id: string;
  session_id: string;
  role: ChatRole;
  content: string;
  payload: MessagePayload | null;
  created_at: Date;
}

function toSession(row: ChatSessionRow): ChatSession {
  return {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    bookingContext: row.booking_context ?? {},
    createdAt: row.created_at.toISOString(),
    lastMessageAt: row.last_message_at.toISOString(),
  };
}

function toMessage(row: ChatMessageRow): ChatMessage {
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role,
    content: row.content,
    payload: row.payload,
    createdAt: row.created_at.toISOString(),
  };
}

const SESSION_COLUMNS = 'id, user_id, title, booking_context, created_at, last_message_at';

export const chatRepository = {
  async createSession(userId: string | null, title?: string): Promise<ChatSession> {
    const { rows } = await query<ChatSessionRow>(
      `INSERT INTO chat_sessions (user_id, title) VALUES ($1, $2) RETURNING ${SESSION_COLUMNS}`,
      [userId, title ?? null],
    );
    return toSession(rows[0]!);
  },

  async findSessionById(id: string): Promise<ChatSession | null> {
    const row = await queryOne<ChatSessionRow>(
      `SELECT ${SESSION_COLUMNS} FROM chat_sessions WHERE id = $1`,
      [id],
    );
    return row ? toSession(row) : null;
  },

  /**
   * Attaches an anonymous session to a user.
   *
   * Someone who chats first and signs in afterwards keeps their conversation.
   * Guarded with `user_id IS NULL` so a session can never be reassigned from
   * one user to another.
   */
  async attachUser(sessionId: string, userId: string): Promise<void> {
    await query('UPDATE chat_sessions SET user_id = $1 WHERE id = $2 AND user_id IS NULL', [
      userId,
      sessionId,
    ]);
  },

  /**
   * Merges new booking details into the session's scratchpad.
   *
   * `||` on JSONB is a shallow merge, so a partial update leaves untouched keys
   * intact. Doing it in SQL keeps the operation atomic — two messages arriving
   * close together cannot clobber each other's contributions.
   */
  async mergeBookingContext(sessionId: string, updates: Partial<BookingContext>): Promise<void> {
    if (Object.keys(updates).length === 0) return;
    await query(
      `UPDATE chat_sessions
       SET booking_context = booking_context || $2::jsonb,
           last_message_at = now()
       WHERE id = $1`,
      [sessionId, JSON.stringify(updates)],
    );
  },

  async setTitle(sessionId: string, title: string): Promise<void> {
    await query('UPDATE chat_sessions SET title = $2 WHERE id = $1 AND title IS NULL', [
      sessionId,
      title.slice(0, 120),
    ]);
  },

  async touchSession(sessionId: string): Promise<void> {
    await query('UPDATE chat_sessions SET last_message_at = now() WHERE id = $1', [sessionId]);
  },

  async addMessage(input: {
    sessionId: string;
    role: ChatRole;
    content: string;
    payload?: MessagePayload | null;
  }): Promise<ChatMessage> {
    const { rows } = await query<ChatMessageRow>(
      `INSERT INTO chat_messages (session_id, role, content, payload)
       VALUES ($1, $2, $3, $4)
       RETURNING id, session_id, role, content, payload, created_at`,
      [input.sessionId, input.role, input.content, input.payload ? JSON.stringify(input.payload) : null],
    );
    return toMessage(rows[0]!);
  },

  /** Transcript, oldest first. Served by `chat_messages_session_created_idx`. */
  async getMessages(sessionId: string, limit = 100): Promise<ChatMessage[]> {
    const { rows } = await query<ChatMessageRow>(
      `SELECT id, session_id, role, content, payload, created_at
       FROM chat_messages
       WHERE session_id = $1
       ORDER BY created_at ASC
       LIMIT $2`,
      [sessionId, limit],
    );
    return rows.map(toMessage);
  },

  async listSessionsForUser(userId: string, limit = 20): Promise<ChatSession[]> {
    const { rows } = await query<ChatSessionRow>(
      `SELECT ${SESSION_COLUMNS} FROM chat_sessions
       WHERE user_id = $1
       ORDER BY last_message_at DESC
       LIMIT $2`,
      [userId, limit],
    );
    return rows.map(toSession);
  },

  /**
   * AI observability.
   *
   * Prompts and replies are recorded; credentials never are. The AI service
   * passes only the fields below, so an API key has no path into this table.
   */
  async logInteraction(input: {
    sessionId: string;
    userId: string | null;
    userMessage: string;
    aiResponse: string;
    provider: string;
    model: string;
    intent?: string | null;
    toolsUsed: string[];
    retrievedDocs: string[];
    latencyMs: number;
    promptTokens?: number | undefined;
    outputTokens?: number | undefined;
    wasFallback: boolean;
    error?: string | null;
  }): Promise<void> {
    await query(
      `INSERT INTO ai_interactions (
         session_id, user_id, user_message, ai_response, provider, model,
         intent, tools_used, retrieved_docs, latency_ms,
         prompt_tokens, output_tokens, was_fallback, error
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        input.sessionId,
        input.userId,
        input.userMessage,
        input.aiResponse,
        input.provider,
        input.model,
        input.intent ?? null,
        input.toolsUsed,
        input.retrievedDocs,
        input.latencyMs,
        input.promptTokens ?? null,
        input.outputTokens ?? null,
        input.wasFallback,
        input.error ?? null,
      ],
    );
  },
};
