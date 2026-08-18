/**
 * URL normalization for the site model.
 * Spec ref: docs/specs/test-writer/spec-recon-crawler.md §6
 *
 * urlNormalized = origin + pathname, with the trailing slash stripped (except
 * root), query string dropped, fragment dropped. Path params are deliberately
 * NOT templated in v1 — normalization bugs silently merge or explode the page
 * graph, so the rules stay trivial and observable.
 */

/** Normalize an absolute URL, or return null if it is not http(s). */
export function normalizeUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  let path = url.pathname;
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  return url.origin + path;
}

/** Resolve a possibly-relative href against a base page URL, then normalize. */
export function normalizeHref(href: string, baseUrl: string): string | null {
  try {
    return normalizeUrl(new URL(href, baseUrl).toString());
  } catch {
    return null;
  }
}

/** True when the normalized URL shares an origin with the crawl root. */
export function isSameOrigin(normalized: string, rootOrigin: string): boolean {
  try {
    return new URL(normalized).origin === rootOrigin;
  } catch {
    return false;
  }
}

/** The pathname of a normalized URL ('' on parse failure). */
export function pathOf(normalized: string): string {
  try {
    return new URL(normalized).pathname;
  } catch {
    return '';
  }
}

/**
 * The URL as observed, minus the fragment. Used for the NAVIGABLE form of a
 * page (site_pages.url_observed) — normalisation is for identity only, and
 * stripping a trailing slash from a URL we then navigate to is how a 200 page
 * became a 404 and a false broken-link finding.
 * Spec: docs/specs/test-writer/spec-oracle-delta-and-fidelity.md §4
 */
export function stripFragment(raw: string): string {
  try {
    const url = new URL(raw);
    url.hash = '';
    return url.toString();
  } catch {
    return raw;
  }
}
