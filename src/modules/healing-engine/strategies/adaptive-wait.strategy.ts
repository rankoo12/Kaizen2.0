import type { IHealingStrategy } from '../interfaces';
import type { ClassifiedFailure, HealingContext, HealingAttempt } from '../../../types';

type PageLike = {
  $(selector: string): Promise<unknown | null>;
  waitForTimeout(ms: number): Promise<void>;
};

const MAX_WAIT_MS = 10_000;
const POLL_INTERVAL_MS = 500;
/**
 * Time left for the strategies BEHIND this one. A renamed control classifies
 * TIMING too, and its dead selector never appears no matter how long we wait —
 * ResolveAndRetry is what fixes it, so the waiter must never starve it.
 */
const RESOLVE_RESERVE_MS = 15_000;

/**
 * AdaptiveWaitStrategy — Priority 2
 * Spec ref: Section 10
 *
 * Retries the failing selector with exponential backoff. The budget is the
 * step's remaining watchdog allowance (context.deadlineAt, minus a reserve for
 * the strategies behind it) when known, else the classic 10s. The fixed cap
 * gave up before genuinely-late content existed (the stress site's 20s-late
 * widgets), and a "pass" there used to depend on earlier recovery layers
 * ACCIDENTALLY wasting enough time first — bench finding #10b made the
 * patience deliberate. Smart polling: checks every 500ms, doubles on each miss.
 * Handles: TIMING, PAGE_NOT_LOADED
 */
export class AdaptiveWaitStrategy implements IHealingStrategy {
  readonly name = 'AdaptiveWaitStrategy';

  canHandle(failure: ClassifiedFailure): boolean {
    // Nothing resolved (NoSelectorsError) leaves no selector to wait FOR: the
    // poll below would probe '' — which Playwright rejects — and swallow that
    // as "not there yet" until the whole budget is gone, a blind sleep of up to
    // ~40s that starved the one strategy able to act (ResolveAndRetry, which
    // polls the DOM for the target itself). Measured on the nightmare site.
    if (failure.previousSelector.trim() === '') return false;
    return failure.failureClass === 'TIMING' || failure.failureClass === 'PAGE_NOT_LOADED';
  }

  async heal(failure: ClassifiedFailure, context: HealingContext): Promise<HealingAttempt> {
    const start = Date.now();
    const page = context.page as PageLike;
    const selector = failure.previousSelector;

    // At least the classic 10s (the heal-entry budget gate guarantees that much
    // headroom), at most everything the watchdog allows minus the reserve.
    const maxWait = context.deadlineAt
      ? Math.max(MAX_WAIT_MS, context.deadlineAt - start - RESOLVE_RESERVE_MS)
      : MAX_WAIT_MS;

    let waited = 0;
    let interval = POLL_INTERVAL_MS;

    while (waited < maxWait) {
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

      interval = Math.min(interval * 2, maxWait - waited);
    }

    return { succeeded: false, newSelector: null, durationMs: Date.now() - start };
  }
}
