import { canonicalFrameUrl, findFrameByUrl, findFrameForSelector, frameAfterHeal, framesMatchingUrl, framesOf } from '../frame-url';

/**
 * Spec: docs/specs/reliability/spec-iframe-selector-caching.md §2
 *
 * The whole reason iframe-resolved elements used to be uncacheable is that a CMP
 * iframe's URL carries per-session state. Canonicalization is what makes the entry
 * matchable next run, so these are the load-bearing cases.
 */
describe('canonicalFrameUrl', () => {
  it('strips the query string that makes a consent iframe unmatchable next run', () => {
    expect(
      canonicalFrameUrl('https://cdn.privacy-mgmt.com/index.html?message_id=104&consentUUID=8f3c&_sp=x'),
    ).toBe('https://cdn.privacy-mgmt.com/index.html');
  });

  it('strips the hash too', () => {
    expect(canonicalFrameUrl('https://consent.example.com/frame#step2')).toBe(
      'https://consent.example.com/frame',
    );
  });

  it('keeps origin and path, which is what identifies the CMP', () => {
    expect(canonicalFrameUrl('https://a.example.com:8443/consent/v2/ui')).toBe(
      'https://a.example.com:8443/consent/v2/ui',
    );
  });

  it('treats a bare origin as origin + "/"', () => {
    expect(canonicalFrameUrl('https://consent.example.com')).toBe('https://consent.example.com/');
  });

  // A frame with no durable identity must stay uncacheable — a fingerprint for it
  // could never match again, so the entry would only ever cost a wasted lookup.
  it.each([
    ['about:blank'],
    ['about:srcdoc'],
    ['data:text/html,<button>hi</button>'],
    ['blob:https://example.com/9f2c'],
    ['javascript:void(0)'],
    ['not a url'],
    [''],
  ])('refuses to fingerprint %s', (url) => {
    expect(canonicalFrameUrl(url)).toBeNull();
  });

  it('refuses null and undefined', () => {
    expect(canonicalFrameUrl(null)).toBeNull();
    expect(canonicalFrameUrl(undefined)).toBeNull();
  });
});

describe('findFrameByUrl', () => {
  const frame = (url: string) => ({ url: () => url, tag: url });

  it('matches the live URL exactly, so same-run behaviour is unchanged', () => {
    const live = frame('https://cdn.privacy-mgmt.com/index.html?consentUUID=8f3c');
    const other = frame('https://cdn.privacy-mgmt.com/index.html?consentUUID=different');
    // Both canonicalize identically; the exact match must win so a set resolved a
    // moment ago acts on the very frame it was resolved in.
    expect(findFrameByUrl([other, live], live.url())).toBe(live);
  });

  it('falls back to origin + path, which is what a cached entry carries', () => {
    const live = frame('https://cdn.privacy-mgmt.com/index.html?consentUUID=NEW-SESSION');
    expect(findFrameByUrl([live], 'https://cdn.privacy-mgmt.com/index.html')).toBe(live);
  });

  it('does not match a different path on the same origin', () => {
    const live = frame('https://cdn.privacy-mgmt.com/other.html?x=1');
    expect(findFrameByUrl([live], 'https://cdn.privacy-mgmt.com/index.html')).toBeNull();
  });

  it('does not match a different origin on the same path', () => {
    const live = frame('https://evil.example.com/index.html');
    expect(findFrameByUrl([live], 'https://cdn.privacy-mgmt.com/index.html')).toBeNull();
  });

  it('returns null when the frame is gone — the caller must not fall back to the page', () => {
    expect(findFrameByUrl([frame('https://example.com/')], 'https://cdn.privacy-mgmt.com/index.html')).toBeNull();
  });

  it('survives a frame that detached mid-lookup', () => {
    const detached = { url: () => { throw new Error('Frame was detached'); } };
    const live = frame('https://cdn.privacy-mgmt.com/index.html');
    expect(findFrameByUrl([detached, live], 'https://cdn.privacy-mgmt.com/index.html')).toBe(live);
  });
});

describe('framesOf', () => {
  it('returns the frames', () => {
    expect(framesOf({ frames: () => [1, 2] })).toEqual([1, 2]);
  });

  it('returns empty for a page that cannot enumerate frames', () => {
    expect(framesOf({})).toEqual([]);
    expect(framesOf(null)).toEqual([]);
    expect(framesOf({ frames: () => { throw new Error('closed'); } })).toEqual([]);
  });
});

// Nested about:srcdoc widgets share ONE url, so the url says nothing about WHICH
// frame. findFrameByUrl returned the first (the outermost), and a step acted in a
// frame that did not contain its element. Seen live: the nightmare subscribe form,
// three srcdoc hops deep.
describe('framesMatchingUrl', () => {
  const frame = (url: string) => ({ url: () => url });

  it('returns every frame that shares the url', () => {
    const a = frame('about:srcdoc');
    const b = frame('about:srcdoc');
    const other = frame('https://example.com/');
    expect(framesMatchingUrl([a, other, b], 'about:srcdoc')).toEqual([a, b]);
  });

  it('prefers exact matches and only then falls back to canonical ones', () => {
    const live = frame('https://cdn.example.com/x.html?s=1');
    const sibling = frame('https://cdn.example.com/x.html?s=2');
    expect(framesMatchingUrl([sibling, live], live.url())).toEqual([live]);
    expect(framesMatchingUrl([sibling, live], 'https://cdn.example.com/x.html')).toEqual([sibling, live]);
  });
});

describe('findFrameForSelector', () => {
  const frame = (url: string, matches: Record<string, number> = {}) => ({
    url: () => url,
    locator: jest.fn((selector: string) => ({ count: async () => matches[selector] ?? 0 })),
  });

  it('tells apart frames that share a url by which one the selector matches in', async () => {
    const outer = frame('about:srcdoc');
    const mid = frame('about:srcdoc');
    const inner = frame('about:srcdoc', { '#void-email': 1 });
    expect(await findFrameForSelector([outer, mid, inner], 'about:srcdoc', '#void-email')).toBe(inner);
  });

  it('answers the first frame when none of the same-url frames matches (nothing that worked changes)', async () => {
    const a = frame('about:srcdoc');
    const b = frame('about:srcdoc');
    expect(await findFrameForSelector([a, b], 'about:srcdoc', '#nope')).toBe(a);
  });

  it('does not probe at all when exactly one frame matches — byte-identical to findFrameByUrl', async () => {
    const only = frame('https://cdn.example.com/index.html');
    const result = await findFrameForSelector([only, frame('https://other.example/')], 'https://cdn.example.com/index.html', '#x');
    expect(result).toBe(only);
    expect(only.locator).not.toHaveBeenCalled();
  });

  it('answers null when no frame matches the url', async () => {
    expect(await findFrameForSelector([frame('https://example.com/')], 'about:srcdoc', '#x')).toBeNull();
  });

  it('takes the first match when there is no selector to tell them apart', async () => {
    const a = frame('about:srcdoc');
    const b = frame('about:srcdoc');
    expect(await findFrameForSelector([a, b], 'about:srcdoc', undefined)).toBe(a);
  });

  it('survives a frame that detaches or cannot parse the selector mid-probe', async () => {
    const broken = { url: () => 'about:srcdoc', locator: () => { throw new Error('Frame was detached'); } };
    const good = frame('about:srcdoc', { '#x': 1 });
    expect(await findFrameForSelector([broken, good], 'about:srcdoc', '#x')).toBe(good);
  });

  it('tolerates frames that cannot count (a mock with only a url)', async () => {
    const a = { url: () => 'about:srcdoc' };
    const b = { url: () => 'about:srcdoc' };
    expect(await findFrameForSelector([a, b], 'about:srcdoc', '#x')).toBe(a);
  });
});

describe('frameAfterHeal', () => {
  it('keeps the step\'s own frame when the heal re-tried its selector (nothing reported)', () => {
    expect(frameAfterHeal('https://cdn.example.com/consent.html', undefined)).toBe('https://cdn.example.com/consent.html');
    expect(frameAfterHeal(undefined, undefined)).toBeUndefined();
  });

  it('moves the action into the frame the heal found the element in', () => {
    expect(frameAfterHeal(undefined, 'about:srcdoc')).toBe('about:srcdoc');
    expect(frameAfterHeal('https://old.example/f', 'https://new.example/f')).toBe('https://new.example/f');
  });

  it('clears a stale frame when the heal found a main-document element (null)', () => {
    expect(frameAfterHeal('https://cdn.example.com/consent.html', null)).toBeUndefined();
  });
});
