/**
 * Kaizen worker process.
 *
 * Consumes run jobs from the BullMQ queue, executes each step against a live
 * Playwright browser, and writes the final run status back to Postgres.
 *
 * Phase 2 additions:
 *  - CompositeElementResolver replaces direct LLMElementResolver
 *  - CachedElementResolver provides L1 Redis + L2 alias + L3/L4 pgvector lookup
 *  - OpenAIGateway receives Redis instance for prompt dedup cache
 *
 * Remaining Phase 1 simplifications:
 *  - No step_results rows (requires full test hierarchy)
 *  - No tenant concurrency control (Redis INCR/DECR gate from spec §15)
 *  - One browser per worker process; one context per job (spec-correct isolation)
 */

import dotenv from 'dotenv';
dotenv.config();

import { Worker } from 'bullmq';
import { chromium } from 'playwright';
import pino from 'pino';
import { PinoObservability } from '../modules/observability/pino.observability';
import { PostgresBillingMeter } from '../modules/billing-meter/postgres.billing-meter';
import { OpenAIGateway } from '../modules/llm-gateway/openai.gateway';
import { PlaywrightDOMPruner } from '../modules/dom-pruner/playwright.dom-pruner';
import { LLMElementResolver } from '../modules/element-resolver/llm.element-resolver';
import { CachedElementResolver } from '../modules/element-resolver/cached.element-resolver';
import { CompositeElementResolver } from '../modules/element-resolver/composite.element-resolver';
import { PlaywrightExecutionEngine } from '../modules/execution-engine/playwright.execution-engine';
import { getPool, closePool } from '../db/pool';
import { createRedisConnection, RUNS_QUEUE_NAME } from '../queue';
import type { RunJobPayload } from '../queue';
import type { StepAST } from '../types';

// ─── Module Setup ─────────────────────────────────────────────────────────────

const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  ...(process.env.NODE_ENV === 'development' && {
    transport: { target: 'pino-pretty' },
  }),
});

const obs = new PinoObservability(logger);
const billing = new PostgresBillingMeter(obs);
const cacheRedis = createRedisConnection();
const llm = new OpenAIGateway(billing, obs, undefined, cacheRedis);
const domPruner = new PlaywrightDOMPruner();
const llmResolver = new LLMElementResolver(domPruner, llm, obs);
const cachedResolver = new CachedElementResolver(cacheRedis, llm, obs);
const resolver = new CompositeElementResolver(cachedResolver, llmResolver, obs);
const engine = new PlaywrightExecutionEngine(obs);

// ─── DB Helpers ───────────────────────────────────────────────────────────────

async function markRunRunning(runId: string): Promise<void> {
  await getPool().query(
    `UPDATE runs SET status = 'running', started_at = now() WHERE id = $1`,
    [runId],
  );
}

async function markRunComplete(runId: string, status: 'passed' | 'failed'): Promise<void> {
  await getPool().query(
    `UPDATE runs SET status = $1, completed_at = now() WHERE id = $2`,
    [status, runId],
  );
}

// ─── Job Processor ────────────────────────────────────────────────────────────

async function processRun(payload: RunJobPayload): Promise<void> {
  const { runId, tenantId, compiledSteps, baseUrl } = payload;
  const span = obs.startSpan('worker.processRun', { runId, tenantId });

  await markRunRunning(runId);
  logger.info({ event: 'run_started', runId, tenantId, stepCount: compiledSteps.length });

  const browser = await chromium.launch({ headless: true });
  // One isolated BrowserContext per run — clean cookies, no cached state
  const context = await browser.newContext({ baseURL: baseUrl });
  const page = await context.newPage();

  let runPassed = true;
  const domain = new URL(baseUrl).hostname;

  try {
    for (const step of compiledSteps) {
      const stepResult = await executeStep(step, page, tenantId, domain);

      if (stepResult === 'failed') {
        runPassed = false;
        // Phase 1: log and continue. Phase 3 will invoke HealingEngine here.
        logger.warn({ event: 'step_failed', runId, action: step.action, rawText: step.rawText });
      }
    }
  } finally {
    // Always clean up the browser context — even if a step throws unexpectedly
    await context.close();
    await browser.close();
  }

  const finalStatus = runPassed ? 'passed' : 'failed';
  await markRunComplete(runId, finalStatus);

  obs.increment('worker.run_completed', { status: finalStatus });
  logger.info({ event: 'run_completed', runId, status: finalStatus });
  span.end();
}

async function executeStep(
  step: StepAST,
  page: unknown,
  tenantId: string,
  domain: string,
): Promise<'passed' | 'failed'> {
  const context = { tenantId, domain, page };

  // Resolve selectors (LLM call on miss; early exit for navigate/press_key)
  const selectorSet = await resolver.resolve(step, context);

  // Execute against live browser
  const result = await engine.executeStep(step, selectorSet, page);

  // Feed outcome back to the resolver for future confidence scoring
  if (result.status === 'passed' && result.selectorUsed) {
    void resolver.recordSuccess(step.contentHash, domain, result.selectorUsed);
  } else if (result.status === 'failed') {
    const firstSelector = selectorSet.selectors[0]?.selector ?? '';
    void resolver.recordFailure(step.contentHash, domain, firstSelector);
  }

  return result.status;
}

// ─── BullMQ Worker ────────────────────────────────────────────────────────────

const worker = new Worker<RunJobPayload>(
  RUNS_QUEUE_NAME,
  async (job) => {
    logger.info({ event: 'job_received', jobId: job.id, runId: job.data.runId });
    try {
      await processRun(job.data);
    } catch (err: any) {
      // Unexpected error (e.g. Playwright launch failure, DB down)
      // Mark the run as failed so GET /runs/:id doesn't hang in 'queued'
      logger.error({ event: 'job_error', jobId: job.id, runId: job.data.runId, error: err.message });
      await markRunComplete(job.data.runId, 'failed').catch(() => {});
      throw err; // re-throw so BullMQ records the job as failed
    }
  },
  {
    connection: createRedisConnection(),
    concurrency: 1, // Phase 1: one run at a time per worker process
  },
);

worker.on('completed', (job) => {
  logger.info({ event: 'job_completed', jobId: job.id });
});

worker.on('failed', (job, err) => {
  logger.error({ event: 'job_failed', jobId: job?.id, error: err.message });
});

// ─── Graceful Shutdown ────────────────────────────────────────────────────────

const shutdown = async (signal: string): Promise<void> => {
  logger.info({ event: 'shutdown', signal });
  await worker.close();
  await closePool();
  process.exit(0);
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

logger.info({ event: 'worker_started', queue: RUNS_QUEUE_NAME });
