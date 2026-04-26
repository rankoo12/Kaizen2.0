import Fastify from 'fastify';
import { testCasesRoutes } from '../test-cases';
import { getPool } from '../../../db/pool';
import { withTenantTransaction } from '../../../db/transaction';
import { usageThisMonth } from '../../../modules/billing-meter/usage';

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
});
