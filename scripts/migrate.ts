/**
 * Simple SQL migration runner.
 *
 * - Reads all *.sql files from db/migrations/ in lexicographic order.
 * - Tracks applied migrations in a schema_migrations table.
 * - Wraps each migration in a transaction; rolls back on error.
 *
 * Usage: tsx scripts/migrate.ts
 */
import { Client } from 'pg';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const MIGRATIONS_DIR = path.join(__dirname, '..', 'db', 'migrations');

async function migrate(): Promise<void> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  // Ensure the tracking table exists (outside a transaction — idempotent).
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ DEFAULT now()
    )
  `);

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  if (files.length === 0) {
    console.log('No migration files found.');
    await client.end();
    return;
  }

  for (const file of files) {
    const version = file.replace('.sql', '');

    const { rows } = await client.query<{ version: string }>(
      'SELECT version FROM schema_migrations WHERE version = $1',
      [version],
    );

    if (rows.length > 0) {
      console.log(`  skip : ${file}`);
      continue;
    }

    console.log(`  apply: ${file}`);
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');

    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migrations (version) VALUES ($1)',
        [version],
      );
      await client.query('COMMIT');
      console.log(`  done : ${file}`);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`  FAIL : ${file}`);
      throw err;
    }
  }

  await client.end();
  console.log('All migrations applied.');
}

migrate().catch((err) => {
  console.error('Migration runner failed:', err);
  process.exit(1);
});
