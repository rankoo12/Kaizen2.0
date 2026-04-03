import { CachedElementResolver } from '../cached.element-resolver';
import type { ILLMGateway } from '../../llm-gateway/interfaces';
import type { IObservability } from '../../observability/interfaces';

jest.mock('../../../db/pool', () => ({
  getPool: jest.fn().mockReturnValue({ query: jest.fn() }),
}));

import { getPool } from '../../../db/pool';

const makeStep = (overrides = {}) => ({
  action: 'click' as const,
  targetDescription: 'submit button',
  value: null,
  url: null,
  rawText: 'click submit',
  contentHash: 'hash-abc',
  ...overrides,
});

const makeContext = () => ({
  tenantId: '00000000-0000-0000-0000-000000000001',
  domain: 'example.com',
  page: {},
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
      generateEmbedding: jest.fn().mockResolvedValue(Array(1536).fill(0.1)),
    };

    mockObservability = {
      startSpan: jest.fn().mockReturnValue({ end: jest.fn(), setAttribute: jest.fn() }),
      log: jest.fn(),
      increment: jest.fn(),
      histogram: jest.fn(),
    };

    mockQuery = jest.fn();
    (getPool as jest.Mock).mockReturnValue({ query: mockQuery });

    resolver = new CachedElementResolver(mockRedis as any, mockLLMGateway, mockObservability);
  });

  afterEach(() => jest.clearAllMocks());

  // ─── L1: Redis hit ─────────────────────────────────────────────────────────

  it('L1: returns from Redis and skips DB + embedding on Redis hit', async () => {
    const selectors = [{ selector: '#btn', strategy: 'css', confidence: 0.9 }];
    mockRedis.get.mockResolvedValueOnce(JSON.stringify(selectors));

    const result = await resolver.resolve(makeStep(), makeContext());

    expect(result.selectors).toEqual(selectors);
    expect(result.fromCache).toBe(true);
    expect(result.cacheSource).toBe('tenant');
    expect(mockLLMGateway.generateEmbedding).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockObservability.increment).toHaveBeenCalledWith('resolver.cache_hit', { source: 'redis' });
  });

  // ─── L2: alias hit ─────────────────────────────────────────────────────────

  it('L2: returns via alias and writes to Redis', async () => {
    const selectors = [{ selector: '[aria-label="Submit"]', strategy: 'aria', confidence: 0.95 }];

    mockQuery
      .mockResolvedValueOnce({ rows: [{ canonical_hash: 'canonical-hash' }] }) // alias lookup
      .mockResolvedValueOnce({ rows: [{ selectors, content_hash: 'canonical-hash' }] }); // fetch by hash

    const result = await resolver.resolve(makeStep(), makeContext());

    expect(result.selectors).toEqual(selectors);
    expect(result.fromCache).toBe(true);
    expect(mockRedis.setex).toHaveBeenCalledWith(
      expect.stringContaining('00000000-0000-0000-0000-000000000001'),
      3600,
      JSON.stringify(selectors),
    );
    expect(mockObservability.increment).toHaveBeenCalledWith('resolver.cache_hit', { source: 'alias' });
    expect(mockLLMGateway.generateEmbedding).not.toHaveBeenCalled();
  });

  // ─── L3: pgvector tenant hit ───────────────────────────────────────────────

  it('L3: returns via pgvector tenant similarity and writes alias + Redis', async () => {
    const selectors = [{ selector: '[data-testid="submit"]', strategy: 'data-testid', confidence: 1.0 }];

    mockQuery
      .mockResolvedValueOnce({ rows: [] })  // alias miss
      .mockResolvedValueOnce({ rows: [{ selectors, content_hash: 'canonical-hash', similarity: 0.95 }] }) // tenant vector hit
      .mockResolvedValueOnce({ rows: [] }); // write alias

    const result = await resolver.resolve(makeStep(), makeContext());

    expect(result.selectors).toEqual(selectors);
    expect(result.cacheSource).toBe('tenant');
    expect(mockLLMGateway.generateEmbedding).toHaveBeenCalledTimes(1);
    expect(mockObservability.increment).toHaveBeenCalledWith('resolver.cache_hit', { source: 'pgvector_tenant' });
  });

  // ─── L4: pgvector shared hit ───────────────────────────────────────────────

  it('L4: falls through to shared pool when tenant vector misses', async () => {
    const selectors = [{ selector: 'button.submit', strategy: 'css', confidence: 0.7 }];

    mockQuery
      .mockResolvedValueOnce({ rows: [] })  // alias miss
      .mockResolvedValueOnce({ rows: [] })  // tenant vector miss
      .mockResolvedValueOnce({ rows: [{ selectors, content_hash: 'shared-hash', similarity: 0.93 }] }) // shared hit
      .mockResolvedValueOnce({ rows: [] }); // write alias

    const result = await resolver.resolve(makeStep(), makeContext());

    expect(result.selectors).toEqual(selectors);
    expect(result.cacheSource).toBe('shared');
    expect(mockObservability.increment).toHaveBeenCalledWith('resolver.cache_hit', { source: 'pgvector_shared' });
  });

  // ─── Full miss ─────────────────────────────────────────────────────────────

  it('returns empty selectors and cache_miss on full miss', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })  // alias miss
      .mockResolvedValueOnce({ rows: [] })  // tenant vector miss
      .mockResolvedValueOnce({ rows: [] }); // shared miss

    const result = await resolver.resolve(makeStep(), makeContext());

    expect(result.selectors).toHaveLength(0);
    expect(result.fromCache).toBe(false);
    expect(mockObservability.increment).toHaveBeenCalledWith('resolver.cache_miss');
  });

  // ─── DB failure resilience ────────────────────────────────────────────────

  it('returns empty selectors gracefully when DB throws', async () => {
    mockQuery.mockRejectedValue(new Error('DB down'));

    const result = await resolver.resolve(makeStep(), makeContext());

    expect(result.selectors).toHaveLength(0);
    expect(mockObservability.log).toHaveBeenCalledWith('warn', expect.any(String), expect.any(Object));
  });
});
