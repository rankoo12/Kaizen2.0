/// <reference lib="dom" />
import type { CandidateNode } from '../../../types';
import type { RevealCapture } from '../interfaces';
import type { IObservability } from '../../observability/interfaces';
import { normalizeHref, isSameOrigin } from './url-normalizer';

/**
 * Interactive probe protocol — reveal states unreachable by URL (tabs,
 * accordions, menus, modals), then ALWAYS restore so the BFS continues from a
 * known state.
 * Spec ref: docs/specs/test-writer/spec-recon-crawler.md §4.2
 *
 * The caller (crawler) has already filtered candidates through the safety
 * classifier — only 'safe-reveal' elements ever reach this module.
 */

const INTERACTIVE_QUERY =
  'button, a, input, textarea, select, ' +
  '[role="button"], [role="link"], [role="checkbox"], ' +
  '[role="combobox"], [role="searchbox"], [role="tab"], [role="menuitem"], [role="textbox"]';

// NOTE: the baseline attribute name is inlined inside the evaluate() closures
// below — browser-context functions cannot reference Node-scope constants.
const SETTLE_MS = 400;

/**
 * Stamp every currently-VISIBLE interactive element as "seen before probing".
 * Visibility matters: accordion/tab/menu content is usually already in the DOM,
 * just hidden — stamping it here would make the post-probe diff blind to
 * exactly the reveals we're probing for.
 */
async function stampBaseline(pwPage: any): Promise<void> {
  await pwPage.evaluate((query: string) => {
    document.querySelectorAll(query).forEach((el) => {
      const rect = (el as HTMLElement).getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const style = window.getComputedStyle(el as HTMLElement);
      if (style.display === 'none' || style.visibility === 'hidden') return;
      el.setAttribute('data-kaizen-probe-baseline', '1');
    });
  }, INTERACTIVE_QUERY);
}

/** Collect (and stamp) interactive elements that appeared since the baseline. */
async function collectRevealed(pwPage: any): Promise<{
  elements: Array<{ role: string; name: string }>;
  hrefs: string[];
}> {
  return pwPage.evaluate((query: string) => {
    const isVisible = (el: Element): boolean => {
      const rect = (el as HTMLElement).getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return false;
      const style = window.getComputedStyle(el as HTMLElement);
      return style.display !== 'none' && style.visibility !== 'hidden';
    };

    const fresh = Array.from(document.querySelectorAll(query))
      .filter((el) => !el.hasAttribute('data-kaizen-probe-baseline') && isVisible(el));

    const elements: Array<{ role: string; name: string }> = [];
    const hrefs: string[] = [];
    for (const el of fresh.slice(0, 40)) {
      // Stamp so the next probe on this page doesn't recount it.
      el.setAttribute('data-kaizen-probe-baseline', '1');
      // Implicit ARIA roles, NOT tag names. This fell back to the raw tag for
      // everything except <a> and <button>, so a revealed <input> was recorded
      // with role "input" — which is not an ARIA role at all. Nothing
      // downstream accepts it: kindOf() files it under 'other', and
      // isRoleCompatible('type', 'input') is false, so the schema gate refused
      // to type into it. Every field revealed behind a modal — exactly the
      // high-value ones probing exists to find — was therefore unusable by
      // construction, and Kaizen could not write a test for its own
      // create-a-test form.
      //
      // Kept in sync with the survey's derivation in
      // playwright.dom-pruner.ts (both must run inside page context, so the
      // mapping cannot be imported); probe.test.ts locks the two together.
      const tag = el.tagName.toLowerCase();
      let role = el.getAttribute('role') || '';
      if (!role) {
        if (tag === 'a') role = 'link';
        else if (tag === 'button') role = 'button';
        else if (tag === 'select') role = 'combobox';
        else if (tag === 'textarea') role = 'textbox';
        else if (tag === 'input') {
          const t = (el.getAttribute('type') || 'text').toLowerCase();
          role = t === 'checkbox' ? 'checkbox'
            : t === 'radio' ? 'radio'
            : (t === 'submit' || t === 'button' || t === 'reset') ? 'button'
            : t === 'search' ? 'searchbox' : 'textbox';
        } else role = tag;
      }
      // Named the way the survey names things: an explicit label beats the
      // placeholder. The first version read placeholder before label, so the
      // New Test sheet's name field was "Sign in with valid credentials" and its
      // "Target URL" field — labelled, no placeholder — had no name at all and
      // never reached the writer, which then could not fill it.
      let labelText = '';
      const id = el.getAttribute('id');
      if (id) {
        const lab = document.querySelector('label[for="' + id.replace(/"/g, '\\"') + '"]') as HTMLElement | null;
        if (lab) labelText = lab.innerText || lab.textContent || '';
      }
      if (!labelText) {
        const wrap = el.closest('label') as HTMLElement | null;
        if (wrap) labelText = (wrap.innerText || wrap.textContent || '').replace((el as HTMLInputElement).value ?? '', '');
      }
      if (!labelText) {
        const by = el.getAttribute('aria-labelledby');
        if (by) labelText = by.split(/\s+/).map((i) => (document.getElementById(i)?.innerText ?? '')).join(' ');
      }
      if (!labelText && (tag === 'input' || tag === 'textarea' || tag === 'select')) {
        // A field whose label sits just before it in the same block.
        const prev = el.previousElementSibling as HTMLElement | null;
        const t = (prev?.innerText ?? '').trim();
        if (prev && t && t.length <= 40 && !/^(button|a|input|select|textarea)$/i.test(prev.tagName)) labelText = t;
      }
      const name = (el.getAttribute('aria-label')
        || labelText
        || (tag === 'input' || tag === 'textarea' || tag === 'select' ? '' : (el as HTMLElement).innerText)
        || el.getAttribute('placeholder')
        || el.getAttribute('title')
        || '').trim().replace(/\s+/g, ' ').slice(0, 80);
      elements.push({ role, name });
      const href = el.getAttribute('href');
      if (href) hrefs.push(href);
    }
    return { elements, hrefs };
  }, INTERACTIVE_QUERY);
}

export type ProbeContext = {
  pageUrl: string;
  rootOrigin: string;
  obs: IObservability;
};

/**
 * Probe up to `budget` safe-reveal candidates on the current page. Returns the
 * reveals plus how many probes were actually performed.
 */
export async function runProbes(
  page: unknown,
  safeRevealCandidates: CandidateNode[],
  budget: number,
  ctx: ProbeContext,
): Promise<{ reveals: RevealCapture[]; probesPerformed: number }> {
  const pwPage = page as any;
  const reveals: RevealCapture[] = [];
  let probesPerformed = 0;

  if (safeRevealCandidates.length === 0 || budget <= 0) {
    return { reveals, probesPerformed };
  }

  await stampBaseline(pwPage);

  for (const candidate of safeRevealCandidates.slice(0, budget)) {
    probesPerformed++;
    try {
      await pwPage.click(`[data-kaizen-id='${candidate.kaizenId}']`, { timeout: 3_000 });
    } catch {
      ctx.obs.increment('testwriter.probe_click_failed');
      continue; // element gone/covered — nothing revealed, nothing to restore
    }

    await pwPage.waitForTimeout(SETTLE_MS);

    // A safe-reveal should never navigate; if it did anyway, restore FIRST and
    // record the destination as a discovered link.
    const revealedLinks: string[] = [];
    let revealedElements: Array<{ role: string; name: string }> = [];

    const urlAfter: string = pwPage.url();
    if (urlAfter !== ctx.pageUrl) {
      const normalized = normalizeHref(urlAfter, ctx.pageUrl);
      if (normalized && isSameOrigin(normalized, ctx.rootOrigin)) revealedLinks.push(normalized);
      await restoreUrl(pwPage, ctx.pageUrl);
      ctx.obs.increment('testwriter.probe_unexpected_navigation');
    } else {
      try {
        const collected = await collectRevealed(pwPage);
        revealedElements = collected.elements;
        for (const href of collected.hrefs) {
          const normalized = normalizeHref(href, ctx.pageUrl);
          if (normalized && isSameOrigin(normalized, ctx.rootOrigin)) revealedLinks.push(normalized);
        }
      } catch {
        ctx.obs.increment('testwriter.probe_collect_failed');
      }
      // Close whatever the probe opened (modal, menu) so the next probe starts
      // from a comparable state. Escape is harmless when nothing is open.
      await pwPage.keyboard.press('Escape').catch(() => {});
    }

    if (revealedElements.length > 0 || revealedLinks.length > 0) {
      reveals.push({
        trigger: { role: candidate.role, name: candidate.name },
        revealedElements,
        revealedLinks: [...new Set(revealedLinks)],
      });
    }
  }

  return { reveals, probesPerformed };
}

/** goBack → verify → reload as last resort. The BFS must continue from pageUrl. */
async function restoreUrl(pwPage: any, pageUrl: string): Promise<void> {
  try {
    await pwPage.goBack({ timeout: 10_000, waitUntil: 'domcontentloaded' });
  } catch { /* fall through to the check below */ }
  if (pwPage.url() !== pageUrl) {
    await pwPage.goto(pageUrl, { timeout: 15_000, waitUntil: 'domcontentloaded' }).catch(() => {});
  }
}
