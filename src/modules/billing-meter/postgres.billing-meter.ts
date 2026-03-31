import type { IBillingMeter } from './interfaces';
import type { BillingEventInput, TenantUsage, BillingEventType, Span } from '../../types';

// We import IObservability interface depending on where it's defined
import type { IObservability } from '../observability/interfaces';
import { withTenantTransaction } from '../../db/transaction';

/**
 * Phase 1 Implementation of IBillingMeter backed by PostgreSQL.
 * For Phase 1, only emit() is fully implemented. Budget checks are stubbed.
 */
export class PostgresBillingMeter implements IBillingMeter {
  constructor(private readonly observability: IObservability) {}

  async emit(event: BillingEventInput): Promise<void> {
    const span = this.observability.startSpan('billing_meter.emit', { eventType: event.eventType });
    try {
      await withTenantTransaction(event.tenantId, async (client) => {
        await client.query(
          `INSERT INTO billing_events (tenant_id, event_type, quantity, unit, metadata)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            event.tenantId,
            event.eventType,
            event.quantity,
            event.unit,
            event.metadata ? JSON.stringify(event.metadata) : null,
          ]
        );
      });
      // Emit a metric indicating successful persistence
      this.observability.increment('billing.events_emitted', { type: event.eventType });
    } catch (error: any) {
      // The spec states: "Append a billing event. Fire-and-forget in most callers; must not throw on transient errors."
      this.observability.log('error', 'billing_emit_failed', { 
        error: error.message, 
        tenantId: event.tenantId,
        eventType: event.eventType
      });
    } finally {
      span.end();
    }
  }

  async getCurrentUsage(tenantId: string): Promise<TenantUsage> {
    return {
      tenantId,
      month: new Date().toISOString().substring(0, 7), // e.g. "2026-03"
      llmTokens: 0,
      testRuns: 0,
      screenshotBytes: 0,
      storageGbDays: 0,
    };
  }

  async isOverBudget(_tenantId: string, _forEventType: BillingEventType): Promise<boolean> {
    // Stub definition for Phase 1 constraints so test runner will never be blocked
    return false;
  }
}
