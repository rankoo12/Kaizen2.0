import { LLMElementResolver } from '../llm.element-resolver';
import type { IDOMPruner } from '../../dom-pruner/interfaces';
import type { ILLMGateway } from '../../llm-gateway/interfaces';
import type { IObservability } from '../../observability/interfaces';

jest.mock('../../../db/pool', () => ({
  getPool: jest.fn().mockReturnValue({ query: jest.fn() }),
}));

import { getPool } from '../../../db/pool';

const makeObservability = (): jest.Mocked<IObservability> => ({
  startSpan: jest.fn().mockReturnValue({ end: jest.fn(), setAttribute: jest.fn() }),
  log: jest.fn(),
  increment: jest.fn(),
  histogram: jest.fn(),
});

const makeMockRedis = () => ({
  scan: jest.fn().mockResolvedValue(['0', []]),
  del: jest.fn().mockResolvedValue(0),
  get: jest.fn().mockResolvedValue(null),
  setex: jest.fn().mockResolvedValue('OK'),
});

describe('LLMElementResolver — persistToCache retry', () => {
  let resolver: LLMElementResolver;
  let obs: jest.Mocked<IObservability>;
  let mockQuery: jest.Mock;
  let mockRedis: ReturnType<typeof makeMockRedis>;

  beforeEach(() => {
    obs = makeObservability();
    mockQuery = jest.fn().mockResolvedValue({ rows: [] });
    (getPool as jest.Mock).mockReturnValue({ query: mockQuery });
    mockRedis = makeMockRedis();

    const mockDOMPruner: jest.Mocked<IDOMPruner> = { prune: jest.fn() };
    const mockLLMGateway: jest.Mocked<ILLMGateway> = {
      compileStep: jest.fn(),
      resolveElement: jest.fn(),
      generateEmbedding: jest.fn().mockResolvedValue(Array(1536).fill(0.1)),
    };

    resolver = new LLMElementResolver(mockDOMPruner, mockLLMGateway, obs, undefined, mockRedis as any);
  });

  afterEach(() => jest.clearAllMocks());

  it('retries once on transient Postgres error (code 08006)', async () => {
    const transientError = Object.assign(new Error('connection lost'), { code: '08006' });
    mockQuery
      .mockRejectedValueOnce(transientError)  // first attempt fails
      .mockResolvedValueOnce({ rows: [] });    // retry succeeds

    // Call recordSuccess to trigger updateOutcomeWindow → which does a SELECT then UPDATE.
    // The SELECT fails transiently — but updateOutcomeWindow catches errors internally.
    // Instead, test the writeCacheRow retry via the private persistToCache.
    // We'll trigger it indirectly via resolve() which calls persistToCache at the end.

    // For a focused test, access the private method via prototype
    const writeCacheRow = (resolver as any).writeCacheRow.bind(resolver);
    const context = { tenantId: 'tenant-1', domain: 'example.com', pageUrl: 'https://example.com/login' };
    const step = { targetHash: 'hash1', action: 'click', targetDescription: 'button' };
    const selectorSet = { selectors: [{ selector: 'role=button[name="Login"]', strategy: 'aria', confidence: 0.95 }] };

    await writeCacheRow(context, step, selectorSet, Array(1536).fill(0.1), Array(1536).fill(0.1));

    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(obs.increment).toHaveBeenCalledWith('resolver.cache_write_retry');
  });

  it('does not retry on non-transient error (code 23505 unique violation)', async () => {
    const uniqueError = Object.assign(new Error('duplicate key'), { code: '23505' });
    mockQuery.mockRejectedValueOnce(uniqueError);

    const writeCacheRow = (resolver as any).writeCacheRow.bind(resolver);
    const context = { tenantId: 'tenant-1', domain: 'example.com', pageUrl: 'https://example.com' };
    const step = { targetHash: 'hash1', action: 'click', targetDescription: 'button' };
    const selectorSet = { selectors: [{ selector: '#btn', strategy: 'css', confidence: 0.9 }] };

    await expect(
      writeCacheRow(context, step, selectorSet, Array(1536).fill(0.1), Array(1536).fill(0.1)),
    ).rejects.toThrow('duplicate key');

    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(obs.increment).not.toHaveBeenCalledWith('resolver.cache_write_retry');
  });

  it('logs warning when retry also fails', async () => {
    const transientError = Object.assign(new Error('connection lost'), { code: '08006' });
    mockQuery
      .mockRejectedValueOnce(transientError)
      .mockRejectedValueOnce(transientError);

    const writeCacheRow = (resolver as any).writeCacheRow.bind(resolver);
    const context = { tenantId: 'tenant-1', domain: 'example.com', pageUrl: 'https://example.com' };
    const step = { targetHash: 'hash1', action: 'click', targetDescription: 'button' };
    const selectorSet = { selectors: [{ selector: '#btn', strategy: 'css', confidence: 0.9 }] };

    await expect(
      writeCacheRow(context, step, selectorSet, Array(1536).fill(0.1), Array(1536).fill(0.1)),
    ).rejects.toThrow('connection lost');

    expect(obs.increment).toHaveBeenCalledWith('resolver.cache_write_retry');
  });
});

describe('LLMElementResolver — updateOutcomeWindow Redis invalidation', () => {
  let resolver: LLMElementResolver;
  let obs: jest.Mocked<IObservability>;
  let mockQuery: jest.Mock;
  let mockRedis: ReturnType<typeof makeMockRedis>;

  beforeEach(() => {
    obs = makeObservability();
    mockQuery = jest.fn();
    (getPool as jest.Mock).mockReturnValue({ query: mockQuery });
    mockRedis = makeMockRedis();

    const mockDOMPruner: jest.Mocked<IDOMPruner> = { prune: jest.fn() };
    const mockLLMGateway: jest.Mocked<ILLMGateway> = {
      compileStep: jest.fn(),
      resolveElement: jest.fn(),
      generateEmbedding: jest.fn().mockResolvedValue(Array(1536).fill(0.1)),
    };

    resolver = new LLMElementResolver(mockDOMPruner, mockLLMGateway, obs, undefined, mockRedis as any);
  });

  afterEach(() => jest.clearAllMocks());

  it('invalidates Redis after Postgres outcome update', async () => {
    // SELECT returns an existing outcome window
    mockQuery
      .mockResolvedValueOnce({ rows: [{ outcome_window: [true, true] }] })  // SELECT
      .mockResolvedValueOnce({ rows: [] });                                   // UPDATE

    mockRedis.scan.mockResolvedValueOnce(['0', ['sel:t1:hash1:example.com']]);
    mockRedis.del.mockResolvedValueOnce(1);

    await resolver.recordFailure('hash1', 'example.com', 'role=button[name="Login"]');

    expect(mockRedis.scan).toHaveBeenCalledWith('0', 'MATCH', 'sel:*:hash1:example.com', 'COUNT', '100');
    expect(mockRedis.del).toHaveBeenCalledWith('sel:t1:hash1:example.com');
    expect(obs.increment).toHaveBeenCalledWith('resolver.redis_invalidated', { count: '1' });
  });

  it('works when no Redis keys exist to invalidate', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ outcome_window: [true] }] })
      .mockResolvedValueOnce({ rows: [] });

    mockRedis.scan.mockResolvedValueOnce(['0', []]);

    await resolver.recordSuccess('hash1', 'example.com', 'role=button[name="Login"]');

    expect(mockRedis.del).not.toHaveBeenCalled();
  });

  it('still works when Redis is not provided (optional param)', async () => {
    const mockDOMPruner: jest.Mocked<IDOMPruner> = { prune: jest.fn() };
    const mockLLMGateway: jest.Mocked<ILLMGateway> = {
      compileStep: jest.fn(),
      resolveElement: jest.fn(),
      generateEmbedding: jest.fn().mockResolvedValue(Array(1536).fill(0.1)),
    };

    // No redis param
    const resolverNoRedis = new LLMElementResolver(mockDOMPruner, mockLLMGateway, obs);

    mockQuery
      .mockResolvedValueOnce({ rows: [{ outcome_window: [true] }] })
      .mockResolvedValueOnce({ rows: [] });

    // Should not throw
    await resolverNoRedis.recordFailure('hash1', 'example.com', '#btn');

    expect(mockRedis.scan).not.toHaveBeenCalled();
  });
});
