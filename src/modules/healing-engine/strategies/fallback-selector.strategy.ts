import type { IHealingStrategy } from '../interfaces';
import type { ClassifiedFailure, HealingContext, HealingAttempt } from '../../../types';

type PageLike = {
  $(selector: string): Promise<unknown | null>;
};

/**
 * FallbackSelectorStrategy — Priority 1
 * Spec ref: Section 10
 *
 * Tries each selector from the existing SelectorSet in ranked order,
 * skipping the one that already failed. Zero LLM cost.
 * Handles: ELEMENT_MUTATED, ELEMENT_REMOVED
 */
export class FallbackSelectorStrategy implements IHealingStrategy {
  readonly name = 'FallbackSelectorStrategy';

  canHandle(failure: ClassifiedFailure): boolean {
    return (
      failure.failureClass === 'ELEMENT_MUTATED' ||
      failure.failureClass === 'ELEMENT_REMOVED'
    );
  }

  async heal(failure: ClassifiedFailure, context: HealingContext): Promise<HealingAttempt> {
    const start = Date.now();
    const page = context.page as PageLike;

    const selectors: Array<{ selector: string }> =
      (failure.stepResult as any).selectors ?? [];

    for (const entry of selectors) {
      if (entry.selector === failure.previousSelector) continue;
      try {
        const handle = await page.$(entry.selector);
        if (handle !== null) {
          return { succeeded: true, newSelector: entry.selector, durationMs: Date.now() - start };
        }
      } catch {
        // try next
      }
    }

    return { succeeded: false, newSelector: null, durationMs: Date.now() - start };
  }
}
