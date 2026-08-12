import dotenv from 'dotenv';
dotenv.config();

import { getPool, closePool } from '../src/db/pool';
import { withTenantTransaction } from '../src/db/transaction';
import { auditRunOracles, type AuditObservation, type AuditStep } from '../src/modules/test-writer/validate/oracle-audit';

/**
 * Retroactive oracle audit over drafts that were promoted before the audit
 * existed. Spec: docs/specs/test-writer/spec-validation-trust.md §11
 *
 * Every generated draft carrying a validation_run_id was promoted on run status
 * alone, so none of them has ever faced the question "did the assertion check
 * what it claims?". This replays that question against what the runs recorded.
 *
 *   npx tsx scripts/audit-existing-drafts.ts           # report only
 *   npx tsx scripts/audit-existing-drafts.ts --apply   # also stamp validation_state
 *
 * Acceptance fixture: on the dogfood tenant, runs bf259685 / 7c5463f9 / 6a03cac7
 * must come out oracle_unfaithful and f235e94f oracle_self_echo. If they do not,
 * the audit is wrong — not the fixture.
 */

type CaseRow = {
  id: string;
  tenant_id: string;
  name: string;
  validation_run_id: string;
  validation_state: string | null;
  login_case_id: string | null;
  scope: string | null;
  run_status: string;
};

async function loadSteps(tenantId: string, caseId: string): Promise<AuditStep[]> {
  return withTenantTransaction(tenantId, async (client) => {
    const { rows } = await client.query<{ compiled_ast: AuditStep | null }>(
      `SELECT ts.compiled_ast
       FROM test_case_steps tcs
       JOIN test_steps ts ON ts.id = tcs.step_id
       WHERE tcs.case_id = $1
       ORDER BY tcs.position ASC`,
      [caseId],
    );
    return rows.map((r) => ({
      action: r.compiled_ast?.action ?? 'unknown',
      targetDescription: r.compiled_ast?.targetDescription ?? null,
      value: r.compiled_ast?.value ?? null,
    })) as AuditStep[];
  });
}

async function loadObservations(tenantId: string, runId: string): Promise<AuditObservation[]> {
  return withTenantTransaction(tenantId, async (client) => {
    const { rows } = await client.query<{
      step_index: number; selector_used: string | null;
      resolution_source: string | null; healed: boolean;
    }>(
      `SELECT step_index, selector_used, resolution_source,
              (status = 'healed' OR healing_event_id IS NOT NULL) AS healed
       FROM step_results
       WHERE run_id = $1 AND step_index IS NOT NULL
       ORDER BY step_index ASC`,
      [runId],
    );
    return rows.map((r) => ({
      stepIndex: r.step_index,
      selectorUsed: r.selector_used,
      resolutionSource: r.resolution_source,
      healed: r.healed,
    }));
  });
}

/** How many leading steps are the sign-in recipe, not the scenario. */
async function prefixLength(tenantId: string, row: CaseRow): Promise<number> {
  if (row.scope !== 'authenticated' || !row.login_case_id) return 0;
  return withTenantTransaction(tenantId, async (client) => {
    const { rows } = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM test_case_steps WHERE case_id = $1`,
      [row.login_case_id],
    );
    return Number(rows[0]?.n ?? 0);
  });
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const pool = getPool();

  const { rows: cases } = await pool.query<CaseRow>(
    `SELECT tc.id, tc.tenant_id, tc.name, tc.validation_run_id, tc.validation_state,
            gj.login_case_id, gj.scope, r.status::text AS run_status
     FROM test_cases tc
     JOIN runs r ON r.id = tc.validation_run_id
     LEFT JOIN generation_jobs gj ON gj.id = tc.generation_job_id
     WHERE tc.origin = 'generated' AND tc.validation_run_id IS NOT NULL
     ORDER BY tc.created_at ASC`,
  );

  console.log(`Auditing ${cases.length} generated case(s) with a validation run.\n`);

  const tally: Record<string, number> = {};
  let changed = 0;

  for (const row of cases) {
    // The audit judges ORACLE integrity, not run outcome. A case whose run went
    // red was never promoted and must not be graded as though it had been —
    // stamping it from a clean audit would invent evidence that never existed.
    if (row.run_status !== 'passed' && row.run_status !== 'healed') {
      console.log(`- ${row.id.slice(0, 8)} "${row.name}" — not green (run ${row.run_status}), left alone`);
      tally.not_green = (tally.not_green ?? 0) + 1;
      continue;
    }

    const steps = await loadSteps(row.tenant_id, row.id);
    const observations = await loadObservations(row.tenant_id, row.validation_run_id);
    if (steps.length === 0 || observations.length === 0) {
      console.log(`- ${row.id.slice(0, 8)} "${row.name}" — SKIPPED (no steps or no step_results)`);
      tally.skipped = (tally.skipped ?? 0) + 1;
      continue;
    }

    const verdict = auditRunOracles(steps, observations, await prefixLength(row.tenant_id, row));
    const next = !verdict.ok ? 'rejected'
      : verdict.unprovenSignin ? 'unproven_signin'
        : row.run_status === 'healed' ? 'healed'
          : verdict.weakOracle ? 'weak_oracle'
            : 'validated';
    tally[verdict.ok ? next : String(verdict.rule)] = (tally[verdict.ok ? next : String(verdict.rule)] ?? 0) + 1;

    const run = row.validation_run_id.slice(0, 8);
    if (!verdict.ok) {
      console.log(`- ${row.id.slice(0, 8)} run ${run} "${row.name}"`);
      console.log(`    ${verdict.rule}: ${verdict.reason}`);
    } else if (next !== 'validated') {
      console.log(`- ${row.id.slice(0, 8)} run ${run} "${row.name}" → ${next}`);
      for (const f of verdict.findings) console.log(`    ${f}`);
    }

    if (apply && row.validation_state !== next) {
      await withTenantTransaction(row.tenant_id, async (client) => {
        // A case the audit rejects is no longer a proposal: it goes back to
        // 'rejected' so it stops appearing as something the customer can accept.
        await client.query(
          verdict.ok
            ? `UPDATE test_cases SET validation_state = $2 WHERE id = $1`
            : `UPDATE test_cases SET validation_state = NULL, status = 'rejected' WHERE id = $1`,
          verdict.ok ? [row.id, next] : [row.id],
        );
      });
      changed++;
    }
  }

  console.log(`\nSummary: ${JSON.stringify(tally)}`);
  console.log(apply ? `Applied to ${changed} case(s).` : 'Dry run — pass --apply to persist.');
  await closePool();
}

main().catch(async (err) => {
  console.error(err);
  await closePool();
  process.exit(1);
});
