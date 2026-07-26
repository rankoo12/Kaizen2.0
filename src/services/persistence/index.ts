/**
 * Persistence service entrypoint — Phase 2 extraction.
 *
 * Runs the SAME startPersistenceConsumer the worker co-locates in Phase 1, as
 * its own process/container: kaizen-persist → Postgres (step_results +
 * run_events). No logic change — this file is a deployment seam only. When
 * this service runs, start the worker with DISABLE_INPROCESS_CONSUMERS=1 so
 * jobs aren't split between two consumers (safe either way — writes are
 * idempotent — but pointless).
 *
 * Spec: docs/specs/workers/spec-service-decomposition.md §3, §8 (P2)
 */

import dotenv from 'dotenv';
dotenv.config();

import pino from 'pino';
import { PinoObservability } from '../../modules/observability/pino.observability';
import { closePool } from '../../db/pool';
import { createRedisConnection, PERSIST_QUEUE_NAME } from '../../queue';
import { startPersistenceConsumer } from '../../workers/consumers/persistence.consumer';

const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  ...(process.env.NODE_ENV === 'development' && {
    transport: { target: 'pino-pretty' },
  }),
});

const obs = new PinoObservability(logger);
const redis = createRedisConnection();
const consumer = startPersistenceConsumer({ redis, obs });

const shutdown = async (signal: string): Promise<void> => {
  logger.info({ event: 'shutdown', signal });
  await consumer.close();
  await closePool();
  redis.disconnect();
  process.exit(0);
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

logger.info({ event: 'persistence_service_started', queue: PERSIST_QUEUE_NAME });
