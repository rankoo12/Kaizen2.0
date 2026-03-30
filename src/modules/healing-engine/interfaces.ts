import type { ClassifiedFailure, HealingContext, HealingResult, HealingAttempt } from '../../types';

/**
 * Spec ref: Section 6.5 — IHealingStrategy / IHealingEngine
 *
 * Self-healing uses the Chain of Responsibility pattern.
 * IHealingEngine holds an ordered list of IHealingStrategy implementations.
 * On failure, it calls canHandle() on each in order and executes the first match.
 * If that strategy fails, it continues down the chain.
 *
 * Strategy priority order (Section 10):
 *  1. FallbackSelectorStrategy   — try next-ranked cached selector
 *  2. AdaptiveWaitStrategy       — retry with exponential backoff (TIMING failures)
 *  3. ResolveAndRetryStrategy    — fresh LLM re-resolution, update cache, retry
 *  4. EscalationStrategy         — notify team; mark test needs-review
 *
 * Healing budget (enforced in Redis):
 *  - Max 3 healing attempts per step per run
 *  - Max 2 ResolveAndRetry calls per tenant per hour
 *  - Auto-disable healing after 5 consecutive ResolveAndRetry failures on same step
 */
export interface IHealingStrategy {
  /** Returns true if this strategy can handle the given failure class. */
  canHandle(failure: ClassifiedFailure): boolean;

  /** Attempt to heal. Implementations must respect the healing budget. */
  heal(failure: ClassifiedFailure, context: HealingContext): Promise<HealingAttempt>;
}

export interface IHealingEngine {
  /** Run all applicable strategies in priority order until one succeeds. */
  heal(failure: ClassifiedFailure, context: HealingContext): Promise<HealingResult>;
}
