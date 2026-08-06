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
