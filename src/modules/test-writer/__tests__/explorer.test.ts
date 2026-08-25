import { Explorer, isExplorerClickable, parseAction } from '../recon/explorer';
import { DEFAULT_BUDGETS, type PageCapture } from '../interfaces';
import type { BrowserPool } from '../../../workers/browser-pool';
import type { IObservability } from '../../observability/interfaces';
import type { ITestWriterGateway } from '../../llm-gateway/testwriter.interfaces';
import type { CandidateNode } from '../../../types';
import type { ExploreAction } from '../../../types/test-writer';

/**
 * The explorer subagent — the model decides where to go, our code decides what
 * is clickable and what may be recorded.
 * Spec: docs/specs/test-writer/spec-agentic-testwriter.md §4
 */

const obs: IObservability = {
  startSpan: () => ({ end: () => {} }) as never,
  log: jest.fn(),
  increment: jest.fn(),
  histogram: jest.fn(),
};

const ctx = { rootOrigin: 'http://app.local', pageUrl: 'http://app.local/tests' };

function node(partial: Partial<CandidateNode> & { role: string; name: string }): CandidateNode {
  return {
    cssSelector: `#${partial.name.toLowerCase().replace(/\W+/g, '-')}`,
    xpath: '', attributes: {}, textContent: partial.name, isVisible: true, similarityScore: 0,
    ...partial,
  };
}

describe('isExplorerClickable', () => {
  it('allows a named hrefless sidebar button the crawler would call mutating', () => {
    expect(isExplorerClickable(node({ role: 'button', name: 'Runs', attributes: { 'nav-context': 'aside' } }), ctx)).toBe(true);
  });
  it('allows a row — it opens a detail view', () => {
    expect(isExplorerClickable(node({ role: 'row', name: 'Checkout smoke' }), ctx)).toBe(true);
  });
  it('refuses destructive, session-ending and action names regardless of role', () => {
    expect(isExplorerClickable(node({ role: 'button', name: 'Delete suite' }), ctx)).toBe(false);
    expect(isExplorerClickable(node({ role: 'button', name: 'Sign out' }), ctx)).toBe(false);
    expect(isExplorerClickable(node({ role: 'button', name: 'Run now' }), ctx)).toBe(false);
    expect(isExplorerClickable(node({ role: 'button', name: 'Save' }), ctx)).toBe(false);
  });
  it('refuses submit buttons, external links and unnamed controls', () => {
    expect(isExplorerClickable(node({ role: 'button', name: 'Go', attributes: { type: 'submit' } }), ctx)).toBe(false);
    expect(isExplorerClickable(node({ role: 'link', name: 'Docs', attributes: { href: 'https://other.example/' } }), ctx)).toBe(false);
    expect(isExplorerClickable(node({ role: 'button', name: '' }), ctx)).toBe(false);
  });
  it('keeps the crawler\'s safe-reveal verdicts (openers, menus)', () => {
    expect(isExplorerClickable(node({ role: 'button', name: 'New Test' }), ctx)).toBe(true);
    expect(isExplorerClickable(node({ role: 'button', name: 'File', attributes: { 'aria-haspopup': 'menu' } }), ctx)).toBe(true);
  });
});

describe('parseAction', () => {
  it('accepts the five moves and rejects everything else', () => {
    expect(parseAction({ action: 'click', control: 3 })).toEqual({ action: 'click', control: 3, why: undefined });
    expect(parseAction({ action: 'record', name: 'Runs', purpose: 'see runs', claims: ['x', 2] }))
      .toEqual({ action: 'record', name: 'Runs', purpose: 'see runs', claims: ['x'], why: undefined });
    expect(parseAction({ action: 'done' })?.action).toBe('done');
    expect(parseAction({ action: 'click', control: 'three' })).toBeNull();
    expect(parseAction({ action: 'delete' })).toBeNull();
    expect(parseAction(null)).toBeNull();
  });
});

// ─── the loop, against a scripted SPA ────────────────────────────────────────

type View = 'tests' | 'runs';

function makeStack() {
  let view: View = 'tests';
  const currentUrl = 'http://app.local/tests';
  const surveys: Record<View, CandidateNode[]> = {
    tests: [
      node({ role: 'button', name: 'Runs', attributes: { 'nav-context': 'aside' } }),
      node({ role: 'button', name: 'Delete suite' }),
      node({ role: 'button', name: 'New Test' }),
    ],
    runs: [
      node({ role: 'button', name: 'Runs', attributes: { 'nav-context': 'aside', 'aria-current': 'page' } }),
      node({ role: 'button', name: 'Rerun failed' }),
      node({ role: 'button', name: 'Filter by status' }),
    ],
  };
  const page = {
    url: () => currentUrl,
    goto: async () => { view = 'tests'; },
    evaluate: async (fn: (...args: unknown[]) => unknown) => {
      const src = fn.toString();
      if (src.includes('password')) {
        return {
          title: 'Kaizen', headings: view === 'runs' ? ['Runs'] : ['Tests'],
          hasVisiblePasswordInput: false, pageText: view === 'runs' ? 'Runs of your tests' : 'Your tests',
        };
      }
      if (src.includes('a[href]')) return [];
      return [];
    },
    waitForTimeout: async () => {},
    waitForLoadState: async () => {},
    keyboard: { press: async () => {} },
    on: jest.fn(),
    locator: (sel: string) => ({
      first: () => ({
        count: async () => (sel === '#runs' || sel === '#delete-suite' ? 1 : 0),
        click: async () => { if (sel === '#runs') view = 'runs'; },
      }),
    }),
    getByRole: (_role: string, opts: { name: string }) => ({
      first: () => ({ click: async () => { if (opts.name === 'Runs') view = 'runs'; } }),
    }),
  };
  const context = {
    on: jest.fn(), addInitScript: async () => {}, newPage: async () => page, close: jest.fn(async () => {}),
  };
  const browser = { newContext: async () => context };
  const release = jest.fn(async () => {});
  const pool = { acquire: async () => browser, release } as unknown as BrowserPool;
  const surveyor = { survey: async () => surveys[view] };
  return { pool, surveyor, release, context };
}

function scriptedGateway(moves: ExploreAction[]): ITestWriterGateway & { inputs: unknown[] } {
  const inputs: unknown[] = [];
  let i = 0;
  return {
    inputs,
    exploreStep: async (input: unknown) => { inputs.push(input); return moves[Math.min(i++, moves.length - 1)]; },
  } as unknown as ITestWriterGateway & { inputs: unknown[] };
}

describe('Explorer loop', () => {
  it('clicks where the model says, records the view as a screen with its reach recipe, refuses the unsafe click', async () => {
    const stack = makeStack();
    const gateway = scriptedGateway([
      { action: 'click', control: 1 },                    // Delete suite — refused by the gate
      { action: 'click', control: 0 },                    // Runs — allowed
      { action: 'record', name: 'Runs', purpose: 'review test runs', claims: ['lists runs'] },
      { action: 'record', name: 'Runs again', purpose: 'dup', claims: [] },   // identical view — refused
      { action: 'done' },
    ]);
    const explorer = new Explorer({
      pool: stack.pool, surveyor: stack.surveyor, challenges: { detect: async () => null }, obs, gateway,
    });
    const captures: PageCapture[] = [];
    const report = await explorer.explore({
      tenantId: 't', jobId: 'j', targetUrl: 'http://app.local/tests', startUrl: 'http://app.local/tests',
      budgets: DEFAULT_BUDGETS, appSummary: 'a test app', tenantBrief: null,
      maxTurns: 10, maxScreens: 5, knownHashes: new Set(), knownUrls: new Set(['http://app.local/tests']),
    }, async (capture) => { captures.push(capture); });

    expect(report.endedBy).toBe('done');
    expect(report.clicksRefused).toBe(1);
    expect(report.clicksMade).toBe(1);
    expect(report.screensRecorded).toBe(1);
    expect(report.recordsRefused).toBe(1);
    expect(captures).toHaveLength(1);
    expect(captures[0].urlNormalized).toBe('http://app.local/tests#screen=runs');
    expect(captures[0].reachedBy).toMatchObject([{ role: 'button', name: 'Runs' }]);
    expect(captures[0].headings).toEqual(['Runs']);
    expect(report.knowledge[0]).toMatchObject({ name: 'Runs', claims: ['lists runs'] });
    expect(stack.release).toHaveBeenCalled();

    // The refused click was reported back to the model on the next turn.
    const second = gateway.inputs[1] as { lastResult: string };
    expect(second.lastResult).toContain('not clickable');
  });

  it('refuses to record a URL page the crawler already captured', async () => {
    const stack = makeStack();
    const gateway = scriptedGateway([
      { action: 'record', name: 'Tests', purpose: 'the tests page', claims: [] },
      { action: 'done' },
    ]);
    const explorer = new Explorer({
      pool: stack.pool, surveyor: stack.surveyor, challenges: { detect: async () => null }, obs, gateway,
    });
    const captures: PageCapture[] = [];
    const report = await explorer.explore({
      tenantId: 't', jobId: 'j', targetUrl: 'http://app.local/tests', startUrl: 'http://app.local/tests',
      budgets: DEFAULT_BUDGETS, appSummary: 'a test app', tenantBrief: null,
      maxTurns: 10, maxScreens: 5, knownHashes: new Set(), knownUrls: new Set(['http://app.local/tests']),
    }, async (capture) => { captures.push(capture); });
    expect(captures).toHaveLength(0);
    expect(report.recordsRefused).toBe(1);
  });

  it('stops at the turn budget and reports it', async () => {
    const stack = makeStack();
    const gateway = scriptedGateway([{ action: 'home' }]);
    const explorer = new Explorer({
      pool: stack.pool, surveyor: stack.surveyor, challenges: { detect: async () => null }, obs, gateway,
    });
    const report = await explorer.explore({
      tenantId: 't', jobId: 'j', targetUrl: 'http://app.local/tests', startUrl: 'http://app.local/tests',
      budgets: DEFAULT_BUDGETS, appSummary: 'a test app', tenantBrief: null,
      maxTurns: 3, maxScreens: 5, knownHashes: new Set(), knownUrls: new Set(),
    }, async () => {});
    expect(report.turns).toBe(3);
    expect(report.endedBy).toBe('turns');
  });
});
