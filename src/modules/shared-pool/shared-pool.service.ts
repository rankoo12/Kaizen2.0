/**
 * Spec ref: Phase 4 — Global Brain Seeding
 * kaizen-phase4-spec.md §3
 *
 * Manages writes to the shared selector pool (is_shared=true rows in selector_cache).
 * The read path (L4 vector search) lives in CachedElementResolver — not here.
 */

import type { Redis } from 'ioredis';
import type { IObservability } from '../observability/interfaces';
import type { ISharedPoolService, ContributeParams } from './interfaces';
import { tenantQuery } from '../../db/transaction';
import { toVectorSQL } from '../../utils/vector';

const QUALITY_THRESHOLD = 0.8;  // minimum confidence_score to contribute to shared pool
const OPT_IN_CACHE_TTL = 300;   // Redis TTL seconds for isOptedIn cache

export class SharedPoolService implements ISharedPoolService {
  constructor(
    private readonly redis: Redis,
    private readonly observability: IObservability,
  ) {}

  async contribute(params: ContributeParams): Promise<void> {
    // Every statement here runs AS the contributing tenant. The rows it writes
    // carry tenant_id = NULL (that is what makes them shared), and the 037
    // policy's WITH CHECK admits exactly that shape — a NULL-tenant, is_shared
    // row — for any tenant. So the tenant scope is not what authorises the
    // write; it is what lets the write happen at all under an unprivileged
    // runtime, where a statement with no tenant set is not a broader statement
    // but a rejected one.
    // 1. Opt-in gate
    const optedIn = await this.isOptedIn(params.tenantId);
    if (!optedIn) return;

    // 2. Quality gate
    if (params.confidenceScore < QUALITY_THRESHOLD) return;


    try {
      // 3. Check if a shared entry already exists for this (content_hash, domain)
      const { rows: existing } = await tenantQuery<{ id: string; attribution: any }>(
        params.tenantId,
        `SELECT id, attribution FROM selector_cache
         WHERE content_hash = $1 AND domain = $2 AND is_shared = true AND tenant_id IS NULL
         LIMIT 1`,
        [params.contentHash, params.domain],
      );

      if (existing.length > 0) {
        // Append this tenant as an additional contributor
        const current = existing[0].attribution ?? { contributors: [], source: 'tenant' };
        const contributors: Array<{ tenantId: string; contributedAt: string }> =
          current.contributors ?? [];

        // Avoid duplicate contributor entries
        if (!contributors.some((c) => c.tenantId === params.tenantId)) {
          contributors.push({ tenantId: params.tenantId, contributedAt: new Date().toISOString() });
          await tenantQuery(
            params.tenantId,
            `UPDATE selector_cache SET attribution = $1, updated_at = now() WHERE id = $2`,
            [JSON.stringify({ ...current, contributors }), existing[0].id],
          );
        }
        return;
      }

      // 4. Insert new shared row
      const attribution = {
        source: 'tenant',
        contributors: [{ tenantId: params.tenantId, contributedAt: new Date().toISOString() }],
      };

      await tenantQuery(
        params.tenantId,
        `INSERT INTO selector_cache
           (tenant_id, content_hash, domain, selectors, step_embedding, element_embedding,
            confidence_score, is_shared, attribution)
         VALUES (NULL, $1, $2, $3, $4::vector, $5, $6, true, $7)
         ON CONFLICT DO NOTHING`,
        [
          params.contentHash,
          params.domain,
          JSON.stringify(params.selectors),
          toVectorSQL(params.stepEmbedding),
          params.elementEmbedding ? toVectorSQL(params.elementEmbedding) : null,
          params.confidenceScore,
          JSON.stringify(attribution),
        ],
      );

      this.observability.increment('shared_pool.contributed', { domain: params.domain });
    } catch (e: any) {
      // Fire-and-forget — must never break the resolution call that triggered this
      this.observability.log('warn', 'shared_pool.contribute_failed', { error: e.message });
    }
  }

  async isOptedIn(tenantId: string): Promise<boolean> {
    const cacheKey = `brain_opt_in:${tenantId}`;

    try {
      const cached = await this.redis.get(cacheKey);
      if (cached !== null) return cached === '1';
    } catch {
      // Redis miss — fall through to DB
    }

    try {
      const { rows } = await tenantQuery<{ global_brain_opt_in: boolean }>(
        tenantId,
        `SELECT global_brain_opt_in FROM tenants WHERE id = $1`,
        [tenantId],
      );

      const value = rows[0]?.global_brain_opt_in ?? false;

      try {
        await this.redis.setex(cacheKey, OPT_IN_CACHE_TTL, value ? '1' : '0');
      } catch {
        // Cache write failure is non-fatal
      }

      return value;
    } catch (e: any) {
      this.observability.log('warn', 'shared_pool.opt_in_lookup_failed', { error: e.message });
      return false; // Fail closed — don't contribute if we can't verify opt-in
    }
  }

  async setOptIn(tenantId: string, value: boolean): Promise<void> {
    await tenantQuery(
      tenantId,
      `UPDATE tenants SET global_brain_opt_in = $1 WHERE id = $2`,
      [value, tenantId],
    );

    // Invalidate Redis cache
    try {
      await this.redis.del(`brain_opt_in:${tenantId}`);
    } catch {
      // Non-fatal — will expire naturally after TTL
    }

    this.observability.log('info', 'shared_pool.opt_in_changed', { tenantId, value });
  }
}
