/**
 * Which steps bypass the selector cache.
 * Spec: docs/specs/reliability/spec-assertion-selector-caching.md §4
 *
 * The rule this pins down: a state assertion resolves fresh only when its target actually
 * varies per run. Before, every state assertion bypassed the cache unconditionally, which
 * meant they re-paid the model on every run forever — and since assertions end most tests,
 * that was a permanent floor under the cost curve.
 */
// From the policy module, not worker.ts: importing worker.ts executes its module-level
// setup, which starts a BullMQ consumer on the shared runs queue.
import { shouldResolveFresh } from '../assertion-cache-policy';

const STATE_ASSERTIONS = [
  'assert_visible', 'assert_enabled', 'assert_disabled',
  'assert_checked', 'assert_attribute',
];

describe('shouldResolveFresh', () => {
  it('lets a state assertion with a stable target use the cache', () => {
    // "verify the number field has value 42" — no {{token}}, same element every run.
    // This is the case that was costing an LLM call on every single run.
    for (const action of STATE_ASSERTIONS) {
      expect(shouldResolveFresh(action, false)).toBe(false);
    }
  });

  it('forces a fresh resolve when the target interpolated a per-run value', () => {
    // "verify the header shows {{email}}" — targetHash is stable (computed pre-
    // interpolation and never recomputed) while the text changes, so a cached selector
    // would point at a previous run's email.
    for (const action of STATE_ASSERTIONS) {
      expect(shouldResolveFresh(action, true)).toBe(true);
    }
  });

  it('always resolves assert_not_visible fresh, even with a stable target', () => {
    // Its pass condition is that the element is absent; resolving it from a remembered
    // selector inverts what the step is asking.
    expect(shouldResolveFresh('assert_not_visible', false)).toBe(true);
    expect(shouldResolveFresh('assert_not_visible', true)).toBe(true);
  });

  it('never diverts an interaction step, whatever its target does', () => {
    // Interactions have always cached; a {{token}} in the target must not change that,
    // or typing into "the {{field}} box" would silently stop learning.
    for (const action of ['click', 'type', 'select', 'check', 'hover', 'clear', 'upload']) {
      expect(shouldResolveFresh(action, false)).toBe(false);
      expect(shouldResolveFresh(action, true)).toBe(false);
    }
  });

  it('leaves non-state assertions on the normal caching path', () => {
    // assert_text / assert_url / assert_title were never in the bypass set; this guards
    // against the set quietly growing.
    for (const action of ['assert_text', 'assert_url', 'assert_title', 'assert_not_text']) {
      expect(shouldResolveFresh(action, false)).toBe(false);
    }
  });
});
