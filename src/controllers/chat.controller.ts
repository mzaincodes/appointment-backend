import type { Request, Response } from 'express';
import { chatService } from '../services/chat/chat.service';
import { aiService } from '../services/ai/ai.service';
import { created, ok } from '../utils/http';
import { UnauthorizedError } from '../utils/errors';

/**
 * Chat controllers.
 *
 * Socket.IO is the primary transport; these endpoints exist so a client with a
 * blocked websocket can still hold a conversation, and so the transcript can be
 * loaded on page render. Both paths call the same `chatService`, so behaviour
 * is identical either way.
 */
export const chatController = {
  /** `POST /api/chat/sessions` — open or adopt a conversation. */
  async createSession(req: Request, res: Response): Promise<Response> {
    const { sessionId } = req.body as { sessionId?: string };
    const session = await chatService.resolveSession(sessionId, req.user);
    const messages = await chatService.getMessages(session.id, req.user);

    return created(res, {
      session,
      messages,
      welcome: messages.length === 0 ? chatService.getWelcomeMessage(req.user) : null,
      provider: aiService.getProviderInfo(),
    });
  },

  /** `GET /api/chat/sessions/:id/messages` */
  async getMessages(req: Request, res: Response): Promise<Response> {
    const { id } = req.params as { id: string };
    return ok(res, { messages: await chatService.getMessages(id, req.user) });
  },

  /** `GET /api/chat/sessions` — the signed-in patient's conversations. */
  async listSessions(req: Request, res: Response): Promise<Response> {
    if (!req.user) throw new UnauthorizedError();
    return ok(res, { sessions: await chatService.listSessions(req.user) });
  },

  /** `POST /api/chat/sessions/:id/messages` — HTTP fallback for a turn. */
  async sendMessage(req: Request, res: Response): Promise<Response> {
    const { id } = req.params as { id: string };
    const { content } = req.body as { content: string };

    const result = await chatService.sendMessage({ sessionId: id, content, user: req.user });
    return created(res, result);
  },
};
