import { getPool } from '../db/pool';
import type { IObservability } from '../modules/observability/interfaces';
import type { RunEventLevel, RunEventPhase, RunEventRow } from '../modules/event-bus/interfaces';

/**
 * RunLogger — buffers a chronological event stream for one run, flushed as
 * batches (per step and at run end) into run_events, powering the full-run
 * report's "pytest -v"-style log. Each event carries a monotonic `seq` so the
 * report can order them deterministically even when timestamps tie.
 *
 * Flush target: when a sink is injected (decomposed worker), each batch is
 * handed to it — the worker's sink publishes a persist.run_events envelope to
 * the event bus. Without a sink, flush() falls back to the legacy direct
 * batched INSERT.
 *
 * Failures to persist are swallowed (logged via observability) — the run log is
 * an observability aid and must never break execution.
 *
 * Spec: docs/specs/tests-ux/spec-run-report-view.md §1.1
 *       docs/specs/workers/spec-service-decomposition.md §5 (sink)
 */

export type { RunEventLevel, RunEventPhase } from '../modules/event-bus/interfaces';

type PendingEvent = RunEventRow;

/** Receives each flushed batch. Must not reject with intent — flush() guards anyway. */
export type RunEventSink = (rows: RunEventRow[]) => Promise<void>;

export class RunLogger {
  private seq = 0;
  private buffer: PendingEvent[] = [];

  constructor(
    private readonly tenantId: string,
    private readonly runId: string,
    private readonly obs: IObservability,
    private readonly sink?: RunEventSink,
  ) {}

  /** Record an event. Buffered until flush(). */
  log(
    phase: RunEventPhase,
    message: string,
    opts: { level?: RunEventLevel; stepIndex?: number | null; data?: Record<string, unknown> } = {},
  ): void {
    this.buffer.push({
      stepIndex: opts.stepIndex ?? null,
      seq: this.seq++,
      level: opts.level ?? 'info',
      phase,
      message,
      data: opts.data ?? null,
    });
  }

  /** Hand buffered events to the sink (or legacy direct INSERT), then clear the buffer. */
  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const batch = this.buffer;
    this.buffer = [];

    if (this.sink) {
      try {
        await this.sink(batch);
      } catch (e: any) {
        this.obs.log('warn', 'run_logger.flush_failed', { error: e.message, dropped: batch.length });
      }
      return;
    }

    // Build a multi-row VALUES list: ($1,$2,...) per event.
    const cols = 7; // tenant_id, run_id, step_index, seq, level, phase, message, data → 8
    void cols;
    const values: unknown[] = [];
    const tuples: string[] = [];
    batch.forEach((e, i) => {
      const b = i * 8;
      tuples.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8})`);
      values.push(
        this.tenantId, this.runId, e.stepIndex, e.seq, e.level, e.phase, e.message,
        e.data ? JSON.stringify(e.data) : null,
      );
    });

    try {
      await getPool().query(
        `INSERT INTO run_events
           (tenant_id, run_id, step_index, seq, level, phase, message, data)
         VALUES ${tuples.join(', ')}`,
        values,
      );
    } catch (e: any) {
      // Re-buffer is pointless (likely a schema/connection issue); just report.
      this.obs.log('warn', 'run_logger.flush_failed', { error: e.message, dropped: batch.length });
    }
  }
}
