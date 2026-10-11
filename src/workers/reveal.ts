/**
 * Hover-to-reveal recovery — finding #7.
 * Spec: docs/specs/workers/spec-hover-reveal-scroll-find.md §1
 *
 * A control inside a CSS :hover-revealed container (a "⋯" menu) is hidden at
 * resolution time, so the pruner never offers it and the step dies on a page
 * where a human would simply hover the trigger first. This module is the last
 * resort on the worker's resolution-recovery path: scan the live DOM for a
 * HIDDEN element that carries the step's named target, hover its nearest
 * VISIBLE ancestor (the trigger zone), verify the target became visible, and
 * hand back a selector for it. The mouse is left resting there, so the hover
 * state survives into the action — Playwright then moves the pointer onto the
 * revealed descendant, which keeps the ancestor's :hover chain active.
 *
 * Safety: strict name containment (the quoted name, or ALL salient words — a
 * lookalike is never revealed), post-hover visibility verification, at most
 * three candidates, and it only ever runs after resolution has already failed.
 */
import { quotedName, salientWords } from './name-fidelity';

/** The slice of a Playwright Page this module needs — structural, so tests fake it. */
export type RevealPageLike = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  evaluate(fn: (arg: any) => unknown, arg?: unknown): Promise<unknown>;
  hover(selector: string, options?: { timeout?: number }): Promise<void>;
  waitForTimeout(ms: number): Promise<void>;
};

type RevealHit = { target: string; anchor: string; name: string };

/* Runs in-browser: find hidden clickables whose accessible-ish name carries the
   target, stamp each and its nearest visible ancestor with data-kz-reveal
   markers, and return the stamped selector pairs. */
function scanForHidden(arg: { phrase: string | null; words: string[] }): RevealHit[] {
  const tidy = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  const hiddenSelf = (el: Element) => {
    const st = getComputedStyle(el);
    return st.display === 'none' || st.visibility === 'hidden';
  };
  const isShown = (el: Element): boolean => {
    for (let n: Element | null = el; n && n !== document.documentElement; n = n.parentElement) {
      if (hiddenSelf(n)) return false;
    }
    return true;
  };
  const nameOf = (el: Element) => tidy(el.getAttribute('aria-label') || el.textContent);
  const matches = (name: string) => {
    if (!name || name.length > 120) return false;
    if (arg.phrase) return name.includes(arg.phrase);
    return arg.words.length > 0 && arg.words.every((w) => name.includes(w));
  };
  const CLICKABLE = 'button, a, [role="button"], [role="menuitem"], [role="tab"], input, label, li';
  const out: RevealHit[] = [];
  let n = 0;
  for (const el of Array.from(document.querySelectorAll(CLICKABLE))) {
    if (out.length >= 3) break;
    if (isShown(el)) continue;            // only HIDDEN targets need revealing
    if (!matches(nameOf(el))) continue;
    let anchor: Element | null = el.parentElement;
    while (anchor && anchor !== document.body && !isShown(anchor)) anchor = anchor.parentElement;
    if (!anchor || anchor === document.body) continue;
    el.setAttribute('data-kz-reveal', 'r' + n);
    anchor.setAttribute('data-kz-reveal-anchor', 'a' + n);
    out.push({ target: `[data-kz-reveal="r${n}"]`, anchor: `[data-kz-reveal-anchor="a${n}"]`, name: nameOf(el) });
    n++;
  }
  return out;
}

/* Runs in-browser: is the stamped element actually visible now? */
function isVisibleNow(sel: string): boolean {
  const el = document.querySelector(sel);
  if (!el) return false;
  for (let n: Element | null = el; n && n !== document.documentElement; n = n.parentElement) {
    const st = getComputedStyle(n);
    if (st.display === 'none' || st.visibility === 'hidden') return false;
  }
  const r = (el as HTMLElement).getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

/* Runs in-browser: remove every reveal stamp (total-miss cleanup). */
function clearStamps(): boolean {
  for (const el of Array.from(document.querySelectorAll('[data-kz-reveal], [data-kz-reveal-anchor]'))) {
    el.removeAttribute('data-kz-reveal');
    el.removeAttribute('data-kz-reveal-anchor');
  }
  return true;
}

/**
 * Try to reveal the step's named target. Returns a selector for the now-visible
 * element, or null. On success the stamps stay (the selector must keep
 * resolving through the action); on a total miss they are removed.
 */
export async function revealHiddenTarget(page: RevealPageLike, targetDescription: string | null | undefined): Promise<string | null> {
  if (!targetDescription) return null;
  const phrase = quotedName(targetDescription)?.toLowerCase() ?? null;
  const words = salientWords(targetDescription);
  if (!phrase && words.length === 0) return null;

  const hits = (await page.evaluate(scanForHidden, { phrase, words }).catch(() => [])) as RevealHit[];
  for (const hit of hits) {
    try {
      await page.hover(hit.anchor, { timeout: 1500 });
      await page.waitForTimeout(250); // let the :hover reveal settle
      const visible = (await page.evaluate(isVisibleNow, hit.target)) as boolean;
      if (visible) return hit.target;
    } catch { /* this anchor did not reveal it — try the next hit */ }
  }
  if (hits.length > 0) await page.evaluate(clearStamps).catch(() => false);
  return null;
}
