import { CompositeElementResolver } from '../composite.element-resolver';
import type { IElementResolver } from '../interfaces';
import type { IObservability } from '../../observability/interfaces';
import type { ILLMGateway } from '../../llm-gateway/interfaces';
import type { SelectorSet, ResolutionContext } from '../../../types';

const makeStep = () => ({
  action: 'click' as const,
  targetDescription: 'submit button',
  value: null,
  url: null,
  rawText: 'click submit',
  contentHash: 'hash-abc',
      targetHash: 'test-target-hash',
});

const makeContext = () => ({
  tenantId: '00000000-0000-0000-0000-000000000001',
  domain: 'example.com',
  page: {},
});

const hitSet = (source: 'tenant' | 'shared' = 'tenant'): SelectorSet => ({
  selectors: [{ selector: '#btn', strategy: 'css', confidence: 0.9 }],
  fromCache: true,
  cacheSource: source,
  resolutionSource: null,
  similarityScore: null,
});

const missSet: SelectorSet = { selectors: [], fromCache: false, cacheSource: null, resolutionSource: null, similarityScore: null };

describe('CompositeElementResolver', () => {
  let composite: CompositeElementResolver;
  let mockCached: jest.Mocked<IElementResolver>;
  let mockLLM: jest.Mocked<IElementResolver>;
  let mockObservability: jest.Mocked<IObservability>;

  beforeEach(() => {
    mockCached = {
      resolve: jest.fn(),
      recordSuccess: jest.fn().mockResolvedValue(undefined),
      recordFailure: jest.fn().mockResolvedValue(undefined),
    };

    mockLLM = {
      resolve: jest.fn(),
      recordSuccess: jest.fn().mockResolvedValue(undefined),
      recordFailure: jest.fn().mockResolvedValue(undefined),
    };

    mockObservability = {
      startSpan: jest.fn().mockReturnValue({ end: jest.fn(), setAttribute: jest.fn() }),
      log: jest.fn(),
      increment: jest.fn(),
      histogram: jest.fn(),
    };

    composite = new CompositeElementResolver([mockCached, mockLLM], mockObservability);
  });

  afterEach(() => jest.clearAllMocks());

  it('returns cache result directly and never calls LLM on cache hit', async () => {
    mockCached.resolve.mockResolvedValueOnce(hitSet());

    const result = await composite.resolve(makeStep(), makeContext());

    expect(result.fromCache).toBe(true);
    expect(result.selectors).toHaveLength(1);
    expect(mockLLM.resolve).not.toHaveBeenCalled();
  });

  it('falls through to next resolver on cache miss (empty selectors)', async () => {
    mockCached.resolve.mockResolvedValueOnce(missSet);
    mockLLM.resolve.mockResolvedValueOnce({
      selectors: [{ selector: "[data-kaizen-id='kz-1']", strategy: 'data-testid', confidence: 0.99 }],
      fromCache: false,
      cacheSource: null,
      resolutionSource: 'llm',
      similarityScore: null,
    });

    const result = await composite.resolve(makeStep(), makeContext());

    expect(result.fromCache).toBe(false);
    expect(mockLLM.resolve).toHaveBeenCalledTimes(1);
  });

  it('recordSuccess delegates to all resolvers', async () => {
    await composite.recordSuccess('hash', 'example.com', '#btn');

    expect(mockCached.recordSuccess).toHaveBeenCalledWith('hash', 'example.com', '#btn');
    expect(mockLLM.recordSuccess).toHaveBeenCalledWith('hash', 'example.com', '#btn');
  });

  it('recordFailure delegates to all resolvers', async () => {
    await composite.recordFailure('hash', 'example.com', '#btn');

    expect(mockCached.recordFailure).toHaveBeenCalledWith('hash', 'example.com', '#btn');
    expect(mockLLM.recordFailure).toHaveBeenCalledWith('hash', 'example.com', '#btn');
  });

  it('returns empty selectors and emits full_miss when all resolvers miss', async () => {
    mockCached.resolve.mockResolvedValueOnce(missSet);
    mockLLM.resolve.mockResolvedValueOnce(missSet);

    const result = await composite.resolve(makeStep(), makeContext());

    expect(result.selectors).toHaveLength(0);
    expect(mockLLM.resolve).toHaveBeenCalledTimes(1);
    expect(mockObservability.increment).toHaveBeenCalledWith('composite_resolver.full_miss', { action: 'click' });
  });

  it('returns first resolver result without calling subsequent resolvers', async () => {
    const mockFirst: jest.Mocked<IElementResolver> = {
      resolve: jest.fn().mockResolvedValue(hitSet()),
      recordSuccess: jest.fn().mockResolvedValue(undefined),
      recordFailure: jest.fn().mockResolvedValue(undefined),
    };
    composite = new CompositeElementResolver([mockFirst, mockCached, mockLLM], mockObservability);

    const result = await composite.resolve(makeStep(), makeContext());

    expect(result.selectors).toHaveLength(1);
    expect(mockCached.resolve).not.toHaveBeenCalled();
    expect(mockLLM.resolve).not.toHaveBeenCalled();
  });

  describe('step embedding propagation', () => {
    const makeMockGateway = (): jest.Mocked<ILLMGateway> => ({
      resolveElement: jest.fn(),
      generatePrompt: jest.fn(),
      complete: jest.fn(),
      generateEmbedding: jest.fn().mockResolvedValue([0.1, 0.2, 0.3]),
    } as unknown as jest.Mocked<ILLMGateway>);

    it('skips embedding when the first resolver (L0 archetype) hits', async () => {
      const mockArchetype: jest.Mocked<IElementResolver> = {
        resolve: jest.fn().mockResolvedValue(hitSet()),
        recordSuccess: jest.fn().mockResolvedValue(undefined),
        recordFailure: jest.fn().mockResolvedValue(undefined),
      };
      const gateway = makeMockGateway();
      composite = new CompositeElementResolver([mockArchetype, mockCached, mockLLM], mockObservability, gateway);

      await composite.resolve(makeStep(), makeContext());

      expect(gateway.generateEmbedding).not.toHaveBeenCalled();
    });

    it('computes step embedding exactly once when the chain passes L0', async () => {
      const mockArchetype: jest.Mocked<IElementResolver> = {
        resolve: jest.fn().mockResolvedValue(missSet),
        recordSuccess: jest.fn().mockResolvedValue(undefined),
        recordFailure: jest.fn().mockResolvedValue(undefined),
      };
      mockCached.resolve.mockResolvedValueOnce(missSet);
      mockLLM.resolve.mockResolvedValueOnce(hitSet());
      const gateway = makeMockGateway();
      composite = new CompositeElementResolver([mockArchetype, mockCached, mockLLM], mockObservability, gateway);

      await composite.resolve(makeStep(), makeContext());

      expect(gateway.generateEmbedding).toHaveBeenCalledTimes(1);
      expect(gateway.generateEmbedding).toHaveBeenCalledWith('click submit button');
    });

    it('propagates the embedding via ResolutionContext.stepEmbedding', async () => {
      const mockArchetype: jest.Mocked<IElementResolver> = {
        resolve: jest.fn().mockResolvedValue(missSet),
        recordSuccess: jest.fn().mockResolvedValue(undefined),
        recordFailure: jest.fn().mockResolvedValue(undefined),
      };
      mockCached.resolve.mockResolvedValueOnce(hitSet());
      const gateway = makeMockGateway();
      composite = new CompositeElementResolver([mockArchetype, mockCached, mockLLM], mockObservability, gateway);

      await composite.resolve(makeStep(), makeContext());

      const cachedCallContext = mockCached.resolve.mock.calls[0][1] as ResolutionContext;
      expect(cachedCallContext.stepEmbedding).toEqual([0.1, 0.2, 0.3]);
    });

    it('skips embedding entirely when targetDescription is null', async () => {
      const navStep = { ...makeStep(), targetDescription: null };
      mockCached.resolve.mockResolvedValueOnce(hitSet());
      const gateway = makeMockGateway();
      composite = new CompositeElementResolver([mockCached, mockLLM], mockObservability, gateway);

      await composite.resolve(navStep, makeContext());

      expect(gateway.generateEmbedding).not.toHaveBeenCalled();
      const ctx = mockCached.resolve.mock.calls[0][1] as ResolutionContext;
      expect(ctx.stepEmbedding).toBeUndefined();
    });

    it('does not crash when llmGateway is undefined (backwards-compat)', async () => {
      mockCached.resolve.mockResolvedValueOnce(hitSet());
      composite = new CompositeElementResolver([mockCached, mockLLM], mockObservability);

      const result = await composite.resolve(makeStep(), makeContext());
      expect(result.selectors).toHaveLength(1);
    });

    it('on embedding failure falls through with undefined stepEmbedding and logs', async () => {
      const mockArchetype: jest.Mocked<IElementResolver> = {
        resolve: jest.fn().mockResolvedValue(missSet),
        recordSuccess: jest.fn().mockResolvedValue(undefined),
        recordFailure: jest.fn().mockResolvedValue(undefined),
      };
      mockCached.resolve.mockResolvedValueOnce(hitSet());
      const gateway = makeMockGateway();
      gateway.generateEmbedding.mockRejectedValueOnce(new Error('openai down'));
      composite = new CompositeElementResolver([mockArchetype, mockCached, mockLLM], mockObservability, gateway);

      const result = await composite.resolve(makeStep(), makeContext());

      expect(result.selectors).toHaveLength(1); // still resolves on the cached layer
      expect(mockObservability.log).toHaveBeenCalledWith(
        'warn',
        'composite_resolver.embedding_failed',
        expect.objectContaining({ error: 'openai down' }),
      );
      const ctx = mockCached.resolve.mock.calls[0][1] as ResolutionContext;
      expect(ctx.stepEmbedding).toBeUndefined();
    });
  });
});
