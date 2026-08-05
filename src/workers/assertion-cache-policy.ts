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
export function shouldResolveFresh(action: string, targetIsRunVarying: boolean): boolean {
  if (!NO_CACHE_ASSERTIONS.has(action)) return false;
  return targetIsRunVarying || action === 'assert_not_visible';
}
