import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import type { StepAST } from '../types';

export type RunJobPayload = {
  runId: string;
  tenantId: string;
  compiledSteps: StepAST[];
  /**
   * Parallel to `compiledSteps`: `stepIds[i]` is the `test_steps.id` for
   * `compiledSteps[i]`. The worker writes `step_results.step_id` from this
   * so the runs API can LEFT JOIN `test_steps` to recover the step's
   * natural-language text for the timeline display.
   *
   * Optional for backwards-compat with jobs queued before this field
   * existed — the worker treats absence as "all step_ids are NULL", which
   * is the legacy behaviour.
   *
   * Spec: docs/specs/workers/spec-live-run-updates.md §5.1.
   */
  stepIds?: string[];
  baseUrl: string;
};

export const RUNS_QUEUE_NAME = 'kaizen-runs';

/**
 * Creates a Redis connection configured for BullMQ.
 * maxRetriesPerRequest: null is a BullMQ hard requirement — without it
 * blocking commands (XREAD etc.) time out and throw.
 */
export function createRedisConnection(): Redis {
  return new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
    maxRetriesPerRequest: null,
  });
}

export function createRunQueue(): Queue<RunJobPayload> {
  return new Queue<RunJobPayload>(RUNS_QUEUE_NAME, {
    connection: createRedisConnection(),
    defaultJobOptions: {
      attempts: 1,           // Phase 1: no retries — healing engine handles failures
      removeOnComplete: 100,
      removeOnFail: 200,
    },
  });
}
