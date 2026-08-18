import { deriveName, humanise } from '../recon/derived-name';

/** Spec: spec-recon-crawler.md §4.1 (amended 2026-08-18) — unnamed controls get the developer's own handle. */
describe('deriveName', () => {
  it('turns saucedemo\'s sort select into something a test can cite', () => {
    expect(deriveName({ 'data-test': 'product-sort-container', class: 'product_sort_container' })).toBe('product sort container');
    expect(deriveName({ id: 'productSortContainer' })).toBe('product sort container');
  });
  it('prefers a real label over an id, and never invents one from noise', () => {
    expect(deriveName({ id: 'x9f3a2b1c4d', 'aria-label': 'Sort products' })).toBe('sort products');
    expect(deriveName({ id: 'a1b2c3d4e5f6' })).toBeNull();
    expect(deriveName({ id: 'q' })).toBeNull();
    expect(deriveName(null)).toBeNull();
    expect(deriveName({})).toBeNull();
  });
  it('humanise splits snake, kebab and camel', () => {
    expect(humanise('checkout_button-primaryCta')).toBe('checkout button primary cta');
  });
});
