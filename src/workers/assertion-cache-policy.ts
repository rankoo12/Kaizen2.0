/**
 * Which steps must resolve against the live page instead of the selector cache.
 *
 * Lives in its own module rather than in worker.ts so it can be imported without
 * executing that file's module-level side effects — importing worker.ts starts a BullMQ
 * consumer on the shared runs queue, which a unit test must never do.
 *
 * Spec: docs/specs/reliability/spec-assertion-selector-caching.md §4
 */

/**
 * State / negative assertions: they verify CURRENT page state rather than locate a
 * durable element.
 */
export const NO_CACHE_ASSERTIONS = new Set([
  'assert_visible', 'assert_not_visible', 'assert_enabled',
  'assert_disabled', 'assert_checked', 'assert_attribute',
]);

/**
 * Should this step bypass the selector cache and resolve fresh?
 *
 * The hazard is a target that embeds run-specific data — "verify the header shows
 * {{email}}". `targetHash` is computed by the COMPILER from the raw text, and
 * `interpolateStep` never recomputes it, so such a step carries a STABLE cache key
 * pointing at CHANGING content: run 2 would read back run 1's selector and assert against
 * an email that no longer exists.
 *
 * That hazard only exists when interpolation actually substituted something. Bypassing
 * every state assertion unconditionally — the previous behaviour — made them re-pay the
 * model on every run forever: the no-cache resolver runs with `cacheWrites: false`, which
 * gates not only `persistToCache` but also the last-resort selector synthesis. An element
 * with no stable selector (an unlabelled `<input type="number">`) therefore stayed on its
 * session-scoped `data-kaizen-id` and could never be cached by anything. Assertions end
 * most tests, so that was a permanent floor under the cost curve.
 *
 * `assert_not_visible` resolves fresh regardless: its pass condition is that the element
 * is absent, so answering it from a remembered selector inverts what the step asks.
 *
 * @param action              the compiled step action
 * @param targetIsRunVarying  whether interpolation changed the step's targetDescription
 */
export function shouldResolveFresh(
  action: string,
  targetIsRunVarying: boolean,
  /**
   * True for Test Writer proving runs. Every assertion then resolves through the
   * no-cache chain, which also means `cacheWrites: false` — so a proving run can
   * never TEACH the tenant's cache where an assertion's anchor lives.
   *
   * The failure this prevents is not hypothetical: an assertion described as
   * "the no-results message" resolved to the always-visible File menubar button,
   * that pick was written to selector_cache at confidence 1.0, and every
   * subsequent run replayed it from cache — the wrong answer, promoted to
   * remembered fact, cheaper each time. A proving run exists to be judged, not
   * to be believed. Spec: spec-validation-trust.md §9
   */
  isProvingRun = false,
): boolean {
  if (!NO_CACHE_ASSERTIONS.has(action)) return false;
  return isProvingRun || targetIsRunVarying || action === 'assert_not_visible';
}

/**
 * May this healed step still count as passed?
 *
 * Healing an ASSERTION is categorically different from healing an action. When a
 * click heals onto a moved button, the test did what it meant to do. When an
 * assertion heals, the verification landed on an element the resolver picked
 * AFTER the original target was not found — so the step now verifies something
 * the test never named. Observed live: an assertion healed from the login page's
 * email field onto the Search textbox and was recorded as satisfied, which is
 * how "the user is signed in" could be certified from the login page.
 *
 * Strategies that re-resolve the target find a DIFFERENT element; strategies
 * that wait or retry the same selector do not, and remain legitimate.
 * Spec: docs/specs/test-writer/spec-validation-trust.md §9
 */
const RE_RESOLVING_STRATEGIES = new Set(['ResolveAndRetryStrategy', 'ElementSimilarityStrategy']);

export function healCertifiesAssertion(action: string, strategyUsed: string | null | undefined): boolean {
  if (!NO_CACHE_ASSERTIONS.has(action)) return true;
  return !RE_RESOLVING_STRATEGIES.has(strategyUsed ?? '');
}
