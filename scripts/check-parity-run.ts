/**
 * Parity-validation checker (worker service decomposition, Phase 1).
 *
 * Prints a run's status, its step_results (ordered by the new step_index),
 * run_events coverage, and whether each referenced screenshot actually exists
 * (local-disk fallback keys are absolute paths).
 *
 * Usage: npx tsx scripts/check-parity-run.ts <runId>
 * Spec: docs/specs/workers/spec-service-decomposition.md §9
 */
import dotenv from 'dotenv';
import fs from 'fs';
import { Client } from 'pg';

dotenv.config();

async function main(): Promise<void> {
  const runId = process.argv[2];
  if (!runId) throw new Error('usage: tsx scripts/check-parity-run.ts <runId>');

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  const { rows: [run] } = await client.query(
    `SELECT id, status, environment_url, started_at, completed_at FROM runs WHERE id = $1`, [runId]);
  console.log(JSON.stringify(run, null, 2));

  const { rows: steps } = await client.query(`
    SELECT step_index, status, selector_used, screenshot_key, duration_ms,
           resolution_source, error_type, captured_name, captured_value
    FROM step_results WHERE run_id = $1
    ORDER BY step_index ASC NULLS LAST, created_at ASC`, [runId]);
  for (const s of steps) {
    const shotOk = s.screenshot_key
      ? (s.screenshot_key.startsWith('gs://') ? 'gcs(unchecked)' : String(fs.existsSync(s.screenshot_key)))
      : 'none';
    console.log(JSON.stringify({ ...s, screenshot_exists: shotOk }));
  }

  const { rows: [events] } = await client.query(`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE phase = 'run')::int AS run_level,
           max(seq)::int AS max_seq,
           count(DISTINCT seq)::int AS distinct_seq
    FROM run_events WHERE run_id = $1`, [runId]);
  console.log('run_events:', JSON.stringify(events));

  await client.end();
}

main().catch((e) => { console.error(e.message); process.exit(1); });
