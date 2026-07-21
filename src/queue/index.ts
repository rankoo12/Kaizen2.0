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
  /**
   * Pre-seeded run-scoped variables (generated form data) made available to
   * steps via {{token}} interpolation. Generated fresh per run by the API so
   * each run registers unique data. Optional for backwards-compat.
   * Spec: docs/specs/tests-ux/spec-duplicate-case-and-generated-data.md §2.3
   */
  seedVariables?: Record<string, string>;
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
      // Retry on THROWN exceptions only — transient infra faults (DB/Redis
      // connection timeouts, browser-launch hiccups, network blips). Normal test
      // outcomes (failed assertions) never throw out of processRun, so they are
      // NOT retried. Backoff spaces attempts so a briefly-unavailable dependency
      // has time to recover; processRun clears prior rows on entry so a retry
      // produces clean results. Without this, a transient fault stranded the run
      // in 'queued'/'running' forever.
      attempts: 3,
      backoff: { type: 'exponential', delay: 3000 },
      removeOnComplete: 100,
      removeOnFail: 200,
    },
  });
}
