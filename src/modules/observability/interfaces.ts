import type { Span } from '../../types';

/**
 * Spec ref: Section 6.8 — IObservability
 *
 * Cross-cutting observability concern. All module implementations receive
 * IObservability via constructor injection.
 *
 * All interface adapters (e.g. CompositeElementResolver) automatically wrap
 * calls in spans and emit cache_hit/miss counters — no manual instrumentation
 * needed in business logic.
 *
 * Three layers (Section 17):
 *  1. Structured logs  — pino JSON; every event is key-value (no interpolated strings)
 *  2. OTel traces      — one trace per run; one span per step; child spans per operation
 *  3. Business metrics — OpenTelemetry metrics exported to Prometheus / Datadog
 *
 * Key metrics emitted:
 *  kaizen_llm_tokens_total          counter  {tenant, model, purpose}
 *  kaizen_cache_hit_ratio           gauge    {tenant, cache_level}
 *  kaizen_heal_success_rate         gauge    {tenant, strategy}
 *  kaizen_step_duration_ms          histogram{tenant, action}
 *  kaizen_selector_confidence_avg   gauge    {tenant, domain}
 */
export interface IObservability {
  /** Start an OpenTelemetry span. Caller is responsible for calling span.end(). */
  startSpan(name: string, attributes?: Record<string, string>): Span;

  /**
   * Emit a structured log event. Every loggable fact must be a key-value pair
   * in `data` — not embedded in the `event` string.
   */
  log(level: 'info' | 'warn' | 'error', event: string, data: Record<string, unknown>): void;

  /** Increment a counter metric by 1. */
  increment(metric: string, labels?: Record<string, string>): void;

  /** Record a value in a histogram metric (e.g. duration in ms). */
  histogram(metric: string, value: number, labels?: Record<string, string>): void;
}
