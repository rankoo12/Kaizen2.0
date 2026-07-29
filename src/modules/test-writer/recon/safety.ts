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

const SESSION_ENDING = [
  'logout', 'log out', 'sign out', 'signout', 'log off', 'logoff', 'end session',
] as const;

// Names that signal a pure state-reveal control. Kept tight: unknown names
// fall through to 'mutating', never to 'safe-reveal'.
const REVEAL_NAMES = [
  'show more', 'show all', 'view more', 'view all', 'see more', 'see all',
  'expand', 'collapse', 'menu', 'open menu', 'toggle', 'more options',
  'next', 'previous', 'details', 'read more',
] as const;

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

  // 2. Anchors: navigation is handled by the BFS queue, never by clicking.
  if (href !== undefined) {
    const lowerHref = href.toLowerCase();
    if (lowerHref.startsWith('mailto:') || lowerHref.startsWith('tel:')) return 'external';
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

  // 6. Everything else — unnamed buttons, menu items, unknown widgets —
  //    resolves DOWN.
  return 'mutating';
}
