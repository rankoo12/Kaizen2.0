/**
 * RECON live smoke — drives the real Test Writer pipeline (crawler + site
 * model persistence) against a public site, end to end, without the queue.
 *
 * Usage:
 *   npx tsx scripts/recon-smoke.ts [targetUrl] [maxPages]
 *   (defaults: https://books.toscrape.com, 8 pages)
 *
 * Creates (or reuses) a "Recon Smoke" suite under the first tenant, inserts a
 * generation_jobs row, runs the pipeline, then prints the report and the
 * resulting site-model row counts.
 *
 * Spec: docs/specs/test-writer/spec-recon-crawler.md §8 (live acceptance)
 */

import dotenv from 'dotenv';
dotenv.config();

import pino from 'pino';
import { PinoObservability } from '../src/modules/observability/pino.observability';
import { PlaywrightDOMPruner } from '../src/modules/dom-pruner/playwright.dom-pruner';
import { PageChallengeDetector } from '../src/modules/execution-engine/challenge-detector';
import { ReconCrawler } from '../src/modules/test-writer/recon/crawler';
import { SiteModelRepository } from '../src/modules/test-writer/site-model.repository';
import { runTestWriterJob } from '../src/modules/test-writer/pipeline';
import { BrowserPool } from '../src/workers/browser-pool';
import { getPool, closePool } from '../src/db/pool';

const targetUrl = process.argv[2] ?? 'https://books.toscrape.com';
const maxPages = Number(process.argv[3] ?? 8);

async function main(): Promise<void> {
  const logger = pino({ level: 'info', transport: { target: 'pino-pretty' } });
  const obs = new PinoObservability(logger);
  const db = getPool();

  const { rows: tenants } = await db.query<{ id: string }>(`SELECT id FROM tenants ORDER BY created_at LIMIT 1`);
  if (tenants.length === 0) throw new Error('No tenant in the database — seed one first.');
  const tenantId = tenants[0].id;

  const { rows: suites } = await db.query<{ id: string }>(
    `INSERT INTO test_suites (tenant_id, name, description)
     VALUES ($1, 'Recon Smoke', 'Test Writer recon smoke target')
     ON CONFLICT DO NOTHING RETURNING id`,
    [tenantId],
  );
  const suiteId = suites[0]?.id ?? (await db.query<{ id: string }>(
    `SELECT id FROM test_suites WHERE tenant_id = $1 AND name = 'Recon Smoke'`, [tenantId],
  )).rows[0].id;

  const { rows: jobs } = await db.query<{ id: string }>(
    `INSERT INTO generation_jobs (tenant_id, suite_id, target_url, scope, options)
     VALUES ($1, $2, $3, 'public', $4) RETURNING id`,
    [tenantId, suiteId, targetUrl, JSON.stringify({ maxPages })],
  );
  const jobId = jobs[0].id;
  logger.info({ jobId, tenantId, suiteId, targetUrl, maxPages }, 'recon smoke starting');

  const pool = new BrowserPool();
  const crawler = new ReconCrawler({
    pool,
    surveyor: new PlaywrightDOMPruner(),
    challenges: new PageChallengeDetector(),
    obs,
    // No screenshots in the smoke — keeps it independent of GCS/local media config.
  });

  const startedAt = Date.now();
  await runTestWriterJob(
    {
      jobId, tenantId, suiteId, targetUrl,
      scope: 'public', authConsent: false,
      options: { maxPages, maxScenarios: 6, includeNegative: true, safeMode: true, validate: false },
    },
    { crawler, repository: new SiteModelRepository(), obs },
  );

  const { rows: jobRows } = await db.query(
    `SELECT status, report, error FROM generation_jobs WHERE id = $1`, [jobId]);
  const counts = await db.query<{ pages: string; elements: string; links: string }>(
    `SELECT
       (SELECT COUNT(*) FROM site_pages    WHERE suite_id = $1) AS pages,
       (SELECT COUNT(*) FROM page_elements pe JOIN site_pages sp ON sp.id = pe.page_id WHERE sp.suite_id = $1) AS elements,
       (SELECT COUNT(*) FROM page_links    pl JOIN site_pages sp ON sp.id = pl.from_page_id WHERE sp.suite_id = $1) AS links`,
    [suiteId],
  );
  const { rows: samplePages } = await db.query(
    `SELECT url_normalized, title, content_hash IS NOT NULL AS hashed
     FROM site_pages WHERE suite_id = $1 ORDER BY first_seen_at LIMIT 10`, [suiteId]);

  logger.info({
    durationMs: Date.now() - startedAt,
    job: jobRows[0],
    counts: counts.rows[0],
    samplePages,
  }, 'recon smoke finished');

  await pool.close();
  await closePool();
}

main().catch((err) => {
  console.error('recon smoke failed:', err);
  process.exit(1);
});
