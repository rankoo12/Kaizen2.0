import { LLMElementResolver } from '../llm.element-resolver';
import type { IDOMPruner } from '../../dom-pruner/interfaces';
import type { ILLMGateway } from '../../llm-gateway/interfaces';
import type { IObservability } from '../../observability/interfaces';
import type { CandidateNode } from '../../../types';

jest.mock('../../../db/pool', () => ({
  getPool: jest.fn().mockReturnValue({ query: jest.fn() }),
}));

import { getPool } from '../../../db/pool';

describe('LLMElementResolver', () => {
  let resolver: LLMElementResolver;
  let mockDOMPruner: jest.Mocked<IDOMPruner>;
  let mockLLMGateway: jest.Mocked<ILLMGateway>;
  let mockObservability: jest.Mocked<IObservability>;
  let mockPage: { $: jest.Mock };
  let mockQuery: jest.Mock;

  beforeEach(() => {
    mockDOMPruner = { prune: jest.fn() };

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

    mockPage = { $: jest.fn() };

    mockQuery = jest.fn().mockResolvedValue({ rows: [] });
    (getPool as jest.Mock).mockReturnValue({ query: mockQuery });

    resolver = new LLMElementResolver(mockDOMPruner, mockLLMGateway, mockObservability);
  });

  afterEach(() => jest.clearAllMocks());

  it('exits early if no target description is required by the action', async () => {
    const step = { action: 'navigate' as const, targetDescription: null, value: null, url: 'https://youtube.com', rawText: 'go to youtube', contentHash: 'abc' };
    const context = { tenantId: 'tenant-1', domain: 'youtube.com', page: mockPage };

    const result = await resolver.resolve(step, context);

    expect(result.selectors).toHaveLength(0);
    expect(mockDOMPruner.prune).not.toHaveBeenCalled();
    expect(mockLLMGateway.resolveElement).not.toHaveBeenCalled();
  });

  it('filters out hallucinated selectors during live DOM validation', async () => {
    const step = { action: 'click' as const, targetDescription: 'submit button', value: null, url: null, rawText: 'click submit', contentHash: 'abc' };
    const context = { tenantId: 'tenant-1', domain: 'example.com', page: mockPage };

    const candidates: CandidateNode[] = [
      { kaizenId: 'kz-1', role: 'button', name: 'Submit', cssSelector: '', xpath: '', attributes: {}, textContent: 'Submit', isVisible: true, similarityScore: 1 },
    ];

    mockDOMPruner.prune.mockResolvedValueOnce(candidates);
    mockLLMGateway.resolveElement.mockResolvedValueOnce({
      selectors: [
        { selector: "[data-kaizen-id='kz-1']", strategy: 'data-testid', confidence: 0.95 },
        { selector: '#fake-hallucination', strategy: 'css', confidence: 0.8 },
      ],
      fromCache: false,
      promptTokens: 100,
      completionTokens: 20,
      templateVersion: '1.0.0',
    });

    mockPage.$.mockImplementation(async (sel: string) =>
      sel === "[data-kaizen-id='kz-1']" ? {} : null,
    );

    const result = await resolver.resolve(step, context);

    expect(result.selectors).toHaveLength(1);
    expect(result.selectors[0].selector).toBe("[data-kaizen-id='kz-1']");
    expect(mockObservability.increment).toHaveBeenCalledWith('resolver.validation_failed', { strategy: 'css' });
  });

  it('persists resolved selectors and step_embedding to selector_cache', async () => {
    const step = { action: 'click' as const, targetDescription: 'subscribe', value: null, url: null, rawText: 'click subscribe', contentHash: 'hash-xyz' };
    const context = { tenantId: 'tenant-1', domain: 'youtube.com', page: mockPage };

    mockDOMPruner.prune.mockResolvedValueOnce([
      { kaizenId: 'kz-3', role: 'button', name: 'Subscribe', cssSelector: '', xpath: '', attributes: {}, textContent: 'Subscribe', isVisible: true, similarityScore: 1 },
    ]);
    mockLLMGateway.resolveElement.mockResolvedValueOnce({
      selectors: [{ selector: "[data-kaizen-id='kz-3']", strategy: 'data-testid', confidence: 0.99 }],
      fromCache: false, promptTokens: 80, completionTokens: 20, templateVersion: '1.0.0',
    });
    mockPage.$.mockResolvedValue({});

    await resolver.resolve(step, context);
    await new Promise((r) => setImmediate(r));

    expect(mockLLMGateway.generateEmbedding).toHaveBeenCalledWith('click subscribe');
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO selector_cache'),
      expect.arrayContaining(['tenant-1', 'hash-xyz', 'youtube.com']),
    );
  });

  it('does not persist when all selectors fail live DOM validation', async () => {
    const step = { action: 'click' as const, targetDescription: 'ghost', value: null, url: null, rawText: 'click ghost', contentHash: 'ghost-hash' };
    const context = { tenantId: 'tenant-1', domain: 'example.com', page: mockPage };

    mockDOMPruner.prune.mockResolvedValueOnce([
      { kaizenId: 'kz-1', role: 'button', name: 'Ghost', cssSelector: '', xpath: '', attributes: {}, textContent: 'Ghost', isVisible: true, similarityScore: 1 },
    ]);
    mockLLMGateway.resolveElement.mockResolvedValueOnce({
      selectors: [{ selector: '#ghost', strategy: 'css', confidence: 0.5 }],
      fromCache: false, promptTokens: 50, completionTokens: 10, templateVersion: '1.0.0',
    });
    mockPage.$.mockResolvedValue(null);

    await resolver.resolve(step, context);
    await new Promise((r) => setImmediate(r));

    expect(mockLLMGateway.generateEmbedding).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('recordSuccess updates outcome_window with a success in DB', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ outcome_window: [true, true, false] }] })
      .mockResolvedValueOnce({ rows: [] });

    await resolver.recordSuccess('hash', 'example.com', '#btn');

    expect(mockQuery).toHaveBeenCalledTimes(2);
    const updateCall = mockQuery.mock.calls[1];
    expect(updateCall[0]).toContain('UPDATE selector_cache');
    const newWindow = JSON.parse(updateCall[1][0]);
    expect(newWindow[newWindow.length - 1]).toBe(true);
  });

  it('recordFailure updates outcome_window with a failure in DB', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ outcome_window: [true, true] }] })
      .mockResolvedValueOnce({ rows: [] });

    await resolver.recordFailure('hash', 'example.com', '#btn');

    const updateCall = mockQuery.mock.calls[1];
    const newWindow = JSON.parse(updateCall[1][0]);
    expect(newWindow[newWindow.length - 1]).toBe(false);
  });

  it('recordSuccess is a no-op when selector_cache row does not exist', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await expect(resolver.recordSuccess('nonexistent', 'example.com', '#btn')).resolves.not.toThrow();
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });
});
