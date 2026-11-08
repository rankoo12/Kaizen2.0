import { oracleStrength, oracleStrengthAt, oracleProfile, assertionWeakening } from '../write/oracle-strength';
import type { StepIntent } from '../../../types/test-writer';

/**
 * S3 — oracle strength: how much can this assertion actually tell us?
 * Spec: docs/specs/roadmap/spec-research-adoption-2026-11.md §S3. A test whose only
 * assertions are "is visible" passes while the app is wrong in every way that
 * matters, and repair agents "converge" partly by deleting or weakening assertions.
 */
const EL = '11111111-1111-4111-8111-111111111111';
const el = { kind: 'element' as const, elementId: EL };

const click: StepIntent = { action: 'click', target: el };
const visible: StepIntent = { action: 'assert_visible', target: el };
const text = (value: string): StepIntent => ({ action: 'assert_text', value });
const url = (value: string): StepIntent => ({ action: 'assert_url', value });
const attr = (expected: string): StepIntent =>
  ({ action: 'assert_attribute', target: el, attribute: 'href', expected });
const count = (): StepIntent => ({ action: 'assert_count', target: el, value: '3' }) as unknown as StepIntent;

describe('oracleStrength', () => {
  it('ranks value comparisons strong; location, absence and control STATE moderate; bare visibility weak', () => {
    expect(oracleStrength(text('Order confirmed'))).toBe('strong');
    expect(oracleStrength(count())).toBe('strong');
    expect(oracleStrength(attr('/cart'))).toBe('strong');

    expect(oracleStrength(url('/dashboard'))).toBe('moderate');
    expect(oracleStrength({ action: 'assert_title', value: 'Home' })).toBe('moderate');
    expect(oracleStrength({ action: 'assert_not_text', value: 'Error' })).toBe('moderate');

    // Control state / disappearance is the OUTCOME of a toggle, enable or close —
    // a first cut called these weak and flagged exactly such tests on real data.
    for (const action of ['assert_checked', 'assert_not_checked', 'assert_enabled', 'assert_disabled', 'assert_not_visible'] as const) {
      expect(oracleStrength({ action, target: el })).toBe('moderate');
    }

    // Only "the element exists" is weak.
    expect(oracleStrength({ action: 'assert_visible', target: el })).toBe('weak');
  });

  it('is null for anything that is not an assertion', () => {
    expect(oracleStrength(click)).toBeNull();
    expect(oracleStrength({ action: 'wait', value: '500' })).toBeNull();
  });

  it('does not credit a blank text or attribute comparison — nothing is being compared', () => {
    expect(oracleStrength({ action: 'assert_text', value: '   ' })).toBe('weak');
    expect(oracleStrength(attr(''))).toBe('weak');
  });
});

describe('oracleStrengthAt — state relative to a prior step is strong', () => {
  const OTHER = '22222222-2222-4222-8222-222222222222';
  const onEl = (action: string): StepIntent => ({ action, target: el }) as unknown as StepIntent;
  const onOther = (action: string): StepIntent => ({ action, target: { kind: 'element', elementId: OTHER } }) as unknown as StepIntent;

  it('promotes a state assertion on a target an earlier step acted on — the checkbox just toggled, the notification just closed', () => {
    expect(oracleStrengthAt([onEl('check'), onEl('assert_checked')], 1)).toBe('strong');
    expect(oracleStrengthAt([onEl('click'), onEl('assert_not_visible')], 1)).toBe('strong');
    expect(oracleStrengthAt([onEl('click'), onEl('assert_enabled')], 1)).toBe('strong');
  });

  it('matches description targets case-insensitively', () => {
    const d = (description: string) => ({ kind: 'description' as const, description });
    const steps = [
      { action: 'click', target: d('The "×" link') },
      { action: 'assert_not_visible', target: d('the "×" LINK') },
    ] as unknown as StepIntent[];
    expect(oracleStrengthAt(steps, 1)).toBe('strong');
  });

  it('does NOT promote a state assertion on a different target — nothing links it to the action', () => {
    expect(oracleStrengthAt([onEl('click'), onOther('assert_checked')], 1)).toBe('moderate');
  });

  it('does NOT promote when the assertion comes before the action, or no step acted at all', () => {
    expect(oracleStrengthAt([onEl('assert_checked'), onEl('click')], 0)).toBe('moderate');
    expect(oracleStrengthAt([onEl('assert_checked')], 0)).toBe('moderate');
  });

  it('never promotes assert_visible — an element the test just clicked still being visible proves nothing', () => {
    expect(oracleStrengthAt([onEl('click'), onEl('assert_visible')], 1)).toBe('weak');
  });
});

describe('oracleProfile', () => {
  it('tallies assertions, scores them, and reports the strongest', () => {
    const p = oracleProfile([click, visible, url('/x'), text('Saved')]);
    expect(p).toEqual({ assertions: 3, weak: 1, moderate: 1, strong: 1, score: 1 + 2 + 3, best: 'strong' });
  });

  it('has no best when nothing is asserted', () => {
    expect(oracleProfile([click])).toMatchObject({ assertions: 0, score: 0, best: null });
  });
});

describe('assertionWeakening — a repair must not "fix" a test by asserting less', () => {
  it('allows a rewrite that asserts the same or more', () => {
    expect(assertionWeakening([click, visible], [click, visible])).toBeNull();
    expect(assertionWeakening([click, visible], [click, text('Saved')])).toBeNull(); // weak → strong
    expect(assertionWeakening([click, visible], [click, visible, text('Saved')])).toBeNull(); // added one
  });

  it('allows swapping a flagged assertion for an equally strong one', () => {
    // e.g. the judge objects to a volatile value; the rewrite asserts a stable one.
    expect(assertionWeakening([click, text('Total $12.99')], [click, text('Order total')])).toBeNull();
  });

  it('blocks DELETING an assertion — the classic way a repair "converges"', () => {
    const reason = assertionWeakening([click, visible, text('Saved')], [click, text('Saved')]);
    expect(reason).toContain('fewer assertions');
    expect(reason).toContain('2 assertions');
  });

  it('blocks DILUTING one — same count, a text check swapped for a visibility check', () => {
    const reason = assertionWeakening([click, text('Order confirmed')], [click, visible]);
    expect(reason).toContain('asserts less');
    expect(reason).toContain('1 strong');
    expect(reason).toContain('1 weak');
  });

  it('blocks swapping a state check for a bare visibility check — the hole when both were "weak"', () => {
    const checked: StepIntent = { action: 'assert_checked', target: el };
    expect(assertionWeakening([click, checked], [click, visible])).toContain('asserts less');
    expect(assertionWeakening([click, visible], [click, checked])).toBeNull(); // the other way is an upgrade
  });

  it('blocks a rewrite that breaks a transition oracle by pointing the assertion elsewhere', () => {
    const OTHER = '22222222-2222-4222-8222-222222222222';
    const gone: StepIntent = { action: 'assert_not_visible', target: el };                 // acted-on target → strong
    const elsewhere: StepIntent = { action: 'assert_not_visible', target: { kind: 'element', elementId: OTHER } }; // moderate
    expect(assertionWeakening([click, gone], [click, elsewhere])).toContain('asserts less');
  });

  it('blocks a rewrite that keeps the count but trades two strong checks for one strong and one weak', () => {
    expect(assertionWeakening([click, text('A'), text('B')], [click, text('A'), visible])).toContain('asserts less');
  });

  it('has nothing to weaken when the original asserted nothing', () => {
    expect(assertionWeakening([click], [click, visible])).toBeNull();
    expect(assertionWeakening([], [])).toBeNull();
  });
});
