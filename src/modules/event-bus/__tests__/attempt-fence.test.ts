import { isStaleAttempt, markRunAttempt, runAttemptKey } from '../attempt-fence';

describe('attempt fence', () => {
  it('markRunAttempt stores the attempt with a TTL', async () => {
    const redis = { set: jest.fn().mockResolvedValue('OK') } as any;
    await markRunAttempt(redis, 'r1', 2);
    expect(redis.set).toHaveBeenCalledWith(runAttemptKey('r1'), '2', 'EX', expect.any(Number));
  });

  it('markRunAttempt swallows Redis errors (best-effort fence)', async () => {
    const redis = { set: jest.fn().mockRejectedValue(new Error('down')) } as any;
    await expect(markRunAttempt(redis, 'r1', 0)).resolves.toBeUndefined();
  });

  it('flags an envelope from a superseded attempt as stale', async () => {
    const redis = { get: jest.fn().mockResolvedValue('2') } as any;
    await expect(isStaleAttempt(redis, 'r1', 1)).resolves.toBe(true);
  });

  it('accepts the current attempt', async () => {
    const redis = { get: jest.fn().mockResolvedValue('2') } as any;
    await expect(isStaleAttempt(redis, 'r1', 2)).resolves.toBe(false);
  });

  it('fails open when no marker exists', async () => {
    const redis = { get: jest.fn().mockResolvedValue(null) } as any;
    await expect(isStaleAttempt(redis, 'r1', 0)).resolves.toBe(false);
  });

  it('fails open on Redis errors', async () => {
    const redis = { get: jest.fn().mockRejectedValue(new Error('down')) } as any;
    await expect(isStaleAttempt(redis, 'r1', 0)).resolves.toBe(false);
  });
});
