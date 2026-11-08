import { OpenAIGateway } from '../openai.gateway';
import { OpenAITestWriterGateway } from '../testwriter.gateway';

jest.mock('openai');
import { OpenAI } from 'openai';

/**
 * S2: every model-calling site routes through model-tier.ts. Before this, the
 * runtime gateway hardcoded 'gpt-4o-mini' in compileStep and resolveElement, so
 * the Jan 14 2027 retirement could not be fixed by env alone.
 */
describe('gateway model routing (S2)', () => {
  const ENV = [
    'KAIZEN_LLM_MODEL_MINI', 'KAIZEN_LLM_MODEL_FRONTIER',
    'KAIZEN_LLM_REASONING_EFFORT_MINI', 'KAIZEN_LLM_REASONING_EFFORT_FRONTIER',
  ];
  let create: jest.Mock;
  let billing: { emit: jest.Mock };
  let obs: { startSpan: jest.Mock; log: jest.Mock; increment: jest.Mock; histogram: jest.Mock };

  beforeEach(() => {
    create = jest.fn();
    billing = { emit: jest.fn().mockResolvedValue(undefined) };
    obs = {
      startSpan: jest.fn().mockReturnValue({ end: jest.fn(), setAttribute: jest.fn() }),
      log: jest.fn(), increment: jest.fn(), histogram: jest.fn(),
    };
    (OpenAI as unknown as jest.Mock).mockImplementation(() => ({
      chat: { completions: { create } },
      embeddings: { create: jest.fn() },
    }));
  });

  afterEach(() => {
    ENV.forEach((k) => delete process.env[k]);
    jest.clearAllMocks();
  });

  const reply = (content: unknown) => ({
    choices: [{ message: { content: JSON.stringify(content) } }],
    usage: { total_tokens: 10, prompt_tokens: 7, completion_tokens: 3 },
  });
  const runtimeGateway = () => new OpenAIGateway(billing as any, obs as any, 'k', { get: jest.fn().mockResolvedValue(null), setex: jest.fn() } as any);
  const candidate = { kaizenId: 'kz-1', role: 'button', name: 'Save', textContent: 'Save', cssSelector: '#s', xpath: '//s', attributes: {}, selectorCandidates: [{ selector: '#s', strategy: 'css', confidence: 0.9 }] } as any;
  const step = { action: 'click', targetDescription: 'Save', rawText: 'click Save', targetHash: 'th', contentHash: 'ch', value: null, url: null } as any;

  describe('runtime gateway (compileStep / resolveElement)', () => {
    it('defaults to gpt-4o-mini with NO reasoning_effort — gpt-4o rejects the parameter', async () => {
      create.mockResolvedValue(reply({ action: 'click', targetDescription: 'Save', value: null, url: null }));
      await runtimeGateway().compileStep('click Save', 't1');

      const arg = create.mock.calls[0][0];
      expect(arg.model).toBe('gpt-4o-mini');
      expect(arg).not.toHaveProperty('reasoning_effort');
      expect(billing.emit).toHaveBeenCalledWith(expect.objectContaining({
        metadata: { model: 'gpt-4o-mini', purpose: 'compileStep' },
      }));
    });

    it('compileStep follows the env to gpt-6-luna, turns reasoning off, and bills the model actually used', async () => {
      process.env.KAIZEN_LLM_MODEL_MINI = 'gpt-6-luna';
      create.mockResolvedValue(reply({ action: 'click', targetDescription: 'Save', value: null, url: null }));
      await runtimeGateway().compileStep('click Save', 't1');

      expect(create).toHaveBeenCalledWith(expect.objectContaining({
        model: 'gpt-6-luna', reasoning_effort: 'none', response_format: { type: 'json_object' },
      }));
      expect(billing.emit).toHaveBeenCalledWith(expect.objectContaining({
        metadata: { model: 'gpt-6-luna', purpose: 'compileStep' },
      }));
    });

    it('resolveElement follows the env too — the second hardcoded site', async () => {
      process.env.KAIZEN_LLM_MODEL_MINI = 'gpt-6-luna';
      create.mockResolvedValue(reply({ kaizenId: 'kz-1' }));
      const result = await runtimeGateway().resolveElement(step, [candidate], 't1');

      expect(create).toHaveBeenCalledWith(expect.objectContaining({ model: 'gpt-6-luna', reasoning_effort: 'none' }));
      expect(result.llmPickedKaizenId).toBe('kz-1');
      expect(billing.emit).toHaveBeenCalledWith(expect.objectContaining({
        metadata: { model: 'gpt-6-luna', purpose: 'resolveElement' },
      }));
    });

    it('warns at construction when the configured model has a published shutdown', () => {
      runtimeGateway();
      expect(obs.log).toHaveBeenCalledWith('warn', 'llm.model_retiring',
        expect.objectContaining({ model: 'gpt-4o-mini', shutdown: '2027-01-14', replacement: 'gpt-6-luna' }));

      obs.log.mockClear();
      process.env.KAIZEN_LLM_MODEL_MINI = 'gpt-6-luna';
      runtimeGateway();
      expect(obs.log).not.toHaveBeenCalledWith('warn', 'llm.model_retiring', expect.anything());
    });
  });

  describe('test-writer gateway (tiered)', () => {
    it('mini-tier calls route to the mini model and frontier-tier to the frontier model, independently', async () => {
      process.env.KAIZEN_LLM_MODEL_MINI = 'gpt-6-luna';
      // frontier left on its default (gpt-4o): the tiers must not bleed into each other.
      create.mockResolvedValue(reply({ purpose: 'p', roles: [], criticalFlows: [], businessRules: [], priorities: [], cautions: [], excludedPaths: [] }));
      const gw = new OpenAITestWriterGateway(billing as any, obs as any, 'k');

      await gw.distillBrief('a product', 't1'); // mini
      expect(create.mock.calls[0][0]).toMatchObject({ model: 'gpt-6-luna', reasoning_effort: 'none' });

      create.mockResolvedValue(reply({ scenarios: [] }));
      await gw.planScenarios({
        maxScenarios: 5, catalogBlock: '', scope: 'public', syntheticDataConsent: false,
        appBrief: {}, capabilitiesByPage: {}, existingCaseNames: [],
      } as any, 't1'); // frontier tier
      const frontierCall = create.mock.calls[1][0];
      expect(frontierCall.model).toBe('gpt-4o');
      expect(frontierCall).not.toHaveProperty('reasoning_effort');
    });

    it('warns for each retiring tier it will call', () => {
      new OpenAITestWriterGateway(billing as any, obs as any, 'k');
      const warned = obs.log.mock.calls.filter(([, ev]) => ev === 'llm.model_retiring').map(([, , d]) => d.model);
      expect(warned.sort()).toEqual(['gpt-4o', 'gpt-4o-mini']);
    });
  });
});
