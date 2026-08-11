/**
 * Post-navigation settle — let a destination finish rendering before the next
 * step resolves against it.
 *
 * The first interaction after a navigation (a click right after signing in, say)
 * must not race a half-rendered page: doing so yields a transient selector that
 * never caches AND an action that silently no-ops against the old DOM. Both
 * waits are bounded, so a chatty page (long-poll, websocket) or a never-quiet
 * DOM can never hang a run.
 *
 * Extracted from the run worker when the P3 dogfood proved auth-session needed
 * exactly the same thing: its login recipe clicked "Demo user", then asserted
 * against the destination while the browser was still on the login page, and
 * resolved the assertion to the login form's email box. One implementation, so
 * the crawler and the worker cannot drift on what "the page is ready" means.
 */

type SettleablePage = {
  url?: () => string;
  waitForLoadState?: (state: string, opts?: { timeout?: number }) => Promise<void>;
  evaluate?: (fn: () => unknown) => Promise<unknown>;
};

/**
 * Waits for the page to quiesce, but only when it actually navigated.
 * Best-effort by contract: every failure is swallowed, because settling is an
 * optimisation for the NEXT step and must never fail the current one.
 */
export async function settleAfterNavigation(page: unknown, urlBefore: string | undefined): Promise<void> {
  try {
    const p = page as SettleablePage;
    if (!p.url || p.url() === urlBefore) return;

    // Network settle — instant when the page does no network I/O.
    await p.waitForLoadState?.('networkidle', { timeout: 2500 }).catch(() => {});

    // DOM-quiescence settle. A CLIENT-SIDE route change does no network I/O at
    // all, so `networkidle` returns immediately and proves nothing; wait for the
    // DOM to stop mutating instead.
    await p.evaluate?.(() => new Promise((resolve) => {
      let timer = setTimeout(() => resolve(null), 400);
      const mo = new MutationObserver(() => {
        clearTimeout(timer);
        timer = setTimeout(() => resolve(null), 400);
      });
      mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
      setTimeout(() => { mo.disconnect(); resolve(null); }, 2000);
    })).catch(() => {});
  } catch {
    /* settling is best-effort — never fail a step on it */
  }
}
