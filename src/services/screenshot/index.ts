/**
 * Screenshot service entrypoint — Phase 2 extraction.
 *
 * Runs the SAME startScreenshotConsumer the worker co-locates in Phase 1, as
 * its own process/container: kaizen-screenshots → GCS (or local disk). No
 * logic change — this file is a deployment seam only. When this service runs,
 * start the worker with DISABLE_INPROCESS_CONSUMERS=1 so jobs aren't split
 * between two consumers (safe either way — uploads are idempotent — but
 * pointless).
 *
 * Spec: docs/specs/workers/spec-service-decomposition.md §3, §8 (P2)
 */

import dotenv from 'dotenv';
dotenv.config();

import { materializeGcsKeyFromEnv } from '../../bootstrap/gcs-key-from-env';
materializeGcsKeyFromEnv();

import pino from 'pino';
import { PinoObservability } from '../../modules/observability/pino.observability';
import { ScreenshotService } from '../../modules/media/screenshot.service';
import { createRedisConnection, SCREENSHOTS_QUEUE_NAME } from '../../queue';
import { startScreenshotConsumer } from '../../workers/consumers/screenshot.consumer';

const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  ...(process.env.NODE_ENV === 'development' && {
    transport: { target: 'pino-pretty' },
  }),
});

const obs = new PinoObservability(logger);
const redis = createRedisConnection();
const screenshots = new ScreenshotService(obs);
const consumer = startScreenshotConsumer({ redis, screenshots, obs });

const shutdown = async (signal: string): Promise<void> => {
  logger.info({ event: 'shutdown', signal });
  await consumer.close();
  redis.disconnect();
  process.exit(0);
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

logger.info({ event: 'screenshot_service_started', queue: SCREENSHOTS_QUEUE_NAME });
