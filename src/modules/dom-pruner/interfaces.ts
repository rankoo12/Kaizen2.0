import type { CandidateNode } from '../../types';

/**
 * Spec ref: Section 6.2 — IDOMPruner
 *
 * Reduces a full browser DOM (potentially 50,000+ tokens) to a compact list
 * of candidate interactive nodes relevant to the current step.
 *
 * Algorithm (two-pass):
 *  Pass 1 — AX tree extraction + string similarity filtering (always runs; ~300–800 tokens out)
 *  Pass 2 — Enriched DOM region (only if Pass 1 returns zero confident candidates; < 5% of calls)
 */
export interface IDOMPruner {
  /**
   * Given a live Playwright page and a step's target description,
   * return a pruned list of up to 20 candidate interactive nodes.
   *
   * @param page            - Live Playwright Page instance (typed as unknown to avoid
   *                          a compile-time dependency on playwright in this interface layer)
   * @param targetDescription - The natural language description of the element to find
   */
  prune(page: unknown, targetDescription: string): Promise<CandidateNode[]>;
}
