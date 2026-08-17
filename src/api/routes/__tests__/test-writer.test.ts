import Fastify from 'fastify';
import { testWriterRoutes } from '../test-writer';
import { getPool } from '../../../db/pool';
import { withTenantTransaction } from '../../../db/transaction';

jest.mock('../../../db/pool', () => ({ getPool: jest.fn() }));
jest.mock('../../../db/transaction', () => ({ withTenantTransaction: jest.fn() }));
jest.mock('../../middleware/auth', () => ({
  requireAuth: jest.fn((request: Record<string, unknown>, _reply: unknown, done: () => void) => {
    request.tenantId = 'tenant-1';
    request.userId = 'user-1';
    request.role = 'owner';
    done();
  }),
}));
jest.mock('../../../modules/billing-meter/usage', () => ({ usageThisMonth: jest.fn() }));
jest.mock('../../../modules/llm-gateway/testwriter.gateway');
jest.mock('../../../modules/billing-meter/postgres.billing-meter');
jest.mock('../../../modules/observability/pino.observability');

const queueAdd = jest.fn();
jest.mock('../../../queue', () => ({
  createTestWriterQueue: jest.fn(() => ({ add: queueAdd })),
}));

/**
 * The plan checkpoint is the product's one blocking gate, so what happens at it
 * is worth asserting: which scenarios go forward, and — new — which ones a human
 * turned down. Without the second, a scenario someone looked at and rejected is
 * indistinguishable from one that was never planned.
 * Spec: docs/specs/tests-ux/spec-testwriter-ux.md §11.6-c
 */
describe('testWriterRoutes - POST /testwriter/jobs/:jobId/plan-approval', () => {
  let app: ReturnType<typeof Fastify>;
  let mockQuery: jest.Mock;

  const JOB = {
    status: 'awaiting_plan_approval',
    suite_id: 'suite-1',
    target_url: 'https://acme.test/',
    scope: 'public',
    auth_consent: false,
    login_case_id: null,
    options: { maxPages: 30 },
    test_plan: { scenarios: [{ name: 'Add to cart' }, { name: 'Search works' }, { name: 'Signup' }] },
  };

  beforeAll(async () => {
    app = Fastify();
    app.decorateRequest('tenantId', '');
    app.decorateRequest('userId', '');
    app.decorateRequest('role', '');
    await app.register(testWriterRoutes);
  });

  beforeEach(() => {
    mockQuery = jest.fn().mockImplementation((sql: string) => {
      if (/FROM generation_jobs/.test(sql)) return Promise.resolve({ rows: [JOB] });
      return Promise.resolve({ rows: [] });
    });
    (getPool as jest.Mock).mockReturnValue({ query: mockQuery });
    (withTenantTransaction as jest.Mock).mockImplementation(
      async (_t: string, cb: (c: unknown) => unknown) => cb({ query: mockQuery }),
    );
  });

  afterEach(() => jest.clearAllMocks());
  afterAll(async () => { await app.close(); });

  /** The UPDATE's `declined` payload, as the route serialized it. */
  function declinedPayload(): Array<{ name: string; reason: string }> | null {
    const call = mockQuery.mock.calls.find((c) => /SET plan_approved_at/.test(String(c[0])));
    return call ? JSON.parse(call[1][2]) : null;
  }

  it('records the scenarios the user unchecked', async () => {
    const res = await app.inject({
      method: 'POST', url: '/testwriter/jobs/job-1/plan-approval',
      payload: { approvedScenarios: ['Add to cart'] },
    });

    expect(res.statusCode).toBe(202);
    expect(res.json().approved).toBe(1);
    expect(declinedPayload()).toEqual([
      { name: 'Search works', reason: 'user_deselected' },
      { name: 'Signup', reason: 'user_deselected' },
    ]);
  });

  it('records nothing as declined when everything was approved', async () => {
    await app.inject({
      method: 'POST', url: '/testwriter/jobs/job-1/plan-approval',
      payload: { approvedScenarios: ['Add to cart', 'Search works', 'Signup'] },
    });
    expect(declinedPayload()).toEqual([]);
  });

  it('records the whole plan as declined when it is discarded', async () => {
    // An explicit empty array is "I want none of this" — the one case where the
    // provenance is the entire record of what happened.
    const res = await app.inject({
      method: 'POST', url: '/testwriter/jobs/job-1/plan-approval',
      payload: { approvedScenarios: [] },
    });
    expect(res.statusCode).toBe(202);
    expect(declinedPayload()).toHaveLength(3);
  });

  it('merges declined into report.plan without discarding the rest of the report', async () => {
    await app.inject({
      method: 'POST', url: '/testwriter/jobs/job-1/plan-approval',
      payload: { approvedScenarios: ['Add to cart'] },
    });
    const sql = String(mockQuery.mock.calls.find(
      (c) => /SET plan_approved_at/.test(String(c[0])))![0]).replace(/\s+/g, ' ');
    // Concatenation onto the existing objects, not assignment over them: recon,
    // comprehend and findings are already in there when the user approves.
    expect(sql).toMatch(/COALESCE\(report, '\{\}'::jsonb\)\s*\|\|/);
    expect(sql).toMatch(/COALESCE\(report->'plan', '\{\}'::jsonb\)\s*\|\|/);
  });

  it('ignores names that are not in this job\'s plan', async () => {
    const res = await app.inject({
      method: 'POST', url: '/testwriter/jobs/job-1/plan-approval',
      payload: { approvedScenarios: ['Add to cart', 'Something invented'] },
    });
    expect(res.json().approved).toBe(1);
    expect(queueAdd).toHaveBeenCalledWith('testwriter', expect.objectContaining({
      approvedScenarios: ['Add to cart'],
    }));
    // The invented name must not appear as something the user declined either.
    expect(declinedPayload()!.map((d) => d.name)).toEqual(['Search works', 'Signup']);
  });

  it('refuses a job that is not at the checkpoint', async () => {
    mockQuery.mockImplementation((sql: string) =>
      /FROM generation_jobs/.test(sql)
        ? Promise.resolve({ rows: [{ ...JOB, status: 'running' }] })
        : Promise.resolve({ rows: [] }));

    const res = await app.inject({
      method: 'POST', url: '/testwriter/jobs/job-1/plan-approval',
      payload: { approvedScenarios: ['Add to cart'] },
    });
    expect(res.statusCode).toBe(409);
    expect(queueAdd).not.toHaveBeenCalled();
  });
});

/**
 * Coverage's guard, not its arithmetic.
 *
 * The number is the least important thing this endpoint returns. What matters
 * is that it refuses to produce one when the crawl behind it saw too little —
 * "1 of 1 covered" off a one-page crawl of an SPA behind robots.txt is worse
 * than silence, because a ratio a user half-reads is remembered as a ratio.
 * The UI leans on this flag to decide whether to print anything at all.
 * Spec: docs/specs/test-writer/spec-findings-and-coverage.md §4, §3.2
 */
describe('testWriterRoutes - GET /suites/:suiteId/coverage', () => {
  let app: ReturnType<typeof Fastify>;
  let mockQuery: jest.Mock;

  const page = (url: string, cases: number, auth = false) => ({
    url_normalized: url, purpose_tag: 'listing', requires_auth: auth, case_count: String(cases),
  });

  /** Wires the three reads the route makes: suite lookup, pages, last job. */
  function withModel(pages: unknown[], lastJob: unknown) {
    mockQuery.mockImplementation((sql: string) => {
      if (/FROM test_suites/.test(sql)) return Promise.resolve({ rows: [{ id: 'suite-1' }] });
      if (/FROM site_pages/.test(sql)) return Promise.resolve({ rows: pages });
      if (/FROM generation_jobs/.test(sql)) return Promise.resolve({ rows: lastJob ? [lastJob] : [] });
      return Promise.resolve({ rows: [] });
    });
  }

  beforeAll(async () => {
    app = Fastify();
    app.decorateRequest('tenantId', '');
    app.decorateRequest('userId', '');
    app.decorateRequest('role', '');
    await app.register(testWriterRoutes);
  });

  beforeEach(() => {
    mockQuery = jest.fn();
    (getPool as jest.Mock).mockReturnValue({ query: mockQuery });
    (withTenantTransaction as jest.Mock).mockImplementation(
      async (_t: string, cb: (c: unknown) => unknown) => cb({ query: mockQuery }),
    );
  });

  afterEach(() => jest.clearAllMocks());
  afterAll(async () => { await app.close(); });

  it('reports coverage when the crawl saw enough to judge', async () => {
    withModel(
      [page('https://a.test/', 1), page('https://a.test/x', 0), page('https://a.test/y', 2)],
      { blocked: false, pages_blocked: 0 },
    );
    const res = await app.inject({ method: 'GET', url: '/suites/suite-1/coverage' });
    expect(res.statusCode).toBe(200);
    const { coverage } = res.json();
    expect(coverage.summary).toEqual({ total: 3, tested: 2, untested: 1 });
    expect(coverage.coverageConfidence).toBe('observed');
    expect(coverage.confidenceReason).toBeNull();
  });

  it('refuses to judge a one-page crawl', async () => {
    // The case the guard exists for: a single page, fully "covered", which would
    // otherwise render as 100%.
    withModel([page('https://a.test/', 1)], { blocked: false, pages_blocked: 0 });
    const { coverage } = (await app.inject({ method: 'GET', url: '/suites/suite-1/coverage' })).json();
    expect(coverage.coverageConfidence).toBe('unknown');
    expect(coverage.confidenceReason).toMatch(/1 page/);
  });

  it('refuses to judge when the last analysis was blocked', async () => {
    withModel(
      [page('https://a.test/', 1), page('https://a.test/x', 1), page('https://a.test/y', 1)],
      { blocked: true, pages_blocked: 0 },
    );
    const { coverage } = (await app.inject({ method: 'GET', url: '/suites/suite-1/coverage' })).json();
    expect(coverage.coverageConfidence).toBe('unknown');
  });

  it('refuses to judge when pages were blocked mid-crawl', async () => {
    withModel(
      [page('https://a.test/', 1), page('https://a.test/x', 1), page('https://a.test/y', 1)],
      { blocked: false, pages_blocked: 4 },
    );
    const { coverage } = (await app.inject({ method: 'GET', url: '/suites/suite-1/coverage' })).json();
    expect(coverage.coverageConfidence).toBe('unknown');
  });

  it('marks pages behind sign-in, so the gap points somewhere', async () => {
    withModel(
      [page('https://a.test/', 1), page('https://a.test/acct', 0, true), page('https://a.test/y', 1)],
      { blocked: false, pages_blocked: 0 },
    );
    const { coverage } = (await app.inject({ method: 'GET', url: '/suites/suite-1/coverage' })).json();
    const behindAuth = coverage.pages.filter((p: { requiresAuth: boolean }) => p.requiresAuth);
    expect(behindAuth).toHaveLength(1);
    expect(behindAuth[0].tested).toBe(false);
  });

  it('404s a suite that is not the caller\'s', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    const res = await app.inject({ method: 'GET', url: '/suites/someone-elses/coverage' });
    expect(res.statusCode).toBe(404);
  });
});
