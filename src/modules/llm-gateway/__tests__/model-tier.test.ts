import {
  modelFor, reasoningParamsFor, retirementNotice, warnOnRetiringModels,
} from '../model-tier';

/**
 * S2 (spec-research-adoption-2026-11): gpt-4o and gpt-4o-mini shut down on
 * 2027-01-14. The router is the one place a model is chosen, and the only place
 * that decides whether a call may carry `reasoning_effort` — gpt-4o rejects the
 * parameter, while gpt-6-luna defaults to `medium` and would silently spend
 * reasoning tokens on every classification call if it were omitted.
 */
describe('modelFor', () => {
  const KEYS = ['KAIZEN_LLM_MODEL_MINI', 'KAIZEN_LLM_MODEL_FRONTIER'];
  afterEach(() => KEYS.forEach((k) => delete process.env[k]));

  it('defaults stay on the models that work today until a deliberate, evidence-gated flip', () => {
    expect(modelFor('mini')).toBe('gpt-4o-mini');
    expect(modelFor('frontier')).toBe('gpt-4o');
  });

  it('reads the env per call — a re-pointed deployment needs no import-time luck', () => {
    process.env.KAIZEN_LLM_MODEL_MINI = 'gpt-6-luna';
    expect(modelFor('mini')).toBe('gpt-6-luna');
    expect(modelFor('frontier')).toBe('gpt-4o'); // tiers are independent
    process.env.KAIZEN_LLM_MODEL_MINI = '  ';
    expect(modelFor('mini')).toBe('gpt-4o-mini'); // blank is not a model
  });
});

describe('reasoningParamsFor', () => {
  const KEYS = ['KAIZEN_LLM_REASONING_EFFORT_MINI', 'KAIZEN_LLM_REASONING_EFFORT_FRONTIER'];
  afterEach(() => KEYS.forEach((k) => delete process.env[k]));

  it('never sends the parameter to gpt-4o — it rejects it outright', () => {
    expect(reasoningParamsFor('gpt-4o-mini', 'mini')).toEqual({});
    expect(reasoningParamsFor('gpt-4o', 'frontier')).toEqual({});
    process.env.KAIZEN_LLM_REASONING_EFFORT_MINI = 'high';
    expect(reasoningParamsFor('gpt-4o-mini', 'mini')).toEqual({}); // even when env asks
  });

  it('turns reasoning OFF for gpt-6 on the mini tier — its default is medium, and classification never asked', () => {
    expect(reasoningParamsFor('gpt-6-luna', 'mini')).toEqual({ reasoning_effort: 'none' });
  });

  it('leaves the frontier tier on the model default — judgment is what frontier tokens are for', () => {
    expect(reasoningParamsFor('gpt-6-luna', 'frontier')).toEqual({});
  });

  it('honors a per-tier env override, and ignores values the API would reject', () => {
    process.env.KAIZEN_LLM_REASONING_EFFORT_FRONTIER = 'High'; // case-insensitive
    expect(reasoningParamsFor('gpt-6-luna', 'frontier')).toEqual({ reasoning_effort: 'high' });

    process.env.KAIZEN_LLM_REASONING_EFFORT_MINI = 'ludicrous';
    expect(reasoningParamsFor('gpt-6-luna', 'mini')).toEqual({ reasoning_effort: 'none' }); // falls to the default
  });

  it('does not assume older reasoning families accept `none` — they get an effort only when asked', () => {
    expect(reasoningParamsFor('gpt-5-mini', 'mini')).toEqual({});
    expect(reasoningParamsFor('o3', 'mini')).toEqual({});
    process.env.KAIZEN_LLM_REASONING_EFFORT_MINI = 'low';
    expect(reasoningParamsFor('gpt-5-mini', 'mini')).toEqual({ reasoning_effort: 'low' });
  });
});

describe('retirementNotice', () => {
  const NOW = new Date('2026-11-08T12:00:00Z');

  it('flags the gpt-4o family — aliases and dated snapshots — with the published date and replacement', () => {
    for (const model of ['gpt-4o', 'gpt-4o-mini', 'gpt-4o-2024-08-06', 'gpt-4o-2024-11-20', 'gpt-4o-mini-2024-07-18']) {
      expect(retirementNotice(model, NOW)).toMatchObject({
        model, shutdown: '2027-01-14', replacement: 'gpt-6-luna', daysLeft: 67,
      });
    }
  });

  it('reports the already-shut-down snapshot as negative days left, with its own replacement', () => {
    const n = retirementNotice('gpt-4o-2024-05-13', NOW);
    expect(n).toMatchObject({ shutdown: '2026-10-23', replacement: 'gpt-5.6-sol' });
    expect(n!.daysLeft).toBeLessThan(0);
  });

  it('stays quiet for models with no published shutdown, and for lookalike names it does not use', () => {
    expect(retirementNotice('gpt-6-luna', NOW)).toBeNull();
    expect(retirementNotice('text-embedding-3-small', NOW)).toBeNull();
    expect(retirementNotice('gpt-4o-mini-tts', NOW)).toBeNull(); // different model, different date
  });
});

describe('warnOnRetiringModels', () => {
  const makeObs = () => ({ log: jest.fn(), increment: jest.fn(), startSpan: jest.fn(), histogram: jest.fn() });

  it('warns once per distinct retiring model, naming the date and the replacement', () => {
    const obs = makeObs();
    warnOnRetiringModels(obs as any, ['gpt-4o-mini', 'gpt-4o', 'gpt-4o-mini']);
    expect(obs.log).toHaveBeenCalledTimes(2);
    expect(obs.log).toHaveBeenCalledWith('warn', 'llm.model_retiring',
      expect.objectContaining({ model: 'gpt-4o-mini', shutdown: '2027-01-14', replacement: 'gpt-6-luna' }));
  });

  it('is silent when nothing configured is retiring', () => {
    const obs = makeObs();
    warnOnRetiringModels(obs as any, ['gpt-6-luna']);
    expect(obs.log).not.toHaveBeenCalled();
  });
});
