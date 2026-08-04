import Fastify from 'fastify';
import { testCasesRoutes } from '../test-cases';
import { getPool } from '../../../db/pool';
import { withTenantTransaction } from '../../../db/transaction';
import { usageThisMonth } from '../../../modules/billing-meter/usage';
import { LearnedCompiler } from '../../../modules/test-compiler/learned.compiler';

// Mock DB interactions
jest.mock('../../../db/pool', () => ({
  getPool: jest.fn(() => ({
    query: jest.fn()
  }))
}));
jest.mock('../../../db/transaction', () => ({
  withTenantTransaction: jest.fn()
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
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'case-1', suite_id: 'suite-1', base_url: 'http://test' }] });
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
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'case-1', suite_id: 'suite-1', base_url: 'http://test' }] });
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
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'case-1', suite_id: 'suite-1', base_url: 'http://test' }] });
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
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'case-1', suite_id: 'suite-1', base_url: 'http://test' }] });
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
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'case-1', suite_id: 'suite-1', base_url: 'http://test' }] });
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
