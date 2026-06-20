/**
 * Evicts selector_cache rows whose stored selector embeds run-specific data
 * (an email address). These poison assertion steps like "verify {{email}}
 * appears in the header" by reusing a previous run's email.
 * Read-only preview by default; pass --apply to delete.
 *
 * PowerShell: $env:PROD_DATABASE_URL="..."; npx tsx scripts/evict-poisoned-selectors.ts [--apply]
 */
import { Client } from 'pg';

const url = process.env.PROD_DATABASE_URL;
if (!url) { console.error('Set PROD_DATABASE_URL first.'); process.exit(1); }
const apply = process.argv.includes('--apply');

// Match rows whose selectors JSON/text contains an email-like token.
const WHERE = `selectors::text ~ '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'`;

(async () => {
  const c = new Client({ connectionString: url });
  await c.connect();
  const sel = await c.query(`SELECT target_hash, domain, selectors FROM selector_cache WHERE ${WHERE}`);
  console.log(`Found ${sel.rowCount} poisoned selector_cache row(s):`);
  sel.rows.forEach((r: any) => console.log('  ', r.domain, '→', JSON.stringify(r.selectors).slice(0, 120)));

  if (!apply) { console.log('\n(preview only — re-run with --apply to delete)'); await c.end(); return; }

  const del = await c.query(`DELETE FROM selector_cache WHERE ${WHERE}`);
  console.log(`\nDeleted ${del.rowCount} row(s).`);
  await c.end();
})().catch((e) => { console.error('ERR:', e.message); process.exit(1); });
