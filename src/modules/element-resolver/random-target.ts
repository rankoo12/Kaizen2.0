/**
 * Direct "find the repeated elements, pick one" resolution for click_random.
 *
 * The DOM pruner returns every interactive element with a constant relevance
 * score, which makes it unsuitable for "pick a random <kind>". This module
 * instead queries the LIVE page for the specific repeated control the target
 * describes (e.g. add-to-cart buttons, product links), assigns each a stable
 * nth-of-match selector, and reads the associated item title — so the worker
 * can pick one by a seeded index and later assert the cart against its name.
 *
 * Spec: docs/specs/workers/spec-engine-capabilities-assert-random-capture.md §2
 */

export interface RandomTargetPageLike {
  /** Playwright $$eval: runs `fn` with the matched element array, in-browser. */
  $$eval<T>(selector: string, fn: (els: Element[]) => T): Promise<T>;
}

export type RepeatedMatch = {
  /** Stable selector locating exactly this element (CSS :nth-of-type chain or marker). */
  selector: string;
  /** The item title associated with this element (product name), if resolvable. */
  title: string | null;
};

/**
 * Map a natural-language target to one or more CSS selectors for the repeated
 * control to click. Ordered by specificity; the first selector that matches
 * anything on the page wins. Kept deliberately small and demowebshop/nopCommerce
 * aware while still covering generic e-commerce markup.
 */
export function selectorsForTarget(target: string): string[] {
  const t = target.toLowerCase();
  const wantsAddToCart = /(add).*(cart)|cart.*button/.test(t) || t.includes('add to cart');

  if (wantsAddToCart) {
    return [
      'input.product-box-add-to-cart-button',           // nopCommerce/demowebshop
      'button.product-box-add-to-cart-button',
      'input[value="Add to cart" i]',
      'button:has-text("Add to cart")',                  // Playwright text engine
      '.product-item input[type="button"]',
    ];
  }

  // Default: a product link/card title.
  return [
    '.product-item .product-title a',
    '.item-box .product-title a',
    '.product-item h2 a',
    '.product-grid .product-title a',
  ];
}

/**
 * Find all elements matching the target on the live page and return a pickable
 * entry for each, with a stable per-element selector and its product title.
 * Returns [] when nothing matches any selector.
 */
export async function findRepeatedTargets(
  page: RandomTargetPageLike,
  target: string,
): Promise<RepeatedMatch[]> {
  for (const sel of selectorsForTarget(target)) {
    const matches = await page
      .$$eval(sel, (els: Element[]) => {
        const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

        // Title lookup: climb to the product card, read its title link.
        const CARD = ['.item-box', '.product-item', '.product-card', '[data-productid]', 'li.product', 'article'];
        const TITLE = ['h2.product-title a', '.product-title a', '.product-title', 'h2 a', 'h2', '.product-name a', '.product-name'];
        const titleFor = (el: Element): string | null => {
          // If the element itself is the title link.
          if (el.tagName.toLowerCase() === 'a') {
            const own = clean(el.textContent);
            if (own) return own;
          }
          let node: Element | null = el;
          for (let h = 0; node && h < 8; h++) {
            if (CARD.some((c) => node!.matches?.(c))) {
              for (const ts of TITLE) {
                const found = clean(node.querySelector(ts)?.textContent);
                if (found) return found;
              }
            }
            node = node.parentElement;
          }
          return null;
        };

        // Build a stable selector: prefer id, else a nth-of-type path tagging the
        // element's index among siblings so Playwright can re-locate exactly it.
        const stableSelector = (el: Element): string => {
          if (el.id) return `#${CSS.escape(el.id)}`;
          // Tag the element with a transient attribute the worker can target.
          const marker = `kz-rand-${Math.random().toString(36).slice(2, 9)}`;
          el.setAttribute('data-kz-rand', marker);
          return `[data-kz-rand="${marker}"]`;
        };

        return els.map((el) => ({ selector: stableSelector(el), title: titleFor(el) }));
      })
      .catch(() => [] as RepeatedMatch[]);

    if (matches.length > 0) return matches;
  }
  return [];
}
