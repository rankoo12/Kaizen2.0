import { oracleStrength, oracleProfile, assertionWeakening } from '../write/oracle-strength';
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
  it('ranks value comparisons strong, location/absence moderate, boolean-only weak', () => {
    expect(oracleStrength(text('Order confirmed'))).toBe('strong');
    expect(oracleStrength(count())).toBe('strong');
    expect(oracleStrength(attr('/cart'))).toBe('strong');

    expect(oracleStrength(url('/dashboard'))).toBe('moderate');
    expect(oracleStrength({ action: 'assert_title', value: 'Home' })).toBe('moderate');
    expect(oracleStrength({ action: 'assert_not_text', value: 'Error' })).toBe('moderate');

    for (const action of ['assert_visible', 'assert_not_visible', 'assert_enabled', 'assert_disabled', 'assert_checked', 'assert_not_checked'] as const) {
      expect(oracleStrength({ action, target: el })).toBe('weak');
    }
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

  it('blocks a rewrite that keeps the count but trades two strong checks for one strong and one weak', () => {
    expect(assertionWeakening([click, text('A'), text('B')], [click, text('A'), visible])).toContain('asserts less');
  });

  it('has nothing to weaken when the original asserted nothing', () => {
    expect(assertionWeakening([click], [click, visible])).toBeNull();
    expect(assertionWeakening([], [])).toBeNull();
  });
});
