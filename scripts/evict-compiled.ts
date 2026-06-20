/**
 * Deletes specific phrases from compiled_ast_cache so they recompile via the
 * current LLM rules. Targeted (one row per phrase) — NOT a cache wipe.
 * PowerShell: $env:PROD_DATABASE_URL="..."; npx tsx scripts/evict-compiled.ts
 */
import { Client } from 'pg';
import { createHash } from 'crypto';

const url = process.env.PROD_DATABASE_URL;
if (!url) { console.error('Set PROD_DATABASE_URL first.'); process.exit(1); }

function normalise(text: string): string {
  return text.trim().toLowerCase()
    .replace(/[""'']/g, '').replace(/"/g, '').replace(/'/g, '')
    .replace(/\s+/g, ' ').trim();
}
const hash = (t: string) => createHash('sha256').update(normalise(t)).digest('hex');

// Phrases to force-recompile. Add any others you used for the random step.
const PHRASES = [
  'add a random product to the cart',
  'select a random product',
  'click add to cart for that product',
];

(async () => {
  const c = new Client({ connectionString: url });
  await c.connect();
  for (const p of PHRASES) {
    const r = await c.query('DELETE FROM compiled_ast_cache WHERE content_hash = $1', [hash(p)]);
    console.log(`evicted ${r.rowCount} row(s) for: "${p}"`);
  }
  await c.end();
  console.log('Done — these phrases will recompile on the next run.');
})().catch((e) => { console.error('ERR:', e.message); process.exit(1); });
