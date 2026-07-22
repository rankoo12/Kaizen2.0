/**
 * Parity-validation helper (worker service decomposition, Phase 1).
 *
 * Finds the most recent completed dogfood run and prints its step texts +
 * per-step statuses, so the decomposed worker can replay the exact same
 * steps and diff the persisted results against the monolith's.
 *
 * Usage: npx tsx scripts/find-parity-case.ts
 * Spec: docs/specs/workers/spec-service-decomposition.md §9
 */
import dotenv from 'dotenv';
import { Client } from 'pg';

dotenv.config();

async function main(): Promise<void> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  const { rows: runs } = await client.query(`
    SELECT r.id, r.status, r.environment_url, r.completed_at, t.slug AS tenant_slug
    FROM runs r JOIN tenants t ON t.id = r.tenant_id
    WHERE r.status IN ('passed', 'healed') AND t.slug = 'test-tenant'
    ORDER BY r.completed_at DESC NULLS LAST
    LIMIT 5`);
  console.log('recent completed runs:');
  console.log(JSON.stringify(runs, null, 2));

  // Exact step texts: POST /runs jobs carry no test_steps back-refs, but the
  // RunLogger 'resolve' events embed the raw text: `step NN · action · "text"`.
  for (const run of runs) {
    const { rows: events } = await client.query(`
      SELECT message FROM run_events
      WHERE run_id = $1 AND phase = 'resolve' AND message LIKE 'step %'
      ORDER BY seq ASC`, [run.id]);
    const texts = events
      .map((e: { message: string }) => /^step \d+ · [^·]+ · "(.*)"$/.exec(e.message)?.[1])
      .filter(Boolean);
    const { rows: statuses } = await client.query(`
      SELECT status FROM step_results WHERE run_id = $1 ORDER BY created_at ASC`, [run.id]);
    console.log(JSON.stringify({
      runId: run.id,
      baseUrl: run.environment_url,
      steps: texts,
      statuses: statuses.map((s: { status: string }) => s.status),
    }, null, 2));
  }

  await client.end();
}

main().catch((e) => { console.error(e.message); process.exit(1); });
