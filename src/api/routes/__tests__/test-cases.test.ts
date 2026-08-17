import Fastify from 'fastify';
import { testCasesRoutes } from '../test-cases';
import { getPool } from '../../../db/pool';
import { withTenantTransaction, tenantQuery, tenantPool } from '../../../db/transaction';
import { usageThisMonth } from '../../../modules/billing-meter/usage';
import { LearnedCompiler } from '../../../modules/test-compiler/learned.compiler';

// Mock DB interactions
jest.mock('../../../db/pool', () => ({
  getPool: jest.fn(() => ({
    query: jest.fn()
  }))
}));
// tenantQuery is a thin wrapper over withTenantTransaction; the mock mirrors that
// relationship so a route that switched to it exercises the same fake client.
jest.mock('../../../db/transaction', () => ({
  withTenantTransaction: jest.fn(),
  tenantQuery: jest.fn(),
  tenantPool: jest.fn(),
}));

// Mock Auth Middleware
jest.mock('../../middleware/auth', () => ({
  requireAuth: jest.fn((request, reply, done) => {
    request.tenantId = 'tenant-1';
    request.userId = 'user-1';
    done();
  })
}));

// Mock Usage Calculation
jest.mock('../../../modules/billing-meter/usage', () => ({
  usageThisMonth: jest.fn()
}));

// Mock Queue
jest.mock('../../../queue', () => ({
  createRunQueue: jest.fn(() => ({
    add: jest.fn()
  }))
}));

// Mock internal modules
jest.mock('../../../modules/test-compiler/learned.compiler');
jest.mock('../../../modules/llm-gateway/openai.gateway');
jest.mock('../../../modules/billing-meter/postgres.billing-meter');
jest.mock('../../../modules/observability/pino.observability');

describe('testCasesRoutes - Token Limit Enforcement', () => {
  let app: ReturnType<typeof Fastify>;
  let mockQuery: jest.Mock;

  beforeAll(async () => {
    app = Fastify();
    // Inject mock request decorators so TS is happy and middleware works
    app.decorateRequest('tenantId', '');
    app.decorateRequest('userId', '');
    
    await app.register(testCasesRoutes);
  });

  beforeEach(() => {
    mockQuery = jest.fn();
    (getPool as jest.Mock).mockReturnValue({ query: mockQuery });
    (withTenantTransaction as jest.Mock).mockImplementation(
      async (_tenantId, cb) => cb({ query: mockQuery })
    );
    (tenantQuery as jest.Mock).mockImplementation(
      async (_tenantId: string, sql: string, params?: unknown[]) => mockQuery(sql, params),
    );
    (tenantPool as jest.Mock).mockImplementation(() => ({ query: mockQuery }));
    // The automocked compiler returns undefined, which used to be harmless because
    // compiledSteps only ever reached the mocked queue. It now also supplies
    // runs.total_steps, so give it the shape the real compiler returns: one compiled
    // step per raw step. Set per-test — clearAllMocks() in afterEach resets it.
    (LearnedCompiler.prototype.compileMany as jest.Mock).mockImplementation(
      async (steps: string[]) => steps.map((raw) => ({ action: 'click', rawText: raw })),
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('enqueues successfully when usage is below budget', async () => {
    // 1st query inside withTenantTransaction for case/step fetching
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'case-1', suite_id: 'suite-1', base_url: 'http://test', status: 'active' }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ raw_text: 'click btn' }] });

    // 2nd query (budget check)
    mockQuery.mockResolvedValueOnce({ rows: [{ llm_budget_tokens_monthly: '5000' }] });
    
    // usage check mock
    (usageThisMonth as jest.Mock).mockResolvedValue(4999);
    
    // 3rd query (insert run)
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'run-1' }] });

    const response = await app.inject({
      method: 'POST',
      url: '/cases/case-1/run',
      payload: { baseUrl: 'http://test' }
    });

    expect(response.statusCode).toBe(202);
    expect(JSON.parse(response.payload)).toMatchObject({ status: 'queued', runId: 'run-1' });
  });

  it('stamps the run with its own step count so progress has a stable denominator', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'case-1', suite_id: 'suite-1', base_url: 'http://test', status: 'active' }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ raw_text: 'click btn' }, { raw_text: 'type hello' }, { raw_text: 'verify done' }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ llm_budget_tokens_monthly: '5000' }] });
    (usageThisMonth as jest.Mock).mockResolvedValue(0);
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'run-1' }] });

    const response = await app.inject({
      method: 'POST', url: '/cases/case-1/run', payload: { baseUrl: 'http://test' },
    });
    expect(response.statusCode).toBe(202);

    // total_steps must come from what this run compiled, not from the case — the case's
    // active steps can change mid-run now that tests are editable.
    // Spec: docs/specs/roadmap/spec-phase-0-plumbing.md §3
    const insert = mockQuery.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO runs'));
    expect(insert).toBeDefined();
    expect(String(insert![0])).toContain('total_steps');
    expect(insert![1]).toContain(3);
  });

  it('returns 402 TOKEN_LIMIT_REACHED when usage equals budget', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'case-1', suite_id: 'suite-1', base_url: 'http://test', status: 'active' }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ raw_text: 'click btn' }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ llm_budget_tokens_monthly: '5000' }] });
    
    (usageThisMonth as jest.Mock).mockResolvedValue(5000);

    const response = await app.inject({
      method: 'POST',
      url: '/cases/case-1/run',
    });

    expect(response.statusCode).toBe(402);
    expect(JSON.parse(response.payload)).toMatchObject({
      error: 'TOKEN_LIMIT_REACHED',
      message: 'Token limit reached (5,000). Used 5,000 this month.'
    });
  });

  it('returns 402 TOKEN_LIMIT_REACHED when usage exceeds budget', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'case-1', suite_id: 'suite-1', base_url: 'http://test', status: 'active' }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ raw_text: 'click btn' }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ llm_budget_tokens_monthly: '5000' }] });
    
    (usageThisMonth as jest.Mock).mockResolvedValue(5200);

    const response = await app.inject({
      method: 'POST',
      url: '/cases/case-1/run',
    });

    expect(response.statusCode).toBe(402);
    expect(JSON.parse(response.payload)).toMatchObject({
      error: 'TOKEN_LIMIT_REACHED',
      message: 'Token limit reached (5,000). Used 5,200 this month.'
    });
  });

  it('returns 402 INSUFFICIENT_TOKENS when budget is 0', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'case-1', suite_id: 'suite-1', base_url: 'http://test', status: 'active' }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ raw_text: 'click btn' }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ llm_budget_tokens_monthly: '0' }] });

    const response = await app.inject({
      method: 'POST',
      url: '/cases/case-1/run',
    });

    expect(response.statusCode).toBe(402);
    expect(JSON.parse(response.payload)).toMatchObject({
      error: 'INSUFFICIENT_TOKENS'
    });
  });

  // ── Draft lifecycle ────────────────────────────────────────────────────────
  // A draft is a proposal, not part of the suite's contract yet: it must not be
  // runnable, and it reaches 'active' only through an explicit acceptance.
  // Spec: docs/specs/tests-ux/spec-testwriter-ux.md §1, §5.2

  it('refuses to run a draft — it has not been accepted into the suite', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'case-1', suite_id: 'suite-1', base_url: 'http://test', status: 'draft' }],
    });
    mockQuery.mockResolvedValueOnce({ rows: [{ raw_text: 'click btn' }] });

    const response = await app.inject({ method: 'POST', url: '/cases/case-1/run' });

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.payload)).toMatchObject({ error: 'CASE_NOT_ACTIVE', status: 'draft' });
  });

  it('accepts a draft into the suite (draft → active)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ status: 'draft' }] });          // current status
    mockQuery.mockResolvedValueOnce({                                          // update
      rows: [{
        id: 'case-1', name: 'A test', base_url: 'http://test', suite_id: 'suite-1',
        status: 'active', created_at: new Date(), updated_at: new Date(),
      }],
    });
    mockQuery.mockResolvedValueOnce({ rows: [] });                             // steps

    const response = await app.inject({
      method: 'PATCH', url: '/cases/case-1', payload: { status: 'active' },
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.payload).case.status).toBe('active');
  });

  it('refuses to resurrect a rejected case into the suite', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ status: 'rejected' }] });

    const response = await app.inject({
      method: 'PATCH', url: '/cases/case-1', payload: { status: 'active' },
    });

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.payload)).toMatchObject({ error: 'INVALID_STATUS_TRANSITION' });
  });

  it('allows restoring an archived case back to draft (the accept-undo path)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ status: 'archived' }] });
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'case-1', name: 'A test', base_url: 'http://test', suite_id: 'suite-1',
        status: 'draft', created_at: new Date(), updated_at: new Date(),
      }],
    });
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const response = await app.inject({
      method: 'PATCH', url: '/cases/case-1', payload: { status: 'draft' },
    });

    expect(response.statusCode).toBe(200);
  });

  // Regression: DELETE used to remove test_steps while step_results still pointed at
  // them, so deleting any case that had ever run failed with a 23503 FK violation.
  // Evidence (healing_events -> step_results) has to be cleared before the steps.
  /** Answers the catalog probe the delete runs, so the test controls which schema the
   *  route believes it is on. Spec: spec-keys-quota-authorship.md §3 */
  function mockSchema({ testWriterPresent }: { testWriterPresent: boolean }) {
    mockQuery.mockImplementation(async (sql: string) => {
      const s = String(sql).replace(/\s+/g, ' ');
      if (/information_schema\.columns/.test(s)) {
        return { rows: [{ has_validation_col: testWriterPresent, has_generation_jobs: testWriterPresent }] };
      }
      if (/SELECT id FROM test_cases WHERE id/.test(s)) return { rows: [{ id: 'case-1' }] };
      return { rows: [] };
    });
  }

  it('deletes a case that has run history in FK-safe order', async () => {
    mockSchema({ testWriterPresent: true });

    const response = await app.inject({ method: 'DELETE', url: '/cases/case-1' });
    expect(response.statusCode).toBe(204);

    const sql = mockQuery.mock.calls.map((c) => String(c[0]).replace(/\s+/g, ' '));
    const at = (re: RegExp) => sql.findIndex((s) => re.test(s));

    const healing = at(/DELETE FROM healing_events/);
    const stepResults = at(/DELETE FROM step_results/);
    const runs = at(/DELETE FROM runs/);
    const caseSteps = at(/DELETE FROM test_case_steps/);
    const steps = at(/DELETE FROM test_steps/);
    const theCase = at(/DELETE FROM test_cases/);

    // -1 means the statement was never issued at all.
    expect({ healing, stepResults, runs, caseSteps, steps, theCase }).not.toEqual(
      expect.objectContaining({ healing: -1, stepResults: -1, runs: -1, caseSteps: -1, steps: -1, theCase: -1 }),
    );
    for (const i of [healing, stepResults, runs, caseSteps, steps, theCase]) {
      expect(i).toBeGreaterThan(-1);
    }
    expect(healing).toBeLessThan(stepResults);      // healing_events -> step_results
    expect(stepResults).toBeLessThan(steps);        // step_results  -> test_steps
    expect(stepResults).toBeLessThan(runs);         // step_results  -> runs
    expect(caseSteps).toBeLessThan(steps);          // test_case_steps -> test_steps
    expect(steps).toBeLessThan(theCase);            // test_steps    -> test_cases
    expect(runs).toBeLessThan(theCase);             // runs          -> test_cases

    // A run can be another case's validation run; that pointer must be released
    // before the runs go, or the delete trips validation_run_id's FK.
    const releaseValidation = at(/UPDATE test_cases SET validation_run_id = NULL/);
    expect(releaseValidation).toBeGreaterThan(-1);
    expect(releaseValidation).toBeLessThan(runs);
  });

  it('still deletes when the test-writer schema is absent', async () => {
    // The shape production has: 028_test_writer and 029_site_model live on an unmerged
    // branch, so validation_run_id and generation_jobs do not exist there. Referencing
    // either aborts the transaction, which made every delete 500 in production while
    // passing locally on machines that had the extra migrations.
    mockSchema({ testWriterPresent: false });

    const response = await app.inject({ method: 'DELETE', url: '/cases/case-1' });
    expect(response.statusCode).toBe(204);

    const sql = mockQuery.mock.calls.map((c) => String(c[0]).replace(/\s+/g, ' '));
    expect(sql.some((s) => /UPDATE test_cases SET validation_run_id/.test(s))).toBe(false);
    expect(sql.some((s) => /UPDATE generation_jobs/.test(s))).toBe(false);
    // The rest of the cascade must still happen — skipping is not the same as bailing out.
    expect(sql.some((s) => /DELETE FROM runs/.test(s))).toBe(true);
    expect(sql.some((s) => /DELETE FROM test_cases WHERE id/.test(s))).toBe(true);
  });
});

/**
 * The login-recipe picker's source. This is the first tenant-WIDE case read in
 * the API — every other listing is scoped by a suite the caller named — so the
 * isolation assertion here is doing real work, not ceremony.
 * Spec: docs/specs/test-writer/spec-authenticated-scope.md §10.5, §11.6
 */
describe('testCasesRoutes - GET /cases (tenant-wide login-recipe picker)', () => {
  let app: ReturnType<typeof Fastify>;
  let mockQuery: jest.Mock;

  const ROWS = [
    { id: 'c1', name: 'Sign in', base_url: 'https://app.acme.io/login', suite_id: 's1', suite_name: 'Base' },
    { id: 'c2', name: 'Checkout', base_url: 'https://shop.acme.io/', suite_id: 's2', suite_name: 'Shop' },
  ];

  beforeAll(async () => {
    app = Fastify();
    app.decorateRequest('tenantId', '');
    app.decorateRequest('userId', '');
    await app.register(testCasesRoutes);
  });

  beforeEach(() => {
    mockQuery = jest.fn().mockResolvedValue({ rows: ROWS });
    (getPool as jest.Mock).mockReturnValue({ query: mockQuery });
    (withTenantTransaction as jest.Mock).mockImplementation(
      async (_tenantId: string, cb: (c: unknown) => unknown) => cb({ query: mockQuery }),
    );
  });

  afterEach(() => jest.clearAllMocks());
  afterAll(async () => { await app.close(); });

  it('returns the tenant\'s active cases with their suite', async () => {
    const res = await app.inject({ method: 'GET', url: '/cases?status=active' });
    expect(res.statusCode).toBe(200);
    expect(res.json().cases).toEqual([
      { id: 'c1', name: 'Sign in', baseUrl: 'https://app.acme.io/login', suiteId: 's1', suiteName: 'Base' },
      { id: 'c2', name: 'Checkout', baseUrl: 'https://shop.acme.io/', suiteId: 's2', suiteName: 'Shop' },
    ]);
  });

  it('scopes every read to the caller\'s tenant and to active cases only', async () => {
    await app.inject({ method: 'GET', url: '/cases?status=active' });

    // The transaction wrapper is what applies tenant scoping; going around it
    // with a bare pool query is the mistake this asserts against.
    expect(withTenantTransaction).toHaveBeenCalledWith('tenant-1', expect.any(Function));
    const sql = String(mockQuery.mock.calls[0][0]).replace(/\s+/g, ' ');
    expect(sql).toMatch(/tc\.tenant_id = \$1/);
    expect(sql).toMatch(/tc\.status = 'active'/);
    expect(mockQuery.mock.calls[0][1]).toEqual(['tenant-1']);
  });

  it('rejects a status other than active', async () => {
    // A picker has no business reading drafts or archived tests, and a recipe
    // must be a case the tenant trusts — so the narrow query is the contract.
    const res = await app.inject({ method: 'GET', url: '/cases?status=draft' });
    expect(res.statusCode).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('filters by parsed origin, not by string prefix', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        ...ROWS,
        // The reason the comparison parses rather than matching prefixes.
        { id: 'c3', name: 'Evil', base_url: 'https://app.acme.io.evil.com/', suite_id: 's3', suite_name: 'X' },
      ],
    });
    const res = await app.inject({
      method: 'GET', url: '/cases?status=active&origin=' + encodeURIComponent('https://app.acme.io'),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().cases.map((c: { id: string }) => c.id)).toEqual(['c1']);
  });

  it('400s on an unparseable origin rather than guessing', async () => {
    const res = await app.inject({ method: 'GET', url: '/cases?status=active&origin=not-a-url' });
    expect(res.statusCode).toBe(400);
  });

  it('survives a row whose base_url is not a URL', async () => {
    mockQuery.mockResolvedValue({
      rows: [{ id: 'c9', name: 'Odd', base_url: 'about:blank', suite_id: 's1', suite_name: 'Base' }],
    });
    const res = await app.inject({
      method: 'GET', url: '/cases?status=active&origin=' + encodeURIComponent('https://app.acme.io'),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().cases).toEqual([]);
  });
});

// Spec: docs/specs/tests-ux/spec-run-suite.md
describe('testCasesRoutes - POST /suites/:suiteId/run', () => {
  let app: ReturnType<typeof Fastify>;
  let mockQuery: jest.Mock;
  let mockAdd: jest.Mock;

  beforeAll(async () => {
    app = Fastify();
    app.decorateRequest('tenantId', '');
    app.decorateRequest('userId', '');
    await app.register(testCasesRoutes);
  });

  beforeEach(() => {
    mockQuery = jest.fn();
    mockAdd = jest.fn();
    (getPool as jest.Mock).mockReturnValue({ query: mockQuery });
    (withTenantTransaction as jest.Mock).mockImplementation(async (_t, cb) => cb({ query: mockQuery }));
    (tenantQuery as jest.Mock).mockImplementation(
      async (_t: string, sql: string, params?: unknown[]) => mockQuery(sql, params),
    );
    (tenantPool as jest.Mock).mockImplementation(() => ({ query: mockQuery }));
    (LearnedCompiler.prototype.compile as jest.Mock).mockImplementation(
      async (raw: string) => ({ action: 'click', rawText: raw }),
    );
    (usageThisMonth as jest.Mock).mockResolvedValue(0);
  });

  afterEach(() => jest.clearAllMocks());

  /** Routes SQL by shape rather than by call order, so the per-case fetch loop
   *  reads naturally regardless of how many cases the suite holds. */
  function wireDb(opts: {
    suite?: boolean; cases: Array<{ id: string; name: string; status: string }>; budget?: string;
  }) {
    let runSeq = 0;
    mockQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
      const s = String(sql);
      if (s.includes('FROM test_suites')) return { rows: opts.suite === false ? [] : [{ id: 'suite-1' }] };
      if (s.includes('FROM test_cases') && s.includes('suite_id = $1')) return { rows: opts.cases };
      if (s.includes('FROM test_cases WHERE id = $1')) {
        const c = opts.cases.find((x) => x.id === params?.[0]);
        return { rows: c ? [{ id: c.id, suite_id: 'suite-1', base_url: 'http://t', status: c.status }] : [] };
      }
      if (s.includes('FROM test_case_steps')) return { rows: [{ id: 'st-1', raw_text: 'click x', compiled_ast: null }] };
      if (s.includes('llm_budget_tokens_monthly')) return { rows: [{ llm_budget_tokens_monthly: opts.budget ?? '5000' }] };
      if (s.includes('INSERT INTO runs')) return { rows: [{ id: `run-${++runSeq}` }] };
      throw new Error(`unexpected sql: ${s}`);
    });
  }

  it('queues one run per active case and reports drafts as skipped, not run', async () => {
    wireDb({ cases: [
      { id: 'c1', name: 'A', status: 'active' },
      { id: 'c2', name: 'B (draft)', status: 'draft' },
      { id: 'c3', name: 'C', status: 'active' },
    ] });
    const { createRunQueue } = jest.requireMock('../../../queue');
    (createRunQueue as jest.Mock).mock.results.forEach((r) => { r.value.add = mockAdd; });

    const res = await app.inject({ method: 'POST', url: '/suites/suite-1/run' });
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.queued.map((q: { caseId: string }) => q.caseId)).toEqual(['c1', 'c3']);
    expect(body.skipped).toEqual([{ caseId: 'c2', name: 'B (draft)', reason: expect.stringContaining('draft') }]);
    expect(mockAdd).toHaveBeenCalledTimes(2);
    // Every enqueued job carries the case's tenant — never a body-supplied one.
    for (const [, payload] of mockAdd.mock.calls) expect(payload.tenantId).toBe('tenant-1');
  });

  it('refuses the whole suite before queueing anything when the budget is spent', async () => {
    wireDb({ cases: [{ id: 'c1', name: 'A', status: 'active' }], budget: '100' });
    (usageThisMonth as jest.Mock).mockResolvedValue(100);
    const { createRunQueue } = jest.requireMock('../../../queue');
    (createRunQueue as jest.Mock).mock.results.forEach((r) => { r.value.add = mockAdd; });

    const res = await app.inject({ method: 'POST', url: '/suites/suite-1/run' });
    expect(res.statusCode).toBe(402);
    expect(res.json().error).toBe('TOKEN_LIMIT_REACHED');
    expect(mockAdd).not.toHaveBeenCalled();
    expect(mockQuery.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO runs'))).toBe(false);
  });

  it('400s when every test is still a draft, and says so', async () => {
    wireDb({ cases: [{ id: 'c2', name: 'B', status: 'draft' }] });
    const res = await app.inject({ method: 'POST', url: '/suites/suite-1/run' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'NO_RUNNABLE_CASES', message: expect.stringContaining('draft') });
  });

  it('404s on a suite that is not this tenant\'s — the lookup carries tenant_id', async () => {
    wireDb({ suite: false, cases: [] });
    const res = await app.inject({ method: 'POST', url: '/suites/other/run' });
    expect(res.statusCode).toBe(404);
    const lookup = mockQuery.mock.calls.find(([sql]) => String(sql).includes('FROM test_suites'));
    expect(String(lookup![0])).toContain('tenant_id = $2');
    expect(lookup![1]).toContain('tenant-1');
  });
});
