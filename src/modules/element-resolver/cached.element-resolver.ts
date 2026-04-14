import type { Redis } from 'ioredis';
import type { IElementResolver } from './interfaces';
import type { StepAST, SelectorSet, ResolutionContext, SelectorEntry } from '../../types';
import type { ILLMGateway } from '../llm-gateway/interfaces';
import type { IObservability } from '../observability/interfaces';
import { getPool } from '../../db/pool';
import { toVectorSQL } from '../../utils/vector';

/**
 * Spec ref: Section 8 — Element Resolution & Caching (Levels 1–4)
 *
 *  L1 — Redis hot cache   key: "sel:{tenantId}:{targetHash}:{domain}"  TTL: 1 hour
 *  L2 — Postgres selector_cache exact targetHash lookup
 *  L3 — pgvector step_embedding cosine similarity > 0.92 (tenant scope)
 *  L4 — pgvector step_embedding cosine similarity > 0.92 (shared pool)
 *
 * Returns an empty SelectorSet on full miss so CompositeElementResolver escalates to LLMElementResolver.
 */

const COSINE_THRESHOLD = 0.95;
const REDIS_TTL_SECONDS = 3_600; // 1 hour

const MISS: SelectorSet = { selectors: [], fromCache: false, cacheSource: null, resolutionSource: null, similarityScore: null };

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
      // ── L1: Redis hot cache ───────────────────────────────────────────────
      const redisKey = this.redisKey(context.tenantId, step.targetHash, context.domain);
      const redisHit = await this.redis.get(redisKey);

      if (redisHit) {
        this.observability.increment('resolver.cache_hit', { source: 'redis' });
        return { selectors: JSON.parse(redisHit), fromCache: true, cacheSource: 'tenant', resolutionSource: 'redis', similarityScore: null };
      }

      // ── L2: Postgres exact targetHash lookup ──────────────────────────────
      const directHit = await this.fetchByHash(step.targetHash, context.domain, context.tenantId);
      if (directHit) {
        this.observability.increment('resolver.cache_hit', { source: 'db_target' });
        await this.redis.setex(redisKey, REDIS_TTL_SECONDS, JSON.stringify(directHit.selectors));
        return directHit;
      }

      // ── L3 + L4: pgvector cosine similarity ───────────────────────────────
      // Embed action+targetDescription (value-agnostic) — same intent, same vector.
      const embedding = await this.llmGateway.generateEmbedding(`${step.action} ${step.targetDescription ?? ''}`);
      const embeddingSQL = toVectorSQL(embedding);

      // L3: tenant scope
      const tenantHit = await this.vectorSearch(embeddingSQL, context.tenantId, context.domain, false);

      if (tenantHit) {
        this.observability.increment('resolver.cache_hit', { source: 'pgvector_tenant' });
        await this.redis.setex(redisKey, REDIS_TTL_SECONDS, JSON.stringify(tenantHit.selectors));
        return { selectors: tenantHit.selectors, fromCache: true, cacheSource: 'tenant', resolutionSource: 'pgvector_step', similarityScore: tenantHit.similarity };
      }

      // L4: shared pool
      const sharedHit = await this.vectorSearch(embeddingSQL, null, context.domain, true);

      if (sharedHit) {
        this.observability.increment('resolver.cache_hit', { source: 'pgvector_shared' });
        await this.redis.setex(redisKey, REDIS_TTL_SECONDS, JSON.stringify(sharedHit.selectors));
        return { selectors: sharedHit.selectors, fromCache: true, cacheSource: 'shared', resolutionSource: 'pgvector_step', similarityScore: sharedHit.similarity };
      }

      this.observability.increment('resolver.cache_miss');
      return MISS;
    } finally {
      span.end();
    }
  }

  async recordSuccess(_contentHash: string, domain: string, _selectorUsed: string): Promise<void> {
    this.observability.increment('resolver.record_success', { domain });
  }

  async recordFailure(targetHash: string, domain: string, _selectorAttempted: string): Promise<void> {
    this.observability.increment('resolver.record_failure', { domain });
    // Evict all Redis entries for this targetHash+domain across all tenants.
    // Key format: sel:{tenantId}:{targetHash}:{domain}
    try {
      const pattern = `sel:*:${targetHash}:${domain}`;
      const keys: string[] = [];
      let cursor = '0';
      do {
        const [next, batch] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', '100');
        cursor = next;
        keys.push(...batch);
      } while (cursor !== '0');

      if (keys.length > 0) {
        await this.redis.del(...keys);
        this.observability.increment('resolver.cache_invalidated', { domain, count: String(keys.length) });
      }
    } catch (e: any) {
      this.observability.log('warn', 'cache_resolver.invalidation_failed', { error: e.message });
    }
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  private redisKey(tenantId: string, targetHash: string, domain: string): string {
    return `sel:${tenantId}:${targetHash}:${domain}`;
  }

  private async fetchByHash(
    targetHash: string,
    domain: string,
    tenantId: string,
  ): Promise<SelectorSet | null> {
    try {
      const { rows } = await getPool().query<{ selectors: SelectorEntry[] }>(
        `SELECT selectors
         FROM selector_cache
         WHERE content_hash = $1 AND domain = $2 AND tenant_id = $3
           AND (pinned_at IS NOT NULL OR confidence_score > 0.4)
         ORDER BY pinned_at DESC NULLS LAST
         LIMIT 1`,
        [targetHash, domain, tenantId],
      );
      if (rows.length === 0) return null;
      return { selectors: rows[0].selectors, fromCache: true, cacheSource: 'tenant', resolutionSource: 'db_exact', similarityScore: null };
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
  ): Promise<{ selectors: SelectorEntry[]; similarity: number } | null> {
    try {
      const { rows } = await getPool().query<{
        selectors: SelectorEntry[];
        similarity: number;
      }>(
        `SELECT selectors,
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
      return { selectors: rows[0].selectors, similarity: rows[0].similarity };
    } catch (e: any) {
      this.observability.log('warn', 'cache_resolver.vector_search_failed', { error: e.message });
      return null;
    }
  }
}
