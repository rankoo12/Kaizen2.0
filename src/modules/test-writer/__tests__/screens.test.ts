import { ReconCrawler } from '../recon/crawler';
import { DEFAULT_BUDGETS } from '../interfaces';
import type { PageCapture } from '../interfaces';
import type { CandidateNode } from '../../../types';
import type { BrowserPool } from '../../../workers/browser-pool';
import type { IObservability } from '../../observability/interfaces';
import {
  viewSwitchCandidates, screenSlug, screenUrl, fingerprint, isNewScreen,
} from '../recon/screens';
import { sensitiveTier } from '../recon/safety';
import { prependNavigate } from '../write/scenario-writer';
import type { PlannedScenario, StepIntent } from '../../../types/test-writer';

/**
 * Screen discovery — pages reached by clicking, not by URL.
 * Spec: docs/specs/test-writer/spec-screen-discovery.md
 */

jest.mock('../recon/robots', () => ({
  ...jest.requireActual('../recon/robots'),
  fetchRobots: jest.fn(async () => ({ allows: [], disallows: [] })),
}));

const node = (over: Partial<CandidateNode> & { role: string; name: string }): CandidateNode => ({
  cssSelector: '', xpath: '', attributes: {}, textContent: '', isVisible: true, similarityScore: 0,
  ...over,
});

describe('viewSwitchCandidates — §1.2', () => {
  it('takes hrefless buttons in a navigation container or marked aria-current', () => {
    const survey = [
      node({ role: 'button', name: 'Runs', attributes: { 'nav-context': 'nav-class' } }),
      node({ role: 'button', name: 'Settings', attributes: { 'aria-current': 'false' } }),
      node({ role: 'link', name: 'Analyses', attributes: { 'nav-context': 'aside' } }),
    ];
    expect(viewSwitchCandidates(survey).map((c) => c.name)).toEqual(['Runs', 'Settings', 'Analyses']);
  });

  it('leaves links with an href to the BFS, and ignores controls outside navigation', () => {
    const survey = [
      node({ role: 'link', name: 'Runs', attributes: { 'nav-context': 'nav', href: '/runs' } }),
      node({ role: 'button', name: 'Runs', attributes: {} }),
      node({ role: 'button', name: 'Save', attributes: { 'nav-context': 'nav-class' } }),
    ];
    expect(viewSwitchCandidates(survey)).toEqual([]);
  });

  it('never clicks a session-ending, destructive, submit, opener or menu control', () => {
    const nav = { 'nav-context': 'nav' };
    const survey = [
      node({ role: 'button', name: 'Sign out', attributes: nav }),
      node({ role: 'button', name: 'Delete workspace', attributes: nav }),
      node({ role: 'button', name: 'Go', attributes: { ...nav, type: 'submit' } }),
      node({ role: 'button', name: 'New Test', attributes: nav }),
      node({ role: 'button', name: 'Account', attributes: { ...nav, 'aria-haspopup': 'true' } }),
      node({ role: 'button', name: '', attributes: nav }),
      node({ role: 'button', name: 'Runs', attributes: nav }),
    ];
    expect(viewSwitchCandidates(survey).map((c) => c.name)).toEqual(['Runs']);
  });

  it('dedups by role and name and caps the list', () => {
    const survey = Array.from({ length: 30 }, (_, i) =>
      node({ role: 'button', name: `View ${i % 20}`, attributes: { 'nav-context': 'nav' } }));
    expect(viewSwitchCandidates(survey)).toHaveLength(12);
  });
});

describe('screen identity — §1.3', () => {
  it('slugs strip keyboard hints and punctuation', () => {
    expect(screenSlug('Runs ⌘2')).toBe('runs');
    expect(screenSlug('The Brain')).toBe('the-brain');
    expect(screenSlug('⌘')).toBe('');
  });

  it('a screen url is the parent plus the slug chain', () => {
    expect(screenUrl('https://a.com/tests', [{ role: 'button', name: 'Runs' }])).toBe('https://a.com/tests#screen=runs');
    expect(screenUrl('https://a.com/tests#screen=runs', [{ role: 'button', name: 'Runs' }, { role: 'button', name: 'Open' }]))
      .toBe('https://a.com/tests#screen=runs/open');
    expect(screenUrl('https://a.com/tests', [{ role: 'button', name: '⌘' }])).toBeNull();
  });

  it('a screen is new when its controls, heading or text change materially', () => {
    const el = (...names: string[]) => names.map((name) => ({ role: 'button', name }));
    const parent = fingerprint(el('Runs', 'Tests', 'Search', 'Analyze', 'New Test'), [], 'h1', 'your suites and tests live here');
    const same = fingerprint(el('Runs', 'Tests', 'Search', 'Analyze', 'New Test'), [], 'h1', 'your suites and tests live here');
    const highlight = fingerprint(el('Runs', 'Tests', 'Search', 'Analyze', 'New Test', 'Filter'), [], 'h2', 'your suites and tests live here');
    const runs = fingerprint(el('Runs', 'Tests', 'All', 'Failed'), [], 'h3', 'your suites and tests live here');
    const heading = fingerprint(el('Runs', 'Tests', 'Search', 'Analyze', 'New Test'), ['Runs'], 'h4', '');
    const text = fingerprint(el('Runs', 'Tests', 'Search', 'Analyze', 'New Test'), [], 'h5',
      'every run newest first with the outcome and the healed steps for each case in the workspace');
    expect(isNewScreen(parent, same)).toBe(false);
    expect(isNewScreen(parent, highlight)).toBe(false);
    expect(isNewScreen(parent, runs)).toBe(true);      // 2 fresh, 3 gone
    expect(isNewScreen(parent, heading)).toBe(true);
    expect(isNewScreen(parent, text)).toBe(true);
  });
});

describe('sensitiveTier reads screen slugs — §1.4', () => {
  it('a Settings → API keys screen is Tier A even at /tests', () => {
    expect(sensitiveTier('https://a.com/tests#screen=settings/api-keys')).toBe('capture-suppressed');
    expect(sensitiveTier('https://a.com/tests#screen=settings')).toBe('passive-only');
    expect(sensitiveTier('https://a.com/tests#screen=runs')).toBeNull();
  });
});

describe('prependNavigate reaches a screen — §1.5', () => {
  const plan: PlannedScenario = {
    name: 'Filter runs', kind: 'happy', priority: 'normal', rationale: '', outline: '', journey: null,
    targetPages: ['https://a.com/tests'], source: { kind: 'llm' },
    reachedBy: [{ role: 'button', name: 'Runs' }],
  };
  const click: StepIntent = { action: 'click', target: { kind: 'description', description: 'the "Failed" button' } };

  it('navigates, then clicks the way there, then the body', () => {
    const r = prependNavigate([click], plan, { outcome: 'pass' });
    expect(r.steps).toEqual([
      { action: 'navigate', url: 'https://a.com/tests' },
      { action: 'click', target: { kind: 'description', description: 'the "Runs" button' } },
      click,
    ]);
  });

  it('keeps a navigate the model wrote and drops a reach click it repeated', () => {
    const own: StepIntent[] = [
      { action: 'navigate', url: 'https://a.com/tests' },
      { action: 'click', target: { kind: 'description', description: 'the "Runs" button' } },
      click,
    ];
    const r = prependNavigate(own, plan, { outcome: 'fail', failStepIndex: 2, reason: 'x' });
    expect(r.steps).toEqual(own);
    expect(r.expectation).toEqual({ outcome: 'fail', failStepIndex: 2, reason: 'x' });
  });

  it('moves the expected failure point by every step it inserted', () => {
    const r = prependNavigate([click], plan, { outcome: 'fail', failStepIndex: 0, reason: 'x' });
    expect(r.expectation).toEqual({ outcome: 'fail', failStepIndex: 2, reason: 'x' });
  });
});

// ── the crawler, end to end against a one-URL app with a sidebar ─────────────

const obs: IObservability = {
  startSpan: () => ({ end: () => {} }) as never,
  log: jest.fn(),
  increment: jest.fn(),
  histogram: jest.fn(),
};

const SIDEBAR = [
  node({ role: 'button', name: 'Tests', attributes: { 'nav-context': 'nav-class', 'aria-current': 'page' } }),
  node({ role: 'button', name: 'Runs', attributes: { 'nav-context': 'nav-class' } }),
  node({ role: 'button', name: 'Sign out', attributes: { 'nav-context': 'nav-class' } }),
];
const SCREENS: Record<string, { heading: string; own: CandidateNode[] }> = {
  tests: { heading: 'Tests', own: [node({ role: 'button', name: 'New suite' }), node({ role: 'textbox', name: 'Search tests' })] },
  runs: { heading: 'Runs', own: [node({ role: 'button', name: 'All' }), node({ role: 'button', name: 'Failed' }), node({ role: 'button', name: 'Passed' }), node({ role: 'textbox', name: 'Search runs' })] },
};

function makeSpaStack() {
  let currentUrl = '';
  let screen = 'tests';
  const clicks: string[] = [];
  const page = {
    url: () => currentUrl,
    goto: async (url: string) => { currentUrl = url; screen = 'tests'; },
    evaluate: async (fn: (...args: unknown[]) => unknown) => {
      const src = fn.toString();
      if (src.includes('password')) {
        return { title: 'App', headings: [SCREENS[screen].heading], hasVisiblePasswordInput: false, pageText: '' };
      }
      if (src.includes('a[href]')) return [];
      return [];
    },
    getByRole: (_role: string, opts: { name: string }) => ({
      first: () => ({
        click: async () => {
          clicks.push(opts.name);
          if (opts.name === 'Runs') screen = 'runs';
          else if (opts.name === 'Tests') screen = 'tests';
          else throw new Error('no such control');
        },
      }),
    }),
    waitForTimeout: async () => {},
    waitForLoadState: async () => {},
    keyboard: { press: async () => {} },
    on: jest.fn(),
    click: async () => {},
    screenshot: async () => Buffer.from(''),
  };
  const context = { on: jest.fn(), addInitScript: async () => {}, newPage: async () => page, close: jest.fn(async () => {}) };
  const browser = { newContext: async () => context };
  const pool = { acquire: async () => browser, release: jest.fn(async () => {}) } as unknown as BrowserPool;
  const surveyor = { survey: async () => [...SIDEBAR, ...SCREENS[screen].own] };
  return { pool, surveyor, clicks };
}

describe('ReconCrawler discovers screens — §1.3', () => {
  it('records the Runs view as a page reached by clicking, and not the view it was already on', async () => {
    const stack = makeSpaStack();
    const crawler = new ReconCrawler({ pool: stack.pool, surveyor: stack.surveyor, challenges: { detect: async () => null }, obs });
    const captured: PageCapture[] = [];
    const report = await crawler.crawl({
      tenantId: 't', jobId: 'j', targetUrl: 'https://app.test/tests',
      budgets: { ...DEFAULT_BUDGETS, maxPages: 10, minPageIntervalMs: 0, probesPerPage: 0 },
    }, async (c) => { captured.push(c); });

    const urls = captured.map((c) => c.urlNormalized);
    expect(urls).toContain('https://app.test/tests');
    expect(urls).toContain('https://app.test/tests#screen=runs');
    // "Tests" from /tests is the same view (aria-current) — discarded, not a page.
    expect(urls).not.toContain('https://app.test/tests#screen=tests');
    // "Sign out" is never clicked.
    expect(stack.clicks).not.toContain('Sign out');

    const runs = captured.find((c) => c.urlNormalized === 'https://app.test/tests#screen=runs')!;
    expect(runs.reachedBy).toEqual([{ role: 'button', name: 'Runs' }]);
    expect(runs.urlObserved).toBe('https://app.test/tests');
    expect(runs.headings).toEqual(['Runs']);
    expect(runs.survey.map((s) => s.name)).toContain('Failed');
    expect(report.screensDiscovered).toBe(1);
    expect(report.screensDiscarded).toBeGreaterThanOrEqual(1);
    expect(report.pagesCrawled).toBe(2);
  });
});
