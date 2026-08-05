import { canonicalFrameUrl, findFrameByUrl, framesOf } from '../frame-url';

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
