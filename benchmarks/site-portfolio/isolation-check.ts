/**
 * Site-portfolio bench — behindAuth isolation audit (the §5 negative control).
 * Spec: docs/specs/bench/spec-site-portfolio.md §5
 *
 *   npx tsx benchmarks/site-portfolio/isolation-check.ts
 *
 * After a tenant has run the wp-admin (behindAuth) leg, NOTHING learned behind
 * that auth wall may exist anywhere a second tenant could be served from:
 *
 *   1. SHARED POOL: selector_cache rows with is_shared=true for domain
 *      'site-wp' must contain no admin-surface selector/name. (The PUBLIC
 *      wp-front leg legitimately shares rows on the same domain — the
 *      boundary is the content, so the audit matches admin markers, not the
 *      domain alone.)
 *   2. GLOBAL ARCHETYPES: element_archetypes is tenant-free AND domain-free;
 *      behindAuth runs must not have taught it admin vocabulary.
 *
 * Any hit is a campaign-stopping security finding, appended to campaign.jsonl
 * as a flagged record and exiting non-zero.
 */
import { sql } from '../changing-sites/lib/evidence';
import { appendRecord } from './lib/log';

/** Admin-surface vocabulary that exists ONLY behind wp-login. Lowercase. */
const ADMIN_MARKERS = [
  'at a glance', 'wp-admin', 'howdy', 'dashboard', 'add new post', 'quick draft',
  'site health', 'permalink', 'nickname', 'admin-bar', 'adminmenu', 'wpadminbar',
  'screen options', 'bulk actions',
];

const like = (col: string) => ADMIN_MARKERS.map((m) => `lower(${col}) LIKE '%${m}%'`).join(' OR ');

async function main(): Promise<void> {
  const sharedHits = await sql<{ content_hash: string; selectors: unknown }>(
    `SELECT content_hash, selectors FROM selector_cache
      WHERE is_shared = true AND domain = 'site-wp'
        AND (${like('selectors::text')})`,
  );
  const archetypeHits = await sql<{ name: string; role: string }>(
    `SELECT name, role FROM element_archetypes
      WHERE (${like('name')})`,
  );

  const flags: string[] = [];
  for (const r of sharedHits) {
    flags.push(`ISOLATION-LEAK shared pool: domain=site-wp hash=${r.content_hash.slice(0, 12)} selectors=${JSON.stringify(r.selectors).slice(0, 120)}`);
  }
  for (const a of archetypeHits) {
    flags.push(`ISOLATION-LEAK global archetype: "${a.name}" (${a.role}) carries admin-surface vocabulary`);
  }

  appendRecord({
    at: new Date().toISOString(),
    site: 'wp-admin', siteKind: 'real', loop: 'learning', phase: 'cold',
    tenant: 'AUDIT', model: 'haiku', runIds: [],
    cases: { passed: 0, failed: 0, healed: 0 },
    tokens: { total: 0, perCase: {} }, resolutionLlmSteps: 0,
    sourceHistogram: {}, heals: { attempted: 0, succeeded: 0, byStrategy: {} },
    durationMs: 0, flags,
    notes: `isolation audit: ${sharedHits.length} shared-pool hits, ${archetypeHits.length} archetype hits (0/0 = clean)`,
  });

  if (flags.length > 0) {
    console.error(`ISOLATION AUDIT FAILED (${flags.length} leak(s)):`);
    for (const f of flags) console.error(`  ✗ ${f}`);
    process.exit(1);
  }
  console.log('ISOLATION AUDIT CLEAN: shared pool and global archetypes carry nothing from behind the WordPress auth wall.');
}

main().catch((e) => { console.error(e); process.exit(1); });
