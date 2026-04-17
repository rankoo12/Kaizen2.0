import type { Redis } from 'ioredis';

/**
 * Invalidates all Redis hot-cache entries for a given targetHash + domain.
 * Key format: sel:{tenantId}:{targetHash}:{domain}
 *
 * Used by both CachedElementResolver (on recordFailure) and LLMElementResolver
 * (after outcome window updates) to keep Redis in sync with Postgres.
 */
export async function invalidateRedisCache(
  redis: Redis,
  targetHash: string,
  domain: string,
): Promise<number> {
  const pattern = `sel:*:${targetHash}:${domain}`;
  const keys: string[] = [];
  let cursor = '0';
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', '100');
    cursor = next;
    keys.push(...batch);
  } while (cursor !== '0');

  if (keys.length > 0) {
    await redis.del(...keys);
  }
  return keys.length;
}

/**
 * Returns true for Postgres error codes that are typically transient:
 *  - 08xxx: connection exceptions
 *  - 40001: serialization failure
 *  - 40P01: deadlock detected
 *  - 57P01: admin shutdown
 */
export function isTransient(error: any): boolean {
  if (!error) return false;
  const code = error.code as string | undefined;
  if (!code) return false;
  return code.startsWith('08') || code === '40001' || code === '40P01' || code === '57P01';
}
