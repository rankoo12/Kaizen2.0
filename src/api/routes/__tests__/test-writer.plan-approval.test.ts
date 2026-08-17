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
