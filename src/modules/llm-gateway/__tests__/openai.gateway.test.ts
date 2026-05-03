import { OpenAIGateway, pickIdentifierAttribute } from '../openai.gateway';
import type { IBillingMeter } from '../../billing-meter/interfaces';
import type { IObservability } from '../../observability/interfaces';

jest.mock('openai');
import { OpenAI } from 'openai';

describe('OpenAIGateway', () => {
  let gateway: OpenAIGateway;
  let mockBillingMeter: jest.Mocked<IBillingMeter>;
  let mockObservability: jest.Mocked<IObservability>;
  let mockCreateCompletion: jest.Mock;
  let mockCreateEmbedding: jest.Mock;
  let mockRedis: { get: jest.Mock; setex: jest.Mock };

  beforeEach(() => {
    mockBillingMeter = {
      emit: jest.fn().mockResolvedValue(undefined),
      getCurrentUsage: jest.fn(),
      isOverBudget: jest.fn(),
    };

    mockObservability = {
      startSpan: jest.fn().mockReturnValue({ end: jest.fn(), setAttribute: jest.fn() }),
      log: jest.fn(),
      increment: jest.fn(),
      histogram: jest.fn(),
    };

    mockCreateCompletion = jest.fn();
    mockCreateEmbedding = jest.fn();
    mockRedis = { get: jest.fn().mockResolvedValue(null), setex: jest.fn().mockResolvedValue('OK') };

    (OpenAI as unknown as jest.Mock).mockImplementation(() => ({
      chat: { completions: { create: mockCreateCompletion } },
      embeddings: { create: mockCreateEmbedding },
    }));

    gateway = new OpenAIGateway(mockBillingMeter, mockObservability, 'mock-key', mockRedis as any);
  });

  afterEach(() => jest.clearAllMocks());

  it('compileStep parses AST and emits token billing event', async () => {
    mockCreateCompletion.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify({ action: 'navigate', url: 'https://youtube.com' }) } }],
      usage: { total_tokens: 45 },
    });

    const result = await gateway.compileStep('open youtube', 'tenant-1');

    expect(result.action).toBe('navigate');
    expect(mockBillingMeter.emit).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-1', eventType: 'LLM_CALL', quantity: 45 }),
    );
  });

  it('compileStep throws and logs on LLM error', async () => {
    mockCreateCompletion.mockRejectedValueOnce(new Error('rate limited'));
    await expect(gateway.compileStep('click submit', 'tenant-1')).rejects.toThrow('rate limited');
    expect(mockObservability.log).toHaveBeenCalledWith('error', 'llm.compileStep_failed', expect.any(Object));
  });

  it('resolveElement parses selectors and emits token metrics', async () => {
    mockCreateCompletion.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify({
        selectors: [{ selector: "[data-kaizen-id='kz-2']", strategy: 'data-testid', confidence: 0.99 }],
      }) } }],
      usage: { total_tokens: 150, prompt_tokens: 100, completion_tokens: 50 },
    });

    const step = { action: 'click' as const, targetDescription: 'login', value: null, url: null, rawText: 'click login', contentHash: '123', targetHash: 'test-target-hash' };
    const candidates = [{ kaizenId: 'kz-2', role: 'button', name: 'Login', cssSelector: '', xpath: '', attributes: {}, textContent: 'Login', isVisible: true, similarityScore: 1 }];

    const result = await gateway.resolveElement(step, candidates, 'tenant-1');

    expect(result.selectors[0].selector).toBe("[data-kaizen-id='kz-2']");
    expect(result.fromCache).toBe(false);
    expect(mockBillingMeter.emit).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'LLM_CALL', quantity: 150 }),
    );
  });

  it('resolveElement writes result to Redis dedup cache', async () => {
    mockCreateCompletion.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify({ selectors: [] }) } }],
      usage: { total_tokens: 50, prompt_tokens: 30, completion_tokens: 20 },
    });

    const step = { action: 'click' as const, targetDescription: 'btn', value: null, url: null, rawText: 'click btn', contentHash: 'abc', targetHash: 'test-target-hash' };
    await gateway.resolveElement(step, [], 'tenant-1');

    expect(mockRedis.setex).toHaveBeenCalledWith(
      expect.stringMatching(/^llm:dedup:/),
      86_400,
      expect.any(String),
    );
  });

  it('resolveElement returns fromCache:true and skips LLM on Redis dedup hit', async () => {
    const cached = { selectors: [{ selector: '#btn', strategy: 'css', confidence: 0.8 }], promptTokens: 0, completionTokens: 0, templateVersion: '1.0.0' };
    mockRedis.get.mockResolvedValueOnce(JSON.stringify(cached));

    const step = { action: 'click' as const, targetDescription: 'btn', value: null, url: null, rawText: 'click btn', contentHash: 'abc', targetHash: 'test-target-hash' };
    const result = await gateway.resolveElement(step, [], 'tenant-1');

    expect(result.fromCache).toBe(true);
    expect(mockCreateCompletion).not.toHaveBeenCalled();
    expect(mockBillingMeter.emit).not.toHaveBeenCalled();
    expect(mockObservability.increment).toHaveBeenCalledWith('llm.prompt_cache_hit');
  });

  it('generateEmbedding returns the 1536-float array from OpenAI', async () => {
    const fakeEmbedding = Array(1536).fill(0.1);
    mockCreateEmbedding.mockResolvedValueOnce({ data: [{ embedding: fakeEmbedding }] });

    const result = await gateway.generateEmbedding('click the subscribe button');

    expect(result).toHaveLength(1536);
    expect(mockCreateEmbedding).toHaveBeenCalledWith({
      model: 'text-embedding-3-small',
      input: 'click the subscribe button',
    });
  });

  it('generateEmbedding increments the embeddings_generated metric', async () => {
    mockCreateEmbedding.mockResolvedValueOnce({ data: [{ embedding: Array(1536).fill(0) }] });
    await gateway.generateEmbedding('some text');
    expect(mockObservability.increment).toHaveBeenCalledWith('llm.embeddings_generated');
  });

  it('generateEmbedding trims whitespace before embedding', async () => {
    mockCreateEmbedding.mockResolvedValueOnce({ data: [{ embedding: Array(1536).fill(0) }] });
    await gateway.generateEmbedding('  padded text  ');
    expect(mockCreateEmbedding).toHaveBeenCalledWith(expect.objectContaining({ input: 'padded text' }));
  });

  it('generateEmbedding logs and throws on API error', async () => {
    mockCreateEmbedding.mockRejectedValueOnce(new Error('embedding failed'));
    await expect(gateway.generateEmbedding('text')).rejects.toThrow('embedding failed');
    expect(mockObservability.log).toHaveBeenCalledWith('error', 'llm.generateEmbedding_failed', expect.any(Object));
  });

  // ── Empty-name disambiguation regression coverage ──────────────────────────
  // Spec: docs/specs/dom-pruner/spec-empty-name-disambiguation.md
  describe('resolveElement prompt builder — empty-name disambiguation', () => {
    function makeCandidate(overrides: Partial<{
      kaizenId: string; role: string; name: string; textContent: string;
      attributes: Record<string, string>;
    }> = {}) {
      return {
        kaizenId: overrides.kaizenId ?? 'kz-1',
        role: overrides.role ?? 'textbox',
        name: overrides.name ?? '',
        cssSelector: '',
        xpath: '',
        attributes: overrides.attributes ?? {},
        textContent: overrides.textContent ?? '',
        isVisible: true,
        similarityScore: 1,
      };
    }

    function captureUserPrompt() {
      const call = mockCreateCompletion.mock.calls.at(-1);
      const messages = call?.[0]?.messages ?? [];
      return messages.find((m: any) => m.role === 'user')?.content ?? '';
    }

    it('renders identifier-attr clause when accessible name is empty', async () => {
      mockCreateCompletion.mockResolvedValueOnce({
        choices: [{ message: { content: JSON.stringify({ kaizenId: 'kz-28' }) } }],
        usage: { total_tokens: 10, prompt_tokens: 8, completion_tokens: 2 },
      });

      const candidates = [
        makeCandidate({ kaizenId: 'kz-27', name: 'City * Zipcode *' }),
        makeCandidate({ kaizenId: 'kz-28', name: '', attributes: { id: 'zipcode', name: 'zipcode', 'data-qa': 'zipcode' } }),
      ];
      const step = { action: 'type', targetDescription: 'zipcode', rawText: 'type 12345 in zipcode', targetHash: 'h1' } as any;

      await gateway.resolveElement(step, candidates as any, 'tenant-1');

      const userPrompt = captureUserPrompt();
      expect(userPrompt).toContain('[kz-28] textbox  (data-qa: "zipcode")');
      // Non-empty candidate stays in the legacy `: "name"` shape.
      expect(userPrompt).toContain('[kz-27] textbox: "City * Zipcode *"');
    });

    it('falls back to "" only when no identifier attributes are present', async () => {
      mockCreateCompletion.mockResolvedValueOnce({
        choices: [{ message: { content: JSON.stringify({ kaizenId: 'kz-9' }) } }],
        usage: { total_tokens: 10, prompt_tokens: 8, completion_tokens: 2 },
      });

      const candidates = [
        makeCandidate({ kaizenId: 'kz-9', name: '', attributes: { class: 'pretty' } }),
      ];
      const step = { action: 'click', targetDescription: 'icon', rawText: 'click the icon', targetHash: 'h2' } as any;

      await gateway.resolveElement(step, candidates as any, 'tenant-1');

      expect(captureUserPrompt()).toContain('[kz-9] textbox: ""');
      expect(mockObservability.increment).toHaveBeenCalledWith('llm.candidate_empty_name');
    });
  });

  describe('pickIdentifierAttribute', () => {
    it('returns null when no identifier attribute is present', () => {
      expect(pickIdentifierAttribute({ class: 'foo', placeholder: 'bar' })).toBeNull();
    });

    it('prefers data-qa over data-testid, data-test, id, name', () => {
      expect(pickIdentifierAttribute({
        'data-qa': 'q', 'data-testid': 't', 'data-test': 'd', id: 'i', name: 'n',
      })).toEqual({ key: 'data-qa', value: 'q' });
    });

    it('falls through priority chain when higher-priority keys are absent', () => {
      expect(pickIdentifierAttribute({ id: 'foo', name: 'bar' }))
        .toEqual({ key: 'id', value: 'foo' });
      expect(pickIdentifierAttribute({ name: 'bar' }))
        .toEqual({ key: 'name', value: 'bar' });
    });

    it('skips keys whose value is the empty string', () => {
      expect(pickIdentifierAttribute({ 'data-qa': '', id: 'real-id' }))
        .toEqual({ key: 'id', value: 'real-id' });
    });
  });
});
