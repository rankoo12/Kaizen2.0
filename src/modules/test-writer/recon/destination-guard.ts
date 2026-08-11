/**
 * Destination guard — what Kaizen's crawler is allowed to fetch.
 * Spec: docs/specs/test-writer/spec-authenticated-scope.md §3.1
 *
 * Kaizen fetches URLs a CUSTOMER chooses, from inside our own network, and
 * returns what it saw as page structure and screenshots. That is a
 * server-side request forgery primitive unless something bounds it: a tenant
 * admin could analyze `http://169.254.169.254/latest/meta-data/iam/...` and
 * read cloud credentials straight out of the site model.
 *
 * Found by the P3 dogfood, which also showed the guard had been in the wrong
 * PLACE: P3 checked login-recipe navigations but nothing checked the analyze
 * TARGET, so the public crawler (P1/P2) carried the same exposure and always
 * had. The check therefore lives here and is applied at both entry points.
 *
 * The escape hatch is deliberate and off by default. Kaizen is run locally
 * against `localhost:3001` and self-hosted against private networks, so a
 * blanket ban makes those deployments untestable. `KAIZEN_ALLOW_PRIVATE_TARGETS=1`
 * opts in; a hosted deployment simply never sets it.
 */

/** Human-readable reason a destination is refused, or null when it is allowed. */
export function blockedDestinationReason(rawUrl: string, baseUrl?: string): string | null {
  let url: URL;
  try {
    url = baseUrl ? new URL(rawUrl, baseUrl) : new URL(rawUrl);
  } catch {
    return 'unparseable URL';
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return `unsupported scheme "${url.protocol.replace(':', '')}"`;
  }

  if (privateTargetsAllowed()) return null;

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');

  if (host === 'localhost' || host.endsWith('.localhost')) return 'loopback';
  if (host === '::1' || host === '0:0:0:0:0:0:0:1') return 'IPv6 loopback';
  if (host.endsWith('.internal') || host.endsWith('.local')) return 'internal hostname';
  // Unique-local IPv6 (fc00::/7) — the v6 analogue of RFC1918.
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return 'private network';
  if (/^fe80:/.test(host)) return 'link-local';

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 127) return 'loopback';
    if (a === 10) return 'private network';
    if (a === 169 && b === 254) return 'link-local / cloud metadata';
    if (a === 172 && b >= 16 && b <= 31) return 'private network';
    if (a === 192 && b === 168) return 'private network';
    if (a === 0) return 'unspecified address';
  }
  return null;
}

/**
 * Whether this deployment may crawl private/loopback addresses.
 *
 * Read per call rather than cached at import: tests and the local dogfood set
 * it after modules load, and a cached false would silently ignore them.
 */
export function privateTargetsAllowed(): boolean {
  const v = (process.env.KAIZEN_ALLOW_PRIVATE_TARGETS ?? '').toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}
