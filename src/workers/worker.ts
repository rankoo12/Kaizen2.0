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
import fs from 'node:fs';
import os from 'node:os';
import nodePath from 'node:path';
import { Worker } from 'bullmq';
import { type Page, type Video } from 'playwright';
import { BrowserPool } from './browser-pool';
import { cancelKey } from './cancel-keys';
import { canonicalFrameUrl } from '../utils/frame-url';
import { runStepLoop, STEP_WATCHDOG_MS } from './step-loop';
import { handleTabAction } from './tab-manager';
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
import { deleteKeysByPattern } from '../modules/element-resolver/redis-cache.utils';
import { interpolateStep } from './run-context';
import { shouldResolveFresh, healCertifiesAssertion } from './assertion-cache-policy';
import { DeferredHeals, pageShowsText, type PendingHeal, type SettleDecision } from './deferred-heals';
import { resolveBehindAuth } from './behind-auth';
import { RunLogger } from './run-logger';
import { PlaywrightExecutionEngine } from '../modules/execution-engine/playwright.execution-engine';
import { PageChallengeDetector } from '../modules/execution-engine/challenge-detector';
import {
  captureDeltaFull, captureDeltaBaseline, isDeltaScoped, pickDeltaMatch, summariseDelta,
  STATE_CHANGING_ACTIONS, DELTA_CLEARING_ACTIONS, NOOP_DETECTABLE_ACTIONS,
  readControlState, actionLeftControlUnchanged, type DeltaSnapshot,
} from '../modules/execution-engine/delta';
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
import { closePool } from '../db/pool';
import { tenantPool, tenantQuery } from '../db/transaction';
import { createRedisConnection, RUNS_QUEUE_NAME, SCREENSHOTS_QUEUE_NAME, PERSIST_QUEUE_NAME } from '../queue';
import type { RunJobPayload } from '../queue';
import type { StepAST, ClassifiedFailure, SelectorSet, SelectorEntry, RunContext } from '../types';
import { isSecretStep, redactStepText, REDACTED } from '../modules/test-writer/secret-steps';
import { settleAfterNavigation, settleDom } from '../modules/execution-engine/settle';
import { quotedName, nameOverlaps, countDriftMatch, nameAbsent } from './name-fidelity';
import { revealHiddenTarget } from './reveal';

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
//
// The assertion LLM resolver is a DEDICATED instance that READS the shared brain (so a
// verify reuses the interaction's correct resolution — e.g. "the second checkbox") but
// never WRITES to it (a verify must not persist run-specific selectors). A confident-but-
// wrong element-embedding hit (a checkbox for "College radio button") is caught by the
// resolver's role guard, which drops a role-mismatched hit through to the LLM.
const assertionLlmResolver = new LLMElementResolver(domPruner, llm, obs, sharedPool, cacheRedis, {
  cacheReads: true,
  cacheWrites: false,
});
const assertionResolvers: IElementResolver[] = [archetypeElementResolver];
if (process.env.DISABLE_LLM !== '1') {
  assertionResolvers.push(assertionLlmResolver);
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

// Both take the tenant explicitly. The runs table is under row-level security,
// and under an unprivileged runtime role a write that carries no tenant is not
// a write that goes to the wrong place — it is a write that does not happen.
async function markRunRunning(tenantId: string, runId: string): Promise<void> {
  await tenantQuery(
    tenantId,
    `UPDATE runs SET status = 'running', started_at = now() WHERE id = $1`,
    [runId],
  );
}

/** aria-label / label / title / placeholder / name / value / text of the resolved element; null if unreadable. */
async function describeResolved(page: Page, selector: string): Promise<string | null> {
  try {
    // locator(), not $eval: $eval cannot parse role= selectors (run 10's cached
    // role=textbox[name="e.g. click the “Sign in” button"] read as null, and null
    // means "cannot check" — the gate silently passed the placeholder-named pick).
    return await (page as any).locator(selector).first().evaluate((el: Element) => {
      const e = el as HTMLElement;
      const id = e.getAttribute('id');
      const lab = id ? (document.querySelector('label[for="' + id + '"]') as HTMLElement | null) : null;
      return [
        e.getAttribute('aria-label') ?? '', lab?.innerText ?? '', e.closest('label')?.textContent ?? '',
        e.getAttribute('title') ?? '', e.getAttribute('placeholder') ?? '', e.getAttribute('name') ?? '',
        (e as HTMLInputElement).value ?? '', e.innerText ?? e.textContent ?? '',
      ].join(' ').replace(/\s+/g, ' ').trim().slice(0, 300);
    }, undefined, { timeout: 3000 });
  } catch {
    return null;
  }
}

/** Purge a selector that resolved to the wrong element from every cache layer that could serve it again. */
async function evictWrongSelector(tenantId: string, targetHash: string | null | undefined, selector: string): Promise<void> {
  if (targetHash) {
    await tenantQuery(tenantId, `DELETE FROM selector_cache WHERE content_hash = $1 AND (tenant_id = $2 OR is_shared = true) AND pinned_at IS NULL`, [targetHash, tenantId]);
    // SCAN, not KEYS: this runs on a hot path (every refused pick) and KEYS blocks
    // the whole Redis server for O(keyspace). Best-effort — a failed eviction must
    // not fail the step.
    await deleteKeysByPattern(cacheRedis, `llm:dedup:${targetHash}:*`).catch(() => 0);
  }
  await tenantQuery(tenantId,
    `DELETE FROM selector_cache WHERE (tenant_id = $1 OR is_shared = true) AND pinned_at IS NULL
       AND $2 = ANY(SELECT s->>'selector' FROM jsonb_array_elements(selectors::jsonb) AS s)`,
    [tenantId, selector],
  );
}

async function markRunComplete(tenantId: string, runId: string, status: 'passed' | 'failed' | 'healed' | 'cancelled'): Promise<void> {
  await tenantQuery(
    tenantId,
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

  await markRunRunning(tenantId, runId);

  // Fence consumers BEFORE the clears below: envelopes published by a
  // superseded attempt that are still in flight would otherwise land after the
  // clear and re-insert stale rows. Spec: spec-service-decomposition.md §4.4
  await markRunAttempt(cacheRedis, runId, attempt);

  // Idempotency: a BullMQ retry (after a transient infra fault) re-runs this job
  // from the top. Clear any rows a prior attempt persisted so results and the run
  // log aren't duplicated. FK-safe order: healing_events → step_results → run_events.
  // No-op on a first attempt (nothing persisted yet).
  const db = tenantPool(tenantId);
  await db.query(
    `DELETE FROM healing_events WHERE step_result_id IN (SELECT id FROM step_results WHERE run_id = $1)`,
    [runId],
  ).catch(() => {});
  await db.query(`DELETE FROM step_results WHERE run_id = $1`, [runId]).catch(() => {});
  await db.query(`DELETE FROM run_events   WHERE run_id = $1`, [runId]).catch(() => {});

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
  // §2b (spec-parallel-pipeline): a seeded proving run starts from the
  // storageState a sibling run of the same job exported — one sign-in for the
  // whole validation batch. A missing or expired seed is logged and the run
  // proceeds cold: its first step then fails honestly instead of silently
  // re-submitting credentials.
  let sessionSeed: unknown = null;
  if (payload.sessionSeedKey) {
    const raw = await cacheRedis.get(payload.sessionSeedKey).catch(() => null);
    if (raw) { try { sessionSeed = JSON.parse(raw); } catch { sessionSeed = null; } }
    if (!sessionSeed) obs.log('warn', 'worker.session_seed_missing', { runId, key: payload.sessionSeedKey });
  }
  // Run video — the run detail view's "Watch video" popup plays this back.
  // Gated off for Test Writer proving runs (hundreds per generation job, no
  // player in the drafts UI) and by RUN_VIDEO=off. Best-effort throughout: no
  // video failure may affect the run's outcome.
  // Spec: docs/specs/tests-ux/spec-run-video.md §1
  const videoEnabled = process.env.RUN_VIDEO !== 'off' && payload.triggeredBy !== 'testwriter';
  const videoDir = nodePath.join(os.tmpdir(), 'kaizen-run-video', runId);
  const context = await browser.newContext({
    baseURL: baseUrl,
    ...(sessionSeed ? { storageState: sessionSeed as never } : {}),
    ...(videoEnabled ? { recordVideo: { dir: videoDir } } : {}),
  });

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

  // Auto-accept native JS dialogs (alert/confirm/prompt) on EVERY page in the
  // context — including tabs opened later by a click (target=_blank/window.open).
  // Without a handler Playwright DISMISSES dialogs, so a "click OK" flow gets
  // Cancel and a confirm can stall. Accepting matches the common QA intent.
  const dialogs = { count: 0 };
  const attachDialogHandler = (p: Page): void => {
    p.on('dialog', (dialog) => {
      obs.log('info', 'worker.dialog_accepted', { runId, type: dialog.type(), message: dialog.message() });
      // Counted so a step whose ONLY effect was a dialog can say so. Kaizen
      // answers dialogs automatically, so their contents are gone before any
      // assertion could read them — that is our limitation, not a defect in the
      // customer's app. Spec: spec-oracle-delta-and-fidelity.md §1
      dialogs.count++;
      void dialog.accept().catch(() => { /* already handled/closed */ });
    });
  };
  // Newly opened tabs/windows join the same context; attach the dialog handler to
  // each so it's active no matter which tab a step later switches to.
  context.on('page', attachDialogHandler);

  // Side-channel evidence. A run that passes every step can still be sitting on
  // a page whose console is full of errors and whose XHRs are 500ing — a QA
  // engineer would report that, and until now the browser knew it and nobody
  // asked. Counted at the context so later tabs are included too.
  // Spec: docs/specs/test-writer/spec-validation-trust.md §8
  const sideChannel = { consoleErrors: 0, httpErrors: 0 };
  context.on('page', (p: Page) => {
    p.on('console', (msg: { type(): string }) => {
      if (msg.type() === 'error') sideChannel.consoleErrors++;
    });
    p.on('response', (res: { status(): number }) => {
      if (res.status() >= 400) sideChannel.httpErrors++;
    });
  });

  const page = await context.newPage();
  // Video is per PAGE; the main tab's clip is the run's video (v1 limitation:
  // a second tab records separately and is not stitched). Grab the handle now —
  // the file itself is only finalized when the context closes.
  const mainVideo: Video | null = videoEnabled ? page.video() : null;
  attachDialogHandler(page);
  page.on('console', (msg: { type(): string }) => {
    if (msg.type() === 'error') sideChannel.consoleErrors++;
  });
  page.on('response', (res: { status(): number }) => {
    if (res.status() >= 400) sideChannel.httpErrors++;
  });

  // The "current tab" the step loop operates on. A switch_tab step repoints
  // `tabs.current`; because the executeStep closure reads it fresh each call,
  // every subsequent step runs against the newly-focused tab.
  const tabs = { current: page };

  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });

  const domain = new URL(baseUrl).hostname;

  // Only a test that carries a discover oracle pays for the delta snapshots.
  // Spec: docs/specs/test-writer/spec-oracle-delta-and-fidelity.md §1
  const delta: DeltaMemory = {
    enabled: compiledSteps.some((s) => s.oracleScope === 'delta'),
    baseline: null,
    last: null,
    dialogs,
  };

  // Heals that could not earn the cache on name evidence, held until the run's
  // outcome corroborates them (S4). Per attempt: a BullMQ retry starts clean.
  const deferredHeals = new DeferredHeals(compiledSteps);

  // The privacy boundary is decided HERE, from the case — not only from whatever
  // the producer remembered to put in the payload (finding #14, defense in depth).
  const behindAuthDecision = await resolveBehindAuth({
    tenantId, runId, payloadFlag: payload.behindAuth === true,
  });
  if (behindAuthDecision.behindAuth && behindAuthDecision.source !== 'payload') {
    // The producer did NOT say so — the worker caught it. A 'case' hit means some
    // enqueue site forgot the flag; 'lookup_failed' means we failed closed.
    obs.increment('worker.behind_auth_derived', { source: behindAuthDecision.source });
    runLog.log('run',
      behindAuthDecision.source === 'case'
        ? 'authenticated case — shared learning is off for this run (derived from the case; the queue payload did not carry the flag)'
        : 'could not read the case\'s scope — treating the run as behind a login (shared learning off)',
      { level: behindAuthDecision.source === 'case' ? 'info' : 'warn', data: { source: behindAuthDecision.source } });
  }

  let loopResult;
  try {
    loopResult = await runStepLoop(runId, compiledSteps, {
      isCancelled,
      executeStep: (step, stepIndex, previousAfterPng, runContext) =>
        executeStep(step, tabs.current, tenantId, runId, domain, stepIndex, previousAfterPng, stepIds[stepIndex] ?? null, runContext, runLog, attempt, (p) => { tabs.current = p; }, behindAuthDecision.behindAuth, payload.triggeredBy === 'testwriter', delta, deferredHeals),
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
      // A watchdog kill aborts the step MID-FLIGHT: its own bookkeeping never
      // ran, so without this stamp the run shows an unexplained empty failure
      // (`failed: #1 ?` on the bench — no failure class, no heal events, and
      // "Target page closed" noise from the abandoned call). Finding #10a.
      onStepWatchdog: async (stepIndex, step, watchdogMs) => {
        obs.increment('worker.step_watchdog_killed', { action: step.action });
        await insertStepResult(
          tenantId, runId, step, stepIndex, 'failed',
          null, null, watchdogMs,
          null, null, null, null, 0, null,
          'StepWatchdogTimeout',
          stepIds[stepIndex] ?? null,
        );
        runLog?.log('execute',
          `step ${String(stepIndex + 1).padStart(2, '0')} exceeded the ${Math.round(watchdogMs / 1000)}s watchdog — killed mid-flight (resolution + recovery + healing spent the whole budget)`,
          { stepIndex, level: 'error', data: { watchdogMs } });
        await runLog?.flush();
      },
      onCancelled: (stepsCompleted) => {
        logger.info({ event: 'run_cancelled', runId, stepsCompleted });
      },
    }, payload.seedVariables);
  } finally {
    // Everything the run leaves behind, captured once while the page is still
    // open. Three consumers depend on it and none could exist without it: the
    // vacuity probe needs to know what the page looked like at the end, the
    // oracle harvest has produced an empty object in every job ever run because
    // the worker recorded nothing to harvest, and the findings channel needs the
    // console/network evidence that a green run can otherwise hide.
    // Spec: docs/specs/test-writer/spec-validation-trust.md §8
    await captureFinalState(tabs.current, runLog, sideChannel).catch((e: any) =>
      obs.log('warn', 'worker.final_state_capture_failed', { runId, error: e?.message }));
    await runLog.flush().catch(() => { /* the run's outcome does not depend on this */ });

    // §2b: a passing run asked to seed the batch exports its authenticated
    // storageState for sibling proving runs. Redis only, 30-minute TTL.
    if (payload.sessionExportKey && loopResult?.runPassed) {
      try {
        const state = await context.storageState();
        await cacheRedis.setex(payload.sessionExportKey, 1800, JSON.stringify(state));
      } catch (e: any) {
        obs.log('warn', 'worker.session_export_failed', { runId, error: e?.message });
      }
    }

    // Close only this run's context — the pooled browser stays up for other
    // runs; release() lets the pool recycle it once idle and past budget.
    await context.close();
    await browserPool.release();
    // The webm exists only now that the context is closed. Persisting before
    // markRunComplete means a terminal run row either has its video_key or
    // NULL — the UI never re-polls a finished run for a late video.
    if (videoEnabled) {
      await persistRunVideo(mainVideo, videoDir, tenantId, runId).catch((e: any) =>
        obs.log('warn', 'worker.video_persist_failed', { runId, error: e?.message }));
    }
    // Always clean up the cancellation key so it doesn't linger in Redis.
    await cacheRedis.del(cancelKey(runId)).catch(() => {});
  }

  const { runPassed, anyHealed, cancelled } = loopResult;
  const finalStatus = cancelled ? 'cancelled' : runPassed ? (anyHealed ? 'healed' : 'passed') : 'failed';

  // S4 — settle the heals held back for lack of name evidence. The decisions are
  // synchronous so they land in the run log (an operator can see WHY a rename was
  // or was not learned); the writes (embeddings + upsert) run in the background,
  // exactly like the immediate persists do. Rules: ./deferred-heals.ts.
  if (deferredHeals.size > 0) {
    const plan = deferredHeals.plan({ runPassed, cancelled });
    for (const { pending, decision } of plan) {
      if (decision === 'commit') {
        obs.increment('worker.heal_deferred_committed');
        runLog.log('heal',
          `step ${String(pending.stepIndex + 1).padStart(2, '0')}: heal learned — the run passed and "${pending.outcomeText}" was absent before the healed action and present after it`,
          { stepIndex: pending.stepIndex, data: { decision, outcomeText: pending.outcomeText } });
      } else {
        obs.increment('worker.heal_deferred_discarded', { reason: decision });
        runLog.log('heal',
          `step ${String(pending.stepIndex + 1).padStart(2, '0')}: heal NOT learned — ${DEFERRED_HEAL_DISCARD_REASON[decision]}`,
          { stepIndex: pending.stepIndex, data: { decision, outcomeText: pending.outcomeText } });
      }
    }
    void deferredHeals.commit(plan).then(({ failed }) => {
      if (failed > 0) obs.log('warn', 'worker.heal_deferred_persist_failed', { runId, failed });
    });
  }

  await markRunComplete(tenantId, runId, finalStatus);

  runLog.log('run', `Run ${finalStatus}`, { level: finalStatus === 'failed' ? 'error' : 'info', data: { status: finalStatus } });
  await runLog.flush();

  obs.increment('worker.run_completed', { status: finalStatus });
  logger.info({ event: 'run_completed', runId, status: finalStatus });
  span.end();
}

const DEFERRED_HEAL_DISCARD_REASON: Record<Exclude<SettleDecision, 'commit'>, string> = {
  run_not_passed: 'the run did not pass, so nothing corroborates the pick',
  no_outcome_assertion: 'no assert_text directly follows the healed action to corroborate it',
  outcome_unknown: 'could not tell whether the outcome text was already on the page',
  outcome_already_present: 'the outcome text was already on the page before the healed action, so it cannot show which element was clicked',
};

/**
 * Persist the run's recorded video: read the finalized webm (the context must
 * already be closed), upload it via the media service, stamp runs.video_key,
 * and remove the temp dir. Entirely best-effort — any failure logs, leaves
 * video_key NULL, and the run's already-decided outcome is untouched.
 * Spec: docs/specs/tests-ux/spec-run-video.md §1
 */
async function persistRunVideo(
  video: Video | null,
  videoDir: string,
  tenantId: string,
  runId: string,
): Promise<void> {
  try {
    const videoPath = video ? await video.path().catch(() => null) : null;
    const webm = videoPath ? fs.readFileSync(videoPath) : null;
    if (!webm || webm.length === 0) {
      obs.log('warn', 'worker.video_missing', { runId });
      return;
    }
    const key = await screenshots.uploadVideo(webm, tenantId, runId);
    if (!key) {
      obs.log('warn', 'worker.video_upload_failed', { runId, bytes: webm.length });
      return;
    }
    await tenantQuery(tenantId, `UPDATE runs SET video_key = $1 WHERE id = $2 AND tenant_id = $3`, [key, runId, tenantId]);
    obs.log('info', 'worker.video_saved', { runId, key, bytes: webm.length });
  } finally {
    fs.rmSync(videoDir, { recursive: true, force: true });
  }
}

/**
 * What the page looked like when the run stopped touching it.
 *
 * Deliberately read from the LIVE page rather than reconstructed from step
 * results: the whole point is to record what a human would have seen, including
 * the things no step asserted. Best-effort by design — a closed or crashed page
 * yields nothing and the run's own verdict is unaffected.
 */
async function captureFinalState(
  page: Page,
  runLog: RunLogger,
  sideChannel: { consoleErrors: number; httpErrors: number },
): Promise<void> {
  const observed = await (page as any).evaluate(() => {
    const text = (el: Element | null): string | null => {
      const s = (el as HTMLElement | null)?.innerText?.replace(/\s+/g, ' ').trim();
      return s ? s.slice(0, 300) : null;
    };
    // An alert region is where an app says what just happened — the success
    // banner or the validation error a discover oracle was meant to name.
    const alert = document.querySelector('[role="alert"], .alert, [aria-live="assertive"]');
    return {
      finalUrl: location.href,
      h1: text(document.querySelector('h1')),
      alertText: text(alert),
    };
  }).catch(() => null);

  if (!observed) return;
  runLog.log('capture', 'final page state', {
    data: {
      ...observed,
      consoleErrorCount: sideChannel.consoleErrors,
      httpErrorCount: sideChannel.httpErrors,
    },
  });
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
  frameUrl: string | null = null,
): Promise<string | null> {
  try {
    // step_id back-references the test_steps row this result came from. Lets
    // the runs API LEFT JOIN test_steps and surface the original step text in
    // the timeline. Nullable for backwards-compat with pre-spec queue jobs.
    // Spec: docs/specs/workers/spec-live-run-updates.md §5.1.3
    // captured_name/value record a run-scoped variable captured by this step.
    // Spec: docs/specs/workers/spec-engine-capabilities-assert-random-capture.md §3.5
    const { rows } = await tenantQuery<{ id: string }>(
      tenantId,
      `INSERT INTO step_results
         (tenant_id, run_id, step_id, step_index, content_hash, target_hash, status, selector_used,
          screenshot_key, duration_ms, resolution_source, similarity_score,
          dom_candidates, llm_picked_kaizen_id, tokens_used, archetype_name, error_type,
          captured_name, captured_value, frame_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
       RETURNING id`,
      [tenantId, runId, stepId, stepIndex, step.contentHash, step.targetHash, status, selectorUsed,
       screenshotKey, durationMs, resolutionSource, similarityScore,
       domCandidates ? JSON.stringify(domCandidates) : null,
       llmPickedKaizenId, tokensUsed, archetypeName, errorType,
       capturedName, capturedValue, frameUrl],
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
      frameUrl: null,     // never resolved, so never in a frame
    }, attempt);
  }
}

async function fetchLastGoodScreenshot(
  tenantId: string,
  contentHash: string,
): Promise<Buffer | null> {
  try {
    const { rows } = await tenantQuery<{ screenshot_key: string }>(
      tenantId,
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

/**
 * What the previous action changed, carried across steps of one run.
 * `enabled` is false unless the test actually contains a delta-scoped oracle, so
 * a normal customer run pays nothing for this.
 * Spec: docs/specs/test-writer/spec-oracle-delta-and-fidelity.md §1
 */
type DeltaMemory = {
  enabled: boolean;
  /** Keys of everything visible immediately BEFORE the last action. */
  baseline: string[] | null;
  last: DeltaSnapshot | null;
  /** The run's native-dialog counter, shared with the context's dialog handler. */
  dialogs: { count: number };
};

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
  setCurrentPage?: (p: Page) => void,
  /**
   * This run is executing behind a login wall (a Test Writer proving run for an
   * authenticated draft). Nothing learned here may leave the tenant: no shared-pool
   * contribution, no global archetype learning. The tenant's own selector_cache
   * still fills. Spec: spec-authenticated-scope.md §4.1.
   */
  behindAuth: boolean = false,
  /**
   * This run is proving a generated draft. Assertions then resolve cache-free
   * (so a proving run never teaches the cache where an oracle's anchor lives)
   * and may not be certified by a heal that re-resolved the target.
   * Spec: spec-validation-trust.md §9.
   */
  isProvingRun: boolean = false,
  /**
   * Run-scoped memory of what the previous action changed. A discover oracle
   * ("verify the confirmation is visible") resolves inside it and nowhere else.
   * Spec: docs/specs/test-writer/spec-oracle-delta-and-fidelity.md §1
   */
  delta: DeltaMemory = { enabled: false, baseline: null, last: null, dialogs: { count: 0 } },
  /**
   * Collects heals that failed the name gate so the run's outcome can decide
   * whether they earn the cache. Null where deferral does not apply.
   * Spec: spec-research-adoption-2026-11 §S4; rules in ./deferred-heals.ts.
   */
  deferredHeals: DeferredHeals | null = null,
): Promise<{ status: 'passed' | 'failed'; healed: boolean; afterPng: Buffer | null }> {
  // Resolve {{variable}} tokens captured by earlier steps before doing anything
  // else, so resolution, execution, and persistence all see the concrete values.
  // Spec: docs/specs/workers/spec-engine-capabilities-assert-random-capture.md §3.4
  const step = interpolateStep(rawStep, runContext);
  // Credentials must not land in run_events. A login test typing a literal
  // password leaked it twice here: into data.value, and into the message, which
  // embeds the raw sentence — so redacting one column alone just moved the
  // secret next door. Spec: spec-authenticated-scope.md §12.2.
  const secretStep = isSecretStep(step);
  const loggedText = secretStep ? redactStepText(step.rawText, step.value) : step.rawText;
  runLog?.log('resolve', `step ${String(stepIndex + 1).padStart(2, '0')} · ${step.action} · "${loggedText}"`, {
    stepIndex,
    data: {
      action: step.action,
      target: step.targetDescription,
      value: secretStep ? REDACTED : step.value,
    },
  });
  const resolutionContext = { tenantId, domain, page, pageUrl: page.url(), behindAuth };
  const stepStart = Date.now();
  // ── Recovery time budget (finding #10b) ─────────────────────────────────────
  // Every recovery layer below is individually bounded, but on a slow-rendering
  // page their SUM used to out-spend the step watchdog — which then killed the
  // step mid-flight, throwing away all evidence (finding #10a stamps that kill;
  // this budget makes it rare). Layers check `recoveryBudgetLeft()` before
  // spending more; past the soft deadline (80% of the watchdog) they skip to an
  // honest failure instead of starting work the watchdog would destroy.
  const softDeadlineAt = stepStart + Math.floor(STEP_WATCHDOG_MS * 0.8);
  const recoveryBudgetLeft = (): number => softDeadlineAt - Date.now();
  // Accessible name of the element chosen by a click_random step — captured into
  // the run context for later {{variable}} reference (Gap C wires the store).
  let randomPickName: string | null = null;

  // ── AX snapshot + before screenshot ──────────────────────────────────────
  // page.accessibility is deprecated in Playwright 1.44+ but still functional;
  // cast to any to avoid the removed type definition.
  const axBefore = await (page as any).accessibility?.snapshot().catch(() => null) ?? null;

  // Reuse the previous step's after-screenshot as this step's before-screenshot.
  // Only capture a fresh one for the very first step (no previous).
  // Secret steps upload nothing: /media is readable by every tenant member, and
  // an authenticated draft replays its login prefix on every proving run.
  const beforePng = previousAfterPng ?? await page.screenshot({ type: 'png' }).catch(() => null);
  if (!previousAfterPng && beforePng && !secretStep) {
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

  // ── Tab / window management ────────────────────────────────────────────────
  // switch_tab / close_tab operate on the browser CONTEXT (the set of open tabs),
  // not a DOM element, and must repoint the step loop's current page. Handled here
  // in the worker (the engine only ever knows one page) via the setCurrentPage
  // callback the step loop provides. No resolver/engine involvement.
  if (step.action === 'switch_tab' || step.action === 'close_tab') {
    const outcome = await handleTabAction(step, page, setCurrentPage);
    const focusPage = outcome.page ?? page;
    const afterPng = await focusPage.screenshot({ type: 'png' }).catch(() => null);
    const afterKey = afterPng ? screenshots.keyFor(tenantId, runId, stepIndex, 'after') : null;
    if (afterPng) void bus.publish({ kind: 'screenshot.upload', tenantId, runId, stepIndex, timing: 'after', png: afterPng, attempt });
    void insertStepResult(
      tenantId, runId, step, stepIndex, outcome.ok ? 'passed' : 'failed',
      null, afterKey, Date.now() - stepStart, null, null, null, null, 0, null,
      outcome.ok ? null : 'TabActionError', stepId,
    );
    runLog?.log('execute', `${step.action} ${outcome.ok ? '✓' : '✗'} ${outcome.detail}`, { stepIndex, level: outcome.ok ? 'info' : 'error', data: { detail: outcome.detail } });
    await runLog?.flush();
    return { status: outcome.ok ? 'passed' : 'failed', healed: false, afterPng };
  }

  // ── The delta oracle ──────────────────────────────────────────────────────
  // A discover oracle names something the crawl never saw, so the resolver
  // searches the whole page — and the whole page still contains the button that
  // was clicked. This assertion may only look at what the previous action
  // CHANGED. An empty delta is not "look harder", it is the answer: the action
  // did nothing. Spec: spec-oracle-delta-and-fidelity.md §1
  // A discover oracle with NO action before it on this page has nothing to be
  // about. "navigate → verify the error message is visible" resolved page-wide
  // and passed on whatever it found — which is exactly how the vacuity probe
  // (navigates + assertions, actions removed) called every delta-scoped test
  // vacuous, and how a test could be green while checking nothing. The
  // definition of the oracle is "what the previous action changed"; with no
  // action, the honest answer is a failure that says so.
  // Spec: docs/specs/test-writer/spec-oracle-delta-and-fidelity.md §1
  if (delta.enabled && isDeltaScoped(step) && delta.last === null) {
    const reason = 'no action came before this check on this page — there is nothing it could be verifying';
    obs.increment('worker.delta_oracle_no_action');
    const afterPng = secretStep ? null : await page.screenshot({ type: 'png' }).catch(() => null);
    const afterKey = afterPng ? screenshots.keyFor(tenantId, runId, stepIndex, 'after') : null;
    if (afterPng) {
      void bus.publish({ kind: 'screenshot.upload', tenantId, runId, stepIndex, timing: 'after', png: afterPng, attempt });
    }
    void insertStepResult(
      tenantId, runId, step, stepIndex, 'failed', null, afterKey,
      Date.now() - stepStart, null, null, null, null, 0, null, 'AssertionNoAction', stepId,
    );
    runLog?.log('assert', `assertion failed — ${reason}`, { stepIndex, level: 'error' });
    await runLog?.flush();
    return { status: 'failed', healed: false, afterPng };
  }

  const deltaScoped = delta.enabled && isDeltaScoped(step) && delta.last !== null;
  if (deltaScoped && delta.last!.elements.length === 0 && delta.baseline) {
    // Re-diff first: content that renders asynchronously (a spinner finishing,
    // an SPA route settling) can arrive between the action and this assertion.
    // Let the DOM go quiet before looking — an app that fetches after a click
    // has not answered yet the instant the click returns.
    await settleDom(page);
    const again = await captureDeltaFull(page, delta.baseline);
    delta.last = { ...delta.last!, elements: again.elements, removed: again.removed };
  }
  // Nothing appeared but something DISAPPEARED (a filter hid rows, a banner was
  // dismissed): the action worked; there is just no new element to scope to.
  // Resolve the assertion against the whole page instead of declaring the
  // action a no-op — and say so in the log.
  const onlyRemovals = deltaScoped && delta.last!.elements.length === 0 && (delta.last!.removed ?? 0) > 0;
  // A click that swaps the whole view (a nav chip, a screen switch) puts the
  // ENTIRE new screen in the delta — and then anything on it "proves" any
  // claim. Run 13: "a run entry tied to the Demo suite" matched an old run
  // named "Demo Save And Run Test 2761" this way. A delta that large is a view
  // change, not a reaction: resolve such assertions against the whole page,
  // where the resolver and gates apply, instead of blessing the delta.
  const viewSwapped = deltaScoped && delta.last!.elements.length >= 20;
  if (viewSwapped) {
    obs.increment('worker.delta_oracle_view_swap');
    runLog?.log('resolve',
      `"${delta.last!.afterStep}" replaced the whole view (${delta.last!.elements.length} new elements) — `
      + 'checking the assertion against the page, not the delta',
      { stepIndex, data: { deltaSize: delta.last!.elements.length } });
  }
  if (onlyRemovals) {
    obs.increment('worker.delta_oracle_only_removals');
    runLog?.log('resolve',
      `after "${delta.last!.afterStep}" ${delta.last!.removed} element(s) disappeared and nothing appeared — `
      + 'checking the assertion against the whole page',
      { stepIndex, data: { removed: delta.last!.removed } });
  }
  if (deltaScoped && !onlyRemovals && delta.last!.elements.length === 0) {
    const dialogOnly = delta.last!.dialogAccepted;
    const reason = dialogOnly
      ? `the only thing "${delta.last!.afterStep}" produced was a browser dialog, which Kaizen `
        + 'answers automatically — its contents are gone before anything can be verified'
      : `nothing on the page changed after "${delta.last!.afterStep}" — `
        + `there is no ${step.targetDescription} to verify`;
    obs.increment('worker.delta_oracle_empty', { dialogOnly: String(dialogOnly) });
    const afterPng = secretStep ? null : await page.screenshot({ type: 'png' }).catch(() => null);
    const afterKey = afterPng ? screenshots.keyFor(tenantId, runId, stepIndex, 'after') : null;
    if (afterPng) {
      void bus.publish({ kind: 'screenshot.upload', tenantId, runId, stepIndex, timing: 'after', png: afterPng, attempt });
    }
    void insertStepResult(
      tenantId, runId, step, stepIndex, 'failed', null, afterKey,
      Date.now() - stepStart, null, null, null, null, 0, null,
      // 'Assertion…' reads as the app declining rather than as Kaizen failing to
      // find an element — this failure IS the observation, and §5 files it as a
      // possible app defect. A dialog-only change is NOT that: there the limit
      // is ours, so it must never be reported as a defect in the customer's app.
      dialogOnly ? 'DialogOnlyChange' : 'AssertionNothingChanged',
      stepId,
    );
    runLog?.log('assert', `assertion failed — ${reason}`, { stepIndex, level: 'error', data: { afterStep: delta.last!.afterStep } });
    await runLog?.flush();
    return { status: 'failed', healed: false, afterPng };
  }

  // ── Resolve selectors ─────────────────────────────────────────────────────
  // navigate and press_key act on the page/keyboard, not a specific DOM element.
  let selectorSet: SelectorSet;
  if (deltaScoped && !onlyRemovals && !viewSwapped) {
    const elements = delta.last!.elements;
    let pick = pickDeltaMatch(step.targetDescription ?? '', elements, quotedName(delta.last!.afterStep));
    // ── Delta name-fidelity for assertions (finding #2) ───────────────────────
    // pickDeltaMatch's "about" gate accepts a role-only match — right for
    // generic kind-descriptions ("a confirmation dialog") and a FALSE PASS for
    // named controls: react-spa renamed "Sign in"→"Log in" and the visibility
    // assert of the OLD name went green off the renamed button (the fidelity
    // gates exempt delta, so nothing downstream catches it). An assertion's
    // INTERACTIVE delta pick must share at least one salient word with the
    // target — role included, so "a confirmation dialog" still matches a
    // dialog; prose picks (the error message → "Target URL needs to…") stay
    // exempt, that lookup is the delta oracle's whole point. Zero overlap
    // demotes to no-pick and the assertion fails honestly.
    // Spec: docs/specs/bench/spec-changing-sites.md §12 (#2)
    if (pick && step.action.startsWith('assert') && pick.interactive
        && nameAbsent(step.targetDescription, `${pick.name} ${pick.text} ${pick.role}`)) {
      obs.increment('worker.delta_pick_name_refused');
      runLog?.log('resolve',
        `what changed has a ${pick.role} ("${(pick.text || pick.name).slice(0, 40)}") but it does not carry "${(step.targetDescription ?? '').slice(0, 40)}" — refusing the lookalike`,
        { stepIndex, level: 'warn', data: { refused: pick.text || pick.name, role: pick.role } });
      pick = null;
    }
    // The whole delta rides as candidates and the pick is marked, so the run
    // page shows "what changed" with the chosen element highlighted — a person
    // can check the choice, not just read an opaque [data-kz-delta] selector.
    selectorSet = pick
      ? {
          selectors: [{ selector: `[data-kz-delta="${pick.marker}"]`, strategy: 'css' as const, confidence: 0.9 }],
          fromCache: false, cacheSource: null, resolutionSource: 'delta', similarityScore: null,
          llmPickedKaizenId: pick.marker,
          candidates: elements.slice(0, 10).map((el) => ({
            kaizenId: el.marker, role: el.role, name: el.text || el.name,
            selector: `[data-kz-delta="${el.marker}"]`,
          })),
        }
      : {
          selectors: [], fromCache: false, cacheSource: null, resolutionSource: null, similarityScore: null,
          // No pick, but the delta itself is the diagnosis: the validation
          // runner reads these to tell the fill round WHAT the action actually
          // produced ("Target URL needs to start with http://…"), which is the
          // feedback a rewrite needs.
          candidates: elements.slice(0, 10).map((el) => ({
            kaizenId: el.marker, role: el.role, name: el.text || el.name,
            selector: `[data-kz-delta="${el.marker}"]`,
          })),
        };
    obs.increment('worker.delta_oracle_resolved', { matched: String(!!pick) });
    runLog?.log('resolve',
      pick
        ? `resolved inside what changed → ${pick.role} "${(pick.text || pick.name).slice(0, 60)}"`
        : 'nothing in what changed matched the assertion',
      { stepIndex, data: { deltaSize: elements.length, marker: pick?.marker ?? null } });
  } else if (step.action === 'click_random') {
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
      // findRepeatedTargets' title extraction is e-commerce-hardcoded; fall back to the
      // general card-title resolver at PICK time (element still stable, pre-click — some
      // apps re-render the control on click and destroy any post-click reference).
      if (!randomPickName) randomPickName = await resolveCardTitle(page, chosen.selector).catch(() => null);
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
    // State / negative assertions verify CURRENT page state. The hazard is a target
    // that embeds run-specific data — "verify the header shows {{email}}" — because
    // targetHash is computed by the COMPILER from the raw text and interpolateStep
    // never recomputes it. Such a step therefore has a STABLE cache key pointing at
    // CHANGING content: run 2 would read back run 1's selector and assert against an
    // email that no longer exists.
    const needsElement = !NO_ELEMENT_ACTIONS.has(step.action);
    // interpolateStep returns the SAME object when no {{token}} was present, so this
    // comparison is exact and free.
    const targetIsRunVarying = step.targetDescription !== rawStep.targetDescription;
    const useNoCache = shouldResolveFresh(step.action, targetIsRunVarying, isProvingRun);
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

  // ── Fidelity gate: a quoted name must be ON the element we resolved ─────────
  // `click the "Checkout smoke 6" button` resolved (from cache) to the menubar's
  // "File", the click opened a menu, and the run went green. A step that NAMES
  // its target in quotes is explicit; an element that does not carry that name
  // is not it — refuse it, evict it from the caches that served it, and let
  // the step fail into healing rather than act on the wrong control and call it
  // proof. Shared with the one settled retry below.
  const gateApplies = selectorSet.resolutionSource !== 'delta'
    && step.action !== 'assert_text' && step.action !== 'assert_not_text' && step.action !== 'assert_count';
  const refuseWrongName = async (): Promise<void> => {
    if (selectorSet.selectors.length === 0 || !gateApplies) return;
    // Heal-provenance trust (finding #5): this exact-hash entry was persisted by
    // a VALIDATED heal — the original name-anchored selector died and a verified
    // re-resolution adopted this one. The name mismatch about to be found IS the
    // rename that heal fixed; refusing (and evicting) it here is what kept every
    // renamed control in a re-heal loop (judged healed-not-learned, GAP).
    // Interactions only — an assertion must still carry the name it asserts.
    if (selectorSet.healProvenance && !step.action.startsWith('assert')) {
      obs.increment('worker.heal_provenance_trusted', { action: step.action });
      return;
    }
    const quoted = quotedName(step.targetDescription);
    if (!quoted) return;
    const sel = selectorSet.selectors[0].selector;
    const descriptor = await describeResolved(page, sel);
    // Interactions tolerate COUNT DRIFT ("Demo 5" clicking "Demo 6"): the
    // trailing number is a live badge the run's own tests change. Assertions
    // never get this leniency — gateApplies already keeps them strict, and
    // countDriftMatch demands the same residue + a count in the same spot.
    const agrees = descriptor !== null
      && (nameOverlaps(quoted, descriptor)
        || (!step.action.startsWith('assert') && countDriftMatch(quoted, descriptor)));
    if (descriptor !== null && !agrees) {
      obs.increment('worker.quoted_name_mismatch', { source: selectorSet.resolutionSource ?? 'unknown' });
      runLog?.log('resolve',
        `refused: "${quoted}" resolved to ${sel.slice(0, 80)} (${descriptor.slice(0, 60)}) — not the named element`,
        { stepIndex, level: 'warn', data: { selector: sel, source: selectorSet.resolutionSource } });
      if (selectorSet.fromCache) await evictWrongSelector(tenantId, step.targetHash, sel).catch(() => {});
      selectorSet = { selectors: [], fromCache: false, cacheSource: null, resolutionSource: null, similarityScore: null };
    }
  };
  await refuseWrongName();

  // ── One settled retry when resolution has nothing ──────────────────────────────
  // `click the "Checkout smoke 8" button` resolved to NOTHING six times in run 9:
  // the suites sidebar had not painted when the pruner snapshotted. Refusing to
  // guess is right; giving up before the page finishes rendering is not. Let the
  // DOM go quiet, resolve once more (the retry pick faces the same gate), and
  // only then fail into healing.
  const RETRYABLE_INTERACTIONS = new Set(['click', 'double_click', 'right_click', 'type', 'select', 'check', 'uncheck', 'hover', 'clear']);
  if (selectorSet.selectors.length === 0 && RETRYABLE_INTERACTIONS.has(step.action) && recoveryBudgetLeft() > 5_000) {
    obs.increment('worker.resolution_retry_after_settle', { action: step.action });
    runLog?.log('resolve', 'nothing resolved — letting the page settle and resolving once more', { stepIndex, level: 'warn' });
    await settleDom(page);
    try {
      selectorSet = await resolver.resolve(step, resolutionContext);
    } catch (e: any) {
      obs.log('warn', 'worker.resolution_failed', { runId, action: step.action, error: e.message });
    }
    await refuseWrongName();
  }

  // ── Wrong element under async latency: settle and re-resolve ────────────────
  // A step resolved against a still-rendering page returns a confident WRONG
  // element — the persistent Notifications bell for "Add friend"/"Play"/"Block"
  // (the name-blind element cache rubber-stamps whatever chrome control is
  // present on the skeleton), or the "Messages" nav LINK for a message input
  // that loads 900ms late. The quoted-name gate above misses these because the
  // compiler drops the quotes. Detect the two unambiguous wrong-pick signals —
  // the resolved name shares ZERO salient words with the target, or a fill
  // action landed on a link — then let the DOM settle (patiently, so late
  // content paints) and re-resolve through the normal cache-first chain. Adopt
  // only a NON-suspect result; otherwise restore the original pick, so a correct
  // but oddly-named resolution is never made worse. Spec: spec-changing-sites §12 (#6).
  const FILL_ACTIONS = new Set(['type', 'select', 'check', 'uncheck', 'clear']);
  const isSuspectPick = async (set: SelectorSet): Promise<boolean> => {
    if (!step.targetDescription || set.selectors.length === 0) return false;
    const sel = set.selectors[0].selector;
    if (FILL_ACTIONS.has(step.action) && /^role=link\b/.test(sel)) return true; // can't type into a link
    const descriptor = await describeResolved(page, sel).catch(() => null);
    return descriptor !== null && nameAbsent(step.targetDescription, descriptor);
  };
  // healProvenance skips the suspect gate the same way (see refuseWrongName):
  // RETRYABLE_INTERACTIONS already excludes assertions on this path.
  if (gateApplies && !selectorSet.healProvenance && RETRYABLE_INTERACTIONS.has(step.action) && await isSuspectPick(selectorSet)) {
    const original = selectorSet;
    obs.increment('worker.suspect_pick_retry', { action: step.action, source: selectorSet.resolutionSource ?? 'unknown' });
    runLog?.log('resolve', `suspect pick (${selectorSet.selectors[0].selector.slice(0, 50)}) for "${(step.targetDescription ?? '').slice(0, 40)}" — settling and re-resolving`, { stepIndex, level: 'warn' });
    let recovered = false;
    let current = selectorSet;
    // Each iteration costs a settle (≤3s) + a resolve (possibly an LLM call);
    // never start one the watchdog would kill (finding #10b).
    for (let attempt = 0; attempt < 3 && !recovered && recoveryBudgetLeft() > 8_000; attempt++) {
      // Evict the suspect entry from every cache layer FIRST — the verify run
      // proved that without this the re-resolve is served the SAME poisoned
      // selector all three times ("the Mira Chen conversation" kept getting the
      // cached "Messages" nav link) and the retry loop recovers nothing. The
      // in-memory `original` survives eviction, so restore-below still works.
      if (current.fromCache && current.selectors.length > 0) {
        await evictWrongSelector(tenantId, step.targetHash, current.selectors[0].selector).catch(() => {});
      }
      await settleDom(page, 600, 3000); // patient: outlast the pre-render quiet gap
      let next: SelectorSet;
      try { next = await resolver.resolve(step, resolutionContext); }
      catch { continue; }
      current = next;
      if (next.selectors.length > 0 && !(await isSuspectPick(next))) {
        selectorSet = next;
        recovered = true;
        obs.increment('worker.suspect_pick_recovered', { action: step.action });
        runLog?.log('resolve', `recovered: "${(step.targetDescription ?? '').slice(0, 40)}" → ${next.selectors[0].selector.slice(0, 50)} (${next.resolutionSource})`, { stepIndex, data: { source: next.resolutionSource } });
      }
    }
    if (!recovered) {
      // Unrecovered and still suspect: refuse, don't restore. The pick was
      // confirmed wrong three times (a real descriptor sharing ZERO salient
      // words with the target), and acting on it is the one move that cannot
      // be undone — the Notifications bell "passed" a click meant for the
      // "Accept" button (requests.rename, v2) and the run died downstream on
      // an honest assert, while the heal chain, never consulted, could have
      // re-resolved the renamed button. Failing into healing instead costs at
      // worst one heal (which re-validates by outcome); a correct-but-oddly-
      // named element is not here — its descriptor is null or shares a word,
      // neither of which is suspect. (No quotedName gate: the step compiler
      // DROPS the quotes from targetDescription, so "the Accept button for
      // Sam Idowu" arrives unquoted — gating on quotes made this unreachable.)
      obs.increment('worker.suspect_pick_refused', { action: step.action });
      runLog?.log('resolve',
        `suspect pick not recovered — refusing ${original.selectors[0].selector.slice(0, 50)} for "${(step.targetDescription ?? '').slice(0, 40)}" and failing into healing`,
        { stepIndex, level: 'warn', data: { selector: original.selectors[0].selector } });
      selectorSet = { selectors: [], fromCache: false, cacheSource: null, resolutionSource: null, similarityScore: null };
    }
  }

  // ── Hover-to-reveal: the named element exists but is hidden ─────────────────
  // Last resort after every recovery above: a control inside a :hover-revealed
  // menu (Buzzly's profile "Block" inside the "⋯" menu) is hidden at resolution
  // time, so the pruner never offers it — resolution ends empty or still
  // suspect on a page where a human would simply hover the trigger first.
  // revealHiddenTarget scans for a HIDDEN element carrying the step's named
  // target, hovers its nearest visible ancestor, verifies it became visible,
  // and the step proceeds against it (resolutionSource 'reveal'). Strict name
  // containment means a lookalike is never revealed. Spec: spec-hover-reveal-scroll-find.md §1
  if (
    RETRYABLE_INTERACTIONS.has(step.action) && step.targetDescription && recoveryBudgetLeft() > 6_000 &&
    (selectorSet.selectors.length === 0 || (gateApplies && !selectorSet.healProvenance && await isSuspectPick(selectorSet)))
  ) {
    const revealed = await revealHiddenTarget(page, step.targetDescription).catch(() => null);
    if (revealed) {
      obs.increment('worker.reveal_recovered', { action: step.action });
      runLog?.log('resolve', `revealed hidden "${(step.targetDescription ?? '').slice(0, 40)}" → ${revealed}`, { stepIndex, data: { selector: revealed } });
      selectorSet = {
        selectors: [{ selector: revealed, strategy: 'css', confidence: 1 }],
        fromCache: false, cacheSource: null, resolutionSource: 'reveal', similarityScore: null,
        tokensUsed: selectorSet.tokensUsed, // the failed resolution's spend stays on the books
      };
    }
  }

  // Assertions must never be persisted to the selector cache — re-verify every run.
  const ASSERTION_ACTIONS = new Set([
    'assert_text', 'assert_not_text', 'assert_visible', 'assert_not_visible',
    'assert_url', 'assert_title', 'assert_enabled', 'assert_disabled', 'assert_checked', 'assert_not_checked',
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

  // URL before the action, so we can tell whether this step navigated.
  const urlBefore = (() => { try { return (page as { url?: () => string }).url?.() ?? ''; } catch { return ''; } })();

  // Photograph the page BEFORE the action that is about to change it. Keys come
  // back to Node rather than living on `window`, so the comparison survives the
  // navigation a submit causes. One evaluate, no model call.
  const dialogsBefore = delta.dialogs.count;
  // The state of the control this action targets, read BEFORE it runs — so that
  // an action which leaves it exactly as it found it can be recognised as a no-op
  // afterwards (see captureWhatChanged). Only for actions whose effect on their
  // own target is readable; null means "could not tell", never "unchanged".
  const noopTargetSelector = selectorSet.selectors[0]?.selector ?? null;
  let controlBefore: string | null = null;
  if (delta.enabled && STATE_CHANGING_ACTIONS.has(step.action)) {
    delta.baseline = await captureDeltaBaseline(page);
    if (noopTargetSelector && NOOP_DETECTABLE_ACTIONS.has(step.action)) {
      controlBefore = await readControlState(page, noopTargetSelector);
    }
  }

  try {
    result = await engine.executeStep(step, selectorSet, page);
  } catch (e: any) {
    result = { status: 'failed', selectorUsed: null, durationMs: 0, errorType: null, errorMessage: e.message ?? null, screenshotKey: null, domSnapshotKey: null };
    stepError = e;
  }

  // ── Reveal-retry: the action failed on an element that is hover-hidden ─────
  // The resolution-time reveal gate above only fires when resolution came back
  // EMPTY or suspect. But once the cache has learned the right selector for a
  // menu item (Buzzly's profile "Block" inside the "⋯" menu), resolution
  // SUCCEEDS — and the click then dies on a hidden element, handing the healing
  // chain a chance to re-resolve onto a name-mismatched neighbour ("More
  // options"). Before healing gets it, do what a human does: hover the trigger,
  // verify the named target became visible, retry the action on it. Adopted
  // only when the retried action passes; otherwise the failure path proceeds
  // exactly as before. Spec: docs/specs/workers/spec-hover-reveal-scroll-find.md §1
  if (result.status === 'failed' && RETRYABLE_INTERACTIONS.has(step.action) && step.targetDescription && recoveryBudgetLeft() > 6_000) {
    const revealed = await revealHiddenTarget(page, step.targetDescription).catch(() => null);
    if (revealed) {
      const revealSet: SelectorSet = {
        selectors: [{ selector: revealed, strategy: 'css', confidence: 1 }],
        fromCache: false, cacheSource: null, resolutionSource: 'reveal', similarityScore: null,
        tokensUsed: selectorSet.tokensUsed, // the original resolution's spend stays on the books
      };
      const retry = await engine.executeStep(step, revealSet, page).catch(() => null);
      if (retry && retry.status === 'passed') {
        obs.increment('worker.reveal_recovered', { action: step.action });
        runLog?.log('resolve', `action failed on hidden "${(step.targetDescription ?? '').slice(0, 40)}" — hover-revealed → ${revealed}`, { stepIndex, data: { selector: revealed } });
        selectorSet = revealSet;
        result = retry;
        stepError = null;
      }
    }
  }

  // If this step navigated (login, category nav, an <a> click), let the destination SETTLE
  // before the next step resolves — the first interaction after a nav (e.g. add-to-cart
  // right after login) must not race a half-rendered page, which yields a transient
  // selector that never caches AND a click that silently no-ops. All waits are bounded so
  // a chatty page (long-poll / websocket) or a never-quiet DOM can never hang the run.
  if (result.status !== 'failed') {
    await settleAfterNavigation(page, urlBefore);
  }

  // ── What changed ──────────────────────────────────────────────────────────
  // Recorded once the page has settled, and only for a test that actually
  // carries a delta-scoped oracle. A navigation step throws the memory away:
  // "what changed" across a deliberate page change is the whole page, which
  // would restrict nothing. Spec §1.
  // A closure because TWO success paths need it: the direct pass below, and a
  // HEALED action further down — a heal that re-executed its action changed
  // the page just as a clean pass does, and skipping the capture starved the
  // following delta-scoped assertion into AssertionNoAction (finding #3: the
  // stress site's refresh-stats flow healed the click, then failed the assert
  // for the wrong reason). Spec: docs/specs/bench/spec-changing-sites.md §12 (#3)
  const captureWhatChanged = async (): Promise<void> => {
    if (!delta.enabled) return;
    if (DELTA_CLEARING_ACTIONS.has(step.action)) {
      delta.baseline = null;
      delta.last = null;
      return;
    }
    if (!STATE_CHANGING_ACTIONS.has(step.action) || !delta.baseline) return;

    // An action that left the control it targeted exactly as it found it did
    // NOTHING, and must not be credited with whatever else the page did while it
    // ran. Without this, "clear a box that is already empty" passed whenever the
    // page happened to be rendering on its own at that moment: the baseline was
    // taken before that render, the settle-then-diff after it, so the page's own
    // late rows landed in "what changed" and a later assertion matched them
    // (finding #17; found by the stress site's vacuous-clear must-fail guard,
    // which passed in one round of three). The baseline is dropped as well:
    // the assertion side re-diffs an empty delta against it, which would
    // re-attribute the same late render a second time.
    if (controlBefore !== null && noopTargetSelector) {
      const controlAfter = await readControlState(page, noopTargetSelector);
      if (actionLeftControlUnchanged(step.action, controlBefore, controlAfter)) {
        delta.baseline = null;
        delta.last = {
          elements: [],
          removed: 0,
          afterStep: step.rawText,
          dialogAccepted: delta.dialogs.count > dialogsBefore,
        };
        obs.increment('worker.delta_noop_action', { action: step.action });
        runLog?.log('execute',
          `what changed: nothing — "${(step.targetDescription ?? step.rawText).slice(0, 60)}" was left exactly as it was, ` +
          'so anything the page did on its own is not this step\'s doing',
          { stepIndex, data: { noop: true, action: step.action } });
        return;
      }
    }

    // The click has returned; the app may still be rendering what it did.
    await settleDom(page);
    const after = await captureDeltaFull(page, delta.baseline);
    const changed = after.elements;
    delta.last = {
      elements: changed,
      removed: after.removed,
      afterStep: step.rawText,
      dialogAccepted: delta.dialogs.count > dialogsBefore,
    };
    // "What changed" is page text, and a login step's delta is whatever the
    // app renders around the credential it just accepted. The same rule the
    // rest of this function follows: a secret step writes no evidence.
    if (!secretStep) {
      runLog?.log('execute', `what changed: ${summariseDelta(changed)}`, {
        stepIndex,
        data: { changed: changed.slice(0, 10).map((el) => ({ role: el.role, name: el.name, text: el.text })) },
      });
    }
  };
  if (result.status !== 'failed') {
    await captureWhatChanged();
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
  const afterPng = secretStep ? null : await page.screenshot({ type: 'png' }).catch(() => null);
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
      // A generic action label ("Add to cart" / "Remove") is not the item name. For
      // click_random capture, resolve the item title from the picked element's card —
      // general, so it works on any product grid, not just the seeded e-commerce demos.
      const genericName = capturedValue == null || /^(add to cart|remove|buy|add|select|choose)$/i.test(capturedValue.trim());
      if (genericName && result.selectorUsed) {
        const title = await resolveCardTitle(page, result.selectorUsed).catch(() => null);
        if (title) capturedValue = title;
      }
      if ((capturedValue == null || capturedValue === '') && result.selectorUsed) {
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
    // direct click_random pick whose selector is a transient data-kz-rand marker,
    // and for a hover-reveal pass whose data-kz-reveal stamp dies with the page —
    // persisting it would poison the next run's resolution with a dead selector.
    const cacheable = !isAssertion && step.action !== 'click_random' && selectorSet.resolutionSource !== 'reveal';
    if (result.selectorUsed && cacheable) {
      await resolver.recordSuccess(step.targetHash, domain, result.selectorUsed, tenantId).catch((e: any) =>
        obs.log('warn', 'worker.record_success_failed', { error: e.message }),
      );
    }

    // Archetype learning: when the LLM resolved this step, try to promote the
    // picked element's accessible name into the archetype library so future runs
    // on any site with the same accessible name skip the LLM entirely.
    // Skip for assertions — we never want to learn an archetype from a verify
    // step whose element name may be run-specific data.
    // Skip behind auth — element_archetypes is global, tenant-free AND domain-free
    // (015_element_archetypes.sql), so learning from a signed-in page would publish
    // a customer's private UI vocabulary to everyone. Spec: §4.1, §12 threat 3.
    if (!isAssertion && !behindAuth && selectorSet.resolutionSource === 'llm' && selectorSet.llmPickedKaizenId && selectorSet.candidates) {
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
      // Canonical form (origin + pathname): a CMP iframe's query carries per-session
      // tokens that would make the timeline unreadable and differ on every run.
      frameUrl: canonicalFrameUrl(selectorSet.frameUrl),
    }, attempt);
    await runLog?.flush();
    return { status: 'passed', healed: false, afterPng };
  }

  // ── Failure path: classify → heal ─────────────────────────────────────────
  await resolver.recordFailure(step.targetHash, domain, selectorSet.selectors[0]?.selector ?? '', tenantId).catch((e: any) =>
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
    null,    // capturedName — a failed step captured nothing
    null,    // capturedValue
    canonicalFrameUrl(selectorSet.frameUrl),
  );

  const classifiedFailure: ClassifiedFailure = {
    stepResult: result as any,
    stepResultId: stepResultId ?? undefined,
    failureClass,
    step,
    previousSelector: selectorSet.selectors[0]?.selector ?? '',
  };

  // The heal chain's waits (AdaptiveWait alone can sit 20s) must not START when
  // the watchdog is about to kill them mid-flight — a half-finished heal records
  // confusing partial evidence and wastes an LLM call, while an honest classified
  // failure right now keeps the evidence whole (finding #10b).
  if (recoveryBudgetLeft() < 10_000) {
    obs.increment('worker.heal_skipped_no_budget', { failureClass });
    runLog?.log('heal',
      `step ${String(stepIndex + 1).padStart(2, '0')} failed (${failureClass}) — no time budget left for healing (${Math.round((Date.now() - stepStart) / 1000)}s spent of the ${Math.round(STEP_WATCHDOG_MS / 1000)}s watchdog); failing honestly`,
      { stepIndex, level: 'error', data: { failureClass, spentMs: Date.now() - stepStart } });
    await runLog?.flush();
    return { status: 'failed', healed: false, afterPng };
  }

  runLog?.log('heal', `step ${String(stepIndex + 1).padStart(2, '0')} failed (${failureClass}) — attempting heal`, { stepIndex, level: 'warn', data: { failureClass } });

  const healingResult = await healingEngine.heal(classifiedFailure, {
    tenantId, runId, page, domain,
    // Hard watchdog cutoff minus margin — lets AdaptiveWait be exactly as
    // patient as the step can afford, instead of a fixed 10s (finding #10b).
    deadlineAt: stepStart + STEP_WATCHDOG_MS - 5_000,
  });

  // An assertion that healed by RE-RESOLVING its target verified an element the
  // test never named — the resolver picked it only after the named one was not
  // found. Certifying that as a pass is how a run still sitting on the login
  // page could satisfy "verify the user is signed in". The heal is recorded
  // either way; what changes is that it no longer counts as proof.
  // Spec: docs/specs/test-writer/spec-validation-trust.md §9
  if (healingResult.succeeded && !healCertifiesAssertion(step.action, healingResult.strategyUsed)) {
    obs.increment('worker.assertion_heal_rejected', { strategy: healingResult.strategyUsed ?? 'unknown' });
    if (stepResultId) {
      await tenantQuery(
        tenantId,
        `UPDATE step_results SET selector_used = $1, error_type = 'AssertionHealedOntoDifferentElement' WHERE id = $2`,
        [healingResult.newSelector, stepResultId],
      ).catch((e: any) => obs.log('warn', 'worker.healed_update_failed', { error: e.message }));
    }
    runLog?.log('heal',
      `heal found a different element for an assertion (${healingResult.strategyUsed}) — not treated as verified`,
      { stepIndex, level: 'error', data: { strategy: healingResult.strategyUsed, newSelector: healingResult.newSelector } });
    await runLog?.flush();
    return { status: 'failed', healed: false, afterPng };
  }

  if (healingResult.succeeded) {
    // A strategy "succeeding" means it LOCATED a live element — not that the
    // action ran. Until 2026-10-08 the step was marked healed right here, so a
    // wait-strategy heal of a click was a PHANTOM: the click never dispatched,
    // the run continued green past an action that never happened (changing-
    // sites bench, stress site: 20s-late widget "healed" with no effect; the
    // following assertion failed honestly — but a test ending on the click
    // would have been a false-pass). A heal of an ACTION now re-executes the
    // step against the healed selector and only counts when that passes.
    // Assertions keep their own stricter gate above (healCertifiesAssertion).
    if (!step.action.startsWith('assert')) {
      const healedSet: SelectorSet = {
        ...selectorSet,
        selectors: [{
          selector: healingResult.newSelector ?? classifiedFailure.previousSelector,
          strategy: selectorSet.selectors[0]?.strategy ?? 'css',
          confidence: 1,
        }],
      };

      // S4 — a heal that could not earn the cache on name evidence. Measure,
      // BEFORE the healed action runs, whether the text the next assertion
      // expects is already on the page: if it is, that assertion can never tell
      // us which element was clicked, and the heal stays uncached. A proving run
      // never defers — it must not teach the cache anything about its oracle.
      let pendingHeal: PendingHeal | null = null;
      if (healingResult.deferredPersist && deferredHeals && !isProvingRun) {
        const outcomeText = deferredHeals.outcomeTextAfter(stepIndex);
        pendingHeal = {
          stepIndex,
          persist: healingResult.deferredPersist,
          outcomeText,
          outcomePresentBefore: outcomeText ? await pageShowsText(page, outcomeText) : null,
        };
      }

      const retry = await engine.executeStep(step, healedSet, page).catch((e: any) => ({
        status: 'failed' as const, errorType: 'HealRetryThrew', errorMessage: e?.message,
      }));
      if (retry.status !== 'passed') {
        obs.increment('worker.heal_retry_failed', { failureClass, strategy: healingResult.strategyUsed ?? 'unknown' });
        runLog?.log('heal',
          `heal located an element but the retried action still failed (${healingResult.strategyUsed}) — not a heal`,
          { stepIndex, level: 'error', data: { strategy: healingResult.strategyUsed, newSelector: healingResult.newSelector } });
        await runLog?.flush();
        return { status: 'failed', healed: false, afterPng };
      }
      // The healed action ran and passed — feed the delta memory exactly as a
      // clean pass would, so a following delta-scoped assertion judges what the
      // action produced instead of erroring AssertionNoAction (finding #3).
      await captureWhatChanged();
      if (pendingHeal) deferredHeals!.record(pendingHeal);
    }
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
      await tenantQuery(
        tenantId,
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
        await markRunComplete(job.data.tenantId, job.data.runId, 'failed').catch(() => { });
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
