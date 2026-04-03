/**
 * Spec ref: Section 9 — Selector Confidence & Decay Model
 *
 * Sliding window with exponential recency weighting.
 * outcome_window: last 50 booleans, most-recent LAST.
 * i=0 is the most recent outcome (reversed iteration).
 * weight = 0.95^i  →  recent outcomes matter more.
 */

export const OUTCOME_WINDOW_SIZE = 50;
export const RECENCY_FACTOR = 0.95;

/** Thresholds from spec §9 */
export const CONFIDENCE_HEALTHY   = 0.7;
export const CONFIDENCE_DEGRADED  = 0.4;

export type ConfidenceState = 'healthy' | 'degraded' | 'stale';

/**
 * Compute the confidence score for a given outcome window.
 * Returns 1.0 if the window is empty (no history = assume healthy).
 */
export function computeConfidence(outcomeWindow: boolean[]): number {
  if (outcomeWindow.length === 0) return 1.0;

  let score = 0;
  let totalWeight = 0;

  // Iterate reversed so i=0 is the most recent outcome
  const reversed = [...outcomeWindow].reverse();
  for (let i = 0; i < reversed.length; i++) {
    const weight = Math.pow(RECENCY_FACTOR, i);
    score += weight * (reversed[i] ? 1 : 0);
    totalWeight += weight;
  }

  return totalWeight === 0 ? 1.0 : score / totalWeight;
}

/**
 * Append an outcome to the window, capping at OUTCOME_WINDOW_SIZE.
 * Returns the new window (does not mutate the input).
 */
export function appendOutcome(window: boolean[], success: boolean): boolean[] {
  const next = [...window, success];
  if (next.length > OUTCOME_WINDOW_SIZE) {
    next.shift(); // drop oldest
  }
  return next;
}

/**
 * Classify a confidence score into a named state per spec thresholds.
 */
export function classifyConfidence(score: number): ConfidenceState {
  if (score >= CONFIDENCE_HEALTHY) return 'healthy';
  if (score >= CONFIDENCE_DEGRADED) return 'degraded';
  return 'stale';
}
