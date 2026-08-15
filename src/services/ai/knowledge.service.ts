import { clinicRepository } from '../../repositories/clinic.repository';
import { logger } from '../../utils/logger';
import type { RetrievedDocument } from '../../types';

/**
 * Clinic knowledge retrieval — the "R" in RAG.
 *
 * ## Why this is not a vector database
 *
 * The corpus is ~21 short, single-topic documents describing one clinic. At
 * that size, PostgreSQL's built-in full-text search plus trigram similarity
 * retrieves the right document essentially every time, while an embedding
 * pipeline would add an external service, a network round trip on every
 * message, an API key, and a re-indexing step that can silently drift out of
 * sync with the source rows.
 *
 * The retrieval interface below is deliberately narrow (`retrieve` in,
 * documents out). Swapping in pgvector or a hosted vector store later means
 * reimplementing this one function — nothing else in the codebase knows how
 * retrieval works.
 *
 * The full argument is in the root README under "Lightweight RAG".
 */

/**
 * Minimum blended score for a document to be considered relevant.
 *
 * Tuned against the seeded corpus: genuine matches score well above this, while
 * an unrelated question ("what's the weather") scores below it and retrieves
 * nothing — which is what lets the assistant say "I can't confirm that" instead
 * of answering from a loosely related document.
 */
const RELEVANCE_THRESHOLD = 0.05;

/** Documents always available to the assistant, regardless of the question. */
const CORE_CATEGORIES = ['hours', 'appointments'];

export interface KnowledgeContext {
  /** Formatted block to inject into the system prompt. */
  contextText: string;
  /** Titles of the documents used — logged for traceability. */
  sources: string[];
  documents: RetrievedDocument[];
}

export const knowledgeService = {
  /**
   * Retrieves the documents relevant to a question and formats them for the
   * prompt.
   *
   * Returns an empty context when nothing clears the threshold. The caller then
   * instructs the model to decline rather than improvise — that is the
   * guardrail against inventing clinic facts.
   */
  async retrieve(question: string, limit = 4): Promise<KnowledgeContext> {
    try {
      const documents = (await clinicRepository.searchKnowledge(question, limit)).filter(
        (doc) => doc.score >= RELEVANCE_THRESHOLD,
      );

      if (documents.length === 0) {
        logger.debug('Knowledge retrieval found nothing relevant', { question: truncate(question) });
        return { contextText: '', sources: [], documents: [] };
      }

      logger.debug('Knowledge retrieved', {
        question: truncate(question),
        sources: documents.map((doc) => `${doc.title} (${doc.score.toFixed(3)})`),
      });

      return {
        contextText: format(documents),
        sources: documents.map((doc) => doc.title),
        documents,
      };
    } catch (error) {
      // Retrieval failing must not take the assistant down with it — it answers
      // from the always-present clinic summary instead.
      logger.error('Knowledge retrieval failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return { contextText: '', sources: [], documents: [] };
    }
  },

  /**
   * The always-included clinic facts.
   *
   * Hours and booking basics are in the system prompt on every turn because
   * they are asked about constantly and are needed to reason about dates, so
   * paying for retrieval each time would be wasteful.
   */
  async getCoreContext(): Promise<string> {
    const documents = await clinicRepository.getKnowledgeByCategory(CORE_CATEGORIES);
    if (documents.length === 0) return '';
    return documents.map((doc) => `### ${doc.title}\n${doc.content}`).join('\n\n');
  },

  /** Whole corpus — used by the offline provider's keyword matcher. */
  async getAll() {
    return clinicRepository.getAllKnowledge();
  },
};

function format(documents: RetrievedDocument[]): string {
  return documents.map((doc) => `### ${doc.title}\n${doc.content}`).join('\n\n');
}

function truncate(value: string, max = 80): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
