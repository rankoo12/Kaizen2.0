import { PageChallengeDetector } from '../challenge-detector';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Build a mock Playwright Page whose evaluate() runs the provided callback
 * against the given fake document/window state.
 */
function makePage(domState: {
  title?: string;
  bodyHtml?: string;
  ids?: string[];           // elements returned by getElementById
  selectors?: string[];     // selectors matched by querySelector
}): unknown {
  return {
    url: () => 'https://example.com',
    screenshot: jest.fn().mockResolvedValue(Buffer.from('')),
    evaluate: jest.fn().mockImplementation(async (fn: Function) => {
      // Simulate browser document
      const fakeDoc = {
        title: domState.title ?? '',
        body: { innerHTML: domState.bodyHtml ?? '' },
        getElementById: (id: string) =>
          (domState.ids ?? []).includes(id) ? { id } : null,
        querySelector: (sel: string) =>
          (domState.selectors ?? []).some((s) => sel.includes(s.split('[')[0]) || sel === s)
            ? { matches: true }
            : null,
      };
      // Replace globals the detector uses and run the function
      const origDoc = (global as any).document;
      (global as any).document = fakeDoc;
      try {
        return fn();
      } finally {
        (global as any).document = origDoc;
      }
    }),
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('PageChallengeDetector', () => {
  let detector: PageChallengeDetector;

  beforeEach(() => {
    detector = new PageChallengeDetector();
  });

  // ── Clean pages ─────────────────────────────────────────────────────────────

  it('returns null for a normal page with no challenge signals', async () => {
    const page = makePage({ title: 'GitHub', bodyHtml: '<main>Welcome</main>' });
    expect(await detector.detect(page)).toBeNull();
  });

  it('returns null when the word "cloudflare" appears in body but title is normal', async () => {
    // A page that mentions Cloudflare in its footer but is not a challenge page
    const page = makePage({
      title: 'My App',
      bodyHtml: '<footer>Protected by Cloudflare</footer>',
    });
    expect(await detector.detect(page)).toBeNull();
  });

  // ── Cloudflare IUAM ──────────────────────────────────────────────────────────

  it('detects Cloudflare IUAM via "Just a moment" title alone', async () => {
    const page = makePage({ title: 'Just a moment...' });
    const result = await detector.detect(page);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('cloudflare');
    expect(result!.message).toMatch(/cloudflare/i);
  });

  it('detects Cloudflare via #challenge-running element', async () => {
    const page = makePage({ title: 'example.com', ids: ['challenge-running'] });
    const result = await detector.detect(page);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('cloudflare');
  });

  it('detects Cloudflare via #cf-challenge-running element', async () => {
    const page = makePage({ title: 'example.com', ids: ['cf-challenge-running'] });
    const result = await detector.detect(page);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('cloudflare');
  });

  it('detects Cloudflare via #cf-chl-widget element', async () => {
    const page = makePage({ title: 'example.com', ids: ['cf-chl-widget'] });
    const result = await detector.detect(page);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('cloudflare');
  });

  it('detects Cloudflare via #cf-spinner element', async () => {
    const page = makePage({ title: 'example.com', ids: ['cf-spinner'] });
    const result = await detector.detect(page);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('cloudflare');
  });

  it('detects Cloudflare when title + body both contain cloudflare signal', async () => {
    const page = makePage({
      title: 'Just a moment...',
      bodyHtml: 'Powered by Cloudflare',
    });
    const result = await detector.detect(page);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('cloudflare');
  });

  // ── Generic CAPTCHA ──────────────────────────────────────────────────────────

  it('detects hCaptcha via iframe src', async () => {
    const page = makePage({
      title: 'Access Denied',
      selectors: ['iframe[src*="hcaptcha.com"]'],
    });
    const result = await detector.detect(page);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('generic_captcha');
    expect(result!.message).toMatch(/captcha/i);
  });

  it('detects reCAPTCHA via iframe src', async () => {
    const page = makePage({
      title: 'Access Denied',
      selectors: ['iframe[src*="recaptcha"]'],
    });
    const result = await detector.detect(page);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('generic_captcha');
  });

  // ── Error resilience ─────────────────────────────────────────────────────────

  it('returns null (does not throw) when evaluate() rejects', async () => {
    const page = {
      url: () => 'https://example.com',
      evaluate: jest.fn().mockRejectedValue(new Error('Target closed')),
    };
    expect(await detector.detect(page)).toBeNull();
  });

  // ── Cloudflare takes precedence over generic captcha ────────────────────────

  it('reports cloudflare (not generic_captcha) when both signals are present', async () => {
    const page = makePage({
      title: 'Just a moment...',
      selectors: ['iframe[src*="hcaptcha.com"]'],
    });
    const result = await detector.detect(page);
    expect(result!.type).toBe('cloudflare');
  });
});
