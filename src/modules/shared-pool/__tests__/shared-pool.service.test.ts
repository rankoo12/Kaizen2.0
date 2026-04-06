/**
 * Unit tests for SharedPoolService
 * Spec ref: kaizen-phase4-spec.md §7
 */

import { SharedPoolService } from '../shared-pool.service';
import type { IObservability } from '../../observability/interfaces';

jest.mock('../../../db/pool', () => ({
  getPool: jest.fn().mockReturnValue({ query: jest.fn() }),
}));

import { getPool } from '../../../db/pool';

// ─── Mocks ────────────────────────────────────────────────────────────────────

function makeMockRedis() {
  return {
    get: jest.fn().mockResolvedValue(null),
    setex: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
  };
}

function makeMockObs(): jest.Mocked<IObservability> {
  return {
    startSpan: jest.fn().mockReturnValue({ end: jest.fn(), setAttribute: jest.fn() }),
    log: jest.fn(),
    increment: jest.fn(),
    histogram: jest.fn(),
  };
}

const BASE_PARAMS = {
  tenantId: 'tenant-abc',
  contentHash: 'hash-123',
  domain: 'github.com',
  selectors: [{ selector: '#login_field', strategy: 'css' as const, priority: 1 }],
  stepEmbedding: Array(1536).fill(0.1),
  elementEmbedding: null,
  confidenceScore: 1.0,
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('SharedPoolService', () => {
  let service: SharedPoolService;
  let mockRedis: ReturnType<typeof makeMockRedis>;
  let mockObs: jest.Mocked<IObservability>;
  let mockQuery: jest.Mock;

  beforeEach(() => {
    mockRedis = makeMockRedis();
    mockObs = makeMockObs();
    mockQuery = jest.fn();
    (getPool as jest.Mock).mockReturnValue({ query: mockQuery });
    service = new SharedPoolService(mockRedis as any, mockObs);
  });

  afterEach(() => jest.clearAllMocks());

  // ── contribute() ───────────────────────────────────────────────────────────

  it('contribute() skips if tenant is not opted in', async () => {
    // isOptedIn → DB returns false
    mockQuery.mockResolvedValueOnce({ rows: [{ global_brain_opt_in: false }] });

    await service.contribute(BASE_PARAMS);

    // Only one query (the isOptedIn lookup) — no INSERT or UPDATE
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockObs.increment).not.toHaveBeenCalledWith('shared_pool.contributed', expect.anything());
  });

  it('contribute() skips if confidenceScore is below quality threshold (0.8)', async () => {
    // isOptedIn → true (Redis cache miss → DB returns true)
    mockQuery.mockResolvedValueOnce({ rows: [{ global_brain_opt_in: true }] });

    await service.contribute({ ...BASE_PARAMS, confidenceScore: 0.79 });

    // Only the isOptedIn DB query — no INSERT
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockObs.increment).not.toHaveBeenCalledWith('shared_pool.contributed', expect.anything());
  });

  it('contribute() inserts a new shared row when no existing entry', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ global_brain_opt_in: true }] }) // isOptedIn
      .mockResolvedValueOnce({ rows: [] })                               // existing check → none
      .mockResolvedValueOnce({ rows: [] });                              // INSERT

    await service.contribute(BASE_PARAMS);

    const insertCall = mockQuery.mock.calls[2];
    expect(insertCall[0]).toContain('INSERT INTO selector_cache');
    expect(insertCall[1]).toContain(BASE_PARAMS.contentHash);
    expect(mockObs.increment).toHaveBeenCalledWith('shared_pool.contributed', { domain: 'github.com' });
  });

  it('contribute() updates attribution JSONB when shared entry already exists', async () => {
    const existingAttribution = {
      source: 'tenant',
      contributors: [{ tenantId: 'original-tenant', contributedAt: '2026-01-01T00:00:00Z' }],
    };

    mockQuery
      .mockResolvedValueOnce({ rows: [{ global_brain_opt_in: true }] })                        // isOptedIn
      .mockResolvedValueOnce({ rows: [{ id: 'row-999', attribution: existingAttribution }] }) // existing check → found
      .mockResolvedValueOnce({ rows: [] });                                                    // UPDATE

    await service.contribute(BASE_PARAMS);

    const updateCall = mockQuery.mock.calls[2];
    expect(updateCall[0]).toContain('UPDATE selector_cache');
    const updatedAttribution = JSON.parse(updateCall[1][0]);
    expect(updatedAttribution.contributors).toHaveLength(2);
    expect(updatedAttribution.contributors[1].tenantId).toBe('tenant-abc');
  });

  it('contribute() does not add duplicate contributor if tenant already contributed', async () => {
    const existingAttribution = {
      source: 'tenant',
      contributors: [{ tenantId: 'tenant-abc', contributedAt: '2026-01-01T00:00:00Z' }],
    };

    mockQuery
      .mockResolvedValueOnce({ rows: [{ global_brain_opt_in: true }] })
      .mockResolvedValueOnce({ rows: [{ id: 'row-999', attribution: existingAttribution }] });

    await service.contribute(BASE_PARAMS);

    // No UPDATE call — tenant already listed
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  // ── isOptedIn() ────────────────────────────────────────────────────────────

  it('isOptedIn() returns false when tenant has global_brain_opt_in = false', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ global_brain_opt_in: false }] });

    const result = await service.isOptedIn('tenant-abc');

    expect(result).toBe(false);
    expect(mockRedis.setex).toHaveBeenCalledWith('brain_opt_in:tenant-abc', 300, '0');
  });

  it('isOptedIn() caches result in Redis and does not hit DB on second call', async () => {
    // First call — Redis miss, DB returns true
    mockQuery.mockResolvedValueOnce({ rows: [{ global_brain_opt_in: true }] });
    await service.isOptedIn('tenant-abc');

    // Second call — Redis returns cached '1'
    mockRedis.get.mockResolvedValueOnce('1');
    const result = await service.isOptedIn('tenant-abc');

    expect(result).toBe(true);
    // DB was only queried once (for the first call)
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  // ── setOptIn() ─────────────────────────────────────────────────────────────

  it('setOptIn() updates DB and invalidates Redis cache', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await service.setOptIn('tenant-abc', true);

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE tenants SET global_brain_opt_in'),
      [true, 'tenant-abc'],
    );
    expect(mockRedis.del).toHaveBeenCalledWith('brain_opt_in:tenant-abc');
    expect(mockObs.log).toHaveBeenCalledWith('info', 'shared_pool.opt_in_changed', { tenantId: 'tenant-abc', value: true });
  });
});
