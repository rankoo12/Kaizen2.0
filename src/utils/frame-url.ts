/**
 * Frame identity for elements resolved inside a child iframe.
 *
 * Spec: docs/specs/reliability/spec-iframe-selector-caching.md (backlog B9)
 *
 * A cookie-consent CMP iframe's live URL carries per-session state:
 *
 *   https://cdn.privacy-mgmt.com/index.html?consentUUID=8f3c…&_sp=…
 *
 * Storing that verbatim produces a cache entry that never matches again, which is
 * why frame-resolved elements used to be session-only. Stripping the query and hash
 * leaves the CMP's actual identity, which survives across sessions:
 *
 *   https://cdn.privacy-mgmt.com/index.html
 *
 * That canonical form is what the cache stores and what the UI shows.
 */

/** Minimal surface shared by a Playwright Page and Frame for frame lookup. */
export type FrameLike = { url?: () => string };

/** A page (or anything) that can enumerate its frames. */
export type FramesHost = { frames?: () => unknown[] };

/**
 * Canonical, cacheable identity for a frame URL: `origin + pathname`.
 *
 * Returns null when the frame has no durable identity — `about:blank`, `about:srcdoc`,
 * `data:` / `blob:` URLs, or anything unparseable. Such frames keep the old session-only
 * behaviour rather than get a fingerprint that cannot be relied on next run.
 */
export function canonicalFrameUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  // about:, data:, blob:, javascript: — no stable origin to anchor on.
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  return `${parsed.origin}${parsed.pathname}`;
}

/** Safely read a frame's current URL; frames detach mid-run and url() can throw. */
function urlOf(frame: FrameLike): string {
  try {
    return typeof frame.url === 'function' ? frame.url() : '';
  } catch {
    return '';
  }
}

/**
 * Find the frame a SelectorSet's `frameUrl` refers to.
 *
 * Exact match first, so a set resolved earlier in THIS run — which carries the live
 * URL, session tokens and all — matches byte-identically and behaves exactly as it did
 * before this existed. Canonical match second, which is what a set read back from the
 * cache carries.
 *
 * Returns null when no frame matches. Callers must treat that as "cannot act here"
 * rather than falling back to the top document: a frame-scoped selector run against the
 * main page resolves to nothing and fails a step on a site where nothing is broken.
 */
export function findFrameByUrl<T extends FrameLike>(frames: T[], frameUrl: string): T | null {
  for (const f of frames) {
    if (urlOf(f) === frameUrl) return f;
  }
  const wanted = canonicalFrameUrl(frameUrl) ?? frameUrl;
  for (const f of frames) {
    if (canonicalFrameUrl(urlOf(f)) === wanted) return f;
  }
  return null;
}

/** `page.frames()` with the guards every caller would otherwise repeat. */
export function framesOf<T>(page: unknown): T[] {
  const host = page as FramesHost;
  try {
    return typeof host?.frames === 'function' ? (host.frames() as T[]) : [];
  } catch {
    return [];
  }
}
