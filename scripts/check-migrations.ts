/**
 * Read-only migration-state check. Does NOT modify the database.
 * Usage (PowerShell):  $env:PROD_DATABASE_URL="postgresql://..."; npx tsx scripts/check-migrations.ts
 * Usage (bash):        PROD_DATABASE_URL="postgresql://..." npx tsx scripts/check-migrations.ts
 */
import { Client } from 'pg';
import fs from 'fs';
import path from 'path';

const url = process.env.PROD_DATABASE_URL;
if (!url) { console.error('Set PROD_DATABASE_URL first.'); process.exit(1); }

(async () => {
  const c = new Client({ connectionString: url });
  await c.connect();
  console.log('host:', url.replace(/:[^:@/]+@/, ':***@').slice(0, 70));

  const applied = await c
    .query<{ version: string }>('SELECT version FROM schema_migrations ORDER BY version')
    .then((r) => r.rows.map((x) => x.version))
    .catch((e) => { console.log('schema_migrations:', e.message); return [] as string[]; });
  console.log('\nApplied migrations on prod:');
  console.log(applied.length ? applied.join('\n') : '  (none)');

  const onDisk = fs.readdirSync(path.join(__dirname, '..', 'db', 'migrations'))
    .filter((f) => f.endsWith('.sql')).map((f) => f.replace('.sql', '')).sort();
  const pending = onDisk.filter((v) => !applied.includes(v));
  console.log('\nPending (would be applied):');
  console.log(pending.length ? pending.join('\n') : '  (none — fully up to date)');

  await c.end();
})().catch((e) => { console.error('ERR:', e.message); process.exit(1); });
