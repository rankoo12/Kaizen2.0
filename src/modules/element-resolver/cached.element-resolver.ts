import type { Redis } from 'ioredis';
import type { IElementResolver } from './interfaces';
import type { StepAST, SelectorSet, ResolutionContext, SelectorEntry } from '../../types';
import type { ILLMGateway } from '../llm-gateway/interfaces';
import type { IObservability } from '../observability/interfaces';
import { getPool } from '../../db/pool';
import { toVectorSQL } from '../../utils/vector';
import { invalidateRedisCache } from './redis-cache.utils';
import { semanticGuardPasses } from './cache-semantic-guard';

/**
 * Spec ref: Section 8 — Element Resolution & Caching (Levels 1–4)
 * Updated 2026-04-24: cache-semantic-guard applied at every layer before returning
 * a hit. Rows whose stored vectors disagree with the step's intent vector are
 * deleted and the chain falls through. See spec-element-resolver-cache-semantic-guard.md.
 *
 *  L1 — Redis hot cache   key: "sel:{tenantId}:{targetHash}:{domain}"  TTL: 1 hour
 *  L2 — Postgres selector_cache exact targetHash lookup
 *  L3 — pgvector step_embedding cosine similarity > 0.95 (tenant scope)
 *  L4 — pgvector step_embedding cosine similarity > 0.95 (shared pool)
 *
 * Returns an empty SelectorSet on full miss so CompositeElementResolver escalates to LLMElementResolver.
 */

const COSINE_THRESHOLD = 0.95;
const REDIS_TTL_SECONDS = 3_600; // 1 hour

const MISS: SelectorSet = { selectors: [], fromCache: false, cacheSource: null, resolutionSource: null, similarityScore: null };

/** Shape of the value we now write into Redis — selectors plus the stored vectors
 * so the semantic guard can evaluate on L1 hits without a Postgres roundtrip. */
type RedisPayloadV2 = {
  v: 2;
  selectors: SelectorEntry[];
  stepEmbedding: number[] | null;
  elementEmbedding: number[] | null;
};

/** Legacy Redis shape written before the semantic guard — `selectors` only. */
type RedisPayloadV1 = SelectorEntry[];

function isV2(payload: unknown): payload is RedisPayloadV2 {
  return typeof payload === 'object' && payload !== null && (payload as RedisPayloadV2).v === 2;
}

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
      const stepEmbedding = context.stepEmbedding;
      const redisKey = this.redisKey(context.tenantId, step.targetHash, context.domain);

      // ── L1: Redis hot cache ───────────────────────────────────────────────
      const redisHit = await this.redis.get(redisKey);
      if (redisHit) {
        const parsed = this.parseRedisPayload(redisHit);
        if (parsed) {
          const { passed, bestSimilarity } = semanticGuardPasses(
            stepEmbedding,
            parsed.stepEmbedding,
            parsed.elementEmbedding,
          );
          if (passed) {
            this.observability.increment('resolver.cache_hit', { source: 'redis' });
            return { selectors: parsed.selectors, fromCache: true, cacheSource: 'tenant', resolutionSource: 'redis', similarityScore: null };
          }
          this.observability.increment('resolver.cache_semantic_reject', { source: 'redis' });
          this.observability.log('info', 'cache_resolver.semantic_reject', {
            source: 'redis',
            similarity: bestSimilarity,
            targetHash: step.targetHash,
          });
          await this.invalidateRow(step.targetHash, context.domain, context.tenantId);
          // Fall through to L2+. The DB row was also deleted so L2 will miss too.
        }
      }

      // ── L2: Postgres exact targetHash lookup ──────────────────────────────
      const directHit = await this.fetchByHash(step.targetHash, context.domain, context.tenantId);
      if (directHit) {
        const { passed, bestSimilarity } = semanticGuardPasses(
          stepEmbedding,
          directHit.stepEmbedding,
          directHit.elementEmbedding,
        );
        if (passed) {
          this.observability.increment('resolver.cache_hit', { source: 'db_target' });
          await this.writeRedis(redisKey, directHit.selectors, directHit.stepEmbedding, directHit.elementEmbedding);
          return { selectors: directHit.selectors, fromCache: true, cacheSource: 'tenant', resolutionSource: 'db_exact', similarityScore: null };
        }
        this.observability.increment('resolver.cache_semantic_reject', { source: 'db_exact' });
        this.observability.log('info', 'cache_resolver.semantic_reject', {
          source: 'db_exact',
          similarity: bestSimilarity,
          targetHash: step.targetHash,
        });
        await this.invalidateRow(step.targetHash, context.domain, context.tenantId);
      }

      // ── L3 + L4: pgvector cosine similarity ───────────────────────────────
      // Prefer the embedding computed once by CompositeElementResolver; fall back
      // to computing it here when the composite could not supply one (e.g. a test
      // constructs CachedElementResolver directly).
      const embedding = stepEmbedding ?? await this.llmGateway.generateEmbedding(`${step.action} ${step.targetDescription ?? ''}`);
      const embeddingSQL = toVectorSQL(embedding);

      // L3: tenant scope
      const tenantHit = await this.vectorSearch(embeddingSQL, context.tenantId, context.domain, false);
      if (tenantHit) {
        const { passed, bestSimilarity } = semanticGuardPasses(
          embedding,
          tenantHit.stepEmbedding,
          tenantHit.elementEmbedding,
        );
        if (passed) {
          this.observability.increment('resolver.cache_hit', { source: 'pgvector_tenant' });
          await this.writeRedis(redisKey, tenantHit.selectors, tenantHit.stepEmbedding, tenantHit.elementEmbedding);
          return { selectors: tenantHit.selectors, fromCache: true, cacheSource: 'tenant', resolutionSource: 'pgvector_step', similarityScore: tenantHit.similarity };
        }
        this.observability.increment('resolver.cache_semantic_reject', { source: 'pgvector_tenant' });
        this.observability.log('info', 'cache_resolver.semantic_reject', {
          source: 'pgvector_tenant',
          similarity: bestSimilarity,
          targetHash: step.targetHash,
        });
        // L3 match was on a different content_hash than ours; invalidate the matched row instead.
        if (tenantHit.contentHash) {
          await this.invalidateRow(tenantHit.contentHash, context.domain, context.tenantId);
        }
      }

      // L4: shared pool
      const sharedHit = await this.vectorSearch(embeddingSQL, null, context.domain, true);
      if (sharedHit) {
        const { passed, bestSimilarity } = semanticGuardPasses(
          embedding,
          sharedHit.stepEmbedding,
          sharedHit.elementEmbedding,
        );
        if (passed) {
          this.observability.increment('resolver.cache_hit', { source: 'pgvector_shared' });
          await this.writeRedis(redisKey, sharedHit.selectors, sharedHit.stepEmbedding, sharedHit.elementEmbedding);
          return { selectors: sharedHit.selectors, fromCache: true, cacheSource: 'shared', resolutionSource: 'pgvector_step', similarityScore: sharedHit.similarity };
        }
        this.observability.increment('resolver.cache_semantic_reject', { source: 'pgvector_shared' });
        this.observability.log('info', 'cache_resolver.semantic_reject', {
          source: 'pgvector_shared',
          similarity: bestSimilarity,
          targetHash: step.targetHash,
        });
        // Shared-pool rows are not owned by this tenant — don't delete; just skip.
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
    try {
      const evicted = await invalidateRedisCache(this.redis, targetHash, domain);
      if (evicted > 0) {
        this.observability.increment('resolver.cache_invalidated', { domain, count: String(evicted) });
      }
    } catch (e: any) {
      this.observability.log('warn', 'cache_resolver.invalidation_failed', { error: e.message });
    }
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  private redisKey(tenantId: string, targetHash: string, domain: string): string {
    return `sel:${tenantId}:${targetHash}:${domain}`;
  }

  /** Tolerates both the legacy v1 (array) and v2 (object-with-vectors) Redis payloads. */
  private parseRedisPayload(raw: string): { selectors: SelectorEntry[]; stepEmbedding: number[] | null; elementEmbedding: number[] | null } | null {
    try {
      const value: RedisPayloadV1 | RedisPayloadV2 = JSON.parse(raw);
      if (Array.isArray(value)) {
        // Legacy v1 — no vectors stored; guard will be a no-op (cannot evaluate).
        return { selectors: value, stepEmbedding: null, elementEmbedding: null };
      }
      if (isV2(value)) {
        return { selectors: value.selectors, stepEmbedding: value.stepEmbedding, elementEmbedding: value.elementEmbedding };
      }
      return null;
    } catch {
      return null;
    }
  }

  private async writeRedis(
    key: string,
    selectors: SelectorEntry[],
    stepEmbedding: number[] | null,
    elementEmbedding: number[] | null,
  ): Promise<void> {
    const payload: RedisPayloadV2 = { v: 2, selectors, stepEmbedding, elementEmbedding };
    try {
      await this.redis.setex(key, REDIS_TTL_SECONDS, JSON.stringify(payload));
    } catch (e: any) {
      this.observability.log('warn', 'cache_resolver.redis_write_failed', { error: e.message });
    }
  }

  private async invalidateRow(targetHash: string, domain: string, tenantId: string): Promise<void> {
    try {
      await getPool().query(
        `DELETE FROM selector_cache
         WHERE content_hash = $1 AND domain = $2 AND tenant_id = $3
           AND pinned_at IS NULL`,
        [targetHash, domain, tenantId],
      );
      await invalidateRedisCache(this.redis, targetHash, domain);
      this.observability.increment('resolver.cache_semantic_invalidate', { domain });
    } catch (e: any) {
      this.observability.log('warn', 'cache_resolver.semantic_invalidate_failed', { error: e.message });
    }
  }

  private async fetchByHash(
    targetHash: string,
    domain: string,
    tenantId: string,
  ): Promise<{
    selectors: SelectorEntry[];
    stepEmbedding: number[] | null;
    elementEmbedding: number[] | null;
  } | null> {
    try {
      const { rows } = await getPool().query<{
        selectors: SelectorEntry[];
        step_embedding: number[] | string | null;
        element_embedding: number[] | string | null;
      }>(
        `SELECT selectors, step_embedding, element_embedding
         FROM selector_cache
         WHERE content_hash = $1 AND domain = $2 AND tenant_id = $3
           AND (pinned_at IS NOT NULL OR confidence_score > 0.4)
         ORDER BY pinned_at DESC NULLS LAST
         LIMIT 1`,
        [targetHash, domain, tenantId],
      );
      if (rows.length === 0) return null;
      return {
        selectors: rows[0].selectors,
        stepEmbedding: parsePgVector(rows[0].step_embedding),
        elementEmbedding: parsePgVector(rows[0].element_embedding),
      };
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
  ): Promise<{
    selectors: SelectorEntry[];
    similarity: number;
    stepEmbedding: number[] | null;
    elementEmbedding: number[] | null;
    contentHash: string | null;
  } | null> {
    try {
      const { rows } = await getPool().query<{
        selectors: SelectorEntry[];
        similarity: number;
        step_embedding: number[] | string | null;
        element_embedding: number[] | string | null;
        content_hash: string | null;
      }>(
        `SELECT selectors,
                content_hash,
                step_embedding,
                element_embedding,
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
      return {
        selectors: rows[0].selectors,
        similarity: rows[0].similarity,
        stepEmbedding: parsePgVector(rows[0].step_embedding),
        elementEmbedding: parsePgVector(rows[0].element_embedding),
        contentHash: rows[0].content_hash,
      };
    } catch (e: any) {
      this.observability.log('warn', 'cache_resolver.vector_search_failed', { error: e.message });
      return null;
    }
  }
}

/**
 * pgvector values come back from node-postgres as a string like "[0.1,0.2,...]"
 * by default. Tests pass number[] arrays directly. Handle both.
 */
function parsePgVector(value: number[] | string | null): number[] | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
