import type { Redis } from 'ioredis';

/**
 * Attempt fencing — spec §4.4.
 *
 * processRun clears prior step_results/run_events at the top of every BullMQ
 * attempt. Envelopes published by a superseded attempt can still be in flight
 * when that clear runs; without a fence they would land afterwards and
 * re-insert stale rows (or, for screenshots, overwrite a fresh capture with a
 * stale one — keys are deterministic per step). The producer marks the current
 * attempt in Redis *before* clearing; consumers drop any envelope tagged with
 * an older attempt.
 *
 * The fence fails open (missing marker or Redis error → accept the envelope),
 * which matches pre-decomposition behaviour and can at worst duplicate the
 * idempotent writes it guards.
 */

const ATTEMPT_KEY_PREFIX = 'kzn:run:attempt:';

/** Generous upper bound on run duration — the marker only needs to outlive in-flight jobs. */
const ATTEMPT_KEY_TTL_SECONDS = 6 * 3600;

export function runAttemptKey(runId: string): string {
  return `${ATTEMPT_KEY_PREFIX}${runId}`;
}

/** Producer side: record the attempt now executing. Call BEFORE clearing prior rows. */
export async function markRunAttempt(redis: Redis, runId: string, attempt: number): Promise<void> {
  try {
    await redis.set(runAttemptKey(runId), String(attempt), 'EX', ATTEMPT_KEY_TTL_SECONDS);
  } catch {
    // Best-effort — see fail-open note above.
  }
}

/** Consumer side: true when the envelope's attempt has been superseded. */
export async function isStaleAttempt(redis: Redis, runId: string, attempt: number): Promise<boolean> {
  try {
    const current = await redis.get(runAttemptKey(runId));
    return current !== null && Number(current) > attempt;
  } catch {
    return false;
  }
}
