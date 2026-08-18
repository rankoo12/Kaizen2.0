import { repertoireScenarios } from '../plan/repertoire';
import { applyBriefExclusions, isIndexPage, batchDossiers, knownAccounts } from '../plan/dossier';
import { TestPlanner, sameTest } from '../plan/test-planner';
import type { ITestWriterGateway } from '../../llm-gateway/testwriter.interfaces';
import type { IObservability } from '../../observability/interfaces';
import type { PageDossier, PlanBatchInput, PlannedScenario, TenantBrief } from '../../../types/test-writer';

/**
 * Spec: docs/specs/test-writer/spec-planner-per-page.md
 *
 * The planner plans PAGES: each from its dossier, the shape repertoire first
 * and for free, the brief's cautions as exclusions, the budget spread across
 * pages rather than piled on the first few.
 */

const BASE = 'https://demo.test';
function page(path: string, elements: PageDossier['elements'], extra: Partial<PageDossier> = {}): PageDossier {
  return {
    url: `${BASE}${path}`, urlNormalized: `${BASE}${path.replace(/\/$/, '') || ''}`,
    title: path, headings: [], pageText: '', purpose: '', capabilities: [],
    elements, forms: [], requiresAuth: false, ...extra,
  };
}
const link = (name: string, opensNewTab = false) => ({ role: 'link', name, kind: 'link', ...(opensNewTab ? { opensNewTab } : {}) });

const brief: TenantBrief = {
  purpose: 'demo', roles: [], criticalFlows: [], businessRules: [], priorities: [],
  cautions: [
    'Skip /basic_auth and /digest_auth until site credentials are configured.',
    '/download and /upload involve files; skip them.',
    '/slow takes several seconds — any test there needs an explicit wait.',
  ],
};

describe('applyBriefExclusions', () => {
  it('excludes the pages a caution tells Kaizen to skip, and records why', () => {
    const pages = [page('/basic_auth', []), page('/download', []), page('/slow', []), page('/login', [])];
    const out = applyBriefExclusions(pages, brief);
    expect(out.find((p) => p.urlNormalized.endsWith('/basic_auth'))?.excludedBy).toMatch(/Skip \/basic_auth/);
    expect(out.find((p) => p.urlNormalized.endsWith('/download'))?.excludedBy).toMatch(/skip them/);
    // Advice about a page is not a ban on it.
    expect(out.find((p) => p.urlNormalized.endsWith('/slow'))?.excludedBy).toBeUndefined();
    expect(out.find((p) => p.urlNormalized.endsWith('/login'))?.excludedBy).toBeUndefined();
  });
});

describe('isIndexPage', () => {
  it('calls the home page an index — many distinct links, nothing else', () => {
    const home = page('/', ['A/B Testing', 'Add/Remove', 'Checkboxes', 'Dropdown', 'Hovers', 'Inputs', 'Login', 'Tables', 'Typos'].map((n) => link(n)));
    expect(isIndexPage(home)).toBe(true);
  });
  it('does not call a data table an index — many IDENTICAL links is rows, not a table of contents', () => {
    const table = page('/tables', ['edit', 'delete', 'edit', 'delete', 'edit', 'delete', 'edit', 'delete', 'Last Name', 'Due'].map((n) => link(n)));
    expect(isIndexPage(table)).toBe(false);
  });
  it('does not call a page with any control besides links an index', () => {
    const p = page('/x', [...Array.from({ length: 9 }, (_, i) => link(`Page ${i}`)), { role: 'button', name: 'Go', kind: 'button' }]);
    expect(isIndexPage(p)).toBe(false);
  });
});

describe('repertoireScenarios — tests written without reading a word', () => {
  it('toggles a checkbox, chooses from a dropdown, follows a new-tab link', () => {
    const pages = [
      page('/checkboxes', [{ role: 'checkbox', name: 'checkbox 1', kind: 'input' }]),
      page('/dropdown', [{ role: 'combobox', name: 'dropdown list', kind: 'select' }]),
      page('/windows', [link('Click Here', true)]),
    ];
    const out = repertoireScenarios(pages, brief);
    expect(out.map((s) => s.source.kind === 'repertoire' ? s.source.ruleKey : '?')).toEqual([
      'shape.checkbox-toggle', 'shape.select-option', 'shape.new-tab-link',
    ]);
    // Every one states what it expects to see — the half of a plan PLAN used to omit.
    for (const s of out) expect(s.expectedOutcome).toBeTruthy();
    expect(out[0].targetPages).toEqual([`${BASE}/checkboxes`]);
  });

  it('plans the login negatives for a form with a PASSWORD FIELD, not one that merely says "password"', () => {
    const login = page('/login', [{ role: 'button', name: 'Login', kind: 'button' }], { forms: ['login form: Username, Password, [Login]'] });
    const forgot = page('/forgot_password', [{ role: 'button', name: 'Retrieve password', kind: 'button' }], { forms: ['form: E-mail, [Retrieve password]'] });
    const out = repertoireScenarios([login, forgot], brief);
    expect(out.map((s) => s.name)).toEqual([
      'Sign-in rejects a wrong username on /login',
      'Sign-in rejects a wrong password on /login',
    ]);
  });

  it('plans nothing for an excluded page', () => {
    const p = { ...page('/download', [{ role: 'checkbox', name: 'x', kind: 'input' }]), excludedBy: 'skip' };
    expect(repertoireScenarios([p], brief)).toEqual([]);
  });
});

describe('batchDossiers', () => {
  it('splits into batches of the given size, keeping order', () => {
    const pages = Array.from({ length: 13 }, (_, i) => page(`/p${i}`, []));
    const batches = batchDossiers(pages, 6);
    expect(batches.map((b) => b.length)).toEqual([6, 6, 1]);
    expect(batches[2][0].url).toBe(`${BASE}/p12`);
  });
});

describe('TestPlanner.planPages', () => {
  const obs: IObservability = { log: jest.fn(), increment: jest.fn(), histogram: jest.fn(), gauge: jest.fn() } as unknown as IObservability;

  it('spreads the budget across pages instead of piling it on the first few', async () => {
    // The model returns three scenarios for /a and three for /b; the budget is 4.
    const planPageBatch = jest.fn(async (): Promise<PlannedScenario[]> => [
      ...['a1', 'a2', 'a3'].map((n) => ({ name: n, targetPages: [`${BASE}/a`], kind: 'happy' as const, priority: 'normal' as const, rationale: '', outline: '', expectedOutcome: 'x', journey: null, source: { kind: 'llm' as const } })),
      ...['b1', 'b2', 'b3'].map((n) => ({ name: n, targetPages: [`${BASE}/b`], kind: 'happy' as const, priority: 'normal' as const, rationale: '', outline: '', expectedOutcome: 'y', journey: null, source: { kind: 'llm' as const } })),
    ]);
    const planner = new TestPlanner({ planPageBatch } as unknown as ITestWriterGateway, obs);
    const result = await planner.planPages({
      tenantId: 't', appSummary: 's', tenantBrief: null,
      pages: [page('/a', [{ role: 'button', name: 'Go', kind: 'button' }]), page('/b', [{ role: 'button', name: 'Go', kind: 'button' }])],
      existingCaseNames: [], scope: 'public', syntheticDataConsent: true, maxScenarios: 4,
    });
    expect(result.scenarios.map((s) => s.name)).toEqual(['a1', 'b1', 'a2', 'b2']);
    expect(result.dropped.filter((d) => d.reason === 'over the requested budget')).toHaveLength(2);
    expect(result.pagesPlannedFor).toBe(2);
  });

  it('drops what the model plans against an index page or an excluded page', async () => {
    const planPageBatch = jest.fn(async (): Promise<PlannedScenario[]> => [
      { name: 'home smoke', targetPages: [`${BASE}/`], kind: 'happy', priority: 'normal', rationale: '', outline: '', journey: null, source: { kind: 'llm' } },
      { name: 'dl', targetPages: [`${BASE}/download`], kind: 'happy', priority: 'normal', rationale: '', outline: '', journey: null, source: { kind: 'llm' } },
      { name: 'ok', targetPages: [`${BASE}/inputs`], kind: 'happy', priority: 'normal', rationale: '', outline: '', journey: null, source: { kind: 'llm' } },
    ]);
    const planner = new TestPlanner({ planPageBatch } as unknown as ITestWriterGateway, obs);
    const home = page('/', ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'].map((n) => link(n)));
    const result = await planner.planPages({
      tenantId: 't', appSummary: 's', tenantBrief: brief,
      pages: [home, page('/download', [{ role: 'link', name: 'file', kind: 'link' }]), page('/inputs', [{ role: 'textbox', name: 'n', kind: 'input' }])],
      existingCaseNames: [], scope: 'public', syntheticDataConsent: true, maxScenarios: 10,
    });
    expect(result.scenarios.map((s) => s.name)).toEqual(['ok']);
    expect(result.dropped.map((d) => d.reason)).toEqual(expect.arrayContaining([
      expect.stringMatching(/index page/), expect.stringMatching(/excluded by your brief/),
    ]));
    expect(result.pagesExcludedByBrief).toEqual([`${BASE}/download`]);
    expect(result.pagesSkippedAsIndex).toEqual([`${BASE}`]);
  });

  it('on a fill round, sends only the ledger pages and skips the repertoire', async () => {
    const planPageBatch = jest.fn(async (_input: PlanBatchInput): Promise<PlannedScenario[]> => []);
    const planner = new TestPlanner({ planPageBatch } as unknown as ITestWriterGateway, obs);
    await planner.planPages({
      tenantId: 't', appSummary: 's', tenantBrief: null,
      pages: [page('/checkboxes', [{ role: 'checkbox', name: 'c1', kind: 'input' }])],
      existingCaseNames: [], scope: 'public', syntheticDataConsent: true, maxScenarios: 5,
      ledger: [{ page: `${BASE}/checkboxes`, delivered: ['Toggle it'], rejected: [{ name: 'x', reason: 'weak' }] }],
    });
    const input = planPageBatch.mock.calls[0][0];
    expect(input.repertoire).toEqual([]);
    expect(input.ledger).toHaveLength(1);
  });
});

describe('knownAccounts', () => {
  it('reads a username/password pair the brief names, and nothing it does not', () => {
    const b: TenantBrief = { ...brief, roles: ['Anonymous visitor. One signed-in user on /login: username "tomsmith", password "SuperSecretPassword!".'] };
    expect(knownAccounts(b)).toEqual(['username "tomsmith", password "SuperSecretPassword!"']);
    expect(knownAccounts({ ...brief, roles: ['Anonymous visitor only'] })).toEqual([]);
    expect(knownAccounts(null)).toEqual([]);
  });
});

describe('sameTest — a differently-worded twin is the same test', () => {
  it('matches the shapes the fill rounds actually produced', () => {
    expect(sameTest('Toggle the "checkbox 1" checkbox on /checkboxes', 'Toggle checkbox 1 state')).toBe(true);
    expect(sameTest('Drag element A to element B', 'Drag element A to position of element B')).toBe(true);
    expect(sameTest('hover over each user avatar', 'Hover over avatar to reveal additional information')).toBe(true);
  });
  it('lets a genuinely different test through', () => {
    expect(sameTest('Sign-in rejects a wrong username', 'Sign-in rejects a wrong password')).toBe(false);
    expect(sameTest('Toggle checkbox 1', 'Toggle checkbox 2')).toBe(false);
    expect(sameTest('Add Element creates a Delete button', 'Delete button removes itself')).toBe(false);
  });
});
