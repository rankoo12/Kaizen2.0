import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import type { StepAST } from '../types';
import type { PersistJobData, ScreenshotJobData } from '../modules/event-bus/interfaces';

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
  /**
   * This run executes against a behind-login surface, so nothing it learns may
   * leave the tenant. The worker suppresses BOTH shared-pool contribution and
   * global archetype learning when set — the tenant's own selector_cache still
   * fills, which is what makes an authenticated draft's login prefix cheap.
   *
   * Set by the Test Writer for proving runs of drafts belonging to a
   * scope='authenticated' generation job. Absent (falsy) for every ordinary
   * run, so existing behaviour is unchanged.
   * Spec: docs/specs/test-writer/spec-authenticated-scope.md §4.1, §12 threat 3
   */
  behindAuth?: boolean;
  /**
   * What queued this run. Only 'testwriter' changes behaviour: a proving run
   * must not teach the tenant's selector cache where an ASSERTION found its
   * anchor, because a wrong anchor cached at full confidence becomes the answer
   * every later run replays — which is how `role=button[name="File"]` became the
   * stored meaning of "the no-results message". Absent for ordinary runs.
   * Spec: docs/specs/test-writer/spec-validation-trust.md §9
   */
  triggeredBy?: 'testwriter';
};

/**
 * Test Writer job — one per analyze/suggest request.
 * Spec: docs/specs/test-writer/spec-test-writer-service.md §4
 *
 * The API creates the generation_jobs row FIRST and enqueues its id, so job
 * state/consent/scope are durable and auditable even if the queue drops the
 * message. `authConsent` must be true whenever scope is 'authenticated' —
 * enforced at the API and by a DB CHECK constraint (migration 028).
 */
export type TestWriterJobPayload = {
  jobId: string;
  tenantId: string;
  suiteId: string;
  targetUrl: string;
  scope: 'public' | 'authenticated';
  loginCaseId?: string;
  authConsent: boolean;
  options: {
    maxPages: number;         // default 30, hard cap 50
    maxScenarios: number;     // default 6, hard cap 10
    includeNegative: boolean;
    safeMode: boolean;
    validate: boolean;
    /** 'review' pauses after PLAN for human approval; 'auto' runs straight through. */
    planApproval: 'review' | 'auto';
  };
  /**
   * Set when the job is re-enqueued by the plan-approval endpoint: RECON and
   * COMPREHEND are already done and persisted, so the pipeline resumes at WRITE
   * with only the approved subset.
   */
  resumeFromPlan?: boolean;
  approvedScenarios?: string[];
};

// Queue names are env-overridable so an isolated stack (second worktree, CI)
// can run against the shared Redis without stealing jobs from the primary
// consumers. Defaults preserve production behaviour.
export const RUNS_QUEUE_NAME = process.env.KAIZEN_RUNS_QUEUE ?? 'kaizen-runs';
export const SCREENSHOTS_QUEUE_NAME = process.env.KAIZEN_SCREENSHOTS_QUEUE ?? 'kaizen-screenshots';
export const PERSIST_QUEUE_NAME = process.env.KAIZEN_PERSIST_QUEUE ?? 'kaizen-persist';
export const TESTWRITER_QUEUE_NAME = process.env.KAIZEN_TESTWRITER_QUEUE ?? 'kaizen-testwriter';

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

/**
 * Side-effect queues — worker service decomposition Phase 1.
 * Spec: docs/specs/workers/spec-service-decomposition.md §6
 *
 * Same retry posture as the run queue (transient-fault retries with backoff);
 * both consumers are idempotent (upsert by client-generated id / deterministic
 * screenshot key), so a retry after a mid-write fault is safe. Kept as options
 * objects separate from the run queue's — run jobs and side-effect jobs tune
 * independently.
 */

export function createScreenshotQueue(): Queue<ScreenshotJobData> {
  return new Queue<ScreenshotJobData>(SCREENSHOTS_QUEUE_NAME, {
    connection: createRedisConnection(),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 3000 },
      removeOnComplete: 100,
      removeOnFail: 200,
    },
  });
}

export function createPersistQueue(): Queue<PersistJobData> {
  return new Queue<PersistJobData>(PERSIST_QUEUE_NAME, {
    connection: createRedisConnection(),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 3000 },
      removeOnComplete: 100,
      removeOnFail: 200,
    },
  });
}

export function createTestWriterQueue(): Queue<TestWriterJobPayload> {
  return new Queue<TestWriterJobPayload>(TESTWRITER_QUEUE_NAME, {
    connection: createRedisConnection(),
    defaultJobOptions: {
      // attempts: 1 — a recon/generation job is expensive (crawl + LLM) work.
      // Failures are recorded on the generation_jobs row and retried only by
      // explicit user action, never blindly by the queue.
      attempts: 1,
      removeOnComplete: 100,
      removeOnFail: 200,
    },
  });
}
