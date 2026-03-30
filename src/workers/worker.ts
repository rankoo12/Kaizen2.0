/**
 * Worker entry point — separate Node.js process.
 *
 * Workers are stateless. They consume jobs from the BullMQ queue (backed by Redis),
 * spin up an isolated Playwright BrowserContext per run, and communicate results
 * back only through the internal API and the job queue.
 *
 * Workers do NOT have direct access to Postgres, Redis (beyond the job queue),
 * or the vector DB. All persistence goes through the API layer.
 *
 * Phase 1 stub — BullMQ queue setup and job handlers will be added in Phase 1.
 */
import dotenv from 'dotenv';

dotenv.config();

const log = (level: 'info' | 'error', msg: string, data?: Record<string, unknown>) =>
  process.stdout.write(
    JSON.stringify({ level, msg, timestamp: new Date().toISOString(), ...data }) + '\n',
  );

log('info', 'Kaizen worker process starting');

const shutdown = (signal: string) => {
  log('info', `Worker received ${signal}, shutting down gracefully`);
  // Phase 1: close BullMQ worker and Playwright browser here before exiting.
  process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
