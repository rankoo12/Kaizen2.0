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

  it('resolveElement maps the LLM-picked kaizenId to the candidate selectors and emits token metrics', async () => {
    // Contract: the LLM returns only { kaizenId } (disambiguation). The gateway
    // maps that id back to the candidate's pre-generated selectorCandidates —
    // selector generation is the DOM pruner's job, not the LLM's.
    mockCreateCompletion.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify({ kaizenId: 'kz-2' }) } }],
      usage: { total_tokens: 150, prompt_tokens: 100, completion_tokens: 50 },
    });

    const step = { action: 'click' as const, targetDescription: 'login', value: null, url: null, rawText: 'click login', contentHash: '123', targetHash: 'test-target-hash' };
    const candidates = [{
      kaizenId: 'kz-2', role: 'button', name: 'Login', cssSelector: '', xpath: '', attributes: {},
      textContent: 'Login', isVisible: true, similarityScore: 1,
      selectorCandidates: [{ selector: "[data-kaizen-id='kz-2']", strategy: 'data-testid' as const, confidence: 0.99 }],
    }];

    const result = await gateway.resolveElement(step, candidates, 'tenant-1');

    expect(result.selectors[0].selector).toBe("[data-kaizen-id='kz-2']");
    expect(result.llmPickedKaizenId).toBe('kz-2');
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
      3_600, // intentional 1-hour TTL — see resolveElement (avoids serving stale wrong picks after a verdict=failed rerun)
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

  // The dedup cache is a one-hour LLM-call dedupe, NOT a place tenants learn from
  // each other (that is the governed shared pool). It used to be content-addressed
  // only: two tenants presenting the same step over the same candidate set — say,
  // both testing one vendor's signed-in UI — shared an entry, and a hit returns the
  // cached resolution wholesale (selector list and prompted-candidate names
  // included). Spec: spec-research-adoption-2026-11 §S4 (prompt-cache scoping).
  describe('dedup cache is scoped by tenant', () => {
    const step = { action: 'click' as const, targetDescription: 'login', value: null, url: null, rawText: 'click login', contentHash: '123', targetHash: 'target-xyz' };
    const candidate = (selector: string) => ({
      kaizenId: 'kz-1', role: 'button', name: 'Login', cssSelector: 'role=button[name="Login"]', xpath: '', attributes: {},
      textContent: 'Login', isVisible: true, similarityScore: 1,
      selectorCandidates: [{ selector, strategy: 'data-testid' as const, confidence: 0.99 }],
    });
    /** A working in-memory Redis, so the test sees REAL hit/miss behaviour, not scripted answers. */
    const memoryRedis = () => {
      const store = new Map<string, string>();
      return {
        store,
        get: jest.fn(async (k: string) => store.get(k) ?? null),
        setex: jest.fn(async (k: string, _ttl: number, v: string) => { store.set(k, v); return 'OK'; }),
      };
    };
    const llmPicksKz1 = () => mockCreateCompletion.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({ kaizenId: 'kz-1' }) } }],
      usage: { total_tokens: 20, prompt_tokens: 10, completion_tokens: 10 },
    });

    it('a second tenant on the SAME step and candidates does not get the first tenant\'s cached resolution', async () => {
      const redis = memoryRedis();
      llmPicksKz1();
      const gw = new OpenAIGateway(mockBillingMeter, mockObservability, 'k', redis as any);

      // Tenant A resolves; its private selector lands in the cache.
      const a = await gw.resolveElement(step, [candidate('[data-testid="acme-private-login"]')], 'tenant-A');
      expect(a.selectors[0].selector).toBe('[data-testid="acme-private-login"]');
      expect(mockCreateCompletion).toHaveBeenCalledTimes(1);

      // Tenant B presents an identical step + candidate fingerprint but its OWN selector.
      const b = await gw.resolveElement(step, [candidate('[data-testid="globex-login"]')], 'tenant-B');

      expect(b.fromCache).toBe(false);                                   // not served A's entry
      expect(b.selectors[0].selector).toBe('[data-testid="globex-login"]'); // and never sees A's selector
      expect(mockCreateCompletion).toHaveBeenCalledTimes(2);             // it paid for its own call
      expect(redis.store.size).toBe(2);                                  // two separate entries
    });

    it('the SAME tenant still dedupes — scoping must not cost the cache its purpose', async () => {
      const redis = memoryRedis();
      llmPicksKz1();
      const gw = new OpenAIGateway(mockBillingMeter, mockObservability, 'k', redis as any);

      await gw.resolveElement(step, [candidate('#login')], 'tenant-A');
      const again = await gw.resolveElement(step, [candidate('#login')], 'tenant-A');

      expect(again.fromCache).toBe(true);
      expect(mockCreateCompletion).toHaveBeenCalledTimes(1);
      expect(mockObservability.increment).toHaveBeenCalledWith('llm.prompt_cache_hit');
    });

    it('keeps the llm:dedup:{targetHash}: prefix the pattern evictions rely on, for every tenant', async () => {
      // verdict=failed (runs.ts) and the worker's recovery evict with
      // `llm:dedup:{targetHash}:*` — a tenant in the key must not break that.
      const redis = memoryRedis();
      llmPicksKz1();
      const gw = new OpenAIGateway(mockBillingMeter, mockObservability, 'k', redis as any);

      await gw.resolveElement(step, [candidate('#login')], 'tenant-A');
      await gw.resolveElement(step, [candidate('#login')], 'tenant-B');

      const keys = [...redis.store.keys()];
      expect(keys).toHaveLength(2);
      for (const k of keys) expect(k).toMatch(/^llm:dedup:target-xyz:[0-9a-f]{64}$/);
      expect(new Set(keys).size).toBe(2); // distinct per tenant, same prefix
    });
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
