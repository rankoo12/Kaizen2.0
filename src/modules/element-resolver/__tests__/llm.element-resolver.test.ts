import { LLMElementResolver } from '../llm.element-resolver';
import type { IDOMPruner } from '../../dom-pruner/interfaces';
import type { ILLMGateway } from '../../llm-gateway/interfaces';
import type { IObservability } from '../../observability/interfaces';
import type { CandidateNode } from '../../../types';

describe('LLMElementResolver', () => {
  let resolver: LLMElementResolver;
  let mockDOMPruner: jest.Mocked<IDOMPruner>;
  let mockLLMGateway: jest.Mocked<ILLMGateway>;
  let mockObservability: jest.Mocked<IObservability>;
  let mockPage: any;

  beforeEach(() => {
    mockDOMPruner = { prune: jest.fn() };
    
    mockLLMGateway = { 
      compileStep: jest.fn(),
      resolveElement: jest.fn() 
    };
    
    mockObservability = {
      startSpan: jest.fn().mockReturnValue({ end: jest.fn(), setAttribute: jest.fn() }),
      log: jest.fn(),
      increment: jest.fn(),
      histogram: jest.fn()
    };

    // The page.$ command validates whether the element physically exists on the Live Page
    mockPage = {
      $: jest.fn()
    };

    resolver = new LLMElementResolver(mockDOMPruner, mockLLMGateway, mockObservability);
  });

  it('exits early if no target description is required by the action', async () => {
    const step = { action: 'navigate' as const, targetDescription: null, value: 'https://youtube.com', url: 'https://youtube.com', rawText: 'go to youtube', contentHash: 'abc' };
    const context = { tenantId: 'tenant-1', domain: 'youtube.com', page: mockPage };

    const result = await resolver.resolve(step, context);
    
    expect(result.selectors.length).toBe(0);
    expect(mockDOMPruner.prune).not.toHaveBeenCalled();
    expect(mockLLMGateway.resolveElement).not.toHaveBeenCalled();
    expect(mockObservability.log).toHaveBeenCalledWith('info', 'resolver.early_exit', expect.any(Object));
  });

  it('filters out hallucinated selectors during Live Validation', async () => {
    const step = { action: 'click' as const, targetDescription: 'submit button', value: null, url: null, rawText: 'click submit', contentHash: 'abc' };
    const context = { tenantId: 'tenant-1', domain: 'example.com', page: mockPage };

    const candidates: CandidateNode[] = [
      { kaizenId: 'kz-1', role: 'button', name: 'Submit', cssSelector: '', xpath: '', attributes: {}, textContent: 'Submit', isVisible: true, similarityScore: 1 }
    ];

    mockDOMPruner.prune.mockResolvedValueOnce(candidates);

    mockLLMGateway.resolveElement.mockResolvedValueOnce({
      selectors: [
        { selector: "[data-kaizen-id='kz-1']", strategy: "data-testid", confidence: 0.95 },
        { selector: "#fake-llm-hallucination", strategy: "css", confidence: 0.8 }
      ],
      fromCache: false,
      promptTokens: 100,
      completionTokens: 20,
      templateVersion: '1.0.0'
    });

    // Mock Live DOM: kz-1 exists, but the fake-llm-hallucination returns null
    mockPage.$.mockImplementation(async (sel: string) => {
      if (sel === "[data-kaizen-id='kz-1']") return {}; // Element handle exists
      return null; // Element handle is missing
    });

    const result = await resolver.resolve(step, context);

    expect(mockDOMPruner.prune).toHaveBeenCalledTimes(1);
    expect(mockLLMGateway.resolveElement).toHaveBeenCalledTimes(1);
    
    // Only the verified existing element is returned!
    expect(result.selectors.length).toBe(1);
    expect(result.selectors[0].selector).toBe("[data-kaizen-id='kz-1']");
    expect(mockObservability.increment).toHaveBeenCalledWith('resolver.validation_failed', { strategy: 'css' });
  });
});
