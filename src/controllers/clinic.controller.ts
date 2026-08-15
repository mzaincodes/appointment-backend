import type { Request, Response } from 'express';
import { clinicRepository } from '../repositories/clinic.repository';
import { knowledgeService } from '../services/ai/knowledge.service';
import { SLOT_DURATION_MINUTES } from '../config/clinic';
import { ok } from '../utils/http';

/**
 * Public clinic information.
 *
 * The landing page renders from these endpoints rather than from hard-coded
 * copy, so the site and the chatbot describe the clinic from the same rows.
 */
export const clinicController = {
  /** `GET /api/clinic` — everything the landing page needs, in one request. */
  async getInfo(_req: Request, res: Response): Promise<Response> {
    const [hours, services, knowledge] = await Promise.all([
      clinicRepository.getHours(),
      clinicRepository.getServices(),
      clinicRepository.getKnowledgeByCategory(['general', 'location', 'dentists']),
    ]);

    return ok(res, {
      name: 'Bright Smile Dental Studio',
      tagline: 'Modern dentistry, gently delivered.',
      description: knowledge.find((doc) => doc.category === 'general')?.content ?? '',
      phone: '+1 (415) 555-0142',
      email: 'hello@brightsmiledental.com',
      address: '218 Marina Boulevard, Suite 300, San Francisco, CA 94123',
      slotDurationMinutes: SLOT_DURATION_MINUTES,
      hours,
      services,
      dentists: knowledge
        .filter((doc) => doc.category === 'dentists')
        .map((doc) => ({ name: doc.title, bio: doc.content })),
      location: knowledge.find((doc) => doc.category === 'location')?.content ?? '',
    });
  },

  /** `GET /api/clinic/hours` */
  async getHours(_req: Request, res: Response): Promise<Response> {
    return ok(res, { hours: await clinicRepository.getHours(), slotDurationMinutes: SLOT_DURATION_MINUTES });
  },

  /** `GET /api/clinic/services` */
  async getServices(_req: Request, res: Response): Promise<Response> {
    return ok(res, { services: await clinicRepository.getServices() });
  },

  /**
   * `GET /api/clinic/faq`
   *
   * The same corpus the chatbot retrieves from, exposed so the site can render
   * an FAQ without a second copy of the content drifting out of sync.
   */
  async getFaq(_req: Request, res: Response): Promise<Response> {
    const documents = await knowledgeService.getAll();
    return ok(res, {
      documents: documents.map((doc) => ({
        id: doc.id,
        category: doc.category,
        title: doc.title,
        content: doc.content,
      })),
    });
  },
};
