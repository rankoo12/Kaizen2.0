import type { PoolClient } from 'pg';
import { withTenantTransaction } from '../../../db/transaction';
import type { SelectorSeed } from '../write/scenario-writer';

/**
 * Selector pre-seeding — don't pay the model to rediscover what the crawl found.
 * Spec: docs/specs/test-writer/spec-generation-pipeline.md §5.2
 *
 * The generator cites `page_elements` rows, and those rows carry the selector
 * recon extracted. The rendered TEST deliberately drops it — a test binds to
 * meaning ("the Sign in button"), not to `#login2`, which is what makes it
 * survive a redesign. But the selector CACHE is precisely the layer built to
 * hold that knowledge, so we put it there, keyed by the same targetHash the
 * resolver will look up.
 *
 * ISOLATION: tenant-scoped only. `tenant_id` is always set and `is_shared` is
 * left false — the shared/global pool remains off-limits to every Test Writer
 * code path (service spec §11).
 *
 * CACHE HONESTY: a seeded selector is not trusted, only tried. Execution
 * validates it against the live page; if the page drifted since the crawl the
 * step fails, heals, and the cache corrects itself — exactly as for any other
 * cached selector.
 */

/** ARIA-style Playwright selectors are a different strategy than plain CSS. */
function strategyFor(selector: string): string {
  if (selector.startsWith('role=')) return 'aria';
  if (selector.startsWith('[data-testid') || selector.startsWith('[data-qa')) return 'data-testid';
  return 'css';
}

export function domainOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return '';
  }
}

/**
 * Upsert crawler-observed selectors into the tenant's cache.
 * Returns how many rows were written. Never throws: a seeding failure costs
 * tokens on the proving run, it does not invalidate the test.
 */
export async function seedSelectors(
  tenantId: string,
  baseUrl: string,
  seeds: SelectorSeed[],
  client?: PoolClient,
): Promise<number> {
  if (seeds.length === 0) return 0;
  const domain = domainOf(baseUrl);
  if (!domain) return 0;

  const run = async (db: PoolClient): Promise<number> => {
    let written = 0;
    for (const seed of seeds) {
      const selectors = [{
        selector: seed.selector,
        strategy: strategyFor(seed.selector),
        // Observed by the crawler, not yet proven by execution — below the
        // confidence of a selector that has actually driven a passing step.
        confidence: 0.85,
      }];
      const { rowCount } = await db.query(
        `INSERT INTO selector_cache (tenant_id, content_hash, domain, selectors, confidence_score, is_shared)
         VALUES ($1, $2, $3, $4, 0.85, false)
         ON CONFLICT (tenant_id, content_hash, domain) DO NOTHING`,
        [tenantId, seed.targetHash, domain, JSON.stringify(selectors)],
      );
      written += rowCount ?? 0;
    }
    return written;
  };

  try {
    return client ? await run(client) : await withTenantTransaction(tenantId, run);
  } catch {
    return 0;
  }
}
