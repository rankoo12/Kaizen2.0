/**
 * Global Brain Seeding Script
 * Spec ref: kaizen-phase4-spec.md §6
 *
 * Pre-populates the shared selector pool with verified selectors for common SaaS UIs.
 * Run from a Windows terminal with real DNS access:
 *
 *   npm run brain:seed
 *   npm run brain:seed -- --dry-run
 *
 * Requirements:
 *   - Postgres + Redis must be running (uses .env)
 *   - OPENAI_API_KEY must be set (real LLM calls for embeddings)
 *   - DNS must be available (run from Windows terminal, not the bash shell)
 */

import dotenv from 'dotenv';
dotenv.config();

import { createHash } from 'crypto';
import { chromium } from 'playwright';
import pino from 'pino';
import { PinoObservability } from '../src/modules/observability/pino.observability';
import { PostgresBillingMeter } from '../src/modules/billing-meter/postgres.billing-meter';
import { OpenAIGateway } from '../src/modules/llm-gateway/openai.gateway';
import { PlaywrightDOMPruner } from '../src/modules/dom-pruner/playwright.dom-pruner';
import { getPool, closePool } from '../src/db/pool';
import { createRedisConnection } from '../src/queue';

// ─── Types ────────────────────────────────────────────────────────────────────

type SeedTarget = {
  domain: string;
  url: string;
  steps: string[];
};

// ─── Seed Manifest ────────────────────────────────────────────────────────────

const SEED_MANIFEST: SeedTarget[] = [
  {
    domain: 'github.com',
    url: 'https://github.com/login',
    steps: [
      'type in the username or email field',
      'type in the password field',
      'click the Sign in button',
    ],
  },
  {
    domain: 'github.com',
    url: 'https://github.com',
    steps: [
      'click the Sign in link',
      'click the Sign up button',
    ],
  },
  {
    domain: 'login.salesforce.com',
    url: 'https://login.salesforce.com',
    steps: [
      'type in the email field',
      'type in the password field',
      'click the Log In button',
    ],
  },
  {
    domain: 'accounts.google.com',
    url: 'https://accounts.google.com',
    steps: [
      'type in the email field',
      'click the Next button',
      'type in the password field',
    ],
  },
  {
    domain: 'app.slack.com',
    url: 'https://slack.com/signin',
    steps: [
      'type in the email field',
      'click the Continue button',
    ],
  },
  {
    domain: 'linkedin.com',
    url: 'https://www.linkedin.com/login',
    steps: [
      'type in the email field',
      'type in the password field',
      'click the Sign in button',
    ],
  },
  {
    domain: 'twitter.com',
    url: 'https://twitter.com/login',
    steps: [
      'type in the phone, email, or username field',
      'click the Next button',
      'type in the password field',
      'click the Log in button',
    ],
  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function contentHash(rawText: string): string {
  return createHash('sha256').update(rawText.trim().toLowerCase()).digest('hex');
}

async function upsertSharedEntry(params: {
  contentHash: string;
  domain: string;
  selectors: object[];
  stepEmbedding: number[];
  elementEmbedding: number[] | null;
  dryRun: boolean;
}): Promise<'seeded' | 'skipped' | 'updated'> {
  const toSQL = (v: number[]) => '[' + v.join(',') + ']';

  // Check if a shared entry already exists (with or without embedding)
  const { rows: existing } = await getPool().query<{ id: string; step_embedding: string | null }>(
    `SELECT id, step_embedding FROM selector_cache
     WHERE content_hash = $1 AND domain = $2 AND is_shared = true AND tenant_id IS NULL
     LIMIT 1`,
    [params.contentHash, params.domain],
  );

  if (existing.length > 0) {
    // Already has an embedding — nothing to do
    if (existing[0].step_embedding !== null) return 'skipped';

    // Exists but no embedding — update it
    if (params.dryRun) return 'updated';
    await getPool().query(
      `UPDATE selector_cache
       SET step_embedding = $1::vector,
           element_embedding = $2,
           selectors = $3,
           updated_at = now()
       WHERE id = $4`,
      [
        toSQL(params.stepEmbedding),
        params.elementEmbedding ? toSQL(params.elementEmbedding) : null,
        JSON.stringify(params.selectors),
        existing[0].id,
      ],
    );
    return 'updated';
  }

  if (params.dryRun) return 'seeded';

  const attribution = {
    source: 'seed',
    contributors: [],
    seededAt: new Date().toISOString(),
  };

  await getPool().query(
    `INSERT INTO selector_cache
       (tenant_id, content_hash, domain, selectors, step_embedding, element_embedding,
        confidence_score, is_shared, attribution)
     VALUES (NULL, $1, $2, $3, $4::vector, $5, 1.0, true, $6)
     ON CONFLICT DO NOTHING`,
    [
      params.contentHash,
      params.domain,
      JSON.stringify(params.selectors),
      toSQL(params.stepEmbedding),
      params.elementEmbedding ? toSQL(params.elementEmbedding) : null,
      JSON.stringify(attribution),
    ],
  );

  return 'seeded';
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');

  const logger = pino({
    level: 'info',
    transport: { target: 'pino-pretty' },
  });

  if (dryRun) {
    logger.info('DRY RUN — no DB writes will be made');
  }

  const obs = new PinoObservability(logger);
  const billing = new PostgresBillingMeter(obs);
  const redis = createRedisConnection();
  const llm = new OpenAIGateway(billing, obs, undefined, redis);
  const domPruner = new PlaywrightDOMPruner();

  let totalSeeded = 0;
  let totalSkipped = 0;
  let totalFailed = 0;

  const browser = await chromium.launch({ headless: true });

  try {
    for (const target of SEED_MANIFEST) {
      logger.info({ event: 'target_start', domain: target.domain, url: target.url });

      const context = await browser.newContext({ baseURL: target.url });
      const page = await context.newPage();

      try {
        await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      } catch (e: any) {
        logger.warn({ event: 'navigation_failed', url: target.url, error: e.message });
        await context.close();
        totalFailed += target.steps.length;
        continue;
      }

      for (const stepText of target.steps) {
        const hash = contentHash(stepText);

        const step = {
          action: 'click' as const,
          rawText: stepText,
          contentHash: hash,
          targetDescription: stepText,
          url: null,
          key: null,
          value: null,
        };

        try {
          // Resolve directly — bypass LLMElementResolver to avoid persistToCache side effects
          const candidates = await domPruner.prune(page, stepText);
          if (candidates.length === 0) {
            logger.warn({ event: 'step_no_candidates', step: stepText, domain: target.domain });
            totalFailed++;
            continue;
          }

          const llmResult = await llm.resolveElement(step, candidates, 'seed-script');

          // Validate selectors live on the page
          const validSelectors = [];
          for (const sel of llmResult.selectors) {
            try {
              const handle = await page.$(sel.selector);
              if (handle !== null) validSelectors.push(sel);
            } catch { /* skip invalid */ }
          }

          if (validSelectors.length === 0) {
            logger.warn({ event: 'step_no_selectors', step: stepText, domain: target.domain });
            totalFailed++;
            continue;
          }

          // Generate step embedding
          const stepEmbedding = await llm.generateEmbedding(stepText);

          const result = await upsertSharedEntry({
            contentHash: hash,
            domain: target.domain,
            selectors: validSelectors,
            stepEmbedding,
            elementEmbedding: null,
            dryRun,
          });

          logger.info({
            event: `step_${result}`,
            step: stepText,
            domain: target.domain,
            selector: validSelectors[0]?.selector,
          });

          if (result === 'seeded' || result === 'updated') totalSeeded++;
          else totalSkipped++;
        } catch (e: any) {
          logger.error({ event: 'step_failed', step: stepText, domain: target.domain, error: e.message });
          totalFailed++;
        }
      }

      await context.close();
    }
  } finally {
    await browser.close();
    await redis.quit();
    await closePool();
  }

  logger.info({
    event: 'seed_complete',
    seeded: totalSeeded,
    skipped: totalSkipped,
    failed: totalFailed,
    dryRun,
  });

  if (totalFailed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
