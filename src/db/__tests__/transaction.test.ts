import { withTenantTransaction } from '../transaction';

jest.mock('../pool', () => ({
  getPool: jest.fn(),
}));

import { getPool } from '../pool';

describe('DB Repository Layer - transaction', () => {
  let mockClient: {
    query: jest.Mock;
    release: jest.Mock;
  };

  beforeEach(() => {
    mockClient = {
      query: jest.fn().mockResolvedValue({ rows: [] }),
      release: jest.fn(),
    };
    (getPool as jest.Mock).mockReturnValue({
      connect: jest.fn().mockResolvedValue(mockClient),
    });
  });

  afterEach(() => jest.clearAllMocks());

  it('sets app.current_tenant_id via set_config inside the transaction', async () => {
    const tenantId = '00000000-0000-0000-0000-000000000001';
    const callback = jest.fn().mockResolvedValue('result');

    await withTenantTransaction(tenantId, callback);

    const calls = mockClient.query.mock.calls.map((c: unknown[]) => c[0]);
    expect(calls).toContain('BEGIN');
    expect(calls).toContain('COMMIT');
    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining('set_config'),
      [tenantId],
    );
    expect(callback).toHaveBeenCalledWith(mockClient);
  });

  it('returns the callback result', async () => {
    const tenantId = '00000000-0000-0000-0000-000000000001';
    const result = await withTenantTransaction(tenantId, async () => 42);
    expect(result).toBe(42);
  });

  it('rolls back and re-throws on callback error', async () => {
    const tenantId = '00000000-0000-0000-0000-000000000002';

    await expect(
      withTenantTransaction(tenantId, async () => {
        throw new Error('Test rollback error');
      }),
    ).rejects.toThrow('Test rollback error');

    const calls = mockClient.query.mock.calls.map((c: unknown[]) => c[0]);
    expect(calls).toContain('ROLLBACK');
    expect(calls).not.toContain('COMMIT');
  });

  it('releases the client even when the callback throws', async () => {
    const tenantId = '00000000-0000-0000-0000-000000000003';

    await expect(
      withTenantTransaction(tenantId, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow();

    expect(mockClient.release).toHaveBeenCalledTimes(1);
  });
});
