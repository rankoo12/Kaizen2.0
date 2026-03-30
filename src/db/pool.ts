import { Pool } from 'pg';

/**
 * Singleton pg Pool. Initialized lazily on first call to getPool().
 *
 * Use closePool() in process shutdown handlers (SIGTERM/SIGINT) to drain
 * in-flight queries before the process exits.
 */
let _pool: Pool | undefined;

export function getPool(): Pool {
  if (!_pool) {
    _pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: parseInt(process.env.DB_POOL_MAX ?? '10', 10),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });

    // Without this handler, an idle client error would be an unhandled
    // rejection and crash the process.
    _pool.on('error', (err) => {
      console.error(JSON.stringify({ event: 'db_pool_error', error: err.message }));
    });
  }
  return _pool;
}

export async function closePool(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = undefined;
  }
}
