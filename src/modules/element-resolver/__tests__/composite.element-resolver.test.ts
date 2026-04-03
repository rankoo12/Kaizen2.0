import { CompositeElementResolver } from '../composite.element-resolver';
import type { IElementResolver } from '../interfaces';
import type { IObservability } from '../../observability/interfaces';
import type { SelectorSet } from '../../../types';

const makeStep = () => ({
  action: 'click' as const,
  targetDescription: 'submit button',
  value: null,
  url: null,
  rawText: 'click submit',
  contentHash: 'hash-abc',
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
});

const missSet: SelectorSet = { selectors: [], fromCache: false, cacheSource: null };

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

    composite = new CompositeElementResolver(mockCached, mockLLM, mockObservability);
  });

  afterEach(() => jest.clearAllMocks());

  it('returns cache result directly and never calls LLM on cache hit', async () => {
    mockCached.resolve.mockResolvedValueOnce(hitSet());

    const result = await composite.resolve(makeStep(), makeContext());

    expect(result.fromCache).toBe(true);
    expect(result.selectors).toHaveLength(1);
    expect(mockLLM.resolve).not.toHaveBeenCalled();
  });

  it('falls through to LLM resolver on cache miss (empty selectors)', async () => {
    mockCached.resolve.mockResolvedValueOnce(missSet);
    mockLLM.resolve.mockResolvedValueOnce({
      selectors: [{ selector: "[data-kaizen-id='kz-1']", strategy: 'data-testid', confidence: 0.99 }],
      fromCache: false,
      cacheSource: null,
    });

    const result = await composite.resolve(makeStep(), makeContext());

    expect(result.fromCache).toBe(false);
    expect(mockLLM.resolve).toHaveBeenCalledTimes(1);
    expect(mockObservability.increment).toHaveBeenCalledWith(
      'composite_resolver.llm_escalation',
      { action: 'click' },
    );
  });

  it('recordSuccess delegates to both cached and llm resolvers', async () => {
    await composite.recordSuccess('hash', 'example.com', '#btn');

    expect(mockCached.recordSuccess).toHaveBeenCalledWith('hash', 'example.com', '#btn');
    expect(mockLLM.recordSuccess).toHaveBeenCalledWith('hash', 'example.com', '#btn');
  });

  it('recordFailure delegates to both cached and llm resolvers', async () => {
    await composite.recordFailure('hash', 'example.com', '#btn');

    expect(mockCached.recordFailure).toHaveBeenCalledWith('hash', 'example.com', '#btn');
    expect(mockLLM.recordFailure).toHaveBeenCalledWith('hash', 'example.com', '#btn');
  });

  it('returns LLM result even when LLM also returns empty selectors', async () => {
    mockCached.resolve.mockResolvedValueOnce(missSet);
    mockLLM.resolve.mockResolvedValueOnce(missSet);

    const result = await composite.resolve(makeStep(), makeContext());

    expect(result.selectors).toHaveLength(0);
    expect(mockLLM.resolve).toHaveBeenCalledTimes(1);
  });
});
