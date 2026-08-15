import type { Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import { env } from '../config/env';
import { authService } from '../services/auth/auth.service';
import { chatService } from '../services/chat/chat.service';
import { aiService } from '../services/ai/ai.service';
import { toPublicUser } from '../repositories/user.repository';
import { socketChatLimiter } from '../middleware/rate-limit';
import { AppError } from '../utils/errors';
import { logger } from '../utils/logger';
import type { PublicUser } from '../types';

/**
 * Socket.IO gateway — the real-time transport for chat.
 *
 * Chat runs over websockets rather than HTTP polling because the assistant's
 * turn involves retrieval, one or more tool calls and a model round trip. Over
 * a socket the client gets a typing indicator the instant work starts and the
 * reply the instant it finishes, with no polling interval in between.
 *
 * The gateway is a thin adapter: it authenticates, validates the payload, and
 * calls `chatService`. All conversation logic lives in that service, which is
 * why the REST fallback behaves identically.
 *
 * ## Protocol
 *
 * Client → server
 *   `chat:join`     { sessionId? }            → joins or creates a session
 *   `chat:message`  { sessionId, content }    → sends a message
 *   `chat:typing`   { sessionId, isTyping }   → patient typing indicator
 *
 * Server → client
 *   `chat:joined`      { session, messages, welcome, provider }
 *   `chat:message`     { message }            → echo of the patient's message
 *   `chat:typing`      { isTyping }           → assistant is composing
 *   `chat:reply`       { message }            → the assistant's reply
 *   `chat:error`       { message, code }
 *
 * Acknowledgement callbacks are supported on every client event, so the UI can
 * show a per-message delivered/failed state rather than guessing.
 */

interface JoinPayload {
  sessionId?: string;
}
interface MessagePayload {
  sessionId?: string;
  content?: string;
}
interface TypingPayload {
  sessionId?: string;
  isTyping?: boolean;
}
type Ack = (response: { ok: boolean; error?: string; data?: unknown }) => void;

/** Sockets carry their authenticated user, resolved once at handshake. */
interface SocketData {
  user: PublicUser | undefined;
  sessionId: string | null;
}

const MAX_MESSAGE_LENGTH = 2000;

export function createSocketServer(httpServer: HttpServer): Server {
  const io = new Server(httpServer, {
    cors: {
      origin: env.allowedOrigins,
      credentials: true,
    },
    // Allow a slow first model response without the client giving up.
    pingTimeout: 60_000,
    pingInterval: 25_000,
  });

  /**
   * Handshake authentication.
   *
   * A token is optional — guests can chat and book. An *invalid* token is
   * treated as anonymous rather than rejected, so an expired session cannot
   * lock someone out of the chat widget.
   */
  io.use(async (socket, next) => {
    const token =
      (socket.handshake.auth?.token as string | undefined) ??
      (socket.handshake.headers.authorization?.startsWith('Bearer ')
        ? socket.handshake.headers.authorization.slice(7)
        : undefined);

    const data = socket.data as SocketData;
    data.user = undefined;
    data.sessionId = null;

    if (token) {
      try {
        data.user = toPublicUser(await authService.resolveUserFromToken(token));
      } catch {
        logger.debug('Socket presented an invalid token; continuing as guest', {
          socketId: socket.id,
        });
      }
    }
    next();
  });

  io.on('connection', (socket: Socket) => {
    const data = socket.data as SocketData;
    logger.info('Socket connected', {
      socketId: socket.id,
      userId: data.user?.id ?? null,
    });

    socket.on('chat:join', async (payload: JoinPayload = {}, ack?: Ack) => {
      try {
        const session = await chatService.resolveSession(payload.sessionId, data.user);
        data.sessionId = session.id;

        // Rooms are keyed by session id, so a patient with the site open in two
        // tabs sees the same conversation update in both.
        await socket.join(roomFor(session.id));

        const messages = await chatService.getMessages(session.id, data.user);
        const response = {
          session,
          messages,
          welcome: messages.length === 0 ? chatService.getWelcomeMessage(data.user) : null,
          provider: aiService.getProviderInfo(),
        };

        socket.emit('chat:joined', response);
        ack?.({ ok: true, data: response });
      } catch (error) {
        handleSocketError(socket, error, ack, 'Could not open the conversation.');
      }
    });

    socket.on('chat:message', async (payload: MessagePayload = {}, ack?: Ack) => {
      const content = payload.content?.trim();
      const sessionId = payload.sessionId ?? data.sessionId;

      try {
        if (!sessionId) throw new AppError('Join a conversation first.', 400, 'VALIDATION_ERROR');
        if (!content) throw new AppError('Please type a message.', 400, 'VALIDATION_ERROR');
        if (content.length > MAX_MESSAGE_LENGTH) {
          throw new AppError(
            `Messages are limited to ${MAX_MESSAGE_LENGTH} characters.`,
            400,
            'VALIDATION_ERROR',
          );
        }
        // Socket.IO bypasses Express, so the AI endpoints need their own limit
        // on this path too.
        if (!socketChatLimiter.consume(socket.id)) {
          throw new AppError(
            'You are sending messages very quickly. Please wait a moment.',
            429,
            'RATE_LIMITED',
          );
        }

        // Typing indicator goes out before the model call so the patient sees
        // activity immediately.
        io.to(roomFor(sessionId)).emit('chat:typing', { isTyping: true });

        const result = await chatService.sendMessage({
          sessionId,
          content,
          user: data.user,
        });

        // Echo the stored message so every tab shows the same persisted row.
        io.to(roomFor(sessionId)).emit('chat:message', { message: result.userMessage });
        io.to(roomFor(sessionId)).emit('chat:typing', { isTyping: false });
        io.to(roomFor(sessionId)).emit('chat:reply', { message: result.assistantMessage });

        ack?.({ ok: true, data: result });
      } catch (error) {
        if (sessionId) io.to(roomFor(sessionId)).emit('chat:typing', { isTyping: false });
        handleSocketError(socket, error, ack, 'Your message could not be sent.');
      }
    });

    socket.on('chat:typing', (payload: TypingPayload = {}) => {
      const sessionId = payload.sessionId ?? data.sessionId;
      if (!sessionId) return;
      // Broadcast to the room *except* this socket — the sender does not need
      // to see its own indicator.
      socket.to(roomFor(sessionId)).emit('chat:peer-typing', { isTyping: Boolean(payload.isTyping) });
    });

    socket.on('disconnect', (reason) => {
      socketChatLimiter.release(socket.id);
      logger.info('Socket disconnected', { socketId: socket.id, reason });
    });
  });

  logger.info('Socket.IO ready', { origins: env.allowedOrigins });
  return io;
}

function roomFor(sessionId: string): string {
  return `chat:${sessionId}`;
}

/**
 * Sends a patient-safe error over the socket and acknowledges the failure.
 *
 * Mirrors the REST error middleware: `AppError`s carry a safe message, anything
 * else is replaced with a generic line and logged in full.
 */
function handleSocketError(socket: Socket, error: unknown, ack: Ack | undefined, fallback: string): void {
  const isApp = error instanceof AppError;
  const message = isApp ? error.message : fallback;
  const code = isApp ? error.code : 'INTERNAL_ERROR';

  if (!isApp) {
    logger.error('Socket handler failed', {
      socketId: socket.id,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
  } else {
    logger.warn('Socket request rejected', { socketId: socket.id, code, message });
  }

  socket.emit('chat:error', { message, code });
  ack?.({ ok: false, error: message });
}
