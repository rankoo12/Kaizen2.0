import type { Redis } from 'ioredis';
import type { IElementResolver } from './interfaces';
import type { StepAST, SelectorSet, ResolutionContext, SelectorEntry } from '../../types';
import type { ILLMGateway } from '../llm-gateway/interfaces';
import type { IObservability } from '../observability/interfaces';
import { getPool } from '../../db/pool';

/**
 * Spec ref: Section 8 — Element Resolution & Caching (Levels 1–3)
 *
 * Cache hierarchy (this resolver handles L1–L3; L4/LLM is in LLMElementResolver):
 *
 *  L1 — Redis hot cache
 *       Key: "sel:{tenantId}:{contentHash}:{domain}"  TTL: 1 hour
 *
 *  L2 — selector_cache_aliases (O(1) exact lookup for previously seen similar steps)
 *       new_hash → canonical_hash → fetch from selector_cache
 *       On hit: write alias back to Redis L1 for next time
 *
 *  L3 — Postgres pgvector step_embedding cosine similarity > 0.92 (tenant scope)
 *       On hit: write alias to selector_cache_aliases + write to Redis L1
 *
 *  L4 — Postgres pgvector step_embedding cosine similarity > 0.92 (shared scope, is_shared = true)
 *       On hit: write alias + write to Redis L1
 *
 * Returns null on full miss — caller (CompositeElementResolver) falls through to LLMElementResolver.
 */

const COSINE_THRESHOLD = 0.92;
const REDIS_TTL_SECONDS = 3_600; // 1 hour

export class CachedElementResolver implements IElementResolver {
  constructor(
    private readonly redis: Redis,
    private readonly llmGateway: ILLMGateway,
    private readonly observability: IObservability,
  ) {}

  async resolve(step: StepAST, context: ResolutionContext): Promise<SelectorSet> {
    const span = this.observability.startSpan('cache_resolver.resolve', {
      tenantId: context.tenantId,
    });

    try {
      // ── L1: Redis hot cache (exact hash) ──────────────────────────────────
      const redisKey = this.redisKey(context.tenantId, step.contentHash, context.domain);
      const redisHit = await this.redis.get(redisKey);

      if (redisHit) {
        this.observability.increment('resolver.cache_hit', { source: 'redis' });
        return { selectors: JSON.parse(redisHit), fromCache: true, cacheSource: 'tenant' };
      }

      // ── L2: selector_cache_aliases (O(1) for previously seen similar steps) ──
      const alias = await this.lookupAlias(step.contentHash, context.tenantId);
      if (alias) {
        const selectorSet = await this.fetchByHash(alias, context.domain, context.tenantId);
        if (selectorSet) {
          this.observability.increment('resolver.cache_hit', { source: 'alias' });
          await this.redis.setex(redisKey, REDIS_TTL_SECONDS, JSON.stringify(selectorSet.selectors));
          return selectorSet;
        }
      }

      // ── L3 + L4: pgvector cosine similarity search ────────────────────────
      const embedding = await this.llmGateway.generateEmbedding(step.rawText);
      const embeddingSQL = '[' + embedding.join(',') + ']';

      // L3: tenant scope
      const tenantHit = await this.vectorSearch(
        embeddingSQL,
        context.tenantId,
        context.domain,
        false,
      );

      if (tenantHit) {
        this.observability.increment('resolver.cache_hit', { source: 'pgvector_tenant' });
        await this.writeAlias(step.contentHash, tenantHit.canonicalHash, context.tenantId);
        await this.redis.setex(redisKey, REDIS_TTL_SECONDS, JSON.stringify(tenantHit.selectors));
        return { selectors: tenantHit.selectors, fromCache: true, cacheSource: 'tenant' };
      }

      // L4: shared pool
      const sharedHit = await this.vectorSearch(embeddingSQL, null, context.domain, true);

      if (sharedHit) {
        this.observability.increment('resolver.cache_hit', { source: 'pgvector_shared' });
        await this.writeAlias(step.contentHash, sharedHit.canonicalHash, context.tenantId);
        await this.redis.setex(redisKey, REDIS_TTL_SECONDS, JSON.stringify(sharedHit.selectors));
        return { selectors: sharedHit.selectors, fromCache: true, cacheSource: 'shared' };
      }

      // Full miss — return empty so CompositeElementResolver escalates to LLM
      this.observability.increment('resolver.cache_miss');
      return { selectors: [], fromCache: false, cacheSource: null };
    } finally {
      span.end();
    }
  }

  async recordSuccess(contentHash: string, domain: string, _selectorUsed: string): Promise<void> {
    this.observability.increment('resolver.record_success', { domain });
  }

  async recordFailure(contentHash: string, domain: string, _selectorAttempted: string): Promise<void> {
    // Invalidate Redis entry so the next run re-verifies
    // We don't know tenantId here — a real impl would pass it through;
    // for now we log and let the LLMElementResolver handle outcome_window
    this.observability.increment('resolver.record_failure', { domain });
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  private redisKey(tenantId: string, contentHash: string, domain: string): string {
    return `sel:${tenantId}:${contentHash}:${domain}`;
  }

  private async lookupAlias(
    contentHash: string,
    tenantId: string,
  ): Promise<string | null> {
    try {
      const { rows } = await getPool().query<{ canonical_hash: string }>(
        `SELECT canonical_hash FROM selector_cache_aliases
         WHERE new_hash = $1 AND tenant_id = $2
         LIMIT 1`,
        [contentHash, tenantId],
      );
      return rows.length > 0 ? rows[0].canonical_hash : null;
    } catch (e: any) {
      this.observability.log('warn', 'cache_resolver.alias_lookup_failed', { error: e.message });
      return null;
    }
  }

  private async fetchByHash(
    contentHash: string,
    domain: string,
    tenantId: string,
  ): Promise<SelectorSet | null> {
    try {
      const { rows } = await getPool().query<{ selectors: SelectorEntry[]; content_hash: string }>(
        `SELECT selectors, content_hash
         FROM selector_cache
         WHERE content_hash = $1 AND domain = $2 AND tenant_id = $3
           AND confidence_score > 0.4
         LIMIT 1`,
        [contentHash, domain, tenantId],
      );
      if (rows.length === 0) return null;
      return { selectors: rows[0].selectors, fromCache: true, cacheSource: 'tenant' };
    } catch (e: any) {
      this.observability.log('warn', 'cache_resolver.fetch_by_hash_failed', { error: e.message });
      return null;
    }
  }

  private async vectorSearch(
    embeddingSQL: string,
    tenantId: string | null,
    domain: string,
    shared: boolean,
  ): Promise<{ selectors: SelectorEntry[]; canonicalHash: string } | null> {
    try {
      const { rows } = await getPool().query<{
        selectors: SelectorEntry[];
        content_hash: string;
        similarity: number;
      }>(
        `SELECT selectors, content_hash,
                1 - (step_embedding <=> $1::vector) AS similarity
         FROM selector_cache
         WHERE step_embedding IS NOT NULL
           AND domain = $2
           AND confidence_score > 0.4
           AND ($3::uuid IS NULL OR tenant_id = $3::uuid)
           AND is_shared = $4
           AND 1 - (step_embedding <=> $1::vector) > ${COSINE_THRESHOLD}
         ORDER BY step_embedding <=> $1::vector
         LIMIT 1`,
        [embeddingSQL, domain, tenantId, shared],
      );

      if (rows.length === 0) return null;
      return { selectors: rows[0].selectors, canonicalHash: rows[0].content_hash };
    } catch (e: any) {
      this.observability.log('warn', 'cache_resolver.vector_search_failed', { error: e.message });
      return null;
    }
  }

  private async writeAlias(
    newHash: string,
    canonicalHash: string,
    tenantId: string,
  ): Promise<void> {
    try {
      await getPool().query(
        `INSERT INTO selector_cache_aliases (tenant_id, new_hash, canonical_hash)
         VALUES ($1, $2, $3)
         ON CONFLICT (tenant_id, new_hash) DO NOTHING`,
        [tenantId, newHash, canonicalHash],
      );
    } catch (e: any) {
      this.observability.log('warn', 'cache_resolver.write_alias_failed', { error: e.message });
    }
  }
}
