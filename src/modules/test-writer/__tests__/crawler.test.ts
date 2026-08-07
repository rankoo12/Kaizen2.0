import { ReconCrawler } from '../recon/crawler';
import { DEFAULT_BUDGETS } from '../interfaces';
import type { PageCapture } from '../interfaces';
import type { BrowserPool } from '../../../workers/browser-pool';
import type { IObservability } from '../../observability/interfaces';

// The crawler fetches robots.txt over the network — mock the module so unit
// tests stay offline. isAllowed keeps its real implementation.
jest.mock('../recon/robots', () => ({
  ...jest.requireActual('../recon/robots'),
  fetchRobots: jest.fn(async () => ({ allows: [], disallows: ['/blocked'] })),
}));

const obs: IObservability = {
  startSpan: () => ({ end: () => {} }) as never,
  log: jest.fn(),
  increment: jest.fn(),
  histogram: jest.fn(),
};

type SiteFixture = Record<string, {
  redirectTo?: string;
  hasPassword?: boolean;
  anchors: Array<{ href: string; text: string }>;
}>;

/** Fake browser stack driving the crawler against an in-memory site. */
function makeFakeStack(site: SiteFixture) {
  let currentUrl = '';

  const page = {
    url: () => currentUrl,
    goto: async (url: string) => {
      const fixture = site[url];
      if (!fixture) throw new Error(`net::ERR_NAME_NOT_RESOLVED ${url}`);
      currentUrl = fixture.redirectTo ?? url;
    },
    evaluate: async (fn: (...args: unknown[]) => unknown) => {
      const src = fn.toString();
      const fixture = site[currentUrl] ?? { anchors: [] };
      if (src.includes('password')) {
        return { title: `Title of ${currentUrl}`, headings: [], hasVisiblePasswordInput: !!fixture.hasPassword };
      }
      if (src.includes('a[href]')) return fixture.anchors;
      return []; // forms
    },
    waitForTimeout: async () => {},
    waitForLoadState: async () => {},
    keyboard: { press: async () => {} },
    on: jest.fn(),
    click: async () => {},
    screenshot: async () => Buffer.from(''),
  };

  const context = {
    on: jest.fn(),
    addInitScript: async () => {},
    newPage: async () => page,
    close: jest.fn(async () => {}),
  };
  const browser = { newContext: async () => context };
  const release = jest.fn(async () => {});
  const pool = { acquire: async () => browser, release } as unknown as BrowserPool;

  return { pool, context, release };
}

const surveyor = { survey: async () => [] };
const challenges = { detect: async () => null };

function makeCrawler(site: SiteFixture) {
  const stack = makeFakeStack(site);
  const crawler = new ReconCrawler({
    pool: stack.pool, surveyor, challenges, obs,
  });
  return { crawler, stack };
}

const params = (maxPages: number) => ({
  tenantId: 't-1',
  jobId: 'j-1',
  targetUrl: 'https://a.com/',
  budgets: { ...DEFAULT_BUDGETS, maxPages, minPageIntervalMs: 0 },
});

describe('ReconCrawler', () => {
  it('BFS-crawls same-origin links only and respects the page budget', async () => {
    const site: SiteFixture = {
      'https://a.com/': {
        anchors: [
          { href: '/a', text: 'Page A' },
          { href: '/b', text: 'Page B' },
          { href: 'https://external.com/x', text: 'External' },
        ],
      },
      'https://a.com/a': { anchors: [] },
      'https://a.com/b': { anchors: [] },
    };
    const { crawler, stack } = makeCrawler(site);

    const captures: PageCapture[] = [];
    const report = await crawler.crawl(params(2), async (c) => { captures.push(c); });

    expect(report.pagesCrawled).toBe(2);
    expect(captures.map((c) => c.urlNormalized)).toEqual(['https://a.com/', 'https://a.com/a']);
    // The external link never entered the queue; /b was budgeted out.
    expect(report.urlsSkippedByBudget).toBe(1);
    // Root's outgoing links contain only same-origin targets.
    expect(captures[0].outgoingLinks.map((l) => l.toUrlNormalized))
      .toEqual(['https://a.com/a', 'https://a.com/b']);
    expect(stack.release).toHaveBeenCalled();
    expect(stack.context.close).toHaveBeenCalled();
  });

  it('records robots-disallowed pages as blocked without visiting them', async () => {
    const site: SiteFixture = {
      'https://a.com/': { anchors: [{ href: '/blocked', text: 'Admin' }] },
      'https://a.com/blocked': { anchors: [] },
    };
    const { crawler } = makeCrawler(site);

    const captures: PageCapture[] = [];
    const report = await crawler.crawl(params(10), async (c) => { captures.push(c); });

    expect(report.pagesCrawled).toBe(1);
    expect(report.pagesBlocked).toBe(1);
    const blocked = captures.find((c) => c.urlNormalized === 'https://a.com/blocked');
    expect(blocked?.blocked).toBe('robots');
    expect(blocked?.survey).toEqual([]);
  });

  it('marks a login-wall redirect as requires_auth and does not crawl beyond it', async () => {
    const site: SiteFixture = {
      'https://a.com/': { anchors: [{ href: '/account', text: 'My account' }] },
      'https://a.com/account': {
        redirectTo: 'https://a.com/login',
        anchors: [],
      },
      // The fixture the crawler actually SEES after the redirect — the login
      // wall with a password input and links that must not be followed.
      'https://a.com/login': {
        hasPassword: true,
        anchors: [{ href: '/secret', text: 'Should not be followed' }],
      },
    };
    const { crawler } = makeCrawler(site);

    const captures: PageCapture[] = [];
    const report = await crawler.crawl(params(10), async (c) => { captures.push(c); });

    const wall = captures.find((c) => c.urlNormalized === 'https://a.com/account');
    expect(wall?.requiresAuth).toBe(true);
    expect(wall?.outgoingLinks).toEqual([]);
    expect(captures.some((c) => c.urlNormalized === 'https://a.com/secret')).toBe(false);
    expect(report.pagesCrawled).toBe(2); // root + the auth-wall record
  });

  it('records challenge-blocked pages and never proceeds past them', async () => {
    const challengedDetector = {
      detect: async () => ({ type: 'cloudflare' as const, message: 'blocked' }),
    };
    const site: SiteFixture = { 'https://a.com/': { anchors: [] } };
    const stack = makeFakeStack(site);
    const crawler = new ReconCrawler({
      pool: stack.pool, surveyor, challenges: challengedDetector, obs,
    });

    const captures: PageCapture[] = [];
    const report = await crawler.crawl(params(10), async (c) => { captures.push(c); });

    expect(report.pagesCrawled).toBe(0);
    expect(report.pagesBlocked).toBe(1);
    expect(captures[0].blocked).toBe('challenge');
  });
});

/**
 * Authenticated scope — spec-authenticated-scope.md §5.
 * Invariants: the crawl can never end its own session; pages that render
 * secrets are never surveyed or screenshotted; and without a session the
 * crawler visits nothing behind the wall.
 */
describe('ReconCrawler — authenticated scope', () => {
  // A realistic recipe: navigate, then the terminal assertion §4.3 asks for.
  // Without that assertion an SPA-style login cannot be PROVEN and the job
  // blocks by design — which is its own test, further down.
  const LOGIN_STEPS = [
    {
      rawText: 'go to the login page',
      ast: {
        action: 'navigate', url: 'https://a.com/login', targetDescription: null,
        value: null, rawText: 'go to the login page', contentHash: 'c1', targetHash: 't1',
      },
    },
    {
      rawText: 'verify the dashboard is visible',
      ast: {
        action: 'assert_visible', url: null, targetDescription: 'the dashboard',
        value: null, rawText: 'verify the dashboard is visible', contentHash: 'c2', targetHash: 't2',
      },
    },
  ] as never[];

  function authDeps(overrides: { execute?: jest.Mock } = {}) {
    return {
      engine: { executeStep: overrides.execute ?? jest.fn().mockResolvedValue({ status: 'passed' }) },
      resolver: {
        resolve: jest.fn().mockResolvedValue({
          selectors: [{ selector: '#x', strategy: 'css', confidence: 1 }],
          resolutionSource: 'redis', tokensUsed: 0,
        }),
        recordSuccess: jest.fn(), recordFailure: jest.fn(),
      },
    } as never;
  }

  function makeAuthCrawler(site: SiteFixture, deps = authDeps()) {
    const stack = makeFakeStack(site);
    const crawler = new ReconCrawler({
      pool: stack.pool, surveyor, challenges, obs, auth: deps,
    });
    return { crawler, stack };
  }

  const authParams = (maxPages: number) => ({
    ...params(maxPages),
    auth: { loginCaseId: 'case-1', steps: LOGIN_STEPS },
  });

  it('never enqueues a logout URL, so the crawl cannot end its own session', async () => {
    const site: SiteFixture = {
      'https://a.com/': {
        anchors: [
          { href: '/orders', text: 'Orders' },
          { href: '/users/sign_out', text: '' },     // icon logout — no name
          { href: '/logout', text: 'Log out' },
        ],
      },
      'https://a.com/orders': { anchors: [] },
      'https://a.com/users/sign_out': { anchors: [] },
      'https://a.com/logout': { anchors: [] },
    };
    const { crawler } = makeAuthCrawler(site);
    const captures: PageCapture[] = [];
    const report = await crawler.crawl(authParams(10), async (c) => { captures.push(c); });

    const visited = captures.map((c) => c.urlNormalized);
    expect(visited).not.toContain('https://a.com/logout');
    expect(visited).not.toContain('https://a.com/users/sign_out');
    expect(visited).toContain('https://a.com/orders');
    expect(report.auth!.sessionEndingBlocked).toBeGreaterThan(0);
  });

  it('records Tier A pages as URL + title only — no survey, no screenshot, no outline', async () => {
    const site: SiteFixture = {
      'https://a.com/': { anchors: [{ href: '/api-keys', text: 'API keys' }] },
      'https://a.com/api-keys': { anchors: [] },
    };
    const { crawler } = makeAuthCrawler(site);
    const captures: PageCapture[] = [];
    const report = await crawler.crawl(authParams(10), async (c) => { captures.push(c); });

    const keys = captures.find((c) => c.urlNormalized === 'https://a.com/api-keys')!;
    expect(keys.blocked).toBe('capture-suppressed');
    expect(keys.survey).toEqual([]);
    expect(keys.forms).toEqual([]);
    expect(keys.screenshotKey).toBeNull();
    expect((keys as { axOutline?: unknown }).axOutline).toBeUndefined();
    expect(keys.requiresAuth).toBe(true);
    expect(report.auth!.captureSuppressed).toBe(1);
  });

  it('marks pages seen while signed in as requires_auth', async () => {
    const site: SiteFixture = { 'https://a.com/': { anchors: [] } };
    const { crawler } = makeAuthCrawler(site);
    const captures: PageCapture[] = [];
    await crawler.crawl(authParams(5), async (c) => { captures.push(c); });

    expect(captures[0].requiresAuth).toBe(true);
  });

  it('blocks the job when the login recipe fails, and visits nothing', async () => {
    const site: SiteFixture = { 'https://a.com/': { anchors: [] } };
    const { crawler } = makeAuthCrawler(site, authDeps({
      execute: jest.fn().mockResolvedValue({ status: 'failed', errorMessage: 'no such button' }),
    }));
    const captures: PageCapture[] = [];
    const report = await crawler.crawl(authParams(5), async (c) => { captures.push(c); });

    expect(captures).toHaveLength(0);
    expect(report.pagesCrawled).toBe(0);
    expect(report.auth!.blockedReason).toBe('login_failed');
    expect(report.auth!.blockedDetail).toContain('step 1 of the sign-in test');
  });

  it('reports authScope public and no auth block when no recipe is given', async () => {
    const site: SiteFixture = { 'https://a.com/': { anchors: [] } };
    const { crawler } = makeCrawler(site);
    const report = await crawler.crawl(params(5), async () => {});

    expect(report.authScope).toBe('public');
    expect(report.auth).toBeUndefined();
  });
});
