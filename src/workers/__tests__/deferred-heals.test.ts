import {
  immediateOutcomeText, pageShowsText, settleDecision, DeferredHeals, type PendingHeal,
} from '../deferred-heals';
import type { StepAST } from '../../types';

/**
 * S4 — run-outcome-deferred heal persistence. A heal whose pick shares too few
 * words with the step's target (Post → Publish) cannot earn the selector cache on
 * name evidence — provenance bypasses the serve-time name gate, so a weaker
 * persistence gate is a poison vector (finding #16). It earns the cache only when
 * the RUN corroborates it: the run passed, an assert_text directly follows the
 * healed action, and that text was demonstrably absent before the click.
 * Spec: docs/specs/roadmap/spec-research-adoption-2026-11.md §S4
 */
const step = (action: string, value: string | null = null): StepAST =>
  ({ action, value, targetDescription: null, url: null, rawText: `${action} ${value ?? ''}`, contentHash: 'c', targetHash: 't' }) as unknown as StepAST;

describe('immediateOutcomeText — the outcome belongs to the NEXT assertions, nothing later', () => {
  it('finds the assert_text directly after the healed step', () => {
    const steps = [step('navigate'), step('click'), step('assert_text', 'Reactor online.')];
    expect(immediateOutcomeText(steps, 1)).toBe('Reactor online.');
  });

  it('looks through a contiguous block of assertions to the first assert_text', () => {
    const steps = [step('click'), step('assert_visible'), step('assert_text', 'Saved'), step('assert_text', 'Other')];
    expect(immediateOutcomeText(steps, 0)).toBe('Saved');
  });

  it('stops at the next interaction — a later assertion is not this action\'s outcome', () => {
    const steps = [step('click'), step('type', 'hello'), step('assert_text', 'Sent')];
    expect(immediateOutcomeText(steps, 0)).toBeNull();
  });

  it('looks through a plain wait — time passing does not change whose outcome it is (social bench)', () => {
    const steps = [step('click'), step('wait', '1500'), step('assert_text', 'Testing batch loading')];
    expect(immediateOutcomeText(steps, 0)).toBe('Testing batch loading');
    // …but a wait does not license looking past a real interaction behind it.
    expect(immediateOutcomeText([step('click'), step('wait', '500'), step('click'), step('assert_text', 'x')], 0)).toBeNull();
    // …and a wait with nothing asserted after it still corroborates nothing.
    expect(immediateOutcomeText([step('click'), step('wait', '500')], 0)).toBeNull();
  });

  it('returns null when nothing asserts text (assert_visible alone corroborates nothing)', () => {
    expect(immediateOutcomeText([step('click'), step('assert_visible')], 0)).toBeNull();
    expect(immediateOutcomeText([step('click')], 0)).toBeNull(); // healed step is last
  });

  it('skips a {{variable}} value — it is not concrete until the run resolves it — and an empty one', () => {
    expect(immediateOutcomeText([step('click'), step('assert_text', 'Hello {{firstName}}')], 0)).toBeNull();
    expect(immediateOutcomeText([step('click'), step('assert_text', '  ')], 0)).toBeNull();
  });

  it('does not treat a negative assertion as an outcome', () => {
    expect(immediateOutcomeText([step('click'), step('assert_not_text', 'Error')], 0)).toBeNull();
  });
});

describe('pageShowsText — absent is a claim; unknown must never pass for it', () => {
  const frame = (body: string | Error) => ({
    evaluate: jest.fn(async () => { if (body instanceof Error) throw body; return body; }),
  });
  const page = (...frames: ReturnType<typeof frame>[]) => ({ frames: () => frames as any });

  it('true when any frame renders the text, ignoring case and whitespace', async () => {
    expect(await pageShowsText(page(frame('Welcome'), frame('Your   post\n is LIVE')), 'your post is live')).toBe(true);
  });

  it('false when every frame was read and none shows it', async () => {
    expect(await pageShowsText(page(frame('Welcome'), frame('Pricing')), 'Reactor online.')).toBe(false);
  });

  it('null — not false — when no frame could be read at all', async () => {
    expect(await pageShowsText(page(frame(new Error('detached'))), 'Reactor online.')).toBeNull();
    expect(await pageShowsText(page(), 'Reactor online.')).toBeNull();
  });

  it('still answers from the frames it CAN read when another one throws', async () => {
    expect(await pageShowsText(page(frame(new Error('x-process')), frame('Reactor online.')), 'Reactor online.')).toBe(true);
    // …but a readable frame without the text, beside an unreadable one, is "absent" only
    // for what was readable — the documented limit of the check, not a guarantee.
    expect(await pageShowsText(page(frame(new Error('x-process')), frame('nothing')), 'Reactor online.')).toBe(false);
  });

  it('null for a blank needle', async () => {
    expect(await pageShowsText(page(frame('anything')), '   ')).toBeNull();
  });
});

describe('settleDecision — commit only on a passed run with a causal outcome', () => {
  const pending = (over: Partial<PendingHeal> = {}): PendingHeal => ({
    stepIndex: 1, persist: jest.fn(async () => undefined),
    outcomeText: 'Reactor online.', outcomePresentBefore: false, ...over,
  });
  const passed = { runPassed: true, cancelled: false };

  it('commits: run passed, assertion follows, text was absent before the click', () => {
    expect(settleDecision(pending(), passed)).toBe('commit');
  });

  it('discards when the run did not pass — the vault probe: a wrong pick whose assertion fails', () => {
    expect(settleDecision(pending(), { runPassed: false, cancelled: false })).toBe('run_not_passed');
  });

  it('discards a cancelled run even if it had been passing', () => {
    expect(settleDecision(pending(), { runPassed: true, cancelled: true })).toBe('run_not_passed');
  });

  it('discards when no assert_text follows — nothing corroborates the pick', () => {
    expect(settleDecision(pending({ outcomeText: null, outcomePresentBefore: null }), passed)).toBe('no_outcome_assertion');
  });

  it('discards when the outcome text was ALREADY on the page — that assertion cannot show which element was clicked', () => {
    expect(settleDecision(pending({ outcomePresentBefore: true }), passed)).toBe('outcome_already_present');
  });

  it('discards when presence-before could not be determined — unknown is never "absent"', () => {
    expect(settleDecision(pending({ outcomePresentBefore: null }), passed)).toBe('outcome_unknown');
  });
});

describe('DeferredHeals — plan then commit', () => {
  const steps = [step('click'), step('assert_text', 'Saved'), step('click'), step('assert_text', 'Sent')];

  it('exposes the outcome text for a heal at a given step', () => {
    const d = new DeferredHeals(steps);
    expect(d.outcomeTextAfter(0)).toBe('Saved');
    expect(d.outcomeTextAfter(2)).toBe('Sent');
  });

  it('persists ONLY the corroborated heals, and a failing write never throws out', async () => {
    const good = jest.fn(async () => undefined);
    const bad = jest.fn(async () => { throw new Error('db down'); });
    const wrong = jest.fn(async () => undefined);
    const d = new DeferredHeals(steps);
    d.record({ stepIndex: 0, persist: good, outcomeText: 'Saved', outcomePresentBefore: false });
    d.record({ stepIndex: 2, persist: bad, outcomeText: 'Sent', outcomePresentBefore: false });
    d.record({ stepIndex: 4, persist: wrong, outcomeText: 'Seen', outcomePresentBefore: true }); // already true

    const plan = d.plan({ runPassed: true, cancelled: false });
    expect(plan.map((p) => p.decision)).toEqual(['commit', 'commit', 'outcome_already_present']);

    const tally = await d.commit(plan);
    expect(tally).toEqual({ committed: 1, failed: 1 });
    expect(good).toHaveBeenCalledTimes(1);
    expect(bad).toHaveBeenCalledTimes(1);
    expect(wrong).not.toHaveBeenCalled(); // the discarded heal never touches the cache
  });

  it('a failed run commits nothing at all', async () => {
    const persist = jest.fn(async () => undefined);
    const d = new DeferredHeals(steps);
    d.record({ stepIndex: 0, persist, outcomeText: 'Saved', outcomePresentBefore: false });
    const plan = d.plan({ runPassed: false, cancelled: false });
    expect(plan[0].decision).toBe('run_not_passed');
    await d.commit(plan);
    expect(persist).not.toHaveBeenCalled();
  });

  it('re-healing the same step replaces the earlier record instead of duplicating it', () => {
    const d = new DeferredHeals(steps);
    d.record({ stepIndex: 0, persist: jest.fn(async () => undefined), outcomeText: 'Saved', outcomePresentBefore: false });
    d.record({ stepIndex: 0, persist: jest.fn(async () => undefined), outcomeText: 'Saved', outcomePresentBefore: false });
    expect(d.size).toBe(1);
  });
});
