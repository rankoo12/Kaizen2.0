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
