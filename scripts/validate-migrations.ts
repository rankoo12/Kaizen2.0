/**
 * Read-only validation of migrations 023 + 024. Modifies nothing.
 * PowerShell:  $env:PROD_DATABASE_URL="postgresql://..."; npx tsx scripts/validate-migrations.ts
 */
import { Client } from 'pg';

const url = process.env.PROD_DATABASE_URL;
if (!url) { console.error('Set PROD_DATABASE_URL first.'); process.exit(1); }

(async () => {
  const c = new Client({ connectionString: url });
  await c.connect();
  console.log('host:', url.replace(/:[^:@/]+@/, ':***@').slice(0, 70), '\n');

  // 1. schema_migrations recorded both new versions
  const mig = await c.query<{ version: string }>(
    "SELECT version FROM schema_migrations WHERE version IN ('023_seed_assert_text','024_step_results_capture') ORDER BY version",
  );
  console.log('[1] schema_migrations rows for 023/024:');
  console.log('   ', mig.rows.map((r) => r.version).join(', ') || '(NONE — not applied!)');

  // 2. 024: the two new columns exist on step_results
  const cols = await c.query<{ column_name: string; data_type: string }>(
    `SELECT column_name, data_type FROM information_schema.columns
     WHERE table_name = 'step_results' AND column_name IN ('captured_name','captured_value')
     ORDER BY column_name`,
  );
  console.log('\n[2] step_results capture columns (expect 2):');
  cols.rows.forEach((r) => console.log(`    ${r.column_name} : ${r.data_type}`));
  if (cols.rows.length !== 2) console.log('    ⚠️  expected captured_name + captured_value');

  // 3. 023: the seeded assert_text rows are present
  const seed = await c.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM compiled_ast_cache WHERE ast_json->>'action' = 'assert_text'`,
  );
  console.log(`\n[3] compiled_ast_cache rows with action=assert_text: ${seed.rows[0].n} (expect >= 5)`);

  await c.end();
  console.log('\nDone.');
})().catch((e) => { console.error('ERR:', e.message); process.exit(1); });
