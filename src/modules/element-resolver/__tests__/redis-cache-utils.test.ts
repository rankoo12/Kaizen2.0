import { invalidateRedisCache, isTransient } from '../redis-cache.utils';

const makeMockRedis = () => ({
  scan: jest.fn(),
  del: jest.fn(),
});

describe('invalidateRedisCache', () => {
  let redis: ReturnType<typeof makeMockRedis>;

  beforeEach(() => {
    redis = makeMockRedis();
  });

  it('deletes all matching keys for targetHash + domain', async () => {
    redis.scan.mockResolvedValueOnce(['0', ['sel:t1:hash1:example.com', 'sel:t2:hash1:example.com']]);
    redis.del.mockResolvedValueOnce(2);

    const count = await invalidateRedisCache(redis as any, 'hash1', 'example.com');

    expect(redis.scan).toHaveBeenCalledWith('0', 'MATCH', 'sel:*:hash1:example.com', 'COUNT', '100');
    expect(redis.del).toHaveBeenCalledWith('sel:t1:hash1:example.com', 'sel:t2:hash1:example.com');
    expect(count).toBe(2);
  });

  it('returns 0 and does not call del when no keys match', async () => {
    redis.scan.mockResolvedValueOnce(['0', []]);

    const count = await invalidateRedisCache(redis as any, 'hash1', 'example.com');

    expect(redis.del).not.toHaveBeenCalled();
    expect(count).toBe(0);
  });

  it('handles multi-page SCAN cursor correctly', async () => {
    redis.scan
      .mockResolvedValueOnce(['42', ['sel:t1:hash1:example.com']])
      .mockResolvedValueOnce(['0', ['sel:t2:hash1:example.com']]);
    redis.del.mockResolvedValueOnce(2);

    const count = await invalidateRedisCache(redis as any, 'hash1', 'example.com');

    expect(redis.scan).toHaveBeenCalledTimes(2);
    expect(redis.del).toHaveBeenCalledWith('sel:t1:hash1:example.com', 'sel:t2:hash1:example.com');
    expect(count).toBe(2);
  });

  it('propagates Redis errors to the caller', async () => {
    redis.scan.mockRejectedValueOnce(new Error('Connection refused'));

    await expect(invalidateRedisCache(redis as any, 'hash1', 'example.com'))
      .rejects.toThrow('Connection refused');
  });
});

describe('isTransient', () => {
  it('returns true for connection exception (08006)', () => {
    expect(isTransient({ code: '08006' })).toBe(true);
  });

  it('returns true for serialization failure (40001)', () => {
    expect(isTransient({ code: '40001' })).toBe(true);
  });

  it('returns true for deadlock detected (40P01)', () => {
    expect(isTransient({ code: '40P01' })).toBe(true);
  });

  it('returns true for admin shutdown (57P01)', () => {
    expect(isTransient({ code: '57P01' })).toBe(true);
  });

  it('returns false for unique violation (23505)', () => {
    expect(isTransient({ code: '23505' })).toBe(false);
  });

  it('returns false when no code is present', () => {
    expect(isTransient(new Error('generic error'))).toBe(false);
  });

  it('returns false for null/undefined', () => {
    expect(isTransient(null)).toBe(false);
    expect(isTransient(undefined)).toBe(false);
  });
});
