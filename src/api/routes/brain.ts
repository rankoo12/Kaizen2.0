import type { FastifyInstance } from 'fastify';
import { tenantPool } from '../../db/transaction';
import { requireAuth } from '../middleware/auth';

/**
 * The Brain — read-only view of what Kaizen has actually learned.
 *
 * Backs the web UI's Brain screen. Every field is read straight from
 * selector_cache; nothing is derived from guesses:
 *
 *   intent      the English the selector was learned for, recovered from this
 *               tenant's own step_results. NULL when no step of this tenant has
 *               used the entry (the cache row outlives the step, which is the point).
 *   scope       tenant row vs. shared pool row (tenant_id IS NULL AND is_shared).
 *   uses / ok   outcome_window is the last 50 outcomes as booleans, recent-last.
 *   pinned      pinned_at set by a human verdict (see PATCH /runs/../verdict).
 *
 * Shared-pool rows are included only for domains this tenant already has
 * entries on, so the list stays about work the tenant actually does.
 */
export async function brainRoutes(app: FastifyInstance): Promise<void> {
  app.get('/brain/selectors', { preHandler: [requireAuth] }, async (request, reply) => {
    const query = request.query as { limit?: string; domain?: string };
    const limit = Math.min(500, Math.max(1, parseInt(query.limit ?? '200', 10)));
    const { tenantId } = request;

    const pool = tenantPool(tenantId);
    const { rows } = await pool.query(
      `WITH tenant_domains AS (
         SELECT DISTINCT domain FROM selector_cache WHERE tenant_id = $1
         UNION
         -- Domains the tenant actually tests. Needed because a tenant can resolve
         -- entirely out of the shared pool and own no cache rows of its own — the
         -- shared entries are still the memory answering its runs.
         SELECT DISTINCT split_part(split_part(regexp_replace(base_url, '^https?://', ''), '/', 1), ':', 1)
           FROM test_cases WHERE tenant_id = $1
       ),
       -- selector_cache.content_hash holds the step's TARGET hash, so the English is
       -- recovered through step_results.target_hash. Scoped to this tenant's own runs:
       -- shared rows are global, but the step text that named them is not.
       -- Most recent use: the step text, and which test it belongs to.
       intents AS (
         SELECT DISTINCT ON (sr.target_hash)
                sr.target_hash, ts.raw_text,
                tc.id AS case_id, tc.name AS case_name, su.name AS suite_name,
                sr.run_id AS last_run_id, sr.id AS last_step_result_id,
                sr.created_at AS last_used_at
           FROM step_results sr
           JOIN runs r        ON r.id = sr.run_id AND r.tenant_id = $1
           JOIN test_steps ts ON ts.id = sr.step_id
           JOIN test_cases tc ON tc.id = ts.case_id
      LEFT JOIN test_suites su ON su.id = tc.suite_id
          WHERE sr.target_hash IS NOT NULL
          ORDER BY sr.target_hash, sr.created_at DESC
       ),
       -- First use: how the selector was originally found. This is the honest answer to
       -- "where did this come from" — an entry first resolved by 'llm' was read off the
       -- page by the model, one first seen as 'archetype' matched a known pattern.
       origins AS (
         SELECT DISTINCT ON (sr.target_hash)
                sr.target_hash, sr.resolution_source AS learned_via,
                sr.created_at AS learned_at
           FROM step_results sr
           JOIN runs r ON r.id = sr.run_id AND r.tenant_id = $1
          WHERE sr.target_hash IS NOT NULL AND sr.resolution_source IS NOT NULL
          ORDER BY sr.target_hash, sr.created_at ASC
       ),
       -- How widely the entry is relied on: one selector can serve many tests.
       spread AS (
         SELECT sr.target_hash, COUNT(DISTINCT ts.case_id)::int AS case_count
           FROM step_results sr
           JOIN runs r        ON r.id = sr.run_id AND r.tenant_id = $1
           JOIN test_steps ts ON ts.id = sr.step_id
          WHERE sr.target_hash IS NOT NULL
          GROUP BY sr.target_hash
       )
       SELECT sc.id, sc.tenant_id, sc.content_hash, sc.domain, sc.selectors,
              sc.confidence_score, sc.outcome_window, sc.fail_count_window,
              sc.is_shared, sc.pinned_at, sc.last_verified_at, sc.last_failed_at,
              sc.updated_at,
              i.raw_text AS intent,
              i.case_id, i.case_name, i.suite_name, i.last_run_id,
              i.last_step_result_id, i.last_used_at,
              o.learned_via, o.learned_at,
              COALESCE(sp.case_count, 0) AS case_count
         FROM selector_cache sc
         LEFT JOIN intents i ON i.target_hash = sc.content_hash
         LEFT JOIN origins o ON o.target_hash = sc.content_hash
         LEFT JOIN spread sp ON sp.target_hash = sc.content_hash
        WHERE sc.tenant_id = $1
           OR (sc.tenant_id IS NULL AND sc.is_shared = true
               AND sc.domain IN (SELECT domain FROM tenant_domains))
        -- Entries this tenant's own steps have used come first: they're the memory
        -- that answers its runs. Unused shared entries for the same site follow.
        ORDER BY (i.raw_text IS NULL), COALESCE(sc.last_verified_at, sc.updated_at) DESC NULLS LAST
        LIMIT $2`,
      [tenantId, limit],
    );

    const entries = rows.map((r) => {
      const window: boolean[] = Array.isArray(r.outcome_window) ? r.outcome_window : [];
      const selectors = Array.isArray(r.selectors) ? r.selectors : [];
      return {
        id: r.id,
        intent: r.intent as string | null,
        domain: r.domain as string,
        selector: (selectors[0]?.selector ?? null) as string | null,
        strategy: (selectors[0]?.strategy ?? null) as string | null,
        selectorCount: selectors.length,
        confidence: Number(r.confidence_score),
        scope: r.tenant_id === null ? 'global' : 'tenant',
        uses: window.length,
        ok: window.filter(Boolean).length,
        failCountWindow: r.fail_count_window as number,
        pinned: r.pinned_at !== null,
        lastVerifiedAt: r.last_verified_at,
        lastFailedAt: r.last_failed_at,
        updatedAt: r.updated_at,
        // Provenance — where this entry came from and who relies on it. All null for a
        // shared-pool row no step of this tenant has used yet.
        caseId: (r.case_id ?? null) as string | null,
        caseName: (r.case_name ?? null) as string | null,
        suiteName: (r.suite_name ?? null) as string | null,
        lastRunId: (r.last_run_id ?? null) as string | null,
        lastStepResultId: (r.last_step_result_id ?? null) as string | null,
        lastUsedAt: r.last_used_at ?? null,
        learnedVia: (r.learned_via ?? null) as string | null,
        learnedAt: r.learned_at ?? null,
        caseCount: Number(r.case_count ?? 0),
      };
    });

    return reply.send({ entries, total: entries.length, limit });
  });
}
