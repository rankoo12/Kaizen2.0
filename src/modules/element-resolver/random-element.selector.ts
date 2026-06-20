import { createHash } from 'crypto';
import type { CandidateNode } from '../../types';

/**
 * Random element selection for the `click_random` action.
 *
 * Kaizen's normal resolver chain collapses a target description down to the
 * single *best* element. `click_random` inverts that: it picks one of several
 * equally-valid matches at random (e.g. "select a random product"). This module
 * isolates that selection so it is deterministic-by-seed and unit-testable.
 *
 * Spec: docs/specs/workers/spec-engine-capabilities-assert-random-capture.md §2
 */

/**
 * Deterministic pseudo-random index in [0, length) derived from a seed string.
 *
 * Using a hash of `runId:stepIndex` (rather than Math.random) makes a given run
 * replayable — the same run picks the same element every time — while different
 * runs vary. The first 8 hex chars of a SHA-256 give us 32 bits of spread,
 * which is ample for choosing among a handful of candidates.
 */
export function seededIndex(seed: string, length: number): number {
  if (length <= 0) throw new Error('seededIndex requires length > 0');
  const hex = createHash('sha256').update(seed).digest('hex').slice(0, 8);
  return parseInt(hex, 16) % length;
}

/**
 * Reduce the candidate pool to those plausibly matching the target, preferring
 * candidates the DOM pruner scored as relevant. Falls back to the full pool when
 * nothing scored, so `click_random` still has something to pick from rather than
 * failing outright.
 */
export function eligibleCandidates(candidates: CandidateNode[]): CandidateNode[] {
  const visible = candidates.filter((c) => c.isVisible);
  const pool = visible.length > 0 ? visible : candidates;
  const scored = pool.filter((c) => c.similarityScore > 0);
  return scored.length > 0 ? scored : pool;
}

export type RandomPick = {
  candidate: CandidateNode;
  /** Index chosen within the eligible pool — surfaced for observability/tests. */
  index: number;
  /** Size of the pool the pick was drawn from. */
  poolSize: number;
};

/**
 * Pick one candidate at random (seeded) from those matching the target.
 * Returns null when there are no candidates at all.
 */
export function pickRandomCandidate(
  candidates: CandidateNode[],
  seed: string,
): RandomPick | null {
  if (candidates.length === 0) return null;
  const pool = eligibleCandidates(candidates);
  const index = seededIndex(seed, pool.length);
  return { candidate: pool[index], index, poolSize: pool.length };
}
