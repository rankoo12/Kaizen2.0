/**
 * Element Archetype Seed Script
 * Spec ref: Smart Brain Layer 0 — spec-smart-brain-layer0.md
 *
 * Reads db/seeds/element_archetypes.sql and executes it against the configured DB.
 * Idempotent — safe to run multiple times (SQL uses ON CONFLICT DO NOTHING).
 *
 * Usage:
 *   npm run archetypes:seed
 *
 * Requirements:
 *   - Postgres must be running (uses DATABASE_URL from .env)
 */

import dotenv from 'dotenv';
dotenv.config();

import { readFileSync } from 'fs';
import { join } from 'path';
import pino from 'pino';
import { getPool, closePool } from '../src/db/pool';

const logger = pino({
  level: 'info',
  transport: { target: 'pino-pretty' },
});

async function main(): Promise<void> {
  const sqlPath = join(__dirname, '..', 'db', 'seeds', 'element_archetypes.sql');
  const sql = readFileSync(sqlPath, 'utf-8');

  logger.info({ event: 'archetypes_seed_start', file: sqlPath });

  try {
    await getPool().query(sql);

    const { rows } = await getPool().query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM element_archetypes`,
    );

    logger.info({
      event: 'archetypes_seed_complete',
      totalRows: parseInt(rows[0].count, 10),
    });
  } finally {
    await closePool();
  }
}

main().catch((e) => {
  logger.error({ event: 'archetypes_seed_failed', error: e.message });
  process.exit(1);
});
