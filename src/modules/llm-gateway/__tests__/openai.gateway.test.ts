import { OpenAIGateway } from '../openai.gateway';
import type { IBillingMeter } from '../../billing-meter/interfaces';
import type { IObservability } from '../../observability/interfaces';

// Mock the openAI module completely
jest.mock('openai');
import { OpenAI } from 'openai';

describe('OpenAIGateway', () => {
  let gateway: OpenAIGateway;
  let mockBillingMeter: jest.Mocked<IBillingMeter>;
  let mockObservability: jest.Mocked<IObservability>;
  let mockCreateCompletion: jest.Mock;

  beforeEach(() => {
    mockBillingMeter = {
      emit: jest.fn().mockResolvedValue(undefined),
      getCurrentUsage: jest.fn(),
      isOverBudget: jest.fn()
    };

    mockObservability = {
      startSpan: jest.fn().mockReturnValue({ end: jest.fn(), setAttribute: jest.fn() }),
      log: jest.fn(),
      increment: jest.fn(),
      histogram: jest.fn()
    };

    // Setup the mock behavior for OpenAI Chat Completions
    mockCreateCompletion = jest.fn();
    (OpenAI as unknown as jest.Mock).mockImplementation(() => ({
      chat: {
        completions: {
          create: mockCreateCompletion
        }
      }
    }));

    gateway = new OpenAIGateway(mockBillingMeter, mockObservability, 'mock-key');
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('compileStep parses AST and emits token billing events', async () => {
    mockCreateCompletion.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify({ action: 'navigate', url: 'youtube' }) } }],
      usage: { total_tokens: 45 }
    });

    const result = await gateway.compileStep('open youtube', 'tenant-1');

    expect(result.action).toBe('navigate');
    expect(result.url).toBe('youtube');
    expect(mockBillingMeter.emit).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-1',
      eventType: 'LLM_CALL',
      quantity: 45,
      unit: 'tokens'
    }));
  });

  it('resolveElement parses selectors and emits token metrics', async () => {
    mockCreateCompletion.mockResolvedValueOnce({
      choices: [{ 
        message: { 
          content: JSON.stringify({ 
            selectors: [{ selector: "[data-kaizen-id='kz-2']", strategy: "data-testid", confidence: 0.99 }] 
          }) 
        } 
      }],
      usage: { total_tokens: 150, prompt_tokens: 100, completion_tokens: 50 }
    });

    const step = { action: 'click' as const, targetDescription: 'login button', value: null, url: null, rawText: 'click login', contentHash: '123' };
    const candidates = [
      { kaizenId: 'kz-2', role: 'button', name: 'Login', cssSelector: '', xpath: '', attributes: {}, textContent: 'Login', isVisible: true, similarityScore: 1 }
    ];

    const result = await gateway.resolveElement(step, candidates, 'tenant-1');

    expect(result.selectors.length).toBe(1);
    expect(result.selectors[0].selector).toBe("[data-kaizen-id='kz-2']");
    expect(result.promptTokens).toBe(100);
    expect(mockBillingMeter.emit).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'LLM_CALL',
      quantity: 150
    }));
  });
});
