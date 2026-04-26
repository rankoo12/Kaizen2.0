import { usageThisMonth } from '../usage';

jest.mock('../../../db/pool', () => ({
  getPool: jest.fn(),
}));

import { getPool } from '../../../db/pool';

describe('usageThisMonth', () => {
  let mockQuery: jest.Mock;

  beforeEach(() => {
    mockQuery = jest.fn();
    (getPool as jest.Mock).mockReturnValue({ query: mockQuery });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('returns 0 when no billing_events rows exist for the tenant', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    const result = await usageThisMonth('tenant-1');
    expect(result).toBe(0);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('SELECT COALESCE(SUM(quantity), 0)::text AS total'),
      ['tenant-1']
    );
  });

  it('returns sum of quantity for rows in the current month', async () => {
    mockQuery.mockResolvedValue({ rows: [{ total: '5212' }] });
    const result = await usageThisMonth('tenant-1');
    expect(result).toBe(5212);
  });
});
