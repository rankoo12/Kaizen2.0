/**
 * Test Writer service entrypoint — kaizen-testwriter consumer.
 *
 * Owns its own BrowserPool (never the run-worker's — long-lived crawl page
 * loads must not starve run throughput) and drives the RECON pipeline per job.
 * Same deployment-seam pattern as the screenshot/persistence services.
 *
 * Spec: docs/specs/test-writer/spec-test-writer-service.md §3
 */

import dotenv from 'dotenv';
dotenv.config();

import { materializeGcsKeyFromEnv } from '../../bootstrap/gcs-key-from-env';
materializeGcsKeyFromEnv();

import pino from 'pino';
import { Worker } from 'bullmq';
import { PinoObservability } from '../../modules/observability/pino.observability';
import { ScreenshotService } from '../../modules/media/screenshot.service';
import { PlaywrightDOMPruner } from '../../modules/dom-pruner/playwright.dom-pruner';
import { PageChallengeDetector } from '../../modules/execution-engine/challenge-detector';
import { ReconCrawler } from '../../modules/test-writer/recon/crawler';
import { SiteModelRepository } from '../../modules/test-writer/site-model.repository';
import { runTestWriterJob } from '../../modules/test-writer/pipeline';
import { PageClassifier } from '../../modules/test-writer/comprehend/classifier';
import { AppBriefSynthesizer } from '../../modules/test-writer/comprehend/synthesizer';
import { TestPlanner } from '../../modules/test-writer/plan/test-planner';
import { ScenarioWriter } from '../../modules/test-writer/write/scenario-writer';
import { ValidationRunner } from '../../modules/test-writer/validate/validation-runner';
import { OpenAITestWriterGateway } from '../../modules/llm-gateway/testwriter.gateway';
import { OpenAIGateway } from '../../modules/llm-gateway/openai.gateway';
import { PostgresBillingMeter } from '../../modules/billing-meter/postgres.billing-meter';
import { BrowserPool } from '../../workers/browser-pool';
import { PlaywrightExecutionEngine } from '../../modules/execution-engine/playwright.execution-engine';
import { CompositeElementResolver } from '../../modules/element-resolver/composite.element-resolver';
import { CachedElementResolver } from '../../modules/element-resolver/cached.element-resolver';
import { LLMElementResolver } from '../../modules/element-resolver/llm.element-resolver';
import { ArchetypeElementResolver } from '../../modules/element-resolver/archetype.element-resolver';
import { DBArchetypeResolver } from '../../modules/element-resolver/db.archetype-resolver';
import {
  createRedisConnection, createRunQueue, TESTWRITER_QUEUE_NAME, type TestWriterJobPayload,
} from '../../queue';
import { closePool } from '../../db/pool';

const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  ...(process.env.NODE_ENV === 'development' && {
    transport: { target: 'pino-pretty' },
  }),
});

const obs = new PinoObservability(logger);
const pool = new BrowserPool();
const domPruner = new PlaywrightDOMPruner();

// ── Login-recipe execution seam (P3) ─────────────────────────────────────────
// The crawler needs to RUN the tenant's sign-in test before the BFS starts, so
// it needs the same engine + resolver the worker uses. One deliberate
// difference: LLMElementResolver is constructed WITHOUT a SharedPoolService.
//
// Copying the worker's wiring verbatim would silently break the absolute
// shared-pool prohibition — `persistToCache` contributes to `selector_cache`
// rows with `is_shared = true, tenant_id NULL`, which every other tenant on the
// same domain reads. Behind a login wall those selectors describe a customer's
// private app. The tenant's OWN cache still fills, which is what keeps an
// authenticated draft's login prefix cheap.
// Spec: docs/specs/test-writer/spec-authenticated-scope.md §4.1, §12 threat 3.
const cacheRedis = createRedisConnection();
cacheRedis.on('error', (err) =>
  obs.log('warn', 'redis.cache_connection_error', { error: err.message }));

const llm = new OpenAIGateway(new PostgresBillingMeter(obs), obs, undefined, cacheRedis);
const authResolver = new CompositeElementResolver(
  [
    new ArchetypeElementResolver(domPruner, new DBArchetypeResolver(obs), obs),
    new CachedElementResolver(cacheRedis, llm, obs),
    new LLMElementResolver(domPruner, llm, obs, /* sharedPool */ undefined, cacheRedis),
  ],
  obs,
  llm,
);

const crawler = new ReconCrawler({
  pool,
  surveyor: domPruner,
  challenges: new PageChallengeDetector(),
  obs,
  screenshots: new ScreenshotService(obs),
  auth: {
    engine: new PlaywrightExecutionEngine(obs),
    resolver: authResolver,
  },
});
const repository = new SiteModelRepository();

// Generation stack: one LLM seam, one run queue (validation runs ride the same
// kaizen-runs queue as any other test — a generated test is proven by the same
// worker that will execute it in production).
const gateway = new OpenAITestWriterGateway(new PostgresBillingMeter(obs), obs);
const runQueue = createRunQueue();
const deps = {
  crawler,
  repository,
  obs,
  gateway,
  classifier: new PageClassifier(gateway, repository, obs),
  synthesizer: new AppBriefSynthesizer(gateway, repository, obs),
  planner: new TestPlanner(gateway, obs),
  writer: new ScenarioWriter(gateway, obs),
  validator: new ValidationRunner(runQueue, obs),
  // Compiles login-recipe steps that have no stored AST (spec §4.1). Billed to
  // the job's tenant, and never written to the global compile cache when the
  // step carries a literal value (§12.3).
  llm,
};

const worker = new Worker<TestWriterJobPayload>(
  TESTWRITER_QUEUE_NAME,
  (job) => runTestWriterJob(job.data, deps),
  {
    connection: createRedisConnection(),
    // Crawl jobs are heavyweight (one browser context each, minutes long).
    concurrency: Number(process.env.TESTWRITER_CONCURRENCY ?? 1),
  },
);

worker.on('failed', (job, err) => {
  obs.log('warn', 'testwriter.queue_job_failed', { jobId: job?.id, error: err.message });
});
// Without an 'error' listener, a transient Redis blip becomes an unhandled
// EventEmitter error and kills the process. BullMQ reconnects on its own.
worker.on('error', (err) => {
  obs.log('warn', 'testwriter.worker_error', { error: err.message });
});

const shutdown = async (signal: string): Promise<void> => {
  logger.info({ event: 'shutdown', signal });
  await worker.close();
  await pool.close();
  await closePool();
  process.exit(0);
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

logger.info({ event: 'testwriter_service_started', queue: TESTWRITER_QUEUE_NAME });
