import Fastify from 'fastify';
import { createHash } from 'crypto';
import { runsRoutes } from '../runs';
import { getPool } from '../../../db/pool';

// ── Mocks ─────────────────────────────────────────────────────────────────────

jest.mock('../../../db/pool', () => ({
  getPool: jest.fn(() => ({ query: jest.fn() })),
}));
// Tenant helpers route to the pool mock above — see src/db/__mocks__/transaction.ts
jest.mock('../../../db/transaction');

// Auth middleware — every guard authenticates as tenant-1 and passes through, so
// these tests exercise the route's own tenant-scoping / authorization logic.
jest.mock('../../middleware/auth', () => ({
  requireAuth:    jest.fn((req: any, _reply: any, done: any) => { req.tenantId = 'tenant-1'; req.userId = 'user-1'; done(); }),
  requireTenant:  jest.fn((req: any, _reply: any, done: any) => { req.tenantId = 'tenant-1'; done(); }),
  requireApiKey:  jest.fn((req: any, _reply: any, done: any) => { req.tenantId = 'tenant-1'; req.keyScope = 'execute'; done(); }),
  requireScope:   jest.fn(() => (_req: any, _reply: any, done: any) => done()),
}));

jest.mock('ioredis', () => ({
  Redis: jest.fn().mockImplementation(() => ({
    setex: jest.fn(), del: jest.fn(), get: jest.fn(),
    scan: jest.fn(async () => ['0', []]),
  })),
}));

jest.mock('../../../modules/media/screenshot.service', () => ({
  ScreenshotService: jest.fn().mockImplementation(() => ({
    download: jest.fn(async () => Buffer.from('fake-png-bytes')),
  })),
}));

jest.mock('../../../queue', () => ({
  createRunQueue: jest.fn(() => ({ add: jest.fn() })),
}));
jest.mock('../../../modules/test-compiler/learned.compiler');
jest.mock('../../../modules/llm-gateway/openai.gateway');
jest.mock('../../../modules/billing-meter/postgres.billing-meter');
jest.mock('../../../modules/billing-meter/usage', () => ({ usageThisMonth: jest.fn() }));
jest.mock('../../../modules/observability/pino.observability');

const OWNED_KEY = 'gs://kaizen-screenshots/tenant-1/run-9/0/after.png';

describe('runsRoutes — GET /media (auth, tenant scoping, caching)', () => {
  let app: ReturnType<typeof Fastify>;
  let mockQuery: jest.Mock;

  beforeAll(async () => {
    app = Fastify();
    app.decorateRequest('tenantId', '');
    app.decorateRequest('keyScope', '');
    app.decorateRequest('userId', '');
    await app.register(runsRoutes);
    await app.ready();
  });

  afterAll(async () => { await app.close(); });

  beforeEach(() => {
    mockQuery = jest.fn();
    (getPool as jest.Mock).mockReturnValue({ query: mockQuery });
  });

  afterEach(() => jest.clearAllMocks());

  it('serves an owned screenshot with immutable cache headers + ETag', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }); // authz hit

    const res = await app.inject({ method: 'GET', url: `/media?key=${encodeURIComponent(OWNED_KEY)}` });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['cache-control']).toBe('private, max-age=31536000, immutable');
    expect(res.headers['etag']).toBe(`"${createHash('sha1').update(OWNED_KEY).digest('hex')}"`);
    // Authz query is tenant-scoped on the screenshot key.
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('screenshot_key = $1 AND tenant_id = $2'),
      [OWNED_KEY, 'tenant-1'],
    );
  });

  it('returns 404 for a key not owned by the caller tenant (no cross-tenant read)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }); // authz miss

    const res = await app.inject({ method: 'GET', url: '/media?key=tenant-2/run-1/0/after.png' });

    expect(res.statusCode).toBe(404);
  });

  it('rejects path-traversal keys before touching the DB', async () => {
    const res = await app.inject({ method: 'GET', url: `/media?key=${encodeURIComponent('../../etc/passwd')}` });

    expect(res.statusCode).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('answers 304 Not Modified when If-None-Match matches', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }); // authz hit
    const etag = `"${createHash('sha1').update(OWNED_KEY).digest('hex')}"`;

    const res = await app.inject({
      method: 'GET',
      url: `/media?key=${encodeURIComponent(OWNED_KEY)}`,
      headers: { 'if-none-match': etag },
    });

    expect(res.statusCode).toBe(304);
    expect(res.headers['etag']).toBe(etag);
  });

  it('returns 400 when key is missing', async () => {
    const res = await app.inject({ method: 'GET', url: '/media' });
    expect(res.statusCode).toBe(400);
  });
});

describe('runsRoutes — GET /runs/:id is tenant-scoped', () => {
  let app: ReturnType<typeof Fastify>;
  let mockQuery: jest.Mock;

  beforeAll(async () => {
    app = Fastify();
    app.decorateRequest('tenantId', '');
    app.decorateRequest('keyScope', '');
    app.decorateRequest('userId', '');
    await app.register(runsRoutes);
    await app.ready();
  });

  afterAll(async () => { await app.close(); });

  beforeEach(() => {
    mockQuery = jest.fn();
    (getPool as jest.Mock).mockReturnValue({ query: mockQuery });
  });

  afterEach(() => jest.clearAllMocks());

  it('returns 404 when the run belongs to another tenant', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }); // run not found under tenant filter

    const res = await app.inject({ method: 'GET', url: '/runs/run-owned-by-someone-else' });

    expect(res.statusCode).toBe(404);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('WHERE id = $1 AND tenant_id = $2'),
      ['run-owned-by-someone-else', 'tenant-1'],
    );
  });
});
