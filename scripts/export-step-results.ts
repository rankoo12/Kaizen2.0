/**
 * Exports the most recent step_results rows to a JSON file for inspection.
 *
 * Usage:
 *   tsx scripts/export-step-results.ts               # latest 200 rows, all tenants
 *   tsx scripts/export-step-results.ts --limit 50    # override row count
 *   tsx scripts/export-step-results.ts --run <uuid>  # filter to a specific run
 *
 * Reads DATABASE_URL from .env. Writes ./step_results.json in the project root.
 */
import { Client } from 'pg';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

function parseArgs(): { limit: number; runId: string | null } {
  const args = process.argv.slice(2);
  let limit = 200;
  let runId: string | null = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--limit' && args[i + 1]) limit = Number(args[++i]);
    else if (args[i] === '--run' && args[i + 1]) runId = args[++i];
  }
  return { limit, runId };
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set. Put it in .env or export it before running.');
  }

  const { limit, runId } = parseArgs();
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  const { rows } = runId
    ? await client.query(
        `SELECT sr.*, ts.raw_text AS step_text
         FROM step_results sr
         LEFT JOIN test_steps ts ON ts.content_hash = sr.content_hash
         WHERE sr.run_id = $1
         ORDER BY sr.created_at ASC`,
        [runId],
      )
    : await client.query(
        `SELECT sr.*, ts.raw_text AS step_text
         FROM step_results sr
         LEFT JOIN test_steps ts ON ts.content_hash = sr.content_hash
         ORDER BY sr.created_at DESC
         LIMIT $1`,
        [limit],
      );

  await client.end();

  const outPath = path.join(process.cwd(), 'step_results.json');
  fs.writeFileSync(outPath, JSON.stringify(rows, null, 2));

  console.log(`Wrote ${rows.length} rows to ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
