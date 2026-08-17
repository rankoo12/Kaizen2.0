import { judgeWithRepair } from '../write/judge-round';
import type { WrittenScenario, WriteOutcome } from '../write/scenario-writer';
import type { JudgeVerdict, PlannedScenario } from '../../../types/test-writer';
import type { IObservability } from '../../observability/interfaces';

/**
 * Spec: docs/specs/test-writer/spec-judge-repair-loop.md §2.2
 * PROPOSE survives untouched; anything else gets ONE rewrite on the judge's
 * reasons and one re-judge; REVISE falls back to its original, REJECT is out.
 */

const obs = {
  log: jest.fn(), increment: jest.fn(), histogram: jest.fn(), gauge: jest.fn(),
} as unknown as IObservability;

function scenario(name: string, steps: string[]): WrittenScenario {
  const plan: PlannedScenario = {
    name, journey: null, kind: 'happy', priority: 'normal', rationale: 'r', outline: '',
    targetPages: ['https://shop.test/'], source: { kind: 'llm' }, requiresSyntheticData: false,
  };
  return {
    plan, name, kind: 'positive', intents: [], expectation: { outcome: 'pass' }, rationale: 'r',
    lintFindings: [], needsConsent: false, selectorSeeds: [],
    steps: steps.map((text) => ({ text, ast: {} as never })),
  };
}

const verdict = (planRef: string, v: JudgeVerdict['verdict'], reason = 'weak oracle'): JudgeVerdict => ({
  planRef, verdict: v,
  dimensions: v === 'PROPOSE'
    ? [{ dimension: 'meaningful_oracle', pass: true, reason: 'ok' }]
    : [{ dimension: 'meaningful_oracle', pass: false, reason }],
});

const rewriteOk = (w: WrittenScenario): WriteOutcome => ({
  ok: true, scenario: scenario(w.plan.name, [...w.steps.map((s) => s.text).slice(0, -1), 'verify the cart lists the item']),
});

describe('judgeWithRepair', () => {
  beforeEach(() => jest.clearAllMocks());

  it('rewrites non-PROPOSE scenarios once with the judge\'s reasons and keeps the ones that come back PROPOSE', async () => {
    const good = scenario('Add to cart', ['click a random add to cart button', 'verify the text "{{selectedItem}}" is shown']);
    const weak = scenario('Sort listing', ['select "Price" from the dropdown', 'verify the url contains "inventory"']);
    const dead = scenario('Visit home', ['navigate to https://shop.test/', 'verify the "Products" heading is visible']);

    const judge = jest.fn()
      .mockResolvedValueOnce([verdict('Add to cart', 'PROPOSE'), verdict('Sort listing', 'REVISE', 'asserts the url, not the order'), verdict('Visit home', 'REJECT', 'static heading')])
      .mockResolvedValueOnce([verdict('Sort listing', 'PROPOSE'), verdict('Visit home', 'REJECT', 'still static')]);
    const rewrite = jest.fn(async (w: WrittenScenario, _feedback: string[]) => rewriteOk(w));

    const out = await judgeWithRepair([good, weak, dead], { judge, rewrite, obs });

    expect(judge).toHaveBeenCalledTimes(2);
    expect(rewrite).toHaveBeenCalledTimes(2);
    // The rewrite got the judge's words, and the steps it read.
    expect(rewrite.mock.calls[0][0].plan.name).toBe('Sort listing');
    expect(rewrite.mock.calls[0][1]).toEqual(['meaningful_oracle: asserts the url, not the order']);
    // Round two judged only the rewrites.
    expect(judge.mock.calls[1][0].map((w: WrittenScenario) => w.plan.name)).toEqual(['Sort listing', 'Visit home']);

    expect(out.survivors.map((w) => w.plan.name)).toEqual(['Add to cart', 'Sort listing']);
    // The survivor is the REWRITTEN sort test, not the original.
    expect(out.survivors[1].steps.map((s) => s.text)).toContain('verify the cart lists the item');
    expect(out.rejected).toEqual([{
      name: 'Visit home', stage: 'judge',
      reason: 'meaningful_oracle: static heading; after one rewrite: meaningful_oracle: still static',
      steps: expect.arrayContaining(['verify the cart lists the item']),
    }]);
    expect(out.repairAttempted).toBe(2);
    expect(out.repaired).toBe(1);
  });

  it('a REVISE whose rewrite fails keeps its original; a REJECT whose rewrite fails is out with both reasons', async () => {
    const revise = scenario('Sort listing', ['select "Price"', 'verify the url contains "inventory"']);
    const reject = scenario('Visit home', ['navigate to https://shop.test/', 'verify heading']);
    const judge = jest.fn().mockResolvedValueOnce([verdict('Sort listing', 'REVISE'), verdict('Visit home', 'REJECT', 'static')]);
    const rewrite = jest.fn(async (w: WrittenScenario): Promise<WriteOutcome> => ({
      ok: false, failure: { plan: w.plan, stage: 'schema', reason: 'failed the schema gate twice', steps: ['type in a link'] },
    }));

    const out = await judgeWithRepair([revise, reject], { judge, rewrite, obs });

    expect(judge).toHaveBeenCalledTimes(1);           // nothing to re-judge
    expect(out.survivors).toEqual([revise]);          // proposed with findings, as before
    expect(out.rejected).toEqual([{
      name: 'Visit home', stage: 'judge',
      reason: 'meaningful_oracle: static; rewrite failed: failed the schema gate twice',
      steps: ['type in a link'],
    }]);
    expect(out.repaired).toBe(0);
  });

  it('a judge outage lets everything through, exactly as before', async () => {
    const a = scenario('A', ['x', 'verify y']);
    const judge = jest.fn().mockRejectedValue(new Error('429'));
    const rewrite = jest.fn();
    const out = await judgeWithRepair([a], { judge, rewrite, obs });
    expect(out.survivors).toEqual([a]);
    expect(rewrite).not.toHaveBeenCalled();
    expect(obs.log).toHaveBeenCalledWith('warn', 'testwriter.judge_failed', expect.anything());
  });

  it('never rewrites twice: a rewrite that comes back REVISE is settled, not looped', async () => {
    const weak = scenario('Sort listing', ['select "Price"', 'verify the url contains "inventory"']);
    const judge = jest.fn()
      .mockResolvedValueOnce([verdict('Sort listing', 'REVISE')])
      .mockResolvedValueOnce([verdict('Sort listing', 'REVISE', 'still weak')]);
    const rewrite = jest.fn(async (w: WrittenScenario, _feedback: string[]) => rewriteOk(w));
    const out = await judgeWithRepair([weak], { judge, rewrite, obs });
    expect(rewrite).toHaveBeenCalledTimes(1);
    expect(judge).toHaveBeenCalledTimes(2);
    expect(out.survivors).toEqual([weak]);            // original REVISE falls back
    expect(out.rejected).toEqual([]);
  });
});
