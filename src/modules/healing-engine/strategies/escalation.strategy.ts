import type { IHealingStrategy } from '../interfaces';
import type { ClassifiedFailure, HealingContext, HealingAttempt } from '../../../types';
import type { INotifier } from '../notifier/interfaces';
import type { IObservability } from '../../observability/interfaces';

/**
 * EscalationStrategy — Priority 5 (last resort)
 * Spec ref: Section 10
 *
 * Called when all other strategies have been exhausted.
 * Marks the step as needing human review and notifies the tenant via INotifier.
 *
 * INotifier is currently a stub (LogNotifier). Wire in a real provider
 * (Slack, email, webhook) via per-tenant DB settings — see:
 * src/modules/healing-engine/notifier/interfaces.ts
 *
 * Handles: LOGIC_FAILURE and any unhandled failure class.
 */
export class EscalationStrategy implements IHealingStrategy {
  readonly name = 'EscalationStrategy';

  constructor(
    private readonly notifier: INotifier,
    private readonly observability: IObservability,
  ) {}

  canHandle(_failure: ClassifiedFailure): boolean {
    // Always handles — it is the catch-all last resort
    return true;
  }

  async heal(failure: ClassifiedFailure, context: HealingContext): Promise<HealingAttempt> {
    const start = Date.now();

    this.observability.increment('healing.escalated', {
      tenantId: context.tenantId,
      failureClass: failure.failureClass,
    });

    await this.notifier.notifyEscalation({
      tenantId: context.tenantId,
      runId: context.runId,
      stepText: failure.step.rawText,
      failureClass: failure.failureClass,
      strategiesAttempted: ['FallbackSelectorStrategy', 'AdaptiveWaitStrategy', 'ElementSimilarityStrategy', 'ResolveAndRetryStrategy'],
    });

    // EscalationStrategy never "succeeds" at healing — it marks as unresolvable
    return { succeeded: false, newSelector: null, durationMs: Date.now() - start };
  }
}
