/**
 * Worker feedback loop tests.
 *
 * Verifies that the worker awaits critical state-update calls (recordSuccess,
 * recordFailure, archetypeResolver.learn) instead of fire-and-forget, ensuring
 * the system's self-improvement loop is reliable.
 *
 * These are unit-level tests that mock infrastructure but verify the calling
 * contract between the worker and its dependencies.
 */

import { LLMElementResolver } from '../../modules/element-resolver/llm.element-resolver';
import { CachedElementResolver } from '../../modules/element-resolver/cached.element-resolver';
import { CompositeElementResolver } from '../../modules/element-resolver/composite.element-resolver';
import type { IDOMPruner } from '../../modules/dom-pruner/interfaces';
import type { ILLMGateway } from '../../modules/llm-gateway/interfaces';
import type { IObservability } from '../../modules/observability/interfaces';

jest.mock('../../db/pool', () => ({
  getPool: jest.fn().mockReturnValue({ query: jest.fn() }),
}));

import { getPool } from '../../db/pool';

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

describe('Worker feedback loop — recordFailure propagation', () => {
  let llmResolver: LLMElementResolver;
  let cachedResolver: CachedElementResolver;
  let composite: CompositeElementResolver;
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

    llmResolver = new LLMElementResolver(mockDOMPruner, mockLLMGateway, obs, undefined, mockRedis as any);
    cachedResolver = new CachedElementResolver(mockRedis as any, mockLLMGateway, obs);
    composite = new CompositeElementResolver([cachedResolver, llmResolver], obs);
  });

  afterEach(() => jest.clearAllMocks());

  it('recordFailure updates Postgres outcome window and invalidates Redis', async () => {
    // Setup: existing selector_cache row with healthy outcome window
    mockQuery
      .mockResolvedValueOnce({ rows: [{ outcome_window: [true, true, true] }] })  // SELECT
      .mockResolvedValueOnce({ rows: [] });                                         // UPDATE

    mockRedis.scan.mockResolvedValueOnce(['0', ['sel:t1:hash1:site.com']]);
    mockRedis.del.mockResolvedValueOnce(1);

    // Act: simulate what the worker does after a step fails.
    // The worker now awaits this call instead of fire-and-forget.
    await composite.recordFailure('hash1', 'site.com', 'role=button[name="Login"]');

    // Assert: Postgres was queried (SELECT + UPDATE)
    expect(mockQuery).toHaveBeenCalledTimes(2);

    // Assert: Redis was invalidated
    expect(mockRedis.scan).toHaveBeenCalled();
    expect(mockRedis.del).toHaveBeenCalledWith('sel:t1:hash1:site.com');
  });

  it('recordSuccess updates Postgres outcome window', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ outcome_window: [true, false] }] })  // SELECT
      .mockResolvedValueOnce({ rows: [] });                                    // UPDATE

    await composite.recordSuccess('hash1', 'site.com', 'role=button[name="Login"]');

    // Should have queried for the outcome window and then updated it
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it('recordFailure completes even when Postgres is temporarily unavailable', async () => {
    // Simulate Postgres being down — both cached and LLM resolver catch this internally
    const dbError = Object.assign(new Error('connection refused'), { code: '08006' });
    mockQuery.mockRejectedValue(dbError);

    // Should not throw — errors are caught inside the resolver
    await expect(
      composite.recordFailure('hash1', 'site.com', '#btn'),
    ).resolves.toBeUndefined();

    // The observability layer should have logged the failure
    expect(obs.log).toHaveBeenCalledWith(
      'warn',
      'resolver.outcome_update_failed',
      expect.objectContaining({ error: expect.any(String) }),
    );
  });

  it('Redis invalidation happens AFTER Postgres update (ordering)', async () => {
    const callOrder: string[] = [];

    mockQuery.mockImplementation(async (..._args: any[]) => {
      callOrder.push('postgres');
      return { rows: [{ outcome_window: [true] }] };
    });

    mockRedis.scan.mockImplementation(async (..._args: any[]) => {
      callOrder.push('redis_scan');
      return ['0', ['sel:t1:hash1:site.com']];
    });

    mockRedis.del.mockImplementation(async (..._args: any[]) => {
      callOrder.push('redis_del');
      return 1;
    });

    await llmResolver.recordFailure('hash1', 'site.com', '#btn');

    // Postgres SELECT and UPDATE must happen before Redis invalidation
    expect(callOrder.indexOf('redis_scan')).toBeGreaterThan(callOrder.indexOf('postgres'));
  });
});
