/**
 * A citable name for a control that has no accessible one.
 *
 * saucedemo's sort `<select>` has no label, no aria-label, no title — a screen
 * reader announces nothing, and Kaizen's grounding query dropped it entirely
 * (`pe.name <> ''`), so "Sorting Products Renders Correctly" was written
 * without ever touching the sort control and died for it. The developer DID
 * name the thing, just not for people: `class="product_sort_container"`,
 * `data-test="product-sort-container"`. That is enough to talk about it.
 *
 * Derived names are marked (`attributes.nameSource = 'derived'`) so the
 * accessibility finding still reports the control as unlabelled — the user's
 * screen-reader problem is real even when Kaizen's grounding problem is solved.
 * Spec: docs/specs/test-writer/spec-recon-crawler.md §4.1 (amended 2026-08-18)
 */

const SOURCES = ['aria-label', 'data-test', 'data-testid', 'data-qa', 'id', 'name', 'placeholder', 'title'] as const;

/** `product_sort_container` / `productSortContainer` / `product-sort-container` → "product sort container". */
export function humanise(raw: string): string {
  return raw
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-.:/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .slice(0, 60);
}

/** Null when nothing usable exists — a derived name must never be a guess. */
export function deriveName(attributes: Record<string, string> | null | undefined): string | null {
  if (!attributes) return null;
  for (const key of SOURCES) {
    const v = attributes[key];
    if (typeof v !== 'string') continue;
    const h = humanise(v);
    // React/Vue hashes and one-letter ids describe nothing.
    if (h.length < 3 || /^[a-f0-9 ]{6,}$/.test(h) || /^\w{1,2}$/.test(h)) continue;
    return h;
  }
  return null;
}
