import { normalizeUrl, normalizeHref, isSameOrigin, pathOf } from '../recon/url-normalizer';

describe('normalizeUrl', () => {
  it('drops query string and fragment', () => {
    expect(normalizeUrl('https://a.com/products?page=2#reviews')).toBe('https://a.com/products');
  });

  it('strips the trailing slash except at root', () => {
    expect(normalizeUrl('https://a.com/products/')).toBe('https://a.com/products');
    expect(normalizeUrl('https://a.com/')).toBe('https://a.com/');
  });

  it('keeps concrete path params (no templating in v1)', () => {
    expect(normalizeUrl('https://a.com/product/42')).toBe('https://a.com/product/42');
  });

  it('rejects non-http(s) and unparseable URLs', () => {
    expect(normalizeUrl('ftp://a.com/x')).toBeNull();
    expect(normalizeUrl('mailto:x@y.com')).toBeNull();
    expect(normalizeUrl('not a url')).toBeNull();
  });
});

describe('normalizeHref', () => {
  it('resolves relative hrefs against the page URL', () => {
    expect(normalizeHref('/cart', 'https://a.com/products/1')).toBe('https://a.com/cart');
    expect(normalizeHref('reviews', 'https://a.com/products/1')).toBe('https://a.com/products/reviews');
  });

  it('returns null for javascript: and mailto:', () => {
    expect(normalizeHref('javascript:void(0)', 'https://a.com/')).toBeNull();
    expect(normalizeHref('mailto:x@y.com', 'https://a.com/')).toBeNull();
  });
});

describe('isSameOrigin / pathOf', () => {
  it('detects cross-origin (including subdomains and ports)', () => {
    expect(isSameOrigin('https://a.com/x', 'https://a.com')).toBe(true);
    expect(isSameOrigin('https://sub.a.com/x', 'https://a.com')).toBe(false);
    expect(isSameOrigin('https://a.com:8443/x', 'https://a.com')).toBe(false);
    expect(isSameOrigin('http://a.com/x', 'https://a.com')).toBe(false);
  });

  it('extracts the pathname', () => {
    expect(pathOf('https://a.com/admin/users')).toBe('/admin/users');
  });
});
