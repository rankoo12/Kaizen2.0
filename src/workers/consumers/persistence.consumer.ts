import { Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import { tenantQuery } from '../../db/transaction';
import type { IObservability } from '../../modules/observability/interfaces';
import type {
  PersistJobData,
  RunEventRow,
  StepResultRow,
} from '../../modules/event-bus/interfaces';
import { isStaleAttempt } from '../../modules/event-bus/attempt-fence';
import { createRedisConnection, PERSIST_QUEUE_NAME } from '../../queue';

/**
 * Persistence consumer — drains kaizen-persist into Postgres (step_results +
 * run_events), off the per-step critical path. Phase 1 runs it co-located in
 * the worker process; Phase 2 moves the same start function behind its own
 * entrypoint.
 *
 * Idempotency:
 *  - step_results upserts on the client-generated id (spec §4.2), so a
 *    redelivered job produces a single row.
 *  - run_events inserts ON CONFLICT (run_id, seq) DO NOTHING against the
 *    unique index from migration 027.
 *
 * Unlike the old inline writes (which swallowed errors to protect the step
 * loop), handler failures here THROW: BullMQ retries with backoff, and the
 * writes above are safe to repeat.
 *
 * Spec: docs/specs/workers/spec-service-decomposition.md §3, §4, §6
 */

async function upsertStepResult(row: StepResultRow): Promise<void> {
  await tenantQuery(
    row.tenantId,
    `INSERT INTO step_results
       (id, tenant_id, run_id, step_id, step_index, content_hash, target_hash, status,
        selector_used, screenshot_key, duration_ms, resolution_source, similarity_score,
        dom_candidates, llm_picked_kaizen_id, tokens_used, archetype_name, error_type,
        captured_name, captured_value, frame_url)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
     ON CONFLICT (id) DO UPDATE SET
       status         = EXCLUDED.status,
       selector_used  = EXCLUDED.selector_used,
       screenshot_key = EXCLUDED.screenshot_key,
       duration_ms    = EXCLUDED.duration_ms,
       error_type     = EXCLUDED.error_type,
       captured_name  = EXCLUDED.captured_name,
       captured_value = EXCLUDED.captured_value,
       frame_url      = EXCLUDED.frame_url`,
    [
      row.id, row.tenantId, row.runId, row.stepId, row.stepIndex,
      row.contentHash, row.targetHash, row.status,
      row.selectorUsed, row.screenshotKey, row.durationMs,
      row.resolutionSource, row.similarityScore,
      row.domCandidates ? JSON.stringify(row.domCandidates) : null,
      row.llmPickedKaizenId, row.tokensUsed, row.archetypeName, row.errorType,
      row.capturedName, row.capturedValue, row.frameUrl ?? null,
    ],
  );
}

async function insertRunEvents(tenantId: string, runId: string, rows: RunEventRow[]): Promise<void> {
  if (rows.length === 0) return;
  const values: unknown[] = [];
  const tuples: string[] = [];
  rows.forEach((e, i) => {
    const b = i * 8;
    tuples.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8})`);
    values.push(
      tenantId, runId, e.stepIndex, e.seq, e.level, e.phase, e.message,
      e.data ? JSON.stringify(e.data) : null,
    );
  });
  await tenantQuery(
    tenantId,
    `INSERT INTO run_events
       (tenant_id, run_id, step_index, seq, level, phase, message, data)
     VALUES ${tuples.join(', ')}
     ON CONFLICT (run_id, seq) DO NOTHING`,
    values,
  );
}

export type PersistenceConsumerDeps = {
  /** Non-blocking Redis connection for the attempt fence (not the BullMQ worker connection). */
  redis: Redis;
  obs: IObservability;
};

export async function handlePersistJob(
  data: PersistJobData,
  deps: PersistenceConsumerDeps,
): Promise<void> {
  const runId = data.kind === 'persist.step_result' ? data.row.runId : data.runId;

  if (await isStaleAttempt(deps.redis, runId, data.attempt)) {
    deps.obs.increment('persist_consumer.stale_dropped', { kind: data.kind });
    return;
  }

  if (data.kind === 'persist.step_result') {
    await upsertStepResult(data.row);
    deps.obs.increment('persist_consumer.step_result_written', { status: data.row.status });
  } else {
    await insertRunEvents(data.tenantId, data.runId, data.rows);
    deps.obs.increment('persist_consumer.run_events_written');
  }
}

export function startPersistenceConsumer(deps: PersistenceConsumerDeps): Worker<PersistJobData> {
  const worker = new Worker<PersistJobData>(
    PERSIST_QUEUE_NAME,
    (job) => handlePersistJob(job.data, deps),
    {
      connection: createRedisConnection(),
      // Concurrency 1 keeps per-run write order near-FIFO (reorders only on
      // retry, which the idempotent writes tolerate). Postgres writes are
      // milliseconds — nowhere near a bottleneck at current scale.
      concurrency: Number(process.env.PERSIST_CONSUMER_CONCURRENCY ?? 1),
    },
  );
  worker.on('failed', (job, err) => {
    deps.obs.log('warn', 'persist_consumer.job_failed', { jobId: job?.id, error: err.message });
  });
  // Without an 'error' listener, a transient Redis blip (ECONNRESET) becomes an
  // unhandled EventEmitter error and kills the whole process. BullMQ reconnects
  // on its own; we only need to observe.
  worker.on('error', (err) => {
    deps.obs.log('warn', 'persist_consumer.worker_error', { error: err.message });
  });
  return worker;
}
