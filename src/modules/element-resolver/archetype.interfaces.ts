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

export type ArchetypeFailureKey = {
  tenantId: string;
  domain: string;
  targetHash: string;
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

  /**
   * Returns the set of archetype names on cooldown for this (tenant, domain,
   * target) triple. Archetype resolver skips any archetype whose name appears
   * in this set when selecting a candidate.
   */
  getCooldownArchetypes(key: ArchetypeFailureKey): Promise<Set<string>>;

  /**
   * Record a user-driven failure so future runs skip this archetype for the
   * same (tenant, domain, target) triple until the cooldown window elapses.
   * Fire-and-forget: errors are logged, never thrown.
   */
  recordFailure(
    key: ArchetypeFailureKey,
    archetypeName: string,
    selectorUsed: string,
  ): Promise<void>;
}
