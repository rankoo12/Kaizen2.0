import { invalidateRedisCache, deleteKeysByPattern, isTransient } from '../redis-cache.utils';

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

// The worker's wrong-pick eviction used `KEYS llm:dedup:{targetHash}:*` — O(N) over
// the WHOLE keyspace, blocking the single-threaded server, on a hot path (every
// refused pick). deleteKeysByPattern walks the keyspace with cursor SCAN instead.
describe('deleteKeysByPattern', () => {
  let redis: ReturnType<typeof makeMockRedis>;

  beforeEach(() => {
    redis = makeMockRedis();
  });

  it('deletes matching keys, walking the cursor to completion', async () => {
    redis.scan
      .mockResolvedValueOnce(['17', ['llm:dedup:h:aaa', 'llm:dedup:h:bbb']])
      .mockResolvedValueOnce(['0', ['llm:dedup:h:ccc']]);
    redis.del.mockResolvedValue(1);

    const n = await deleteKeysByPattern(redis as any, 'llm:dedup:h:*');

    expect(redis.scan).toHaveBeenNthCalledWith(1, '0', 'MATCH', 'llm:dedup:h:*', 'COUNT', '100');
    expect(redis.scan).toHaveBeenNthCalledWith(2, '17', 'MATCH', 'llm:dedup:h:*', 'COUNT', '100'); // resumes where it left off
    expect(n).toBe(3);
  });

  it('deletes PER BATCH, so memory stays flat however many keys match', async () => {
    redis.scan
      .mockResolvedValueOnce(['5', ['k1', 'k2']])
      .mockResolvedValueOnce(['0', ['k3']]);
    redis.del.mockResolvedValue(1);

    await deleteKeysByPattern(redis as any, 'p:*');

    expect(redis.del).toHaveBeenCalledTimes(2);
    expect(redis.del).toHaveBeenNthCalledWith(1, 'k1', 'k2');
    expect(redis.del).toHaveBeenNthCalledWith(2, 'k3');
  });

  it('never calls DEL with no keys, and answers 0 when nothing matches', async () => {
    redis.scan.mockResolvedValueOnce(['0', []]);

    expect(await deleteKeysByPattern(redis as any, 'p:*')).toBe(0);
    expect(redis.del).not.toHaveBeenCalled();
  });

  it('uses SCAN and can never fall back to the blocking KEYS — the mock does not even have it', async () => {
    // makeMockRedis exposes only scan + del: if this ever called redis.keys(), it
    // would throw "redis.keys is not a function" rather than quietly block a server.
    expect((redis as unknown as { keys?: unknown }).keys).toBeUndefined();
    redis.scan.mockResolvedValueOnce(['0', ['k1']]);
    redis.del.mockResolvedValue(1);

    await expect(deleteKeysByPattern(redis as any, 'p:*')).resolves.toBe(1);
  });

  it('propagates Redis errors — the best-effort swallowing belongs to the caller that chose it', async () => {
    redis.scan.mockRejectedValueOnce(new Error('Connection refused'));

    await expect(deleteKeysByPattern(redis as any, 'p:*')).rejects.toThrow('Connection refused');
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
