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
import { SharedPoolService } from '../modules/shared-pool/shared-pool.service';
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
import type { StepAST, ClassifiedFailure, SelectorSet } from '../types';

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
const sharedPool = new SharedPoolService(cacheRedis, obs);
const llmResolver = new LLMElementResolver(domPruner, llm, obs, sharedPool);
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

async function markRunComplete(runId: string, status: 'passed' | 'failed' | 'healed' | 'cancelled'): Promise<void> {
  await getPool().query(
    `UPDATE runs SET status = $1, completed_at = now() WHERE id = $2`,
    [status, runId],
  );
}

// ─── Job Processor ────────────────────────────────────────────────────────────

export function cancelKey(runId: string): string {
  return `cancel:${runId}`;
}

async function isCancelled(runId: string): Promise<boolean> {
  try {
    return (await cacheRedis.get(cancelKey(runId))) !== null;
  } catch {
    return false;
  }
}

async function processRun(payload: RunJobPayload): Promise<void> {
  const { runId, tenantId, compiledSteps, baseUrl } = payload;
  const span = obs.startSpan('worker.processRun', { runId, tenantId });

  await markRunRunning(runId);
  logger.info({ event: 'run_started', runId, tenantId, stepCount: compiledSteps.length });

  // Enforcement: Docker environments absolutely require headless: true without xvfb
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ baseURL: baseUrl });
  const page = await context.newPage();

  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });

  let runPassed = true;
  let anyHealed = false;
  let cancelled = false;
  const domain = new URL(baseUrl).hostname;
  let previousAfterPng: Buffer | null = null;

  try {
    for (let i = 0; i < compiledSteps.length; i++) {
      // Check for a cancellation signal set via POST /runs/:id/cancel before
      // starting each step. The current step is allowed to finish; we never
      // interrupt mid-action to avoid leaving the browser in a broken state.
      if (await isCancelled(runId)) {
        cancelled = true;
        logger.info({ event: 'run_cancelled', runId, stepsCompleted: i });
        break;
      }

      const step = compiledSteps[i];
      const { status, healed, afterPng } = await executeStep(step, page, tenantId, runId, domain, i, previousAfterPng);
      previousAfterPng = afterPng;

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
    // Always clean up the cancellation key so it doesn't linger in Redis.
    await cacheRedis.del(cancelKey(runId)).catch(() => {});
  }

  const finalStatus = cancelled ? 'cancelled' : runPassed ? (anyHealed ? 'healed' : 'passed') : 'failed';
  await markRunComplete(runId, finalStatus);

  obs.increment('worker.run_completed', { status: finalStatus });
  logger.info({ event: 'run_completed', runId, status: finalStatus });
  span.end();
}

async function insertStepResult(
  tenantId: string,
  runId: string,
  step: StepAST,
  status: 'passed' | 'failed' | 'healed',
  selectorUsed: string | null,
  screenshotKey: string | null,
  durationMs: number,
  resolutionSource: string | null,
  similarityScore: number | null,
  domCandidates: SelectorSet['candidates'] | null,
  llmPickedKaizenId: string | null,
  tokensUsed: number,
): Promise<string | null> {
  try {
    const { rows } = await getPool().query<{ id: string }>(
      `INSERT INTO step_results
         (tenant_id, run_id, content_hash, target_hash, status, selector_used,
          screenshot_key, duration_ms, resolution_source, similarity_score, dom_candidates, llm_picked_kaizen_id, tokens_used)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING id`,
      [tenantId, runId, step.contentHash, step.targetHash, status, selectorUsed,
       screenshotKey, durationMs, resolutionSource, similarityScore,
       domCandidates ? JSON.stringify(domCandidates) : null,
       llmPickedKaizenId, tokensUsed],
    );
    return rows[0]?.id ?? null;
  } catch (e: any) {
    obs.log('warn', 'worker.step_result_insert_failed', { error: e.message });
    return null;
  }
}

async function fetchLastGoodScreenshot(
  tenantId: string,
  contentHash: string,
): Promise<Buffer | null> {
  try {
    const { rows } = await getPool().query<{ screenshot_key: string }>(
      `SELECT screenshot_key FROM step_results
       WHERE tenant_id = $1 AND content_hash = $2 AND status = 'passed'
         AND screenshot_key IS NOT NULL
       ORDER BY created_at DESC
       LIMIT 1`,
      [tenantId, contentHash],
    );
    if (rows.length === 0 || !rows[0].screenshot_key) return null;
    return screenshots.download(rows[0].screenshot_key);
  } catch {
    return null;
  }
}

async function executeStep(
  step: StepAST,
  page: Page,
  tenantId: string,
  runId: string,
  domain: string,
  stepIndex: number,
  previousAfterPng?: Buffer | null,
): Promise<{ status: 'passed' | 'failed'; healed: boolean; afterPng: Buffer | null }> {
  const resolutionContext = { tenantId, domain, page, pageUrl: page.url() };
  const stepStart = Date.now();

  // ── AX snapshot + before screenshot ──────────────────────────────────────
  // page.accessibility is deprecated in Playwright 1.44+ but still functional;
  // cast to any to avoid the removed type definition.
  const axBefore = await (page as any).accessibility?.snapshot().catch(() => null) ?? null;

  // Reuse the previous step's after-screenshot as this step's before-screenshot.
  // Only capture a fresh one for the very first step (no previous).
  const beforePng = previousAfterPng ?? await page.screenshot({ type: 'png' }).catch(() => null);
  if (!previousAfterPng) {
    void screenshots.upload(beforePng!, tenantId, runId, stepIndex, 'before')
      .catch((e) => obs.log('warn', 'worker.screenshot_upload_failed', { phase: 'before', error: e.message }));
  }

  // ── Resolve selectors ─────────────────────────────────────────────────────
  // navigate and press_key act on the page/keyboard, not a specific DOM element.
  const needsElement = step.action !== 'navigate' && step.action !== 'press_key' && step.action !== 'wait';
  const selectorSet: SelectorSet = needsElement
    ? await resolver.resolve(step, resolutionContext)
    : { selectors: [], fromCache: false, cacheSource: null, resolutionSource: null, similarityScore: null };

  let stepError: Error | null = null;
  let result: Awaited<ReturnType<typeof engine.executeStep>>;

  try {
    result = await engine.executeStep(step, selectorSet, page);
  } catch (e: any) {
    result = { status: 'failed', selectorUsed: null, durationMs: 0, errorType: null, errorMessage: e.message ?? null, screenshotKey: null, domSnapshotKey: null };
    stepError = e;
  }

  // ── After screenshot (upload and get key) ─────────────────────────────────
  const afterPng = await page.screenshot({ type: 'png' }).catch(() => null);
  const afterKey = await screenshots.upload(afterPng!, tenantId, runId, stepIndex, 'after');

  // ── Success path ──────────────────────────────────────────────────────────
  // navigate and press_key pass with selectorUsed: null — check status only
  if (result.status === 'passed') {
    if (result.selectorUsed) {
      void resolver.recordSuccess(step.targetHash, domain, result.selectorUsed);
    }
    void insertStepResult(tenantId, runId, step, 'passed', result.selectorUsed, afterKey, Date.now() - stepStart, selectorSet.resolutionSource, selectorSet.similarityScore, selectorSet.candidates ?? null, selectorSet.llmPickedKaizenId ?? null, selectorSet.tokensUsed ?? 0);
    return { status: 'passed', healed: false, afterPng };
  }

  // ── Failure path: classify → heal ─────────────────────────────────────────
  void resolver.recordFailure(step.targetHash, domain, selectorSet.selectors[0]?.selector ?? '');

  const error = stepError ?? new Error('Step execution failed');
  const axAfter = await (page as any).accessibility?.snapshot().catch(() => null) ?? null;

  // Signal C: fetch the real last-known-good "after" screenshot from GCS/disk
  const lastGoodPng = await fetchLastGoodScreenshot(tenantId, step.contentHash);
  const failureClass = classify(error, axBefore, axAfter, selectorSet.selectors[0]?.selector ?? '', afterPng, lastGoodPng);

  // Insert failed step_result now so healing_events can reference it
  const stepResultId = await insertStepResult(
    tenantId, runId, step, 'failed',
    selectorSet.selectors[0]?.selector ?? null, afterKey, Date.now() - stepStart,
    selectorSet.resolutionSource, selectorSet.similarityScore, selectorSet.candidates ?? null,
    selectorSet.llmPickedKaizenId ?? null, selectorSet.tokensUsed ?? 0,
  );

  const classifiedFailure: ClassifiedFailure = {
    stepResult: result as any,
    stepResultId: stepResultId ?? undefined,
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
    // Update the step_result status to healed
    if (stepResultId) {
      void getPool().query(
        `UPDATE step_results SET status = 'healed', selector_used = $1 WHERE id = $2`,
        [healingResult.newSelector, stepResultId],
      ).catch(() => { });
    }
    return { status: 'passed', healed: true, afterPng };
  }

  return { status: 'failed', healed: false, afterPng };
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
      await markRunComplete(job.data.runId, 'failed').catch(() => { });
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
