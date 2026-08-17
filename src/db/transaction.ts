import { PoolClient, QueryResult, QueryResultRow } from 'pg';
import { getPool } from './pool';

/**
 * Executes a callback within a PostgreSQL database transaction, ensuring that
 * the current tenant ID is securely set via SET LOCAL. This is critical for
 * Row-Level Security (RLS) enforcement and ensuring that tenant IDs do not
 * leak back into the shared connection pool.
 */
export async function withTenantTransaction<T>(
  tenantId: string,
  callback: (client: PoolClient) => Promise<T>
): Promise<T> {
  const pool = getPool();
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // Scopes the configuration parameter to the current transaction block.
    // When the transaction ends, the parameter is cleared.
    // We use set_config() because SET LOCAL does not support $1 parameters in the pg driver.
    await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantId]);
    
    const result = await callback(client);
    
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * One tenant-scoped statement.
 *
 * Exists because the alternative people reach for — `getPool().query(...)` with
 * a `tenant_id = $1` predicate — is isolation by discipline: it works only while
 * every author remembers, and it is invisible to the database. Under
 * `FORCE ROW LEVEL SECURITY` those queries do not quietly return the wrong rows,
 * they fail outright, because the policy reads a setting no one set.
 *
 * Deliberately ONE statement per transaction rather than a long-lived one: the
 * Test Writer pipeline runs for minutes across a crawl and several LLM calls,
 * and holding a connection open across that would trade a security fix for a
 * pool-exhaustion bug. Short transactions keep the tenant setting attached to
 * the statement that needs it and to nothing else.
 */
export async function tenantQuery<T extends QueryResultRow = QueryResultRow>(
  tenantId: string,
  sql: string,
  params: readonly unknown[] = [],
): Promise<QueryResult<T>> {
  return withTenantTransaction(tenantId, (client) => client.query<T>(sql, params as unknown[]));
}
