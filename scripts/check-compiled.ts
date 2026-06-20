/**
 * Read-only: show what given step phrases compiled to in compiled_ast_cache.
 * PowerShell: $env:PROD_DATABASE_URL="..."; npx tsx scripts/check-compiled.ts
 */
import { Client } from 'pg';
import { createHash } from 'crypto';

const url = process.env.PROD_DATABASE_URL;
if (!url) { console.error('Set PROD_DATABASE_URL first.'); process.exit(1); }

// Mirror LearnedCompiler.normalise + hash exactly.
function normalise(text: string): string {
  return text.trim().toLowerCase()
    .replace(/[""'']/g, '').replace(/"/g, '').replace(/'/g, '')
    .replace(/\s+/g, ' ').trim();
}
const hash = (t: string) => createHash('sha256').update(normalise(t)).digest('hex');

const PHRASES = [
  'add a random product to the cart',
  'select a random product',
  'click add to cart for that product',
];

(async () => {
  const c = new Client({ connectionString: url });
  await c.connect();
  for (const p of PHRASES) {
    const { rows } = await c.query<{ ast_json: any }>(
      'SELECT ast_json FROM compiled_ast_cache WHERE content_hash = $1',
      [hash(p)],
    );
    console.log(`\n"${p}"`);
    console.log(rows.length ? '  cached → ' + JSON.stringify(rows[0].ast_json) : '  (not cached — would call LLM)');
  }
  await c.end();
})().catch((e) => { console.error('ERR:', e.message); process.exit(1); });
