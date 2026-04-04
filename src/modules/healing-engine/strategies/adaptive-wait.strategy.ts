import type { IHealingStrategy } from '../interfaces';
import type { ClassifiedFailure, HealingContext, HealingAttempt } from '../../../types';

type PageLike = {
  $(selector: string): Promise<unknown | null>;
  waitForTimeout(ms: number): Promise<void>;
};

const MAX_WAIT_MS = 10_000;
const POLL_INTERVAL_MS = 500;

/**
 * AdaptiveWaitStrategy — Priority 2
 * Spec ref: Section 10
 *
 * Retries the failing selector with exponential backoff up to 10s.
 * Smart polling: checks every 500ms, doubles wait on each miss.
 * Handles: TIMING, PAGE_NOT_LOADED
 */
export class AdaptiveWaitStrategy implements IHealingStrategy {
  readonly name = 'AdaptiveWaitStrategy';

  canHandle(failure: ClassifiedFailure): boolean {
    return failure.failureClass === 'TIMING' || failure.failureClass === 'PAGE_NOT_LOADED';
  }

  async heal(failure: ClassifiedFailure, context: HealingContext): Promise<HealingAttempt> {
    const start = Date.now();
    const page = context.page as PageLike;
    const selector = failure.previousSelector;

    let waited = 0;
    let interval = POLL_INTERVAL_MS;

    while (waited < MAX_WAIT_MS) {
      await page.waitForTimeout(interval);
      waited += interval;

      try {
        const handle = await page.$(selector);
        if (handle !== null) {
          return { succeeded: true, newSelector: selector, durationMs: Date.now() - start };
        }
      } catch {
        // element still not there — keep waiting
      }

      interval = Math.min(interval * 2, MAX_WAIT_MS - waited);
    }

    return { succeeded: false, newSelector: null, durationMs: Date.now() - start };
  }
}
