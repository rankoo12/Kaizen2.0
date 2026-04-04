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
 * Phase 3 additions:
 *  - Before/after screenshot capture + S3 upload (ScreenshotService)
 *  - AX tree (DOM) snapshot before each step
 *  - HealingEngine invoked on step failure (chain-of-responsibility)
 *  - FailureClassifier classifies errors into FailureClass before healing
 */

import dotenv from 'dotenv';
dotenv.config();

import { Worker } from 'bullmq';
import { chromium, type Page } from 'playwright';
import pino from 'pino';
import { PinoObservability } from '../modules/observability/pino.observability';
import { PostgresBillingMeter } from '../modules/billing-meter/postgres.billing-meter';
import { OpenAIGateway } from '../modules/llm-gateway/openai.gateway';
import { PlaywrightDOMPruner } from '../modules/dom-pruner/playwright.dom-pruner';
import { LLMElementResolver } from '../modules/element-resolver/llm.element-resolver';
import { CachedElementResolver } from '../modules/element-resolver/cached.element-resolver';
import { CompositeElementResolver } from '../modules/element-resolver/composite.element-resolver';
import { PlaywrightExecutionEngine } from '../modules/execution-engine/playwright.execution-engine';
import { HealingEngine } from '../modules/healing-engine/healing-engine';
import { FallbackSelectorStrategy } from '../modules/healing-engine/strategies/fallback-selector.strategy';
import { AdaptiveWaitStrategy } from '../modules/healing-engine/strategies/adaptive-wait.strategy';
import { ElementSimilarityStrategy } from '../modules/healing-engine/strategies/element-similarity.strategy';
import { ResolveAndRetryStrategy } from '../modules/healing-engine/strategies/resolve-and-retry.strategy';
import { EscalationStrategy } from '../modules/healing-engine/strategies/escalation.strategy';
import { LogNotifier } from '../modules/healing-engine/notifier/log.notifier';
import { classify } from '../modules/healing-engine/failure-classifier';
import { ScreenshotService } from '../modules/media/screenshot.service';
import { getPool, closePool } from '../db/pool';
import { createRedisConnection, RUNS_QUEUE_NAME } from '../queue';
import type { RunJobPayload } from '../queue';
import type { StepAST, ClassifiedFailure } from '../types';

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
const screenshots = new ScreenshotService(obs);

const notifier = new LogNotifier(obs);
const healingEngine = new HealingEngine(
  [
    new FallbackSelectorStrategy(),
    new AdaptiveWaitStrategy(),
    new ElementSimilarityStrategy(llm, obs),
    new ResolveAndRetryStrategy(domPruner, llm, cacheRedis, obs),
    new EscalationStrategy(notifier, obs),
  ],
  obs,
);

// ─── DB Helpers ───────────────────────────────────────────────────────────────

async function markRunRunning(runId: string): Promise<void> {
  await getPool().query(
    `UPDATE runs SET status = 'running', started_at = now() WHERE id = $1`,
    [runId],
  );
}

async function markRunComplete(runId: string, status: 'passed' | 'failed' | 'healed'): Promise<void> {
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
  const context = await browser.newContext({ baseURL: baseUrl });
  const page = await context.newPage();

  let runPassed = true;
  let anyHealed = false;
  const domain = new URL(baseUrl).hostname;

  try {
    for (let i = 0; i < compiledSteps.length; i++) {
      const step = compiledSteps[i];
      const { status, healed } = await executeStep(step, page, tenantId, runId, domain, i);

      if (status === 'failed') {
        runPassed = false;
        logger.warn({ event: 'step_failed', runId, action: step.action, rawText: step.rawText });
      } else if (healed) {
        anyHealed = true;
      }
    }
  } finally {
    await context.close();
    await browser.close();
  }

  const finalStatus = runPassed ? (anyHealed ? 'healed' : 'passed') : 'failed';
  await markRunComplete(runId, finalStatus);

  obs.increment('worker.run_completed', { status: finalStatus });
  logger.info({ event: 'run_completed', runId, status: finalStatus });
  span.end();
}

async function executeStep(
  step: StepAST,
  page: Page,
  tenantId: string,
  runId: string,
  domain: string,
  stepIndex: number,
): Promise<{ status: 'passed' | 'failed'; healed: boolean }> {
  const resolutionContext = { tenantId, domain, page };

  // ── AX snapshot + before screenshot ──────────────────────────────────────
  // page.accessibility is deprecated in Playwright 1.44+ but still functional;
  // cast to any to avoid the removed type definition.
  const axBefore = await (page as any).accessibility?.snapshot().catch(() => null) ?? null;
  const beforePng = await page.screenshot({ type: 'png' }).catch(() => null);
  void screenshots.upload(beforePng!, tenantId, runId, stepIndex, 'before').catch(() => {});

  // ── Resolve selectors ─────────────────────────────────────────────────────
  const selectorSet = await resolver.resolve(step, resolutionContext);

  let stepError: Error | null = null;
  let result: Awaited<ReturnType<typeof engine.executeStep>>;

  try {
    result = await engine.executeStep(step, selectorSet, page);
  } catch (e: any) {
    result = { status: 'failed', selectorUsed: null, durationMs: 0, errorType: null, errorMessage: e.message ?? null, screenshotKey: null, domSnapshotKey: null };
    stepError = e;
  }

  // ── After screenshot ──────────────────────────────────────────────────────
  const afterPng = await page.screenshot({ type: 'png' }).catch(() => null);
  void screenshots.upload(afterPng!, tenantId, runId, stepIndex, 'after').catch(() => {});

  // ── Success path ──────────────────────────────────────────────────────────
  if (result.status === 'passed' && result.selectorUsed) {
    void resolver.recordSuccess(step.contentHash, domain, result.selectorUsed);
    return { status: 'passed', healed: false };
  }

  // ── Failure path: classify → heal ─────────────────────────────────────────
  void resolver.recordFailure(step.contentHash, domain, selectorSet.selectors[0]?.selector ?? '');

  const error = stepError ?? new Error('Step execution failed');
  const axAfter = await (page as any).accessibility?.snapshot().catch(() => null) ?? null;

  // lastGoodPng: for now use beforePng as the reference (last known good would
  // ideally be fetched from S3 for the previous successful run of this step)
  const failureClass = classify(error, axBefore, axAfter, selectorSet.selectors[0]?.selector ?? '', afterPng, beforePng);

  const classifiedFailure: ClassifiedFailure = {
    stepResult: result as any,
    failureClass,
    step,
    previousSelector: selectorSet.selectors[0]?.selector ?? '',
  };

  const healingResult = await healingEngine.heal(classifiedFailure, { tenantId, runId, page });

  if (healingResult.succeeded) {
    obs.increment('worker.step_healed', { failureClass, strategy: healingResult.strategyUsed });
    logger.info({
      event: 'step_healed',
      runId,
      stepText: step.rawText,
      strategy: healingResult.strategyUsed,
      newSelector: healingResult.newSelector,
    });
    return { status: 'passed', healed: true };
  }

  return { status: 'failed', healed: false };
}

// ─── BullMQ Worker ────────────────────────────────────────────────────────────

const worker = new Worker<RunJobPayload>(
  RUNS_QUEUE_NAME,
  async (job) => {
    logger.info({ event: 'job_received', jobId: job.id, runId: job.data.runId });
    try {
      await processRun(job.data);
    } catch (err: any) {
      logger.error({ event: 'job_error', jobId: job.id, runId: job.data.runId, error: err.message });
      await markRunComplete(job.data.runId, 'failed').catch(() => {});
      throw err;
    }
  },
  {
    connection: createRedisConnection(),
    concurrency: 1,
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
