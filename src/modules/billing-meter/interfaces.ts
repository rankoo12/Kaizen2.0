import type { BillingEventInput, BillingEventType, TenantUsage } from '../../types';

/**
 * Spec ref: Section 6.7 — IBillingMeter
 *
 * Append-only billing event log. All emitted events are persisted to the
 * billing_events table (Postgres), which is enforced append-only via a Postgres rule.
 *
 * Who emits what (Section 18):
 *  - LLM Gateway         → LLM_CALL (after every non-cached call; quantity = total tokens)
 *  - Execution Worker    → TEST_RUN_STARTED (when a run begins; quantity = 1)
 *  - Storage Handler     → SCREENSHOT_STORED (after S3 write; quantity = bytes)
 *  - Billing batch job   → STORAGE_GB_DAY (daily; quantity = total GB stored by tenant)
 *
 * isOverBudget() is called by the LLM Gateway before every LLM call.
 * If over budget: LLM calls are blocked; test execution continues with best cached selectors.
 */
export interface IBillingMeter {
  /** Append a billing event. Fire-and-forget in most callers; must not throw on transient errors. */
  emit(event: BillingEventInput): Promise<void>;

  /** Current month aggregated usage for a tenant. Backed by a Redis-cached materialized view. */
  getCurrentUsage(tenantId: string): Promise<TenantUsage>;

  /** Returns true if the tenant has exceeded their monthly budget for the given event type. */
  isOverBudget(tenantId: string, forEventType: BillingEventType): Promise<boolean>;
}
