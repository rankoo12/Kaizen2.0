import type { CandidateNode } from '../../../types';
import type { InteractionClass } from '../interfaces';

/**
 * Interaction safety classifier — the "don't do anything stupid" component.
 * Spec ref: docs/specs/test-writer/spec-recon-crawler.md §4.1
 *
 * A HARD GATE in code, not prompt guidance: the crawler consults this before
 * every probe and only ever performs 'safe-reveal' interactions. Ambiguity
 * resolves DOWNWARD to 'mutating' — a missed reveal costs coverage, a false
 * "safe" performs a real action on a customer's production site.
 */

// Word-boundary-matched, lowercase. Deliberately over-broad.
// Shared with the WRITE-phase safe-mode filter (generation pipeline spec §4.1).
export const DESTRUCTIVE_VERBS = [
  'submit', 'delete', 'remove', 'cancel', 'pay', 'buy', 'purchase', 'checkout',
  'publish', 'send', 'post', 'save', 'update', 'confirm', 'apply', 'accept',
  'deactivate', 'unsubscribe', 'subscribe', 'transfer', 'order', 'book',
  'register', 'sign up', 'signup', 'reset', 'clear', 'upload', 'download',
  'install', 'add to cart', 'add to bag',
] as const;

/**
 * The subset that must never be activated even via a plain GET link — these
 * are irreversible, unlike "sign up" or "subscribe" which merely name a PAGE
 * recon should absolutely visit.
 */
const HARD_DESTRUCTIVE = [
  'delete', 'remove', 'pay', 'purchase', 'buy', 'transfer', 'withdraw',
  'deactivate', 'publish', 'unpublish',
] as const;

const SESSION_ENDING = [
  'logout', 'log out', 'sign out', 'signout', 'log off', 'logoff', 'end session',
] as const;

/**
 * Session-ending URLs, matched on a normalized token rather than a literal path.
 * Spec: docs/specs/test-writer/spec-authenticated-scope.md §5.2 rule 1
 *
 * The accessible-name lexicon above misses the real-world logout: an icon button
 * with an EMPTY name and href="/logout", which classifies as plain 'navigation'
 * and gets followed by the BFS queue. That queue — not the click path — is the
 * actual crawler-suicide vector, and a literal path list misses most of the
 * field: Devise ships `/users/sign_out` (underscore), Django admin uses
 * `/admin/logout/` (nested, trailing slash), and a large class of apps put it in
 * the query string (`?action=logout`, `/index.php?logout=1`) where a path-only
 * rule never looks.
 *
 * So: lowercase path AND query, drop a file extension, strip separators, and
 * test for containment. This over-suppresses (an article at
 * `/blog/how-to-sign-out` is never crawled) — which is the correct direction:
 * a missed page costs coverage, a followed logout costs the whole crawl and one
 * of the two permitted sign-ins.
 */
const SESSION_ENDING_URL_TOKENS = [
  'logout', 'logoff', 'signout', 'deauth',
  // Both word orders occur: Rails routes `/session/destroy`, other stacks
  // expose `/destroy-session`. Matching only one ordering misses half the field.
  'endsession', 'sessionend', 'destroysession', 'sessiondestroy',
] as const;

/** Collapses a URL path+query to a separator-free lowercase token string. */
function urlToken(pathAndQuery: string): string {
  return pathAndQuery
    .toLowerCase()
    .replace(/\.(php|aspx?|jsp|html?|cgi|do|action)(?=$|[?&/])/g, '')
    .replace(/[-_/.=&?+%]/g, '');
}

/**
 * True when a URL would end the session if visited. Applied BOTH at
 * classification (an element's href) and at frontier-enqueue time, in every
 * scope — a public-scope GET /logout is harmless only by luck.
 */
export function isSessionEndingUrl(rawUrl: string, baseUrl?: string): boolean {
  let path: string;
  let query: string;
  try {
    const u = baseUrl ? new URL(rawUrl, baseUrl) : new URL(rawUrl);
    path = u.pathname;
    query = u.search;
  } catch {
    // Not parseable as a URL — treat the whole string as a path so a bare
    // "/logout" href still matches.
    const [p, q] = rawUrl.split('?');
    path = p;
    query = q ? `?${q}` : '';
  }
  const token = urlToken(`${path}${query}`);
  return SESSION_ENDING_URL_TOKENS.some((t) => token.includes(t));
}

/**
 * Sensitive-area tiers for authenticated crawling.
 * Spec: docs/specs/test-writer/spec-authenticated-scope.md §5.2 rule 2
 *
 * The intuitive rule — "capture them, just don't click anything" — is backwards
 * for the most sensitive half. On a signed-in account these pages RENDER live
 * secrets and personal data, and ordinary capture writes element text into
 * page_elements, uploads a screenshot, and ships the outline to the LLM for
 * classification. For Tier A, reading IS the exposure.
 *
 *   Tier A — capture suppressed: URL + title only. No survey, no forms, no
 *            screenshot, no ax_outline, no classification call.
 *   Tier B — passive + scrubbed: captured but never probed, with secrets and
 *            PII redacted before persistence and before any prompt.
 *
 * Matched per path SEGMENT (a segment that starts with the term), so /settings
 * and /user/settings/profile both hit while /settlements does not.
 */
const TIER_A_PATHS = [
  'api-key', 'api_key', 'apikey', 'token', 'secret', 'credential',
  'billing', 'payment', 'invoice', 'subscription',
] as const;

const TIER_B_PATHS = [
  'setting', 'admin', 'account', 'profile', 'organization', 'organisation',
  'member', 'team', 'user', 'danger', 'security', 'privacy',
] as const;

export type SensitiveTier = 'capture-suppressed' | 'passive-only' | null;

export function sensitiveTier(rawUrl: string): SensitiveTier {
  let segments: string[];
  try {
    segments = new URL(rawUrl).pathname.toLowerCase().split('/').filter(Boolean);
  } catch {
    segments = rawUrl.toLowerCase().split('?')[0].split('/').filter(Boolean);
  }
  const hits = (lex: readonly string[]) =>
    segments.some((seg) => lex.some((term) => seg.startsWith(term)));

  // Tier A wins: a page that is both /admin and /admin/api-keys is Tier A.
  if (hits(TIER_A_PATHS)) return 'capture-suppressed';
  if (hits(TIER_B_PATHS)) return 'passive-only';
  return null;
}

// Names that signal a pure state-reveal control. Kept tight: unknown names
// fall through to 'mutating', never to 'safe-reveal'.
const REVEAL_NAMES = [
  'show more', 'show all', 'view more', 'view all', 'see more', 'see all',
  'expand', 'collapse', 'menu', 'open menu', 'toggle', 'more options',
  'next', 'previous', 'details', 'read more',
] as const;

/**
 * Buttons that OPEN a creation form rather than commit anything.
 * Spec: docs/specs/test-writer/spec-recon-crawler.md §4.1
 *
 * Found by the P3 dogfood. Kaizen's own "New Test" button carries no
 * `aria-haspopup`, so it fell through to the default `mutating` and was never
 * clicked — which meant the create-a-test FORM was never revealed, the crawl
 * captured 41 elements of which exactly one was a text input, and the planned
 * scenario "create a new test and ensure it appears in the list" could not be
 * written for want of a field to type into. The most valuable flow in the app
 * was invisible because the door to it was never opened.
 *
 * The distinction the old rule missed: **opening a form is not mutating;
 * submitting it is** — and the crawler never submits forms. So an opener is
 * exactly the kind of state-reveal probing exists for.
 *
 * Deliberately narrow. Matched as a PREFIX so "New Test" and "Create suite"
 * qualify while "Create account" — a submit sitting at the end of a signup
 * form — does not, and `add` is excluded entirely because "Add to cart" and
 * "Add member" are real mutations. Both earlier gates still run first: an
 * `input[type=submit]` and anything in DESTRUCTIVE_VERBS are already `mutating`
 * before this is consulted.
 */
const OPENER_PREFIXES = [
  'new ', 'create new', 'compose', 'write a', 'start a', 'start new',
] as const;

/** Exact names that are openers on their own. */
const OPENER_EXACT = ['new', '+', 'create', 'add new'] as const;

function isOpenerName(name: string): boolean {
  if (OPENER_EXACT.includes(name as never)) return true;
  return OPENER_PREFIXES.some((p) => name.startsWith(p));
}

function matchesAny(name: string, lexicon: readonly string[]): boolean {
  return lexicon.some((term) =>
    new RegExp(`(^|\\b)${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\b|$)`).test(name));
}

export type SafetyContext = {
  /** Origin of the crawl root — anything else is external. */
  rootOrigin: string;
  /** Absolute URL of the page the element lives on (for resolving relative hrefs). */
  pageUrl: string;
};

export function classifyInteraction(node: CandidateNode, ctx: SafetyContext): InteractionClass {
  const name = (node.name || node.textContent || '').toLowerCase().trim();
  const attrs = node.attributes ?? {};
  const href = attrs['href'];

  // 1. Session-ending beats everything — logout is usually an innocent-looking
  //    same-origin link, and following it mid-crawl kills an authenticated
  //    session (the classic crawler suicide).
  if (matchesAny(name, SESSION_ENDING)) return 'session-ending';

  // 1b. …and the name is not where the real one hides. The classic logout is an
  //     icon link with NO accessible name and href="/logout", which would fall
  //     through to 'navigation' below and be followed by the BFS.
  if (href !== undefined && isSessionEndingUrl(href, ctx.pageUrl)) return 'session-ending';

  // 2. Anchors: navigation is handled by the BFS queue, never by clicking.
  if (href !== undefined) {
    const lowerHref = href.toLowerCase();
    if (lowerHref.startsWith('mailto:') || lowerHref.startsWith('tel:')) return 'external';

    // An anchor whose name is a hard-destructive verb is not treated as
    // navigation: some apps still expose destructive endpoints over GET, and
    // "follow every link" would then delete something.
    if (matchesAny(name, HARD_DESTRUCTIVE)) return 'mutating';

    // Fragment-only anchors (href="#", "#login") navigate nowhere — they are
    // the classic modal/dropdown opener. Treating them as navigation meant the
    // BFS enqueued the page it was already on and the modal was never opened,
    // so everything inside it stayed invisible to the site model.
    // Found by the P2 calibration run against a modal-driven storefront.
    if (lowerHref === '#' || lowerHref.startsWith('#')) return 'safe-reveal';
    // javascript: hrefs execute arbitrary page script on click — unknowable
    // side effects, never "just navigation".
    if (lowerHref.startsWith('javascript:')) return 'mutating';
    if ('download' in attrs) return 'external';
    try {
      const resolved = new URL(href, ctx.pageUrl);
      if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return 'external';
      return resolved.origin === ctx.rootOrigin ? 'navigation' : 'external';
    } catch {
      return 'mutating';
    }
  }

  // 3. Explicit mutators by control type/role — regardless of name.
  const inputType = (attrs['type'] ?? '').toLowerCase();
  if (inputType === 'submit' || inputType === 'reset' || inputType === 'file') return 'mutating';
  if (node.role === 'switch' || node.role === 'checkbox' || node.role === 'radio') {
    return 'mutating'; // settings toggles change real state
  }

  // 4. Destructive lexicon on the accessible name.
  if (matchesAny(name, DESTRUCTIVE_VERBS)) return 'mutating';

  // 5. Positive safe-reveal signals.
  if (node.role === 'tab') return 'safe-reveal';               // switches a view
  if ('aria-expanded' in attrs) return 'safe-reveal';          // disclosure toggle
  if ('aria-haspopup' in attrs) return 'safe-reveal';          // menu/dialog opener
  if (matchesAny(name, REVEAL_NAMES)) return 'safe-reveal';
  // Creation-form openers. Reached only AFTER the submit-type and
  // destructive-verb gates above, so "Add to cart" and `type="submit"` are
  // already excluded. This is what makes every create/edit form in an app
  // reachable — without it, the flows worth testing most stay invisible.
  if (isOpenerName(name)) return 'safe-reveal';

  // 6. Everything else — unnamed buttons, menu items, unknown widgets —
  //    resolves DOWN.
  return 'mutating';
}
