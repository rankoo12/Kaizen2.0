import { createHash } from 'crypto';
import type { CandidateNode } from '../../types';

/**
 * Random element selection for the `click_random` action.
 *
 * Kaizen's normal resolver chain collapses a target description down to the
 * single *best* element. `click_random` inverts that: it picks one of several
 * equally-valid matches at random (e.g. "select a random product"). This module
 * isolates that selection so it is deterministic-by-seed and unit-testable.
 *
 * Spec: docs/specs/workers/spec-engine-capabilities-assert-random-capture.md §2
 */

/**
 * Deterministic pseudo-random index in [0, length) derived from a seed string.
 *
 * Using a hash of `runId:stepIndex` (rather than Math.random) makes a given run
 * replayable — the same run picks the same element every time — while different
 * runs vary. The first 8 hex chars of a SHA-256 give us 32 bits of spread,
 * which is ample for choosing among a handful of candidates.
 */
export function seededIndex(seed: string, length: number): number {
  if (length <= 0) throw new Error('seededIndex requires length > 0');
  const hex = createHash('sha256').update(seed).digest('hex').slice(0, 8);
  return parseInt(hex, 16) % length;
}

/**
 * Site-chrome names that are never the "random product/item" the user means.
 * Footer social links, global search/subscribe, account/nav links. Matched
 * case-insensitively against the accessible name. This stops `click_random`
 * from landing on e.g. the "Twitter" footer link when no candidate lexically
 * matches the vague target ("a random product").
 */
const CHROME_NAMES = new Set([
  'twitter', 'facebook', 'instagram', 'youtube', 'rss', 'google+', 'linkedin',
  'search', 'subscribe', 'log in', 'logout', 'log out', 'register',
  'shopping cart', 'wishlist', 'my account', 'home', 'contact us', 'about us',
  'sitemap', 'addresses', 'orders', 'downloadable products',
]);

function looksLikeChrome(c: CandidateNode): boolean {
  const name = (c.name || '').trim().toLowerCase();
  if (!name) return true; // unnamed interactive elements are not "a product"
  if (CHROME_NAMES.has(name)) return true;
  // "Shopping cart (0)" etc. — strip trailing counts/parens before comparing.
  const base = name.replace(/\s*\(\d+\)\s*$/, '').trim();
  return CHROME_NAMES.has(base);
}

/**
 * Reduce the candidate pool to those plausibly matching the target.
 *
 * Order of preference:
 *   1. candidates the DOM pruner lexically scored as relevant (best signal);
 *   2. otherwise, all visible non-chrome candidates (filters out footer/nav junk
 *      so a vague target like "a random product" can't land on "Twitter");
 *   3. otherwise, the full visible pool (never return empty when input is not).
 */
export function eligibleCandidates(candidates: CandidateNode[]): CandidateNode[] {
  const visible = candidates.filter((c) => c.isVisible);
  const pool = visible.length > 0 ? visible : candidates;

  const scored = pool.filter((c) => c.similarityScore > 0);
  if (scored.length > 0) return scored;

  const nonChrome = pool.filter((c) => !looksLikeChrome(c));
  if (nonChrome.length > 0) return nonChrome;

  return pool;
}

export type RandomPick = {
  candidate: CandidateNode;
  /** Index chosen within the eligible pool — surfaced for observability/tests. */
  index: number;
  /** Size of the pool the pick was drawn from. */
  poolSize: number;
};

/**
 * Pick one candidate at random (seeded) from those matching the target.
 * Returns null when there are no candidates at all.
 */
export function pickRandomCandidate(
  candidates: CandidateNode[],
  seed: string,
): RandomPick | null {
  if (candidates.length === 0) return null;
  const pool = eligibleCandidates(candidates);
  const index = seededIndex(seed, pool.length);
  return { candidate: pool[index], index, poolSize: pool.length };
}

/** Minimal page surface needed to resolve a card title from a picked element. */
export interface CardTitlePageLike {
  $eval<T>(selector: string, fn: (el: Element) => T): Promise<T>;
}

/**
 * Resolve the *item title* associated with a picked element.
 *
 * When `click_random` picks an "Add to cart" button, the button's own text is
 * useless for a later cart match — the value that shows in the cart is the
 * product title, which lives elsewhere in the same product card. This walks up
 * from the picked element to its nearest card container and returns the title
 * text, so the captured value is the product name.
 *
 * Heuristic, in order:
 *   1. nearest ancestor matching a known product-card container, then its title;
 *   2. the picked element's own text if it already looks like a title (a link/
 *      heading rather than a generic button);
 *   3. null when nothing card-like is found (caller falls back to element name).
 *
 * Runs entirely in-browser via $eval so it understands the live DOM.
 */
export async function resolveCardTitle(
  page: CardTitlePageLike,
  selector: string,
): Promise<string | null> {
  return page
    .$eval(selector, (el: Element) => {
      const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

      // 1. Climb to a product-card-like ancestor and read its title.
      const CARD_SELECTORS = [
        '.product-item', '.item-box', '.product-card', '[data-productid]',
        'li.product', 'article',
      ];
      const TITLE_SELECTORS = [
        '.product-title a', '.product-title', 'h2 a', 'h2', 'h3 a', 'h3',
        '.product-name', 'a.product-name',
      ];
      let node: Element | null = el;
      for (let hops = 0; node && hops < 6; hops++) {
        if (CARD_SELECTORS.some((s) => node!.matches?.(s))) {
          for (const ts of TITLE_SELECTORS) {
            const t = node.querySelector(ts);
            const text = clean(t?.textContent);
            if (text) return text;
          }
        }
        node = node.parentElement;
      }

      // 2. The picked element itself, if it reads like a title (link/heading).
      const tag = el.tagName.toLowerCase();
      if (tag === 'a' || tag === 'h1' || tag === 'h2' || tag === 'h3') {
        const own = clean(el.textContent);
        if (own) return own;
      }

      return null;
    })
    .catch(() => null);
}
