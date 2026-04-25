import { CachedElementResolver } from '../cached.element-resolver';
import type { ILLMGateway } from '../../llm-gateway/interfaces';
import type { IObservability } from '../../observability/interfaces';

jest.mock('../../../db/pool', () => ({
  getPool: jest.fn().mockReturnValue({ query: jest.fn() }),
}));

jest.mock('../redis-cache.utils', () => ({
  invalidateRedisCache: jest.fn().mockResolvedValue(0),
  isTransient: jest.fn().mockReturnValue(false),
}));

import { getPool } from '../../../db/pool';
import { invalidateRedisCache } from '../redis-cache.utils';

// Build a vector aligned with [1, 0, 0, ...] direction (dim 8 for tests).
const VEC_DIM = 8;
const aligned = (scale = 1): number[] => {
  const v = new Array(VEC_DIM).fill(0);
  v[0] = scale;
  return v;
};
const orthogonal = (): number[] => {
  const v = new Array(VEC_DIM).fill(0);
  v[1] = 1;
  return v;
};

const makeStep = (overrides = {}) => ({
  action: 'click' as const,
  targetDescription: 'submit button',
  value: null,
  url: null,
  rawText: 'click submit',
  contentHash: 'hash-abc',
  targetHash: 'test-target-hash',
  ...overrides,
});

const makeContext = (overrides: Record<string, unknown> = {}) => ({
  tenantId: '00000000-0000-0000-0000-000000000001',
  domain: 'example.com',
  page: {},
  ...overrides,
});

describe('CachedElementResolver', () => {
  let resolver: CachedElementResolver;
  let mockRedis: { get: jest.Mock; setex: jest.Mock };
  let mockLLMGateway: jest.Mocked<ILLMGateway>;
  let mockObservability: jest.Mocked<IObservability>;
  let mockQuery: jest.Mock;

  beforeEach(() => {
    mockRedis = {
      get: jest.fn().mockResolvedValue(null),
      setex: jest.fn().mockResolvedValue('OK'),
    };

    mockLLMGateway = {
      compileStep: jest.fn(),
      resolveElement: jest.fn(),
      generateEmbedding: jest.fn().mockResolvedValue(aligned(1)),
    } as unknown as jest.Mocked<ILLMGateway>;

    mockObservability = {
      startSpan: jest.fn().mockReturnValue({ end: jest.fn(), setAttribute: jest.fn() }),
      log: jest.fn(),
      increment: jest.fn(),
      histogram: jest.fn(),
    };

    mockQuery = jest.fn();
    (getPool as jest.Mock).mockReturnValue({ query: mockQuery });
    (invalidateRedisCache as jest.Mock).mockClear();

    resolver = new CachedElementResolver(mockRedis as any, mockLLMGateway, mockObservability);
  });

  afterEach(() => jest.clearAllMocks());

  // ─── L1: Redis hit (v2 payload with vectors) ───────────────────────────────

  it('L1: returns from Redis v2 payload when guard passes', async () => {
    const selectors = [{ selector: '#btn', strategy: 'css', confidence: 0.9 }];
    mockRedis.get.mockResolvedValueOnce(JSON.stringify({
      v: 2,
      selectors,
      stepEmbedding: aligned(1),
      elementEmbedding: aligned(1),
    }));

    const result = await resolver.resolve(makeStep(), makeContext({ stepEmbedding: aligned(1) }));

    expect(result.selectors).toEqual(selectors);
    expect(result.fromCache).toBe(true);
    expect(result.resolutionSource).toBe('redis');
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockObservability.increment).toHaveBeenCalledWith('resolver.cache_hit', { source: 'redis' });
  });

  it('L1: accepts legacy v1 array payload (no vectors stored)', async () => {
    const selectors = [{ selector: '#btn', strategy: 'css', confidence: 0.9 }];
    mockRedis.get.mockResolvedValueOnce(JSON.stringify(selectors));

    const result = await resolver.resolve(makeStep(), makeContext({ stepEmbedding: aligned(1) }));

    expect(result.selectors).toEqual(selectors);
    expect(result.resolutionSource).toBe('redis');
  });

  // ─── AT-1: L2 guard rejects semantically-wrong cached hit (bug repro) ──────

  it('AT-1: rejects L2 hit when stored vectors disagree with step intent, deletes row, falls through', async () => {
    const selectors = [{ selector: 'role=link[name=" Test Cases"]', strategy: 'aria', confidence: 0.9 }];
    // L2 returns a row whose stored step_embedding is orthogonal to the current step's intent vector.
    mockQuery
      .mockResolvedValueOnce({ rows: [{ selectors, step_embedding: orthogonal(), element_embedding: orthogonal() }] }) // L2 fetchByHash
      .mockResolvedValueOnce({ rows: [] }) // invalidateRow DELETE
      .mockResolvedValueOnce({ rows: [] }) // L3 vector search (miss)
      .mockResolvedValueOnce({ rows: [] }); // L4 vector search (miss)

    const result = await resolver.resolve(makeStep(), makeContext({ stepEmbedding: aligned(1) }));

    expect(result.selectors).toHaveLength(0);
    expect(mockObservability.increment).toHaveBeenCalledWith('resolver.cache_semantic_reject', { source: 'db_exact' });
    expect(mockObservability.increment).toHaveBeenCalledWith('resolver.cache_semantic_invalidate', { domain: 'example.com' });
    // DELETE query was fired on the row
    const deleteCall = mockQuery.mock.calls.find((c) => /DELETE FROM selector_cache/.test(c[0]));
    expect(deleteCall).toBeDefined();
    expect(invalidateRedisCache).toHaveBeenCalled();
  });

  // ─── AT-2: guard accepts a semantically-close hit ──────────────────────────

  it('AT-2: accepts L2 hit when stored step_embedding aligns with current intent', async () => {
    const selectors = [{ selector: 'role=button[name="Sign in"]', strategy: 'aria', confidence: 0.9 }];
    mockQuery.mockResolvedValueOnce({
      rows: [{ selectors, step_embedding: aligned(1), element_embedding: aligned(1) }],
    });

    const result = await resolver.resolve(makeStep(), makeContext({ stepEmbedding: aligned(1) }));

    expect(result.selectors).toEqual(selectors);
    expect(result.resolutionSource).toBe('db_exact');
    expect(mockObservability.increment).not.toHaveBeenCalledWith(
      'resolver.cache_semantic_reject',
      expect.anything(),
    );
  });

  // ─── AT-3: silent on legacy rows with null embeddings ──────────────────────

  it('AT-3: accepts L2 hit on legacy row with null embeddings (guard cannot evaluate)', async () => {
    const selectors = [{ selector: '#btn', strategy: 'css', confidence: 0.9 }];
    mockQuery.mockResolvedValueOnce({
      rows: [{ selectors, step_embedding: null, element_embedding: null }],
    });

    const result = await resolver.resolve(makeStep(), makeContext({ stepEmbedding: aligned(1) }));

    expect(result.selectors).toEqual(selectors);
    expect(result.resolutionSource).toBe('db_exact');
  });

  // ─── AT-4: guard silent when stepEmbedding is undefined ────────────────────

  it('AT-4: accepts L2 hit when context.stepEmbedding is undefined', async () => {
    const selectors = [{ selector: '#btn', strategy: 'css', confidence: 0.9 }];
    mockQuery.mockResolvedValueOnce({
      rows: [{ selectors, step_embedding: orthogonal(), element_embedding: orthogonal() }],
    });

    const result = await resolver.resolve(makeStep(), makeContext({ /* no stepEmbedding */ }));

    expect(result.selectors).toEqual(selectors);
    expect(mockObservability.increment).not.toHaveBeenCalledWith(
      'resolver.cache_semantic_reject',
      expect.anything(),
    );
  });

  // ─── L1 Redis reject flow ──────────────────────────────────────────────────

  it('L1: rejects Redis v2 hit when stored vectors disagree; invalidates, falls through to L2', async () => {
    mockRedis.get.mockResolvedValueOnce(JSON.stringify({
      v: 2,
      selectors: [{ selector: 'role=link[name=" Test Cases"]', strategy: 'aria', confidence: 0.9 }],
      stepEmbedding: orthogonal(),
      elementEmbedding: orthogonal(),
    }));
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // DELETE from invalidateRow
      .mockResolvedValueOnce({ rows: [] }) // L2 miss (row was already deleted)
      .mockResolvedValueOnce({ rows: [] }) // L3 miss
      .mockResolvedValueOnce({ rows: [] }); // L4 miss

    const result = await resolver.resolve(makeStep(), makeContext({ stepEmbedding: aligned(1) }));

    expect(result.selectors).toHaveLength(0);
    expect(mockObservability.increment).toHaveBeenCalledWith('resolver.cache_semantic_reject', { source: 'redis' });
    expect(invalidateRedisCache).toHaveBeenCalled();
  });

  // ─── L3 / L4 pgvector ──────────────────────────────────────────────────────

  it('L3: returns pgvector tenant hit that passes the guard', async () => {
    const selectors = [{ selector: '[data-testid="submit"]', strategy: 'data-testid', confidence: 1.0 }];
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // L2 miss
      .mockResolvedValueOnce({
        rows: [{ selectors, content_hash: 'canonical-hash', similarity: 0.97, step_embedding: aligned(1), element_embedding: aligned(1) }],
      }); // L3 tenant hit

    const result = await resolver.resolve(makeStep(), makeContext({ stepEmbedding: aligned(1) }));

    expect(result.selectors).toEqual(selectors);
    expect(result.cacheSource).toBe('tenant');
    expect(result.resolutionSource).toBe('pgvector_step');
    expect(mockObservability.increment).toHaveBeenCalledWith('resolver.cache_hit', { source: 'pgvector_tenant' });
  });

  it('L3: rejects pgvector hit when guard fails, falls through to L4', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // L2 miss
      .mockResolvedValueOnce({
        rows: [{ selectors: [{ selector: 'x', strategy: 'css', confidence: 1 }], content_hash: 'stale-hash', similarity: 0.96, step_embedding: orthogonal(), element_embedding: orthogonal() }],
      }) // L3 matched by step_embedding search but element_embedding disagrees → guard rejects
      .mockResolvedValueOnce({ rows: [] }) // invalidateRow DELETE
      .mockResolvedValueOnce({ rows: [] }); // L4 miss

    const result = await resolver.resolve(makeStep(), makeContext({ stepEmbedding: aligned(1) }));

    expect(result.selectors).toHaveLength(0);
    expect(mockObservability.increment).toHaveBeenCalledWith('resolver.cache_semantic_reject', { source: 'pgvector_tenant' });
  });

  it('L4: falls through to shared pool when tenant misses', async () => {
    const selectors = [{ selector: 'button.submit', strategy: 'css', confidence: 0.7 }];
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // L2 miss
      .mockResolvedValueOnce({ rows: [] }) // L3 miss
      .mockResolvedValueOnce({
        rows: [{ selectors, content_hash: 'shared-hash', similarity: 0.93, step_embedding: aligned(1), element_embedding: aligned(1) }],
      }); // L4 shared hit

    const result = await resolver.resolve(makeStep(), makeContext({ stepEmbedding: aligned(1) }));

    expect(result.selectors).toEqual(selectors);
    expect(result.cacheSource).toBe('shared');
    expect(mockObservability.increment).toHaveBeenCalledWith('resolver.cache_hit', { source: 'pgvector_shared' });
  });

  // ─── Full miss ─────────────────────────────────────────────────────────────

  it('returns empty selectors and cache_miss on full miss', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await resolver.resolve(makeStep(), makeContext({ stepEmbedding: aligned(1) }));

    expect(result.selectors).toHaveLength(0);
    expect(result.fromCache).toBe(false);
    expect(mockObservability.increment).toHaveBeenCalledWith('resolver.cache_miss');
  });

  // ─── Embedding fallback when composite did not supply one ──────────────────

  it('computes embedding locally when context.stepEmbedding is missing but L3/L4 need one', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // L2 miss
      .mockResolvedValueOnce({ rows: [] }) // L3 miss
      .mockResolvedValueOnce({ rows: [] }); // L4 miss

    await resolver.resolve(makeStep(), makeContext()); // no stepEmbedding passed

    expect(mockLLMGateway.generateEmbedding).toHaveBeenCalledTimes(1);
    expect(mockLLMGateway.generateEmbedding).toHaveBeenCalledWith('click submit button');
  });

  // ─── DB failure resilience ────────────────────────────────────────────────

  it('returns empty selectors gracefully when DB throws', async () => {
    mockQuery.mockRejectedValue(new Error('DB down'));

    const result = await resolver.resolve(makeStep(), makeContext({ stepEmbedding: aligned(1) }));

    expect(result.selectors).toHaveLength(0);
    expect(mockObservability.log).toHaveBeenCalledWith('warn', expect.any(String), expect.any(Object));
  });

  // ─── Redis v2 write-back ───────────────────────────────────────────────────

  it('writes v2 payload to Redis (with vectors) on L2 hit', async () => {
    const selectors = [{ selector: '#btn', strategy: 'css', confidence: 0.9 }];
    mockQuery.mockResolvedValueOnce({
      rows: [{ selectors, step_embedding: aligned(1), element_embedding: aligned(1) }],
    });

    await resolver.resolve(makeStep(), makeContext({ stepEmbedding: aligned(1) }));

    expect(mockRedis.setex).toHaveBeenCalledTimes(1);
    const [, , payload] = mockRedis.setex.mock.calls[0];
    const parsed = JSON.parse(payload);
    expect(parsed.v).toBe(2);
    expect(parsed.selectors).toEqual(selectors);
    expect(parsed.stepEmbedding).toEqual(aligned(1));
    expect(parsed.elementEmbedding).toEqual(aligned(1));
  });
});
