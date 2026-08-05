/** TEMP smoke test: run the visual validator against the 3 known reds' existing screenshots. Delete after. */
import pg from 'pg';
import { validateVisually } from './lib/visual';
import { ALL_TESTS } from './fixtures';
import type { RunResult, StepResult } from './lib/types';

const PG_URL = process.env.DATABASE_URL ?? 'postgres://kaizen:kaizen@127.0.0.1:5432/kaizen';
const CASES = [
  { id: 'formy-radio-college', runId: 'f89362a2-d320-47e2-8269-c39aed0ca6ee' },
  { id: 'sd-product-detail-add', runId: 'f341ac8a-021a-4db5-bfe7-de34278b031f' },
  { id: 'sd-remove-from-cart', runId: 'd735028b-3402-4097-b0b0-04e821831225' },
];

async function main() {
  const pgc = new pg.Client({ connectionString: PG_URL });
  await pgc.connect();
  for (const c of CASES) {
    const test = ALL_TESTS.find((t) => t.id === c.id)!;
    const { rows } = await pgc.query(
      `SELECT step_index AS index, status, resolution_source AS src, coalesce(tokens_used,0)::int AS tok,
              coalesce(duration_ms,0)::int AS dur, coalesce(selector_used,'') AS sel,
              captured_name AS "capturedName", captured_value AS "capturedValue", screenshot_key AS shot
         FROM step_results WHERE run_id=$1 ORDER BY step_index ASC NULLS LAST`, [c.runId]);
    const run: RunResult = { runId: c.runId, status: 'failed', resolutionTokens: 0, llmResolvedSteps: 0, cacheResolvedSteps: 0, steps: rows as StepResult[] };
    const v = await validateVisually(test, run);
    console.log(`\n=== ${c.id} (oracle: FAILED) ===`);
    console.log(`  ran=${v.ran} pass=${v.pass} conf=${v.confidence ?? '-'} step=${v.stepIndex}`);
    console.log(`  observed: ${v.observed ?? ''}`);
    console.log(`  reason:   ${v.reason}`);
    if (v.error) console.log(`  error:    ${v.error}`);
  }
  await pgc.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
