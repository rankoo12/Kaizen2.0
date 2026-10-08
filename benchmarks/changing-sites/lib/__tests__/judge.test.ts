import { judgeSite } from '../judge';
import type { RunEvidence, SiteEvidence, SiteExpectations, StepEvidence } from '../types';

/** Minimal step; override what the scenario needs. */
const step = (over: Partial<StepEvidence> = {}): StepEvidence => ({
  i: 0, text: 'click the "Go" button', status: 'passed', source: 'redis',
  selector: 'role=button[name="Go"]', errorType: null, failureClass: null,
  tokens: 0, heals: [], ...over,
});

const run = (caseName: string, status: string, steps: StepEvidence[]): RunEvidence =>
  ({ runId: `run-${caseName}`, caseName, status, steps });

const evidenceWith = (r2: RunEvidence[], r3: RunEvidence[]): SiteEvidence => ({
  site: 't', host: 'site-t', suiteId: 's', tenantId: 'tn',
  cases: [], unvalidated: [], r1: [],
  r2_v2: r2, r3_v2: r3,
} as unknown as SiteEvidence);

const exps = (over: Partial<SiteExpectations> = {}): SiteExpectations => ({
  site: 't', defaultOutcome: 'pass-unchanged', expectations: [], ...over,
});

describe('judgeSite — outcome classes', () => {
  it('pass-unchanged: clean cache-served pass is PASS', () => {
    const v = judgeSite(evidenceWith([run('ctrl', 'passed', [step()])], []), exps(), 'v2');
    expect(v.verdicts[0].verdict).toBe('PASS');
  });

  it('pass-unchanged: an unexpected heal on an untouched flow is FAIL (loud default)', () => {
    const healed = run('ctrl', 'healed', [step({
      status: 'healed',
      heals: [{ class: 'TIMING', strategy: 'AdaptiveWaitStrategy', ok: true, old: '#a', new: '#a' }],
    })]);
    const v = judgeSite(evidenceWith([healed], []), exps(), 'v2');
    expect(v.verdicts[0].verdict).toBe('FAIL');
    expect(v.verdicts[0].reasons.join(' ')).toMatch(/zero healing events|clean pass/);
  });

  it('pass-unchanged: resolution tokens spent on an untouched flow is FAIL', () => {
    const v = judgeSite(evidenceWith([run('ctrl', 'passed', [step({ tokens: 420, source: 'llm' })])], []), exps(), 'v2');
    expect(v.verdicts[0].verdict).toBe('FAIL');
  });

  it('heal-learned: resolve_and_retry heal + clean r3 is PASS', () => {
    const e = exps({ expectations: [{ id: 't.h', match: { namePattern: 'renamed' }, mutation: 'label-rename', outcome: 'heal-learned' }] });
    const r2 = run('renamed button', 'healed', [step({
      status: 'healed',
      heals: [{ class: 'TIMING', strategy: 'ResolveAndRetryStrategy', ok: true, old: '#dead', new: 'role=button[name="Log in"]' }],
    })]);
    const r3 = run('renamed button', 'passed', [step({ selector: 'role=button[name="Log in"]' })]);
    const v = judgeSite(evidenceWith([r2], [r3]), e, 'v2');
    expect(v.verdicts[0].verdict).toBe('PASS');
  });

  it('heal-learned: r3 re-healing means the learning did not stick — FAIL', () => {
    const e = exps({ expectations: [{ id: 't.h', match: { namePattern: 'renamed' }, mutation: 'label-rename', outcome: 'heal-learned' }] });
    const heal = { class: 'TIMING', strategy: 'ResolveAndRetryStrategy', ok: true, old: '#dead', new: '#new' };
    const r2 = run('renamed button', 'healed', [step({ status: 'healed', heals: [heal] })]);
    const r3 = run('renamed button', 'healed', [step({ status: 'healed', heals: [heal] })]);
    const v = judgeSite(evidenceWith([r2], [r3]), e, 'v2');
    expect(v.verdicts[0].verdict).toBe('FAIL');
    expect(v.verdicts[0].reasons.join(' ')).toMatch(/re-healed|should pass clean/);
  });

  it('heal-any via a non-persisting strategy is GAP (healed-not-learned)', () => {
    const e = exps({ expectations: [{ id: 't.h', match: { namePattern: 'mutated' }, mutation: 'cosmetic-churn', outcome: 'heal-any' }] });
    const r2 = run('mutated flow', 'healed', [step({
      status: 'healed',
      heals: [{ class: 'ELEMENT_MUTATED', strategy: 'FallbackSelectorStrategy', ok: true, old: '#dead', new: '#alive' }],
    })]);
    const v = judgeSite(evidenceWith([r2], []), e, 'v2');
    expect(v.verdicts[0].verdict).toBe('GAP');
    expect(v.verdicts[0].reasons.join(' ')).toMatch(/healed-not-learned/);
  });

  it('must-fail: an honest failure is PASS', () => {
    const e = exps({ expectations: [{ id: 't.mf', match: { namePattern: 'removed' }, mutation: 'feature-removed', outcome: 'must-fail' }] });
    const r2 = run('removed feature', 'failed', [step({ status: 'failed', errorType: 'ElementNotFound', failureClass: 'TIMING' })]);
    const v = judgeSite(evidenceWith([r2], []), e, 'v2');
    expect(v.verdicts[0].verdict).toBe('PASS');
  });

  it('must-fail: a green run is FALSE-PASS — the hard bench failure', () => {
    const e = exps({ expectations: [{ id: 't.mf', match: { namePattern: 'removed' }, mutation: 'feature-removed', outcome: 'must-fail' }] });
    const r2 = run('removed feature', 'healed', [step({
      status: 'healed',
      heals: [{ class: 'ELEMENT_REMOVED', strategy: 'ResolveAndRetryStrategy', ok: true, old: '#gone', new: '#other-tab' }],
    })]);
    const v = judgeSite(evidenceWith([r2], []), e, 'v2');
    expect(v.verdicts[0].verdict).toBe('FALSE-PASS');
    expect(v.counts['FALSE-PASS']).toBe(1);
  });

  it('decoy-resist: green without touching a decoy is PASS; grabbing one is FALSE-PASS', () => {
    const e = exps({ expectations: [{ id: 't.d', match: { namePattern: 'checkout' }, mutation: 'decoy-added', outcome: 'decoy-resist', decoyMarkers: ['data-decoy'] }] });
    const clean = judgeSite(evidenceWith([run('checkout flow', 'passed', [step()])], []), e, 'v2');
    expect(clean.verdicts[0].verdict).toBe('PASS');

    const grabbed = judgeSite(evidenceWith([run('checkout flow', 'healed', [step({
      status: 'healed',
      heals: [{ class: 'ELEMENT_MUTATED', strategy: 'ElementSimilarityStrategy', ok: true, old: '#checkout', new: 'button[data-decoy="true"]' }],
    })])], []), e, 'v2');
    expect(grabbed.verdicts[0].verdict).toBe('FALSE-PASS');
  });

  it('negative control: AssertionHealedOntoDifferentElement on a GREEN run is a violation', () => {
    const r2 = run('any flow', 'passed', [step({ errorType: 'AssertionHealedOntoDifferentElement' })]);
    const v = judgeSite(evidenceWith([r2], []), exps(), 'v2');
    expect(v.negativeControlViolations.length).toBe(1);
  });

  it('negative control: the same marker on a FAILED run is fine (the refusal worked)', () => {
    const r2 = run('any flow', 'failed', [step({ status: 'failed', errorType: 'AssertionHealedOntoDifferentElement' })]);
    const v = judgeSite(evidenceWith([r2], []), exps(), 'v2');
    // The case itself violates the loud default (failed ≠ pass-unchanged), but
    // the NEGATIVE CONTROL must not fire — the engine refused honestly.
    expect(v.negativeControlViolations.length).toBe(0);
  });

  it('unmatched cases fall to the loud default, named in the verdict', () => {
    const v = judgeSite(evidenceWith([run('surprise flow', 'failed', [step({ status: 'failed' })])], []), exps(), 'v2');
    expect(v.verdicts[0].expectationId).toBe('t.default');
    expect(v.verdicts[0].verdict).toBe('FAIL');
  });
});
