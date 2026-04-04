import type { IHealingEngine, IHealingStrategy } from './interfaces';
import type { ClassifiedFailure, HealingContext, HealingResult } from '../../types';
import type { IObservability } from '../observability/interfaces';
import { getPool } from '../../db/pool';

const MAX_ATTEMPTS_PER_STEP = 3;

/**
 * HealingEngine — Spec ref: Section 10
 *
 * Chain of Responsibility: iterates strategies in priority order.
 * Calls canHandle() → heal() → continues on failure.
 *
 * Budget: max 3 healing attempts per step per run (enforced here).
 * healing_events row written after every attempt.
 */
export class HealingEngine implements IHealingEngine {
  constructor(
    private readonly strategies: IHealingStrategy[],
    private readonly observability: IObservability,
  ) {}

  async heal(failure: ClassifiedFailure, context: HealingContext): Promise<HealingResult> {
    const overallStart = Date.now();
    let attempts = 0;
    let lastStrategyName = 'none';

    for (const strategy of this.strategies) {
      if (!strategy.canHandle(failure)) continue;
      if (attempts >= MAX_ATTEMPTS_PER_STEP) {
        this.observability.log('warn', 'healing.budget_exhausted', {
          tenantId: context.tenantId,
          runId: context.runId,
          stepHash: failure.step.contentHash,
        });
        break;
      }

      attempts++;
      lastStrategyName = strategy.name;

      const attempt = await strategy.heal(failure, context);

      void this.persistHealingEvent(failure, context, strategy.name, attempt);

      this.observability.increment('healing.attempt', {
        strategy: strategy.name,
        failureClass: failure.failureClass,
        succeeded: String(attempt.succeeded),
      });

      if (attempt.succeeded) {
        return {
          succeeded: true,
          strategyUsed: strategy.name,
          newSelector: attempt.newSelector,
          attempts,
          durationMs: Date.now() - overallStart,
        };
      }
    }

    return {
      succeeded: false,
      strategyUsed: lastStrategyName,
      newSelector: null,
      attempts,
      durationMs: Date.now() - overallStart,
    };
  }

  private async persistHealingEvent(
    failure: ClassifiedFailure,
    context: HealingContext,
    strategyName: string,
    attempt: { succeeded: boolean; newSelector: string | null; durationMs: number },
  ): Promise<void> {
    // step_result_id is required by the schema; skip if not yet available
    // (Phase 3 worker does not yet insert step_results rows)
    if (!failure.stepResultId) return;

    try {
      await getPool().query(
        `INSERT INTO healing_events
           (tenant_id, step_result_id, failure_class, strategy_used, attempts, succeeded, new_selector, old_selector, duration_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          context.tenantId,
          failure.stepResultId,
          failure.failureClass,
          strategyName,
          1,
          attempt.succeeded,
          attempt.newSelector,
          failure.previousSelector,
          attempt.durationMs,
        ],
      );
    } catch (e: any) {
      // Fire-and-forget — don't let persistence failure break healing flow
      this.observability.log('warn', 'healing.persist_event_failed', { error: e.message });
    }
  }
}
