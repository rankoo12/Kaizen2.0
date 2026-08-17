/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Manual mock for `src/db/transaction`, picked up by any test that calls
 * `jest.mock('<path>/db/transaction')` with no factory.
 *
 * Why this exists: the codebase moved from `getPool().query(...)` to
 * tenant-scoped `tenantQuery` / `tenantPool` so that queries run inside a
 * transaction that sets `app.current_tenant_id` (row-level security). Dozens of
 * unit tests already mock `db/pool` and assert on the `query` mock they
 * provided. Rather than rewrite every one of them, this mock routes the tenant
 * helpers straight to `getPool().query`, so a test's existing `mockQuery` sees
 * exactly the SQL and params it always did — the tenant scoping is a real-DB
 * concern (see the integration test), not something a unit test can observe.
 *
 * NOT auto-applied: Jest only uses a manual mock for a user module when the
 * test explicitly calls `jest.mock(...)` for it. Tests that provide their own
 * factory (e.g. to assert `withTenantTransaction` was called with a tenant)
 * keep doing that; this file is the zero-effort default for the rest.
 */
import { getPool } from '../pool';

/**
 * Mirrors the real helper's shape: it checks out a client, sets the tenant, and
 * hands the client to the callback. Tests that mocked `connect()` to script a
 * transaction (BEGIN / statements / COMMIT) keep working unchanged; tests that
 * only mocked `query` get the pool itself, whose `query` is the same mock.
 */
export const withTenantTransaction = jest.fn(
  async (_tenantId: string, cb: (client: any) => Promise<any>) => {
    const pool: any = getPool();
    if (typeof pool.connect === 'function') {
      const client = await pool.connect();
      try {
        // The real helper issues BEGIN / set_config / COMMIT around the callback;
        // scripted clients count on those calls, so they are issued here too.
        await client.query('BEGIN');
        await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [_tenantId]);
        const out = await cb(client);
        await client.query('COMMIT');
        return out;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release?.();
      }
    }
    return cb(pool);
  },
);

export const tenantQuery = jest.fn(
  async (_tenantId: string, sql: string, params: readonly unknown[] = []) =>
    (getPool() as any).query(sql, params as unknown[]),
);

export const tenantPool = jest.fn((_tenantId: string) => ({
  query: (sql: string, params: readonly unknown[] = []) =>
    (getPool() as any).query(sql, params as unknown[]),
}));
