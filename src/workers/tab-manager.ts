import type { StepAST } from '../types';

/**
 * Tab / window management for switch_tab and close_tab steps.
 *
 * These actions operate on the browser CONTEXT (the set of open tabs), not a DOM
 * element, and must repoint the step loop's "current page". This logic lives here
 * (not in the execution engine, which only ever knows a single page) and is kept
 * framework-agnostic via the duck-typed TabPage/TabContext interfaces below so it
 * can be unit-tested without a real browser. Playwright's Page/BrowserContext
 * satisfy these structurally.
 */

export interface TabContext {
  pages(): TabPage[];
  waitForEvent(event: 'page', opts?: { timeout?: number }): Promise<unknown>;
}

export interface TabPage {
  title(): Promise<string>;
  bringToFront(): Promise<void>;
  waitForLoadState(state: 'domcontentloaded'): Promise<void>;
  close(): Promise<void>;
  context(): TabContext;
}

export interface TabActionOutcome<P = TabPage> {
  ok: boolean;
  detail: string;
  /** The now-focused page when the action changed focus; undefined on failure. */
  page?: P;
}

/** Best-effort page title (never throws — a closing/navigating page can reject). */
async function safeTitle(p: TabPage): Promise<string> {
  return p.title().catch(() => '');
}

/**
 * Map an ordinal/number hint to a tab index. "first"→0, "second"→1, … "last"→-1,
 * and bare numbers are 1-based ("2"→1). Returns null when the hint has no index.
 */
export function ordinalToIndex(hint: string): number | null {
  const words: Record<string, number> = { first: 0, second: 1, third: 2, fourth: 3, fifth: 4, last: -1 };
  for (const [w, i] of Object.entries(words)) if (hint.includes(w)) return i;
  const m = hint.match(/\b(\d+)\b/);
  if (m) return parseInt(m[1], 10) - 1;
  return null;
}

/**
 * Resolve and perform a switch_tab / close_tab step against `page`'s context,
 * repointing focus via `setCurrentPage`. Target hint comes from the step's
 * value/targetDescription: "new"/"latest" (default) → most recently opened tab;
 * "first"/"original" → the initial tab; an ordinal/number → by index; otherwise
 * a page-title substring match.
 */
export async function handleTabAction<P extends TabPage>(
  step: Pick<StepAST, 'action' | 'value' | 'targetDescription'>,
  page: P,
  setCurrentPage?: (p: P) => void,
): Promise<TabActionOutcome<P>> {
  const context = page.context();
  const hint = (step.value ?? step.targetDescription ?? '').toLowerCase().trim();

  if (step.action === 'close_tab') {
    if (context.pages().length <= 1) return { ok: false, detail: 'only one tab open — nothing to close' };
    await page.close().catch(() => {});
    const remaining = context.pages() as P[];
    const next = remaining[remaining.length - 1];
    if (!next) return { ok: false, detail: 'no tab remained after close' };
    await next.bringToFront().catch(() => {});
    setCurrentPage?.(next);
    return { ok: true, detail: `closed tab; focused "${await safeTitle(next)}"`, page: next };
  }

  // switch_tab
  let pages = context.pages() as P[];
  const wantsFirst = /\b(first|original|main|previous|back)\b/.test(hint);
  const wantsNew = hint === '' || /\b(new|latest|newly|opened|popup|last)\b/.test(hint);

  let target: P | undefined;
  if (wantsFirst) {
    target = pages[0];
  } else if (wantsNew) {
    // A click may have opened the tab asynchronously — wait briefly if it hasn't
    // appeared yet so "click link (opens tab); switch to the new tab" is reliable.
    if (pages.length < 2) {
      await context.waitForEvent('page', { timeout: 5000 }).catch(() => {});
      pages = context.pages() as P[];
    }
    target = pages[pages.length - 1];
  } else {
    const idx = ordinalToIndex(hint);
    if (idx != null) target = pages.at(idx);
    if (!target && hint) {
      for (const p of pages) {
        if ((await safeTitle(p)).toLowerCase().includes(hint)) { target = p; break; }
      }
    }
  }

  if (!target) return { ok: false, detail: `no tab matched "${hint || 'new'}" (${pages.length} open)` };
  await target.bringToFront().catch(() => {});
  await target.waitForLoadState('domcontentloaded').catch(() => {});
  setCurrentPage?.(target);
  return { ok: true, detail: `switched to "${await safeTitle(target)}"`, page: target };
}
