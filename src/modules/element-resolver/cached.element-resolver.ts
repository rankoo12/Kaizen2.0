import type { Redis } from 'ioredis';
import type { IElementResolver } from './interfaces';
import type { StepAST, SelectorSet, ResolutionContext, SelectorEntry } from '../../types';
import type { ILLMGateway } from '../llm-gateway/interfaces';
import type { IObservability } from '../observability/interfaces';
import { getPool } from '../../db/pool';
import { toVectorSQL } from '../../utils/vector';
import { invalidateRedisCache } from './redis-cache.utils';
import { semanticGuardPasses } from './cache-semantic-guard';
import { findFrameByUrl, framesOf } from '../../utils/frame-url';

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

/** Shape of the value we now write into Redis — selectors, the stored vectors so the
 * semantic guard can evaluate on L1 hits without a Postgres roundtrip, and the frame the
 * selectors resolve inside (null for the main document, which is almost every entry). */
type RedisPayloadV3 = {
  v: 3;
  selectors: SelectorEntry[];
  stepEmbedding: number[] | null;
  elementEmbedding: number[] | null;
  frameUrl: string | null;
};

/** v2 — selectors + vectors, written before iframe elements were cacheable. */
type RedisPayloadV2 = Omit<RedisPayloadV3, 'v' | 'frameUrl'> & { v: 2 };

/** Legacy Redis shape written before the semantic guard — `selectors` only. */
type RedisPayloadV1 = SelectorEntry[];

function isVersioned(payload: unknown, version: 2 | 3): boolean {
  return typeof payload === 'object' && payload !== null && (payload as { v?: number }).v === version;
}

/** What a cache tier found, before the frame guard decides whether it is usable. */
type CacheRow = {
  selectors: SelectorEntry[];
  stepEmbedding: number[] | null;
  elementEmbedding: number[] | null;
  frameUrl: string | null;
};

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
          if (passed && await this.frameGuardPasses(parsed, context, 'redis')) {
            this.observability.increment('resolver.cache_hit', { source: 'redis' });
            return { selectors: parsed.selectors, fromCache: true, cacheSource: 'tenant', resolutionSource: 'redis', similarityScore: null, frameUrl: parsed.frameUrl ?? undefined };
          }
          // The frame guard failing is not a semantic disagreement — the entry is fine,
          // the iframe just is not on this page right now. Fall through without deleting.
          if (passed) return MISS;
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
        if (passed && await this.frameGuardPasses(directHit, context, 'db_exact')) {
          this.observability.increment('resolver.cache_hit', { source: 'db_target' });
          await this.writeRedis(redisKey, directHit);
          return { selectors: directHit.selectors, fromCache: true, cacheSource: 'tenant', resolutionSource: 'db_exact', similarityScore: null, frameUrl: directHit.frameUrl ?? undefined };
        }
        if (passed) return MISS;
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
        if (passed && await this.frameGuardPasses(tenantHit, context, 'pgvector_tenant')) {
          this.observability.increment('resolver.cache_hit', { source: 'pgvector_tenant' });
          await this.writeRedis(redisKey, tenantHit);
          return { selectors: tenantHit.selectors, fromCache: true, cacheSource: 'tenant', resolutionSource: 'pgvector_step', similarityScore: tenantHit.similarity, frameUrl: tenantHit.frameUrl ?? undefined };
        }
        if (passed) return MISS;
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
        if (passed && await this.frameGuardPasses(sharedHit, context, 'pgvector_shared')) {
          this.observability.increment('resolver.cache_hit', { source: 'pgvector_shared' });
          await this.writeRedis(redisKey, sharedHit);
          return { selectors: sharedHit.selectors, fromCache: true, cacheSource: 'shared', resolutionSource: 'pgvector_step', similarityScore: sharedHit.similarity, frameUrl: sharedHit.frameUrl ?? undefined };
        }
        if (passed) return MISS;
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

  /**
   * A cached selector scoped to an iframe is only usable if that iframe is on the page
   * NOW and the selector still resolves inside it.
   *
   * Without this check a frame-scoped selector read back days later would be handed to
   * the execution engine, which falls back to the top document when it cannot find the
   * frame — running `button[title="Yes, I'm happy"]` against the main page, matching
   * nothing, and failing a step on a site where nothing is broken. A miss costs one LLM
   * call; a false hit costs a red run.
   *
   * Entries with no frame (every row written before iframe elements became cacheable,
   * and every main-document element since) skip the check entirely.
   * Spec: docs/specs/reliability/spec-iframe-selector-caching.md §4.4
   */
  private async frameGuardPasses(
    row: Pick<CacheRow, 'selectors' | 'frameUrl'>,
    context: ResolutionContext,
    source: string,
  ): Promise<boolean> {
    if (!row.frameUrl) return true;

    const reject = (reason: string): false => {
      this.observability.increment('resolver.frame_guard_reject', { source, reason });
      this.observability.log('info', 'cache_resolver.frame_guard_reject', {
        source,
        reason,
        frameUrl: row.frameUrl,
      });
      return false;
    };

    const frames = framesOf<{ url?: () => string; locator?: (s: string) => { count: () => Promise<number> } }>(context.page);
    const frame = findFrameByUrl(frames, row.frameUrl);
    if (!frame?.locator) return reject('frame_absent');

    const selector = row.selectors[0]?.selector;
    if (!selector) return reject('no_selector');

    try {
      if ((await frame.locator(selector).count()) < 1) return reject('selector_absent_in_frame');
    } catch {
      return reject('selector_error_in_frame');
    }
    return true;
  }

  /** Tolerates the legacy v1 (array) and v2 (no frame) payloads alongside current v3. */
  private parseRedisPayload(raw: string): CacheRow | null {
    try {
      const value: RedisPayloadV1 | RedisPayloadV2 | RedisPayloadV3 = JSON.parse(raw);
      if (Array.isArray(value)) {
        // Legacy v1 — no vectors stored; guard will be a no-op (cannot evaluate).
        return { selectors: value, stepEmbedding: null, elementEmbedding: null, frameUrl: null };
      }
      if (isVersioned(value, 2) || isVersioned(value, 3)) {
        const v = value as RedisPayloadV3;
        // v2 has no frameUrl — undefined normalises to null, i.e. "main document",
        // which is what every entry written before this change was.
        return {
          selectors: v.selectors,
          stepEmbedding: v.stepEmbedding,
          elementEmbedding: v.elementEmbedding,
          frameUrl: v.frameUrl ?? null,
        };
      }
      return null;
    } catch {
      return null;
    }
  }

  private async writeRedis(key: string, row: CacheRow): Promise<void> {
    const payload: RedisPayloadV3 = {
      v: 3,
      selectors: row.selectors,
      stepEmbedding: row.stepEmbedding,
      elementEmbedding: row.elementEmbedding,
      frameUrl: row.frameUrl,
    };
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
  ): Promise<CacheRow | null> {
    try {
      const { rows } = await getPool().query<{
        selectors: SelectorEntry[];
        step_embedding: number[] | string | null;
        element_embedding: number[] | string | null;
        frame_url: string | null;
      }>(
        `SELECT selectors, step_embedding, element_embedding, frame_url
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
        frameUrl: rows[0].frame_url ?? null,
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
  ): Promise<(CacheRow & { similarity: number; contentHash: string | null }) | null> {
    try {
      const { rows } = await getPool().query<{
        selectors: SelectorEntry[];
        similarity: number;
        step_embedding: number[] | string | null;
        element_embedding: number[] | string | null;
        content_hash: string | null;
        frame_url: string | null;
      }>(
        `SELECT selectors,
                content_hash,
                step_embedding,
                element_embedding,
                frame_url,
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
        frameUrl: rows[0].frame_url ?? null,
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
