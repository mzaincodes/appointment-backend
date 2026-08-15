import { query, queryOne } from '../db/pool';
import { DAY_NAMES } from '../config/clinic';
import { normaliseTime } from '../utils/datetime';
import type { ClinicHours, ClinicHoursRow, KnowledgeDocument, RetrievedDocument, Service } from '../types';

/**
 * Clinic reference data: opening hours, services and the knowledge corpus.
 *
 * Opening hours are cached in-process. They are read on every availability
 * request but change perhaps once a year, so re-querying them each time is pure
 * overhead. The TTL is short enough that an edit takes effect without a restart.
 */

const HOURS_CACHE_TTL_MS = 60_000;
let hoursCache: { value: ClinicHours[]; expiresAt: number } | null = null;

function toClinicHours(row: ClinicHoursRow): ClinicHours {
  return {
    dayOfWeek: row.day_of_week,
    dayName: DAY_NAMES[row.day_of_week] ?? 'Unknown',
    isOpen: row.is_open,
    opensAt: row.opens_at ? normaliseTime(row.opens_at) : null,
    closesAt: row.closes_at ? normaliseTime(row.closes_at) : null,
  };
}

export const clinicRepository = {
  async getHours(): Promise<ClinicHours[]> {
    if (hoursCache && hoursCache.expiresAt > Date.now()) return hoursCache.value;

    const { rows } = await query<ClinicHoursRow>(
      'SELECT day_of_week, is_open, opens_at, closes_at FROM clinic_hours ORDER BY day_of_week',
    );
    const value = rows.map(toClinicHours);
    hoursCache = { value, expiresAt: Date.now() + HOURS_CACHE_TTL_MS };
    return value;
  },

  async getHoursForDay(dayOfWeek: number): Promise<ClinicHours | null> {
    const hours = await this.getHours();
    return hours.find((entry) => entry.dayOfWeek === dayOfWeek) ?? null;
  },

  /** Called after an admin edits opening hours so the change is seen at once. */
  invalidateHoursCache(): void {
    hoursCache = null;
  },

  async getServices(): Promise<Service[]> {
    const { rows } = await query<{
      id: string;
      slug: string;
      name: string;
      description: string;
      duration_min: number;
      price_from: number | null;
      icon: string | null;
      display_order: number;
    }>(
      `SELECT id, slug, name, description, duration_min, price_from, icon, display_order
       FROM services WHERE is_active = TRUE ORDER BY display_order, name`,
    );

    return rows.map((row) => ({
      id: row.id,
      slug: row.slug,
      name: row.name,
      description: row.description,
      durationMin: row.duration_min,
      priceFrom: row.price_from,
      icon: row.icon,
      displayOrder: row.display_order,
    }));
  },

  async findServiceBySlug(slug: string): Promise<Service | null> {
    const row = await queryOne<{
      id: string;
      slug: string;
      name: string;
      description: string;
      duration_min: number;
      price_from: number | null;
      icon: string | null;
      display_order: number;
    }>(
      `SELECT id, slug, name, description, duration_min, price_from, icon, display_order
       FROM services WHERE slug = $1 AND is_active = TRUE`,
      [slug],
    );
    if (!row) return null;
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      description: row.description,
      durationMin: row.duration_min,
      priceFrom: row.price_from,
      icon: row.icon,
      displayOrder: row.display_order,
    };
  },

  // -------------------------------------------------------------------------
  //  Knowledge base retrieval  (the "R" in RAG)
  // -------------------------------------------------------------------------
  /**
   * Retrieves the documents most relevant to a question.
   *
   * Two signals are blended:
   *
   *  1. **Full-text rank** over the generated `search_vector`, where title and
   *     keywords are weighted above body text. `websearch_to_tsquery` is used
   *     rather than `plainto_tsquery` because it tolerates natural phrasing and
   *     never throws on punctuation a patient happens to type.
   *
   *  2. **Trigram similarity** against title + keywords, which catches
   *     misspellings ("apointment", "flouride") that stemming cannot.
   *
   * The blend matters: full-text alone misses typos, trigram alone ranks poorly
   * on well-formed questions. `priority` breaks ties between documents that
   * score similarly.
   *
   * This is the whole retrieval layer — no embedding service, no vector store.
   * The reasoning is in the root README under "Lightweight RAG".
   */
  async searchKnowledge(rawQuery: string, limit = 4): Promise<RetrievedDocument[]> {
    const trimmed = rawQuery.trim();
    if (!trimmed) return [];

    const { rows } = await query<{
      id: string;
      category: string;
      title: string;
      content: string;
      priority: number;
      score: number;
    }>(
      `WITH q AS (
         SELECT websearch_to_tsquery('english', $1) AS tsq, $1::text AS raw
       )
       SELECT k.id, k.category, k.title, k.content, k.priority,
              (
                ts_rank(k.search_vector, q.tsq)
                + 0.35 * similarity(k.title || ' ' || k.keywords, q.raw)
                + 0.02 * k.priority
              )::float8 AS score
       FROM clinic_knowledge k, q
       WHERE k.is_active = TRUE
         AND (
           k.search_vector @@ q.tsq
           OR similarity(k.title || ' ' || k.keywords, q.raw) > 0.12
         )
       ORDER BY score DESC
       LIMIT $2`,
      [trimmed, limit],
    );

    return rows.map((row) => ({
      id: row.id,
      category: row.category,
      title: row.title,
      content: row.content,
      priority: row.priority,
      score: Number(row.score),
    }));
  },

  /** Whole categories, used to assemble the always-available clinic summary. */
  async getKnowledgeByCategory(categories: string[]): Promise<KnowledgeDocument[]> {
    const { rows } = await query<{
      id: string;
      category: string;
      title: string;
      content: string;
      priority: number;
    }>(
      `SELECT id, category, title, content, priority
       FROM clinic_knowledge
       WHERE is_active = TRUE AND category = ANY($1::text[])
       ORDER BY priority DESC, title`,
      [categories],
    );
    return rows;
  },

  async getAllKnowledge(): Promise<KnowledgeDocument[]> {
    const { rows } = await query<{
      id: string;
      category: string;
      title: string;
      content: string;
      priority: number;
    }>(
      `SELECT id, category, title, content, priority
       FROM clinic_knowledge WHERE is_active = TRUE
       ORDER BY priority DESC, category, title`,
    );
    return rows;
  },
};
