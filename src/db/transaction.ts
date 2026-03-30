import { PoolClient } from 'pg';
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
