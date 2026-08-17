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
    const url = process.env.DATABASE_URL ?? '';
    // SSL when the URL asks for it, when DB_SSL=true, or when the host is a
    // known managed-Postgres proxy. Off for a plain local Docker Postgres.
    // rejectUnauthorized:false because those proxies present a cert for a
    // name the client is not connecting by; the tunnel is still encrypted.
    // Called for by the deployment spec §3.4 and never wired until the
    // isolation test hit `read ECONNRESET` against Railway's public proxy.
    const wantsSsl = process.env.DB_SSL === 'true'
      || /sslmode=require/i.test(url)
      || /\.proxy\.rlwy\.net|supabase\.co|neon\.tech/i.test(url);
    _pool = new Pool({
      connectionString: url,
      ssl: wantsSsl ? { rejectUnauthorized: false } : undefined,
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
