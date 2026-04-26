/**
 * One-shot cache reset.
 *
 * Wipes the resolver cache stack so the next run resolves every step from
 * scratch via the LLM. Leaves users, projects, suites, tests, steps, and
 * runs intact.
 *
 * Usage: tsx scripts/truncate-caches.ts
 */
import { Client } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const TABLES = [
  'selector_cache',
  'archetype_failures',
  'compiled_ast_cache',
  'step_results',
];

async function main(): Promise<void> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    console.log('Before:');
    for (const t of TABLES) {
      const { rows } = await client.query<{ count: string }>(`SELECT count(*) FROM ${t}`);
      console.log(`  ${t}: ${rows[0].count}`);
    }

    await client.query('BEGIN');
    await client.query(`TRUNCATE ${TABLES.join(', ')} CASCADE`);
    await client.query('COMMIT');

    console.log('\nAfter:');
    for (const t of TABLES) {
      const { rows } = await client.query<{ count: string }>(`SELECT count(*) FROM ${t}`);
      console.log(`  ${t}: ${rows[0].count}`);
    }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
