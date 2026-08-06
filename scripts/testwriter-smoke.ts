/**
 * Test Writer calibration job — the full pipeline end to end, in process.
 *
 * Usage:
 *   npx tsx scripts/testwriter-smoke.ts [targetUrl] [maxPages] [maxScenarios] [validate]
 *   defaults: https://books.toscrape.com 3 2 false
 *
 * With validate=true a worker must be running (npm run dev:worker) to consume
 * the kaizen-runs queue. Prints the phase report and the drafts produced, so
 * the token/wall-clock estimates in the spec can be checked against reality.
 *
 * Spec: docs/specs/test-writer/spec-generation-pipeline.md §7 (live acceptance)
 */

import dotenv from 'dotenv';
dotenv.config();

import pino from 'pino';
import { PinoObservability } from '../src/modules/observability/pino.observability';
import { PlaywrightDOMPruner } from '../src/modules/dom-pruner/playwright.dom-pruner';
import { PageChallengeDetector } from '../src/modules/execution-engine/challenge-detector';
import { ReconCrawler } from '../src/modules/test-writer/recon/crawler';
import { SiteModelRepository } from '../src/modules/test-writer/site-model.repository';
import { PageClassifier } from '../src/modules/test-writer/comprehend/classifier';
import { AppBriefSynthesizer } from '../src/modules/test-writer/comprehend/synthesizer';
import { TestPlanner } from '../src/modules/test-writer/plan/test-planner';
import { ScenarioWriter } from '../src/modules/test-writer/write/scenario-writer';
import { ValidationRunner } from '../src/modules/test-writer/validate/validation-runner';
import { OpenAITestWriterGateway } from '../src/modules/llm-gateway/testwriter.gateway';
import { PostgresBillingMeter } from '../src/modules/billing-meter/postgres.billing-meter';
import { runTestWriterJob } from '../src/modules/test-writer/pipeline';
import { BrowserPool } from '../src/workers/browser-pool';
import { createRunQueue } from '../src/queue';
import { getPool, closePool } from '../src/db/pool';

const targetUrl = process.argv[2] ?? 'https://books.toscrape.com';
const maxPages = Number(process.argv[3] ?? 3);
const maxScenarios = Number(process.argv[4] ?? 2);
const validate = (process.argv[5] ?? 'false') === 'true';

async function main(): Promise<void> {
  const logger = pino({ level: 'info', transport: { target: 'pino-pretty' } });
  const obs = new PinoObservability(logger);
  const db = getPool();

  const { rows: tenants } = await db.query<{ id: string }>(
    `SELECT id FROM tenants ORDER BY created_at LIMIT 1`);
  if (tenants.length === 0) throw new Error('No tenant in the database.');
  const tenantId = tenants[0].id;

  // One suite per target host: a suite's site model is the model of ONE app, so
  // pointing two different domains at the same suite would blend them.
  const suiteName = `Test Writer Smoke — ${new URL(targetUrl).host}`;
  await db.query(
    `INSERT INTO test_suites (tenant_id, name, description)
     SELECT $1, $2, 'Full pipeline calibration target'
     WHERE NOT EXISTS (SELECT 1 FROM test_suites WHERE tenant_id = $1 AND name = $2)`,
    [tenantId, suiteName]);
  const { rows: suites } = await db.query<{ id: string }>(
    `SELECT id FROM test_suites WHERE tenant_id = $1 AND name = $2`, [tenantId, suiteName]);
  const suiteId = suites[0].id;

  // Consent ON so the synthetic-safe archetypes can be exercised end to end.
  await db.query(`UPDATE test_suites SET allow_synthetic_data = true WHERE id = $1`, [suiteId]);

  const options = {
    maxPages, maxScenarios, includeNegative: true, safeMode: true, validate,
    planApproval: 'auto' as const,
  };
  const { rows: jobs } = await db.query<{ id: string }>(
    `INSERT INTO generation_jobs (tenant_id, suite_id, target_url, scope, options)
     VALUES ($1, $2, $3, 'public', $4) RETURNING id`,
    [tenantId, suiteId, targetUrl, JSON.stringify(options)]);
  const jobId = jobs[0].id;

  const gateway = new OpenAITestWriterGateway(new PostgresBillingMeter(obs), obs);
  const repository = new SiteModelRepository();
  const browserPool = new BrowserPool();
  const runQueue = createRunQueue();

  const { rows: before } = await db.query<{ total: string }>(
    `SELECT COALESCE(SUM(quantity), 0) AS total FROM billing_events
     WHERE tenant_id = $1 AND event_type = 'LLM_CALL'`, [tenantId]);

  const startedAt = Date.now();
  await runTestWriterJob(
    {
      jobId, tenantId, suiteId, targetUrl,
      scope: 'public', authConsent: false, options,
    },
    {
      crawler: new ReconCrawler({
        pool: browserPool,
        surveyor: new PlaywrightDOMPruner(),
        challenges: new PageChallengeDetector(),
        obs,
      }),
      repository, obs, gateway,
      classifier: new PageClassifier(gateway, repository, obs),
      synthesizer: new AppBriefSynthesizer(gateway, repository, obs),
      planner: new TestPlanner(gateway, obs),
      writer: new ScenarioWriter(gateway, obs),
      validator: new ValidationRunner(runQueue, obs),
    },
  );

  const { rows: after } = await db.query<{ total: string }>(
    `SELECT COALESCE(SUM(quantity), 0) AS total FROM billing_events
     WHERE tenant_id = $1 AND event_type = 'LLM_CALL'`, [tenantId]);

  const { rows: jobRows } = await db.query(
    `SELECT status, error, test_plan, report FROM generation_jobs WHERE id = $1`, [jobId]);
  const { rows: drafts } = await db.query(
    `SELECT tc.name, tc.status, tc.archetype_key,
            (SELECT COUNT(*) FROM test_case_steps s WHERE s.case_id = tc.id) AS steps
     FROM test_cases tc
     WHERE tc.generation_job_id = $1 ORDER BY tc.created_at`, [jobId]);
  const { rows: stepSample } = await db.query<{ raw_text: string; has_ast: boolean }>(
    `SELECT ts.raw_text, ts.compiled_ast IS NOT NULL AS has_ast
     FROM test_steps ts
     JOIN test_cases tc ON tc.id = ts.case_id
     WHERE tc.generation_job_id = $1 ORDER BY tc.created_at, ts.position LIMIT 20`, [jobId]);

  logger.info({
    durationMs: Date.now() - startedAt,
    tokensSpent: Number(after[0].total) - Number(before[0].total),
    job: jobRows[0],
    drafts,
    stepSample,
  }, 'test writer smoke finished');

  await browserPool.close();
  await runQueue.close();
  await closePool();
  process.exit(0);
}

main().catch((err) => {
  console.error('test writer smoke failed:', err);
  process.exit(1);
});
