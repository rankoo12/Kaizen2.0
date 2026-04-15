/**
 * Spec ref: Smart Brain Layer 0 — Element Archetype Library
 *
 * Resolves DOM candidates against the pre-seeded element_archetypes table.
 * Returns an ARIA-strategy selector when the candidate's role + normalised
 * accessible name matches a known archetype. Returns null on miss.
 *
 * Contract:
 *   - MUST NOT make LLM calls.
 *   - MUST NOT call pgvector or any embedding API.
 *   - MUST return null (not throw) on any DB error — the fallback chain continues.
 *   - The returned selector MUST use strategy: 'aria' and MUST be validated
 *     against the live DOM before being returned by the ArchetypeElementResolver.
 */

import type { CandidateNode } from '../../types';

export type ArchetypeMatch = {
  /** Slug from element_archetypes.name, e.g. 'login_button'. */
  archetypeName: string;
  /** ARIA selector built from the candidate's real accessible name. Always portable. */
  selector: string;
  /** Confidence score from the archetype row. */
  confidence: number;
};

export interface IArchetypeResolver {
  /**
   * Attempt to match a DOM candidate against a known archetype.
   *
   * @param candidate  The top word-overlap candidate from the DOM pruner.
   * @param action     The step action ('click', 'type', etc.) — used to respect action_hint.
   * @returns          An ArchetypeMatch if recognised; null otherwise.
   */
  match(candidate: CandidateNode, action: string): Promise<ArchetypeMatch | null>;
}
