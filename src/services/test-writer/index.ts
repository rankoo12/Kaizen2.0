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
import { BrowserPool } from '../../workers/browser-pool';
import { createRedisConnection, TESTWRITER_QUEUE_NAME, type TestWriterJobPayload } from '../../queue';
import { closePool } from '../../db/pool';

const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  ...(process.env.NODE_ENV === 'development' && {
    transport: { target: 'pino-pretty' },
  }),
});

const obs = new PinoObservability(logger);
const pool = new BrowserPool();
const crawler = new ReconCrawler({
  pool,
  surveyor: new PlaywrightDOMPruner(),
  challenges: new PageChallengeDetector(),
  obs,
  screenshots: new ScreenshotService(obs),
});
const repository = new SiteModelRepository();

const worker = new Worker<TestWriterJobPayload>(
  TESTWRITER_QUEUE_NAME,
  (job) => runTestWriterJob(job.data, { crawler, repository, obs }),
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
