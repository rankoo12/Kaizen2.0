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
  return framesMatchingUrl(frames, frameUrl)[0] ?? null;
}

/**
 * Every frame a `frameUrl` refers to: exact live-URL matches first, canonical
 * matches only when there are none. More than one only when several frames share a
 * URL — nested `about:srcdoc` widgets are the real case, where a URL says nothing
 * about WHICH frame.
 */
export function framesMatchingUrl<T extends FrameLike>(frames: T[], frameUrl: string): T[] {
  const exact = frames.filter((f) => urlOf(f) === frameUrl);
  if (exact.length > 0) return exact;
  const wanted = canonicalFrameUrl(frameUrl) ?? frameUrl;
  return frames.filter((f) => canonicalFrameUrl(urlOf(f)) === wanted);
}

/** A frame that can also count what a selector matches inside it. */
export type CountableFrame = FrameLike & { locator?: (selector: string) => { count(): Promise<number> } };

/**
 * `findFrameByUrl`, told apart by content when the URL cannot. Frames sharing one URL
 * (a subscribe form three `about:srcdoc` hops deep) used to resolve to whichever came
 * first — the outermost — so the step acted in a frame that did not contain its
 * element. Among several same-URL frames this returns the first the selector actually
 * matches in, falling back to the first frame so nothing that worked before changes.
 * A single match is returned without probing, byte-identical to `findFrameByUrl`.
 */
export async function findFrameForSelector<T extends CountableFrame>(
  frames: T[],
  frameUrl: string,
  selector: string | null | undefined,
): Promise<T | null> {
  const matches = framesMatchingUrl(frames, frameUrl);
  if (matches.length <= 1 || !selector) return matches[0] ?? null;
  for (const frame of matches) {
    try {
      if (typeof frame.locator === 'function' && (await frame.locator(selector).count()) > 0) return frame;
    } catch {
      // detached frame or a selector this frame cannot parse — not this one
    }
  }
  return matches[0];
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

/**
 * The frame a healed action must run in. `healed` is what the heal strategy
 * reported: absent means it re-tried the step's OWN selector (keep `current`),
 * null means the main document, a string is the child frame the element was found in.
 */
export function frameAfterHeal(
  current: string | undefined,
  healed: string | null | undefined,
): string | undefined {
  if (healed === undefined) return current;
  return healed ?? undefined;
}
