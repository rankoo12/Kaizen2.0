import type { CandidateNode } from '../../../types';
import { SESSION_ENDING, isOpenerName, matchesAny } from './safety';

/**
 * Screen discovery — pages that are reached by clicking, not by URL.
 * Spec: docs/specs/test-writer/spec-screen-discovery.md
 *
 * A state-machine SPA switches views on `onClick` and never changes the URL.
 * The BFS sees one page; a QA engineer sees the whole app, because they click
 * the sidebar. This module decides which hrefless controls are worth clicking
 * to find a screen (§1.2), names the screen (§1.3), and says whether what
 * appeared after the click is a screen of its own or the same page (§1.3).
 *
 * Deterministic and conservative: unknown resolves to "not a screen". Nothing
 * that the safety classifier calls mutating becomes clickable except through
 * the gate below, which re-checks the destructive and session-ending lexicons.
 */

/** One hop of the recipe that reaches a screen from the page it was found on. */
export type ReachHop = { role: string; name: string };

/** Ceiling on view-switch candidates per page — a sidebar, not a data table. */
export const SCREEN_CANDIDATES_PER_PAGE = 12;

/** Roles a view-switch control can have. Tabs are probes already. */
const SWITCH_ROLES = new Set(['button', 'menuitem', 'link']);

/**
 * Names that are an ACTION or a UI toggle, not a view. Its own list rather than
 * the crawler's destructive lexicon: that one bans "checkout" and "order",
 * which in a sidebar are pages ("Checkout smoke", "Orders"), and misses "run",
 * "refresh" and "hide sidebar" — run 3 of Kaizen-on-Kaizen clicked "Run now" as
 * a screen and started a real run. Word-boundary matched, lowercase.
 */
export const NOT_A_VIEW = [
  // commits and irreversibles
  'submit', 'save', 'update', 'confirm', 'apply', 'accept', 'reject', 'approve', 'reset', 'clear',
  'upload', 'download', 'install', 'send', 'post', 'pay', 'buy', 'purchase', 'delete', 'remove',
  'transfer', 'withdraw', 'deactivate', 'publish', 'unpublish', 'cancel', 'subscribe', 'unsubscribe',
  'add to cart', 'add to bag', 'invite', 'merge', 'deploy', 'import', 'export', 'generate',
  // starts something
  'run', 're-run', 'rerun', 'start', 'stop', 'execute', 'launch', 'trigger', 'retry', 'refresh',
  'reload', 'sync', 'analyze', 'analyse', 'scan',
  // window and layout toggles, and stepping controls
  'close', 'hide', 'show', 'toggle', 'collapse', 'expand', 'minimise', 'minimize', 'maximise',
  'maximize', 'fill the screen', 'fullscreen', 'zoom', 'back', 'next', 'previous', 'prev',
  // account flows are the login recipe's business
  'sign in', 'log in', 'login', 'sign up', 'signup', 'register',
] as const;

/**
 * Elements that look like they switch the view: hrefless, in a navigation
 * container or marked aria-current, named, and not something that commits,
 * opens a form, or ends the session.
 */
export function viewSwitchCandidates(survey: CandidateNode[]): CandidateNode[] {
  const out: CandidateNode[] = [];
  const seen = new Set<string>();
  for (const node of survey) {
    if (!SWITCH_ROLES.has(node.role)) continue;
    const attrs = node.attributes ?? {};
    if (attrs['href'] !== undefined) continue;                 // links are the BFS's job
    const name = node.name.trim();
    if (name.length === 0 || name.length > 40) continue;
    const inNav = !!attrs['nav-context'] || 'aria-current' in attrs;
    if (!inNav) continue;
    if ((attrs['type'] ?? '').toLowerCase() === 'submit') continue;
    if ('aria-haspopup' in attrs) continue;                    // opens a menu — a probe
    if ('aria-expanded' in attrs) continue;                    // a disclosure (File / View menus) — a probe
    const lower = name.toLowerCase();
    if (matchesAny(lower, SESSION_ENDING)) continue;
    if (matchesAny(lower, NOT_A_VIEW)) continue;
    if (isOpenerName(lower)) continue;                         // "New test" reveals a form — a probe
    const key = `${node.role}|${lower}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(node);
    if (out.length >= SCREEN_CANDIDATES_PER_PAGE) break;
  }
  return out;
}

/** "Runs ⌘2" → "runs"; "The Brain" → "the-brain". Empty when nothing survives. */
export function screenSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[⌘⌥⇧⌃]\S*/g, ' ')          // keyboard hints
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

/** The identity of a screen: the page it hangs off plus the slugs that reach it. */
export function screenUrl(baseNormalized: string, hops: ReachHop[]): string | null {
  const slugs = hops.map((h) => screenSlug(h.name)).filter(Boolean);
  if (slugs.length !== hops.length) return null;
  const base = baseNormalized.split('#')[0];
  return `${base}#screen=${slugs.join('/')}`;
}

/** The hops encoded in a screen URL, or [] for an ordinary page. */
export function isScreenUrl(url: string): boolean {
  return /#screen=/.test(url);
}

/** What a captured page looked like, for the newness test. */
export type ScreenFingerprint = {
  elementKeys: Set<string>;
  firstHeading: string;
  textWords: Set<string>;
  contentHash: string;
};

export function fingerprint(
  survey: Array<{ role: string; name: string }>,
  headings: string[],
  contentHash: string,
  pageText = '',
): ScreenFingerprint {
  return {
    // Unnamed controls (icon buttons) are indistinguishable from one another
    // and so say nothing about which view this is.
    elementKeys: new Set(survey.filter((c) => c.name.trim()).map((c) => `${c.role}|${c.name.trim().toLowerCase()}`)),
    firstHeading: (headings[0] ?? '').trim().toLowerCase(),
    textWords: new Set(pageText.toLowerCase().slice(0, 600).split(/[^a-z0-9]+/).filter((w) => w.length > 2)),
    contentHash,
  };
}

/**
 * A screen is kept only when it is materially different from the page it was
 * reached from. Three signals, any one enough: the controls changed (two or
 * more new, or one new and two gone — a view swaps its toolbar), the first
 * heading changed, or the visible text is mostly different. Clicking the item
 * for the view you are already on, or a button that merely highlights itself,
 * fails all three. An app with no headings (Kaizen's own dashboard) still has
 * the first and third.
 */
export function isNewScreen(parent: ScreenFingerprint, child: ScreenFingerprint): boolean {
  if (parent.contentHash === child.contentHash) return false;
  let fresh = 0; let gone = 0;
  for (const key of child.elementKeys) if (!parent.elementKeys.has(key)) fresh++;
  for (const key of parent.elementKeys) if (!child.elementKeys.has(key)) gone++;
  if (fresh >= 2 || (fresh >= 1 && gone >= 2)) return true;
  if (child.firstHeading !== '' && child.firstHeading !== parent.firstHeading) return true;
  if (child.textWords.size >= 8) {
    let shared = 0;
    for (const w of child.textWords) if (parent.textWords.has(w)) shared++;
    const union = child.textWords.size + parent.textWords.size - shared;
    if (union > 0 && shared / union < 0.6) return true;
  }
  return false;
}
