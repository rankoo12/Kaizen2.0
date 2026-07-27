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

import { materializeGcsKeyFromEnv } from '../bootstrap/gcs-key-from-env';
materializeGcsKeyFromEnv();

import { randomUUID } from 'node:crypto';
import { Worker } from 'bullmq';
import { type Page } from 'playwright';
import { BrowserPool } from './browser-pool';
import { cancelKey } from './cancel-keys';
import { runStepLoop } from './step-loop';
import pino from 'pino';
import { PinoObservability } from '../modules/observability/pino.observability';
import { PostgresBillingMeter } from '../modules/billing-meter/postgres.billing-meter';
import { OpenAIGateway } from '../modules/llm-gateway/openai.gateway';
import { PlaywrightDOMPruner } from '../modules/dom-pruner/playwright.dom-pruner';
import { LLMElementResolver } from '../modules/element-resolver/llm.element-resolver';
import { SharedPoolService } from '../modules/shared-pool/shared-pool.service';
import { CachedElementResolver } from '../modules/element-resolver/cached.element-resolver';
import { CompositeElementResolver } from '../modules/element-resolver/composite.element-resolver';
import type { IElementResolver } from '../modules/element-resolver/interfaces';
import { DBArchetypeResolver } from '../modules/element-resolver/db.archetype-resolver';
import { ArchetypeElementResolver } from '../modules/element-resolver/archetype.element-resolver';
import { pickRandomCandidate, resolveCardTitle, seededIndex } from '../modules/element-resolver/random-element.selector';
import { findRepeatedTargets } from '../modules/element-resolver/random-target';
import { resolveCountSelector } from '../modules/element-resolver/countable';
import { interpolateStep } from './run-context';
import { RunLogger } from './run-logger';
import { PlaywrightExecutionEngine } from '../modules/execution-engine/playwright.execution-engine';
import { PageChallengeDetector } from '../modules/execution-engine/challenge-detector';
import { HealingEngine } from '../modules/healing-engine/healing-engine';
import { FallbackSelectorStrategy } from '../modules/healing-engine/strategies/fallback-selector.strategy';
import { AdaptiveWaitStrategy } from '../modules/healing-engine/strategies/adaptive-wait.strategy';
import { ElementSimilarityStrategy } from '../modules/healing-engine/strategies/element-similarity.strategy';
import { ResolveAndRetryStrategy } from '../modules/healing-engine/strategies/resolve-and-retry.strategy';
import { EscalationStrategy } from '../modules/healing-engine/strategies/escalation.strategy';
import { LogNotifier } from '../modules/healing-engine/notifier/log.notifier';
import { classify } from '../modules/healing-engine/failure-classifier';
import { ScreenshotService } from '../modules/media/screenshot.service';
import { BullMQEventBus } from '../modules/event-bus/bullmq.event-bus';
import type { IEventBus, StepResultRow, StepResultStatus } from '../modules/event-bus/interfaces';
import { markRunAttempt } from '../modules/event-bus/attempt-fence';
import { startScreenshotConsumer } from './consumers/screenshot.consumer';
import { startPersistenceConsumer } from './consumers/persistence.consumer';
import { getPool, closePool } from '../db/pool';
import { createRedisConnection, RUNS_QUEUE_NAME, SCREENSHOTS_QUEUE_NAME, PERSIST_QUEUE_NAME } from '../queue';
import type { RunJobPayload } from '../queue';
import type { StepAST, ClassifiedFailure, SelectorSet, SelectorEntry, RunContext } from '../types';

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
// Without an 'error' listener, a transient Redis fault (ECONNRESET, failover)
// is an unhandled EventEmitter 'error' that crashes the whole worker process.
// ioredis auto-reconnects; log and let it recover.
cacheRedis.on('error', (err) => obs.log('warn', 'redis.cache_connection_error', { error: err.message }));
const llm = new OpenAIGateway(billing, obs, undefined, cacheRedis);
const domPruner = new PlaywrightDOMPruner();
const sharedPool = new SharedPoolService(cacheRedis, obs);
const llmResolver = new LLMElementResolver(domPruner, llm, obs, sharedPool, cacheRedis);
const cachedResolver = new CachedElementResolver(cacheRedis, llm, obs);
const archetypeResolver = new DBArchetypeResolver(obs);
const archetypeElementResolver = new ArchetypeElementResolver(domPruner, archetypeResolver, obs);

// DISABLE_LLM=1 removes the LLM resolver from the chain entirely.
// Use this during archetype/cache testing to confirm zero-token resolution.
const resolvers: IElementResolver[] = [archetypeElementResolver, cachedResolver];
if (process.env.DISABLE_LLM !== '1') {
  resolvers.push(llmResolver);
}
if (process.env.DISABLE_LLM === '1') {
  logger.warn({ event: 'llm_disabled' }, 'LLM resolver disabled via DISABLE_LLM=1 — steps that miss archetype/cache will return no selector');
}

const resolver = new CompositeElementResolver(resolvers, obs, llm);

// No-cache resolver for assertion steps: skips the CachedElementResolver so a
// "verify ..." step always re-resolves against the live page and can never read
// a stale selector that embedded run-specific data (e.g. a header link named
// "<a previous run's email>"). Assertions also never write to the cache.
const assertionResolvers: IElementResolver[] = [archetypeElementResolver];
if (process.env.DISABLE_LLM !== '1') {
  assertionResolvers.push(llmResolver);
}
const assertionResolver = new CompositeElementResolver(assertionResolvers, obs, llm);

const engine = new PlaywrightExecutionEngine(obs);
const challengeDetector = new PageChallengeDetector();
const screenshots = new ScreenshotService(obs);
// Phase 3: one shared Chromium, N isolated contexts — the pool relaunches
// after a crash. Spec: spec-service-decomposition.md §7
const browserPool = new BrowserPool();

// Event bus + co-located consumers (Phase 1 modular monolith): the step loop
// publishes side-effects; these BullMQ Workers drain them off the per-step
// critical path. Phase 2 runs the same start functions behind their own
// entrypoints (src/services/{screenshot,persistence}) — set
// DISABLE_INPROCESS_CONSUMERS=1 there so this process stays a pure producer
// and jobs aren't split between two consumers.
// Spec: docs/specs/workers/spec-service-decomposition.md §3, §8
const bus: IEventBus = new BullMQEventBus(cacheRedis, obs);
const inprocessConsumers = process.env.DISABLE_INPROCESS_CONSUMERS !== '1';
const screenshotConsumer = inprocessConsumers ? startScreenshotConsumer({ redis: cacheRedis, screenshots, obs }) : null;
const persistenceConsumer = inprocessConsumers ? startPersistenceConsumer({ redis: cacheRedis, obs }) : null;
if (!inprocessConsumers) {
  logger.info({ event: 'inprocess_consumers_disabled', note: 'expecting dedicated screenshot/persistence services' });
}

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

async function isCancelled(runId: string): Promise<boolean> {
  try {
    return (await cacheRedis.get(cancelKey(runId))) !== null;
  } catch {
    return false;
  }
}

async function processRun(payload: RunJobPayload, attempt: number): Promise<void> {
  const { runId, tenantId, compiledSteps, baseUrl } = payload;
  // stepIds[i] back-references compiledSteps[i] to its test_steps row id.
  // Optional in the payload for backwards-compat with pre-spec queue jobs;
  // when absent, the worker still runs but writes NULL step_ids — matching
  // legacy behaviour. Spec: docs/specs/workers/spec-live-run-updates.md §5.1.
  const stepIds: (string | null)[] = payload.stepIds ?? [];
  const span = obs.startSpan('worker.processRun', { runId, tenantId });

  await markRunRunning(runId);

  // Fence consumers BEFORE the clears below: envelopes published by a
  // superseded attempt that are still in flight would otherwise land after the
  // clear and re-insert stale rows. Spec: spec-service-decomposition.md §4.4
  await markRunAttempt(cacheRedis, runId, attempt);

  // Idempotency: a BullMQ retry (after a transient infra fault) re-runs this job
  // from the top. Clear any rows a prior attempt persisted so results and the run
  // log aren't duplicated. FK-safe order: healing_events → step_results → run_events.
  // No-op on a first attempt (nothing persisted yet).
  await getPool().query(
    `DELETE FROM healing_events WHERE step_result_id IN (SELECT id FROM step_results WHERE run_id = $1)`,
    [runId],
  ).catch(() => {});
  await getPool().query(`DELETE FROM step_results WHERE run_id = $1`, [runId]).catch(() => {});
  await getPool().query(`DELETE FROM run_events   WHERE run_id = $1`, [runId]).catch(() => {});

  logger.info({ event: 'run_started', runId, tenantId, stepCount: compiledSteps.length });

  // Persisted chronological run log → powers the full-run report. Flushes are
  // published to the persist queue (async), not written inline.
  // Spec: docs/specs/tests-ux/spec-run-report-view.md
  const runLog = new RunLogger(tenantId, runId, obs, (rows) =>
    bus.publish({ kind: 'persist.run_events', tenantId, runId, rows, attempt }),
  );
  runLog.log('run', `Run started · ${compiledSteps.length} step(s) · ${baseUrl}`, { data: { baseUrl, stepCount: compiledSteps.length } });

  // One shared browser, one isolated context per run (Phase 3): contexts are
  // cheap and fully sandboxed (cookies/storage/pages) while browser launches
  // cost seconds — the pool owns launch/relaunch and recycles the browser at
  // idle after BROWSER_MAX_RUNS runs (memory hygiene). This run closes ONLY
  // its context; the browser outlives it for concurrent + subsequent runs.
  const browser = await browserPool.acquire();
  const context = await browser.newContext({ baseURL: baseUrl });

  // __name shim: tsx/esbuild (keepNames) wraps named inner declarations inside
  // functions passed to page.$eval/page.evaluate with __name(...) calls. That
  // helper does not exist in the browser, so those serialized functions throw
  // ReferenceError — silently, wherever the caller .catch()es to null (e.g. the
  // assert_text page scan, which then reports "text not found" for text that IS
  // present). Defining __name as identity in every page makes them run. No-op in
  // production, where tsc compiles the worker and emits no __name wrappers.
  await context.addInitScript(() => {
    const g = globalThis as unknown as { __name?: (fn: unknown) => unknown };
    g.__name = g.__name || ((fn) => fn);
  });

  const page = await context.newPage();

  // Auto-accept native JS dialogs (alert/confirm/prompt). Without a handler,
  // Playwright DISMISSES dialogs — so a "click OK" flow gets Cancel and a click
  // that pops a confirm can stall. Accepting matches the common QA intent; the
  // message is logged for the run timeline. (A future action can opt into dismiss.)
  page.on('dialog', (dialog) => {
    obs.log('info', 'worker.dialog_accepted', { runId, type: dialog.type(), message: dialog.message() });
    void dialog.accept().catch(() => { /* already handled/closed */ });
  });

  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });

  const domain = new URL(baseUrl).hostname;

  let loopResult;
  try {
    loopResult = await runStepLoop(runId, compiledSteps, {
      isCancelled,
      executeStep: (step, stepIndex, previousAfterPng, runContext) =>
        executeStep(step, page, tenantId, runId, domain, stepIndex, previousAfterPng, stepIds[stepIndex] ?? null, runContext, runLog, attempt),
      recordSkippedSteps: (steps, startIndex, reason) =>
        recordSkippedSteps(tenantId, runId, steps, startIndex, reason, stepIds, attempt),
      onStepFailed: (stepIndex, step) => {
        logger.warn({ event: 'step_failed', runId, action: step.action, rawText: step.rawText });
        // Stop-on-fail observability — fired every time the loop bails on
        // an unrecovered failure. Spec: docs/specs/workers/spec-worker-stop-on-step-failure.md
        obs.increment('worker.stopped_on_failure', { stepIndex: String(stepIndex) });
        logger.warn({
          event: 'run_stopped_on_failure',
          runId,
          stepIndex,
          stepsSkipped: compiledSteps.length - (stepIndex + 1),
        });
      },
      onCancelled: (stepsCompleted) => {
        logger.info({ event: 'run_cancelled', runId, stepsCompleted });
      },
    }, payload.seedVariables);
  } finally {
    // Close only this run's context — the pooled browser stays up for other
    // runs; release() lets the pool recycle it once idle and past budget.
    await context.close();
    await browserPool.release();
    // Always clean up the cancellation key so it doesn't linger in Redis.
    await cacheRedis.del(cancelKey(runId)).catch(() => {});
  }

  const { runPassed, anyHealed, cancelled } = loopResult;
  const finalStatus = cancelled ? 'cancelled' : runPassed ? (anyHealed ? 'healed' : 'passed') : 'failed';
  await markRunComplete(runId, finalStatus);

  runLog.log('run', `Run ${finalStatus}`, { level: finalStatus === 'failed' ? 'error' : 'info', data: { status: finalStatus } });
  await runLog.flush();

  obs.increment('worker.run_completed', { status: finalStatus });
  logger.info({ event: 'run_completed', runId, status: finalStatus });
  span.end();
}

/**
 * SYNCHRONOUS step_result insert — failure path only. The healing engine
 * FK-references the row from healing_events and the healed-update targets it
 * by id, so the row must exist in the DB before healing starts. Hot-path rows
 * (passed/skipped) go async via publishStepResult below.
 * Spec: docs/specs/workers/spec-service-decomposition.md §4 (P1 scope).
 */
async function insertStepResult(
  tenantId: string,
  runId: string,
  step: StepAST,
  stepIndex: number,
  status: 'passed' | 'failed' | 'healed' | 'skipped',
  selectorUsed: string | null,
  screenshotKey: string | null,
  durationMs: number,
  resolutionSource: string | null,
  similarityScore: number | null,
  domCandidates: SelectorSet['candidates'] | null,
  llmPickedKaizenId: string | null,
  tokensUsed: number,
  archetypeName: string | null = null,
  errorType: string | null = null,
  stepId: string | null = null,
  capturedName: string | null = null,
  capturedValue: string | null = null,
): Promise<string | null> {
  try {
    // step_id back-references the test_steps row this result came from. Lets
    // the runs API LEFT JOIN test_steps and surface the original step text in
    // the timeline. Nullable for backwards-compat with pre-spec queue jobs.
    // Spec: docs/specs/workers/spec-live-run-updates.md §5.1.3
    // captured_name/value record a run-scoped variable captured by this step.
    // Spec: docs/specs/workers/spec-engine-capabilities-assert-random-capture.md §3.5
    const { rows } = await getPool().query<{ id: string }>(
      `INSERT INTO step_results
         (tenant_id, run_id, step_id, step_index, content_hash, target_hash, status, selector_used,
          screenshot_key, duration_ms, resolution_source, similarity_score,
          dom_candidates, llm_picked_kaizen_id, tokens_used, archetype_name, error_type,
          captured_name, captured_value)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
       RETURNING id`,
      [tenantId, runId, stepId, stepIndex, step.contentHash, step.targetHash, status, selectorUsed,
       screenshotKey, durationMs, resolutionSource, similarityScore,
       domCandidates ? JSON.stringify(domCandidates) : null,
       llmPickedKaizenId, tokensUsed, archetypeName, errorType,
       capturedName, capturedValue],
    );
    return rows[0]?.id ?? null;
  } catch (e: any) {
    obs.log('warn', 'worker.step_result_insert_failed', { error: e.message });
    return null;
  }
}

/**
 * ASYNC step_result persistence — the hot path (passed/skipped rows, which
 * nothing FK-references synchronously). Mints the row id client-side
 * (spec §4.2) and publishes; the persistence consumer upserts on that id, so
 * redelivery is idempotent. Fire-and-forget: publish never throws.
 */
function publishStepResult(
  row: Omit<StepResultRow, 'id' | 'status'> & { status: Extract<StepResultStatus, 'passed' | 'skipped'> },
  attempt: number,
): void {
  void bus.publish({
    kind: 'persist.step_result',
    row: { ...row, id: randomUUID() },
    attempt,
  });
}

/**
 * Writes a lean `skipped` row for every step at index >= startIndex. Called
 * after stop-on-fail so the run timeline still enumerates every step from the
 * compiled AST; absent rows would make skipped steps vanish from the UI.
 * Spec: docs/specs/workers/spec-worker-stop-on-step-failure.md
 */
async function recordSkippedSteps(
  tenantId: string,
  runId: string,
  compiledSteps: StepAST[],
  startIndex: number,
  reason: 'prior_step_failed',
  stepIds: (string | null)[] = [],
  attempt: number = 0,
): Promise<void> {
  for (let i = startIndex; i < compiledSteps.length; i++) {
    publishStepResult({
      tenantId,
      runId,
      stepId: stepIds[i] ?? null,  // back-reference to test_steps for timeline display
      stepIndex: i,
      contentHash: compiledSteps[i].contentHash,
      targetHash: compiledSteps[i].targetHash,
      status: 'skipped',
      selectorUsed: null,
      screenshotKey: null,
      durationMs: 0,
      resolutionSource: null,
      similarityScore: null,
      domCandidates: null,
      llmPickedKaizenId: null,
      tokensUsed: 0,
      archetypeName: null,
      errorType: reason,  // carries the skip reason
      capturedName: null,
      capturedValue: null,
    }, attempt);
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
  rawStep: StepAST,
  page: Page,
  tenantId: string,
  runId: string,
  domain: string,
  stepIndex: number,
  previousAfterPng?: Buffer | null,
  stepId: string | null = null,
  runContext: RunContext = { variables: {} },
  runLog?: RunLogger,
  attempt: number = 0,
): Promise<{ status: 'passed' | 'failed'; healed: boolean; afterPng: Buffer | null }> {
  // Resolve {{variable}} tokens captured by earlier steps before doing anything
  // else, so resolution, execution, and persistence all see the concrete values.
  // Spec: docs/specs/workers/spec-engine-capabilities-assert-random-capture.md §3.4
  const step = interpolateStep(rawStep, runContext);
  runLog?.log('resolve', `step ${String(stepIndex + 1).padStart(2, '0')} · ${step.action} · "${step.rawText}"`, {
    stepIndex,
    data: { action: step.action, target: step.targetDescription, value: step.value },
  });
  const resolutionContext = { tenantId, domain, page, pageUrl: page.url() };
  const stepStart = Date.now();
  // Accessible name of the element chosen by a click_random step — captured into
  // the run context for later {{variable}} reference (Gap C wires the store).
  let randomPickName: string | null = null;

  // ── AX snapshot + before screenshot ──────────────────────────────────────
  // page.accessibility is deprecated in Playwright 1.44+ but still functional;
  // cast to any to avoid the removed type definition.
  const axBefore = await (page as any).accessibility?.snapshot().catch(() => null) ?? null;

  // Reuse the previous step's after-screenshot as this step's before-screenshot.
  // Only capture a fresh one for the very first step (no previous).
  const beforePng = previousAfterPng ?? await page.screenshot({ type: 'png' }).catch(() => null);
  if (!previousAfterPng && beforePng) {
    void bus.publish({ kind: 'screenshot.upload', tenantId, runId, stepIndex, timing: 'before', png: beforePng, attempt });
  }

  // ── Challenge detection ───────────────────────────────────────────────────
  // Check before element resolution so we never waste an LLM call on a page
  // that is blocked by an anti-bot challenge. The healing engine is not invoked
  // because challenges cannot be resolved by selector strategies.
  const challenge = await challengeDetector.detect(page);
  if (challenge) {
    obs.log('warn', 'worker.challenge_detected', { runId, stepIndex, type: challenge.type, url: page.url() });
    obs.increment('worker.challenge_detected', { type: challenge.type });
    const afterPng = await page.screenshot({ type: 'png' }).catch(() => null);
    const afterKey = afterPng ? screenshots.keyFor(tenantId, runId, stepIndex, 'after') : null;
    if (afterPng) {
      void bus.publish({ kind: 'screenshot.upload', tenantId, runId, stepIndex, timing: 'after', png: afterPng, attempt });
    }
    void insertStepResult(
      tenantId, runId, step, stepIndex, 'failed', null, afterKey,
      Date.now() - stepStart, null, null, null, null, 0,
      null,
      challenge.type,
      stepId,
    );
    runLog?.log('execute', `step ${String(stepIndex + 1).padStart(2, '0')} blocked by ${challenge.type} challenge`, { stepIndex, level: 'error', data: { challenge: challenge.type } });
    await runLog?.flush();
    return { status: 'failed', healed: false, afterPng };
  }

  // ── Resolve selectors ─────────────────────────────────────────────────────
  // navigate and press_key act on the page/keyboard, not a specific DOM element.
  let selectorSet: SelectorSet;
  if (step.action === 'click_random') {
    // click_random does NOT go through the single-element resolver chain. It
    // queries the live page directly for the repeated control the target names
    // (e.g. add-to-cart buttons), picks ONE by a seeded index (runId+stepIndex →
    // replayable), and reads that element's product-card title so a later step
    // can assert the cart against it.
    // Spec: docs/specs/workers/spec-engine-capabilities-assert-random-capture.md §2
    const target = step.targetDescription ?? '';
    const matches = await findRepeatedTargets(page, target);
    if (matches.length > 0) {
      const idx = seededIndex(`${runId}:${stepIndex}`, matches.length);
      const chosen = matches[idx];
      randomPickName = chosen.title;
      obs.increment('worker.click_random_picked', { poolSize: String(matches.length), source: 'direct' });
      selectorSet = {
        selectors: [{ selector: chosen.selector, strategy: 'css' as const, confidence: 0.9 }],
        fromCache: false,
        cacheSource: null,
        resolutionSource: null,
        similarityScore: null,
        candidates: [{ kaizenId: '', role: 'button', name: chosen.title ?? target, selector: chosen.selector }],
      };
    } else {
      // Fallback: nothing matched the direct selectors — prune + score + pick.
      const candidates = await domPruner.prune(page, target);
      const pick = pickRandomCandidate(candidates, `${runId}:${stepIndex}`, target);
      if (pick) {
        const entries = pick.candidate.selectorCandidates?.length
          ? pick.candidate.selectorCandidates
          : [{ selector: pick.candidate.cssSelector, strategy: 'css' as const, confidence: 0.5 }];
        const cardTitle = await resolveCardTitle(page, pick.candidate.cssSelector);
        randomPickName = cardTitle || pick.candidate.name || pick.candidate.textContent || null;
        obs.increment('worker.click_random_picked', { poolSize: String(pick.poolSize), source: 'pruned' });
        selectorSet = {
          selectors: entries,
          fromCache: false,
          cacheSource: null,
          resolutionSource: null,
          similarityScore: null,
          candidates: [{
            kaizenId: pick.candidate.kaizenId ?? '',
            role: pick.candidate.role,
            name: pick.candidate.name,
            selector: pick.candidate.cssSelector,
          }],
        };
      } else {
        selectorSet = { selectors: [], fromCache: false, cacheSource: null, resolutionSource: null, similarityScore: null };
      }
    }
  } else if (step.action === 'assert_text' || step.action === 'assert_not_text') {
    // Whole-page content assertions ("verify X appears" / "verify X is gone") do
    // NOT need the element resolver — the DOM pruner frequently never surfaces the
    // relevant node. The engine scans the whole page body directly.
    selectorSet = {
      selectors: [{ selector: 'body', strategy: 'css', confidence: 1 }],
      fromCache: false, cacheSource: null, resolutionSource: null, similarityScore: null,
    };
  } else if (step.action === 'assert_count') {
    // assert_count counts a REPEATED GROUP, not a single element — the single-element
    // resolver would return one #id and always count 1. Resolve a group selector
    // directly off the live page (a grounded repeated-sibling group, else a semantic
    // role sweep). Returns empty selectors when nothing is confidently countable, so
    // the engine fails LOUDLY rather than silently passing a wrong count.
    const target = step.targetDescription ?? '';
    const found = await resolveCountSelector(page, target).catch(() => null);
    selectorSet = found
      ? {
          selectors: [{ selector: found.selector, strategy: 'css' as const, confidence: 0.9 }],
          fromCache: false, cacheSource: null, resolutionSource: null, similarityScore: null,
        }
      : { selectors: [], fromCache: false, cacheSource: null, resolutionSource: null, similarityScore: null };
  } else if (step.action === 'drag_and_drop') {
    // Two-target step: SOURCE = targetDescription, DESTINATION = value.
    // Resolve the source through the normal (cached) resolver so it warms like any
    // interaction. Resolve the destination through the NO-CACHE resolver: it shares
    // this step's targetHash, so writing it to selector_cache under that key would
    // collide with the source's cached selector — assertionResolver reads/writes
    // nothing, avoiding the collision. Both selectors ride to the engine together.
    try {
      const sourceSet = await resolver.resolve(step, resolutionContext);
      let destinationSelectors: SelectorEntry[] = [];
      if (step.value) {
        const destStep: StepAST = { ...step, action: 'click', targetDescription: step.value, value: null };
        const destSet = await assertionResolver.resolve(destStep, resolutionContext);
        destinationSelectors = destSet.selectors;
      }
      selectorSet = { ...sourceSet, destinationSelectors };
    } catch (e: any) {
      obs.log('warn', 'worker.resolution_failed', { runId, action: step.action, error: e.message });
      selectorSet = { selectors: [], fromCache: false, cacheSource: null, resolutionSource: null, similarityScore: null };
    }
  } else {
    // Actions that operate on the page / keyboard / URL / title need no element.
    const NO_ELEMENT_ACTIONS = new Set(['navigate', 'press_key', 'wait', 'go_back', 'go_forward', 'reload', 'assert_url', 'assert_title']);
    // State / negative assertions verify CURRENT page state — they must never read
    // a cached selector (it can embed run-specific data, e.g. a header link named
    // with a previous run's email). Use the no-cache resolver.
    const NO_CACHE_ASSERTIONS = new Set(['assert_visible', 'assert_not_visible', 'assert_enabled', 'assert_disabled', 'assert_checked', 'assert_attribute']);
    const needsElement = !NO_ELEMENT_ACTIONS.has(step.action);
    const useNoCache = NO_CACHE_ASSERTIONS.has(step.action);
    try {
      selectorSet = needsElement
        ? await (useNoCache ? assertionResolver : resolver).resolve(step, resolutionContext)
        : { selectors: [], fromCache: false, cacheSource: null, resolutionSource: null, similarityScore: null };
    } catch (e: any) {
      // A resolution error (e.g. an LLM 401/timeout in the embedding path) must
      // degrade to a STEP failure, not escape the step loop as a job error — a
      // thrown error here would fail+retry the WHOLE run 3× and lose the timeline.
      // Empty selectors → the step fails cleanly, healing runs, stop-on-fail records
      // the rest as skipped, and the run completes as 'failed'.
      obs.log('warn', 'worker.resolution_failed', { runId, action: step.action, error: e.message });
      selectorSet = { selectors: [], fromCache: false, cacheSource: null, resolutionSource: null, similarityScore: null };
    }
  }

  // Assertions must never be persisted to the selector cache — re-verify every run.
  const ASSERTION_ACTIONS = new Set([
    'assert_text', 'assert_not_text', 'assert_visible', 'assert_not_visible',
    'assert_url', 'assert_title', 'assert_enabled', 'assert_disabled', 'assert_checked',
    'assert_count', 'assert_attribute',
  ]);
  const isAssertion = ASSERTION_ACTIONS.has(step.action);

  if (selectorSet.resolutionSource) {
    runLog?.log('resolve', `resolved via ${selectorSet.resolutionSource}${selectorSet.tokensUsed ? ` · ${selectorSet.tokensUsed} tok` : ''}`, {
      stepIndex,
      data: { source: selectorSet.resolutionSource, tokens: selectorSet.tokensUsed ?? 0, similarity: selectorSet.similarityScore },
    });
  }

  let stepError: Error | null = null;
  let result: Awaited<ReturnType<typeof engine.executeStep>>;

  try {
    result = await engine.executeStep(step, selectorSet, page);
  } catch (e: any) {
    result = { status: 'failed', selectorUsed: null, durationMs: 0, errorType: null, errorMessage: e.message ?? null, screenshotKey: null, domSnapshotKey: null };
    stepError = e;
  }

  runLog?.log(isAssertion ? 'assert' : 'execute',
    result.status === 'passed'
      ? `${isAssertion ? 'asserted' : step.action} ✓${result.selectorUsed ? ` · ${result.selectorUsed}` : ''} · ${result.durationMs}ms`
      : `${step.action} ✗ ${result.errorType ?? ''} ${result.errorMessage ?? ''}`.trim(),
    { stepIndex, level: result.status === 'passed' ? 'info' : 'error', data: { status: result.status, selector: result.selectorUsed, durationMs: result.durationMs } },
  );

  // ── After screenshot ──────────────────────────────────────────────────────
  // The stored key is deterministic, so it's recorded on the step_result NOW
  // while the bytes upload asynchronously via the screenshot consumer —
  // GCS never blocks the step loop. Spec: spec-service-decomposition.md §4.1
  const afterPng = await page.screenshot({ type: 'png' }).catch(() => null);
  const afterKey = afterPng ? screenshots.keyFor(tenantId, runId, stepIndex, 'after') : null;
  if (afterPng) {
    void bus.publish({ kind: 'screenshot.upload', tenantId, runId, stepIndex, timing: 'after', png: afterPng, attempt });
  }

  // ── Success path ──────────────────────────────────────────────────────────
  // navigate and press_key pass with selectorUsed: null — check status only
  if (result.status === 'passed') {
    // ── Capture: store the resolved element's text into the run context so a
    // later step can reference it via {{captureAs}}. For click_random the name
    // is already known (randomPickName); otherwise read it from the live element.
    // click_random captures IMPLICITLY to `selectedItem` (the LLM AST has no
    // captureAs field), so a later "verify cart matches {{selectedItem}}" works
    // out of the box.
    const captureKey = step.captureAs ?? (step.action === 'click_random' ? 'selectedItem' : null);
    let capturedValue: string | null = null;
    if (captureKey) {
      capturedValue = randomPickName;
      if (capturedValue == null && result.selectorUsed) {
        capturedValue = await page
          .$eval(result.selectorUsed, (el) => (el.textContent ?? '').trim())
          .catch(() => null);
      }
      if (capturedValue != null) {
        runContext.variables[captureKey] = capturedValue;
        obs.log('info', 'worker.captured_value', { name: captureKey, value: capturedValue });
        runLog?.log('capture', `captured {{${captureKey}}} = "${capturedValue}"`, { stepIndex, data: { name: captureKey, value: capturedValue } });
      }
    }
    // Never cache assertion selectors (they verify per-run state and can embed
    // run-specific data like the current email); also skip caching for the
    // direct click_random pick whose selector is a transient data-kz-rand marker.
    const cacheable = !isAssertion && step.action !== 'click_random';
    if (result.selectorUsed && cacheable) {
      await resolver.recordSuccess(step.targetHash, domain, result.selectorUsed).catch((e: any) =>
        obs.log('warn', 'worker.record_success_failed', { error: e.message }),
      );
    }

    // Archetype learning: when the LLM resolved this step, try to promote the
    // picked element's accessible name into the archetype library so future runs
    // on any site with the same accessible name skip the LLM entirely.
    // Skip for assertions — we never want to learn an archetype from a verify
    // step whose element name may be run-specific data.
    if (!isAssertion && selectorSet.resolutionSource === 'llm' && selectorSet.llmPickedKaizenId && selectorSet.candidates) {
      const picked = selectorSet.candidates.find((c) => c.kaizenId === selectorSet.llmPickedKaizenId);
      if (picked) {
        await archetypeResolver.learn(picked.role, picked.name, step.action).catch((e: any) =>
          obs.log('warn', 'worker.archetype_learn_failed', { error: e.message }),
        );
      }
    }

    publishStepResult({
      tenantId, runId, stepId, stepIndex,
      contentHash: step.contentHash, targetHash: step.targetHash,
      status: 'passed',
      selectorUsed: result.selectorUsed, screenshotKey: afterKey,
      durationMs: Date.now() - stepStart,
      resolutionSource: selectorSet.resolutionSource, similarityScore: selectorSet.similarityScore,
      domCandidates: selectorSet.candidates ?? null,
      llmPickedKaizenId: selectorSet.llmPickedKaizenId ?? null,
      tokensUsed: selectorSet.tokensUsed ?? 0,
      archetypeName: selectorSet.archetypeName ?? null,
      errorType: null,
      capturedName: captureKey, capturedValue,
    }, attempt);
    await runLog?.flush();
    return { status: 'passed', healed: false, afterPng };
  }

  // ── Failure path: classify → heal ─────────────────────────────────────────
  await resolver.recordFailure(step.targetHash, domain, selectorSet.selectors[0]?.selector ?? '').catch((e: any) =>
    obs.log('warn', 'worker.record_failure_failed', { error: e.message }),
  );

  const error = stepError ?? new Error('Step execution failed');
  const axAfter = await (page as any).accessibility?.snapshot().catch(() => null) ?? null;

  // Signal C: fetch the real last-known-good "after" screenshot from GCS/disk
  const lastGoodPng = await fetchLastGoodScreenshot(tenantId, step.contentHash);
  const failureClass = classify(error, axBefore, axAfter, selectorSet.selectors[0]?.selector ?? '', afterPng, lastGoodPng);

  // Insert failed step_result now (synchronously) so healing_events can
  // FK-reference it and the healed-update below can target it.
  const stepResultId = await insertStepResult(
    tenantId, runId, step, stepIndex, 'failed',
    selectorSet.selectors[0]?.selector ?? null, afterKey, Date.now() - stepStart,
    selectorSet.resolutionSource, selectorSet.similarityScore, selectorSet.candidates ?? null,
    selectorSet.llmPickedKaizenId ?? null, selectorSet.tokensUsed ?? 0,
    selectorSet.archetypeName ?? null,
    null,    // errorType
    stepId,
  );

  const classifiedFailure: ClassifiedFailure = {
    stepResult: result as any,
    stepResultId: stepResultId ?? undefined,
    failureClass,
    step,
    previousSelector: selectorSet.selectors[0]?.selector ?? '',
  };

  runLog?.log('heal', `step ${String(stepIndex + 1).padStart(2, '0')} failed (${failureClass}) — attempting heal`, { stepIndex, level: 'warn', data: { failureClass } });

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
      await getPool().query(
        `UPDATE step_results SET status = 'healed', selector_used = $1 WHERE id = $2`,
        [healingResult.newSelector, stepResultId],
      ).catch((e: any) => obs.log('warn', 'worker.healed_update_failed', { error: e.message }));
    }
    runLog?.log('heal', `healed via ${healingResult.strategyUsed} → ${healingResult.newSelector}`, { stepIndex, data: { strategy: healingResult.strategyUsed, newSelector: healingResult.newSelector } });
    await runLog?.flush();
    return { status: 'passed', healed: true, afterPng };
  }

  runLog?.log('heal', `heal failed (${failureClass})`, { stepIndex, level: 'error', data: { failureClass } });
  await runLog?.flush();
  return { status: 'failed', healed: false, afterPng };
}

// ─── BullMQ Worker ────────────────────────────────────────────────────────────

const worker = new Worker<RunJobPayload>(
  RUNS_QUEUE_NAME,
  async (job) => {
    logger.info({ event: 'job_received', jobId: job.id, runId: job.data.runId });
    try {
      await processRun(job.data, job.attemptsMade);
    } catch (err: any) {
      // Only mark the run failed once retries are exhausted — otherwise a retry
      // would overwrite a transient 'failed' and the run flickers. Rethrow either
      // way so BullMQ schedules the next attempt (or records the final failure).
      const isLastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      logger.error({ event: 'job_error', jobId: job.id, runId: job.data.runId, error: err.message, attempt: job.attemptsMade + 1, willRetry: !isLastAttempt });
      if (isLastAttempt) {
        await markRunComplete(job.data.runId, 'failed').catch(() => { });
      }
      throw err;
    }
  },
  {
    connection: createRedisConnection(),
    // Phase 3: N runs in parallel, each in its own BrowserContext from the
    // shared browser; side-effects already drain via the event bus. 1 remains
    // the safe default — raise deliberately via WORKER_CONCURRENCY.
    // Spec: spec-service-decomposition.md §7
    concurrency: Math.max(1, Number(process.env.WORKER_CONCURRENCY ?? 1) || 1),
  },
);

worker.on('completed', (job) => {
  logger.info({ event: 'job_completed', jobId: job.id });
});

worker.on('failed', (job, err) => {
  logger.error({ event: 'job_failed', jobId: job?.id, error: err.message });
});

// A BullMQ Worker emits 'error' for connection-level faults (Redis blips, etc.).
// Without this listener the EventEmitter 'error' is unhandled and crashes the
// process — one transient Redis reset would kill the worker. Log and let BullMQ
// reconnect.
worker.on('error', (err) => {
  logger.error({ event: 'worker_error', error: err.message });
});

// ─── Graceful Shutdown ────────────────────────────────────────────────────────

const shutdown = async (signal: string): Promise<void> => {
  logger.info({ event: 'shutdown', signal });
  // Stop claiming run jobs first, then drain the co-located consumers (their
  // queues survive in Redis — anything unfinished resumes on next boot).
  await worker.close();
  await Promise.allSettled([screenshotConsumer?.close(), persistenceConsumer?.close()]);
  await bus.close();
  await browserPool.close();
  await closePool();
  process.exit(0);
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

logger.info({
  event: 'worker_started',
  queue: RUNS_QUEUE_NAME,
  consumers: inprocessConsumers ? [SCREENSHOTS_QUEUE_NAME, PERSIST_QUEUE_NAME] : [],
});
