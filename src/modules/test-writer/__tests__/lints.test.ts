import { lintScenario } from '../write/lints';
import type { StepIntent } from '../../../types/test-writer';

/**
 * The lints are the deterministic slice of quality review — they strip the
 * mechanical checks off the judge so its tokens go to the judgement calls only
 * a reader can make.
 */

const EL = '11111111-1111-4111-8111-111111111111';
const el = { kind: 'element' as const, elementId: EL };

describe('lintScenario — delta assertion (the pre-state test)', () => {
  // Corrected after a live run rejected every navigation-driven test: arriving
  // somewhere IS a change, so a 404 page, an auth gate and a journey hop all
  // assert a genuine delta. Only an assertion with no action at all is vacuous.
  it('accepts a navigation-driven test — arriving is an action', () => {
    const steps: StepIntent[] = [
      { action: 'navigate', url: 'https://shop.test/definitely-not-a-page' },
      { action: 'assert_visible', target: { kind: 'description', description: 'the not-found message' } },
    ];
    expect(lintScenario(steps, 'positive')).toEqual([]);
  });

  it('flags an assertion that follows no action whatsoever', () => {
    const steps: StepIntent[] = [{ action: 'assert_visible', target: el }];
    expect(lintScenario(steps, 'positive').join(' ')).toContain('vacuous');
  });

  it('passes a scenario whose assertion follows a real interaction', () => {
    const steps: StepIntent[] = [
      { action: 'navigate', url: 'https://shop.test/login' },
      { action: 'type', target: el, value: '{{email}}' },
      { action: 'click', target: el },
      { action: 'assert_url', value: '/dashboard' },
    ];
    expect(lintScenario(steps, 'positive')).toEqual([]);
  });
});

// S3 — a happy path that ACTS and then asserts only that something is VISIBLE
// proves an element exists, not that the action produced the right outcome
// (arXiv 2606.18168). Scoped so it does not condemn the shapes sanctioned
// elsewhere: a navigation-only test, a negative that asserts the rejection is
// visible, and a STATE assertion (checked / enabled / gone) — the outcome of a
// toggle-or-close test, which a first cut wrongly called weak on real data.
describe('lintScenario — oracle strength', () => {
  const FLAG = 'only checks that an element is visible';
  const OTHER = '22222222-2222-4222-8222-222222222222';
  const other = { kind: 'element' as const, elementId: OTHER };

  it('flags a positive scenario that acts and asserts only visibility', () => {
    const steps: StepIntent[] = [
      { action: 'navigate', url: 'https://shop.test/' },
      { action: 'click', target: el },
      { action: 'assert_visible', target: el },
    ];
    expect(lintScenario(steps, 'positive').join(' ')).toContain(FLAG);
  });

  it('flags it when several assertions are ALL bare visibility checks', () => {
    const steps: StepIntent[] = [
      { action: 'click', target: el },
      { action: 'assert_visible', target: el },
      { action: 'assert_visible', target: other },
    ];
    expect(lintScenario(steps, 'positive').join(' ')).toContain(FLAG);
  });

  it('does NOT flag a state assertion — the checkbox the test toggled is checked; the notification it closed is gone', () => {
    const toggle: StepIntent[] = [{ action: 'check', target: el }, { action: 'assert_checked', target: el }];
    expect(lintScenario(toggle, 'positive').join(' ')).not.toContain(FLAG);

    const close: StepIntent[] = [{ action: 'click', target: el }, { action: 'assert_not_visible', target: el }];
    expect(lintScenario(close, 'positive').join(' ')).not.toContain(FLAG);

    const enable: StepIntent[] = [{ action: 'click', target: el }, { action: 'assert_enabled', target: other }];
    expect(lintScenario(enable, 'positive').join(' ')).not.toContain(FLAG);
  });

  it('the finding tells the writer not to invent text — an ungrounded stronger assertion just fails validation', () => {
    const steps: StepIntent[] = [{ action: 'click', target: el }, { action: 'assert_visible', target: el }];
    expect(lintScenario(steps, 'positive').join(' ')).toContain('do not invent text');
  });

  it('does not flag a test with ONE value-bearing assertion, however many weak ones surround it', () => {
    const steps: StepIntent[] = [
      { action: 'click', target: el },
      { action: 'assert_visible', target: el },
      { action: 'assert_text', value: 'Order confirmed' },
    ];
    expect(lintScenario(steps, 'positive').join(' ')).not.toContain(FLAG);
  });

  it('a URL assertion is not boolean-only — it is moderate, and not flagged', () => {
    const steps: StepIntent[] = [{ action: 'click', target: el }, { action: 'assert_url', value: '/cart' }];
    expect(lintScenario(steps, 'positive').join(' ')).not.toContain(FLAG);
  });

  it('leaves the sanctioned shapes alone: navigation-only, and a negative ending on the visible rejection', () => {
    const navOnly: StepIntent[] = [
      { action: 'navigate', url: 'https://shop.test/nope' },
      { action: 'assert_visible', target: { kind: 'description', description: 'the not-found message' } },
    ];
    expect(lintScenario(navOnly, 'positive').join(' ')).not.toContain(FLAG);

    const negative: StepIntent[] = [
      { action: 'type', target: el, value: 'bad' },
      { action: 'click', target: el },
      { action: 'assert_visible', target: el },
    ];
    expect(lintScenario(negative, 'negative').join(' ')).not.toContain(FLAG);
  });
});

describe('lintScenario — negative shape', () => {
  it('flags a negative that ends on an absence assertion', () => {
    const steps: StepIntent[] = [
      { action: 'type', target: el, value: 'not-an-email' },
      { action: 'click', target: el },
      { action: 'assert_not_text', value: 'Welcome' },
    ];
    expect(lintScenario(steps, 'negative').join(' ')).toContain('absence-of-success');
  });

  it('passes a negative that asserts the rejection is present', () => {
    const steps: StepIntent[] = [
      { action: 'type', target: el, value: 'not-an-email' },
      { action: 'click', target: el },
      { action: 'assert_visible', target: { kind: 'description', description: 'the error message' } },
    ];
    expect(lintScenario(steps, 'negative')).toEqual([]);
  });
});

describe('lintScenario — determinism', () => {
  it('flags an assertion on a volatile price', () => {
    const steps: StepIntent[] = [
      { action: 'click', target: el },
      { action: 'assert_text', value: 'Total: $29.99' },
    ];
    expect(lintScenario(steps, 'positive').join(' ')).toContain('volatile');
  });

  it('flags click_random whose capture is never used', () => {
    const steps: StepIntent[] = [
      { action: 'click_random', description: 'a product link', captureAs: 'selectedItem' },
      { action: 'assert_url', value: '/product' },
    ];
    expect(lintScenario(steps, 'positive').join(' ')).toContain('no later assertion uses it');
  });

  it('passes click_random that closes its loop', () => {
    const steps: StepIntent[] = [
      { action: 'click_random', description: 'a product link', captureAs: 'selectedItem' },
      { action: 'assert_text', value: '{{selectedItem}}' },
    ];
    expect(lintScenario(steps, 'positive')).toEqual([]);
  });
});
