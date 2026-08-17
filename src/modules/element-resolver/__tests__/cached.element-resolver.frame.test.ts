import { CachedElementResolver } from '../cached.element-resolver';
import type { ILLMGateway } from '../../llm-gateway/interfaces';
import type { IObservability } from '../../observability/interfaces';

jest.mock('../../../db/pool', () => ({
  getPool: jest.fn().mockReturnValue({ query: jest.fn() }),
}));
// Tenant helpers route to the pool mock above — see src/db/__mocks__/transaction.ts
jest.mock('../../../db/transaction');

jest.mock('../redis-cache.utils', () => ({
  invalidateRedisCache: jest.fn().mockResolvedValue(0),
  isTransient: jest.fn().mockReturnValue(false),
}));

import { getPool } from '../../../db/pool';

/**
 * The frame guard — spec-iframe-selector-caching.md §4.4.
 *
 * A frame-scoped selector handed back from cache when its iframe is gone would be run
 * against the top document, match nothing, and fail a step on a healthy site. A miss
 * costs one LLM call; a false hit costs a red run. These tests pin that trade.
 */

const VEC_DIM = 8;
const aligned = (): number[] => {
  const v = new Array(VEC_DIM).fill(0);
  v[0] = 1;
  return v;
};

const CONSENT_CANONICAL = 'https://cdn.privacy-mgmt.com/index.html';
const CONSENT_LIVE = 'https://cdn.privacy-mgmt.com/index.html?consentUUID=fresh-session&_sp=x';
const ACCEPT = { selector: 'button[title="Accept all"]', strategy: 'css', confidence: 0.9 };

const makeStep = () => ({
  action: 'click' as const,
  targetDescription: 'accept cookies button',
  value: null,
  url: null,
  rawText: 'click accept cookies',
  contentHash: 'hash-consent',
  targetHash: 'target-consent',
});

/** A page whose child frames report `urls`, with `count` matches for any selector. */
const pageWithFrames = (urls: string[], count = 1) => ({
  frames: () => urls.map((u) => ({
    url: () => u,
    locator: () => ({ count: async () => count }),
  })),
});

describe('CachedElementResolver — frame guard', () => {
  let resolver: CachedElementResolver;
  let mockRedis: { get: jest.Mock; setex: jest.Mock };
  let mockObservability: jest.Mocked<IObservability>;
  let mockQuery: jest.Mock;

  beforeEach(() => {
    mockRedis = { get: jest.fn().mockResolvedValue(null), setex: jest.fn().mockResolvedValue('OK') };
    mockObservability = {
      startSpan: jest.fn().mockReturnValue({ end: jest.fn(), setAttribute: jest.fn() }),
      log: jest.fn(),
      increment: jest.fn(),
      histogram: jest.fn(),
    } as unknown as jest.Mocked<IObservability>;
    mockQuery = jest.fn();
    (getPool as jest.Mock).mockReturnValue({ query: mockQuery });

    const gateway = {
      compileStep: jest.fn(),
      resolveElement: jest.fn(),
      generateEmbedding: jest.fn().mockResolvedValue(aligned()),
    } as unknown as jest.Mocked<ILLMGateway>;

    resolver = new CachedElementResolver(mockRedis as any, gateway, mockObservability);
  });

  afterEach(() => jest.clearAllMocks());

  const context = (page: unknown) => ({
    tenantId: '00000000-0000-0000-0000-000000000001',
    domain: 'example.com',
    page,
    stepEmbedding: aligned(),
  });

  const dbRowWithFrame = (frameUrl: string | null) => ({
    rows: [{
      selectors: [ACCEPT],
      step_embedding: aligned(),
      element_embedding: aligned(),
      frame_url: frameUrl,
    }],
  });

  it('L2: returns the hit when the frame is present and the selector resolves inside it', async () => {
    mockQuery.mockResolvedValueOnce(dbRowWithFrame(CONSENT_CANONICAL));

    // The live frame carries a fresh session token; only the canonical form matches.
    const result = await resolver.resolve(makeStep(), context(pageWithFrames([CONSENT_LIVE])));

    expect(result.selectors).toEqual([ACCEPT]);
    expect(result.resolutionSource).toBe('db_exact');
    expect(result.frameUrl).toBe(CONSENT_CANONICAL);
    expect(mockObservability.increment).toHaveBeenCalledWith('resolver.cache_hit', { source: 'db_target' });
  });

  it('L2: misses when the iframe is not on the page', async () => {
    mockQuery.mockResolvedValueOnce(dbRowWithFrame(CONSENT_CANONICAL));

    const result = await resolver.resolve(makeStep(), context(pageWithFrames(['https://example.com/other'])));

    expect(result.selectors).toHaveLength(0);
    expect(result.fromCache).toBe(false);
    expect(mockObservability.increment).toHaveBeenCalledWith(
      'resolver.frame_guard_reject', { source: 'db_exact', reason: 'frame_absent' },
    );
  });

  it('L2: misses when the frame is there but the selector no longer resolves inside it', async () => {
    mockQuery.mockResolvedValueOnce(dbRowWithFrame(CONSENT_CANONICAL));

    const result = await resolver.resolve(makeStep(), context(pageWithFrames([CONSENT_LIVE], 0)));

    expect(result.selectors).toHaveLength(0);
    expect(mockObservability.increment).toHaveBeenCalledWith(
      'resolver.frame_guard_reject', { source: 'db_exact', reason: 'selector_absent_in_frame' },
    );
  });

  it('a rejected frame entry is NOT deleted — the entry is fine, the frame is just absent', async () => {
    mockQuery.mockResolvedValueOnce(dbRowWithFrame(CONSENT_CANONICAL));

    await resolver.resolve(makeStep(), context(pageWithFrames([])));

    expect(mockQuery.mock.calls.some((c) => /DELETE FROM selector_cache/.test(c[0]))).toBe(false);
  });

  it('main-document entries never touch the guard, even on a page with no frames at all', async () => {
    mockQuery.mockResolvedValueOnce(dbRowWithFrame(null));

    const result = await resolver.resolve(makeStep(), context({}));

    expect(result.selectors).toEqual([ACCEPT]);
    expect(result.frameUrl).toBeUndefined();
    expect(mockObservability.increment).not.toHaveBeenCalledWith(
      'resolver.frame_guard_reject', expect.anything(),
    );
  });

  it('L1: a v3 Redis payload carries the frame through, and the guard applies to it', async () => {
    mockRedis.get.mockResolvedValueOnce(JSON.stringify({
      v: 3, selectors: [ACCEPT], stepEmbedding: aligned(), elementEmbedding: aligned(),
      frameUrl: CONSENT_CANONICAL,
    }));
    mockQuery.mockResolvedValue({ rows: [] });

    const hit = await resolver.resolve(makeStep(), context(pageWithFrames([CONSENT_LIVE])));
    expect(hit.resolutionSource).toBe('redis');
    expect(hit.frameUrl).toBe(CONSENT_CANONICAL);

    mockRedis.get.mockResolvedValueOnce(JSON.stringify({
      v: 3, selectors: [ACCEPT], stepEmbedding: aligned(), elementEmbedding: aligned(),
      frameUrl: CONSENT_CANONICAL,
    }));
    const miss = await resolver.resolve(makeStep(), context(pageWithFrames([])));
    expect(miss.selectors).toHaveLength(0);
  });

  it('L1: a v2 payload written before this change still parses, as a main-document entry', async () => {
    mockRedis.get.mockResolvedValueOnce(JSON.stringify({
      v: 2, selectors: [ACCEPT], stepEmbedding: aligned(), elementEmbedding: aligned(),
    }));

    const result = await resolver.resolve(makeStep(), context({}));

    expect(result.selectors).toEqual([ACCEPT]);
    expect(result.resolutionSource).toBe('redis');
    expect(result.frameUrl).toBeUndefined();
  });

  it('promotes a frame entry into Redis as v3, so the L1 hit is guarded too', async () => {
    mockQuery.mockResolvedValueOnce(dbRowWithFrame(CONSENT_CANONICAL));

    await resolver.resolve(makeStep(), context(pageWithFrames([CONSENT_LIVE])));

    const written = JSON.parse(mockRedis.setex.mock.calls[0][2]);
    expect(written.v).toBe(3);
    expect(written.frameUrl).toBe(CONSENT_CANONICAL);
  });
});
