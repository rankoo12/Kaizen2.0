import type { PoolClient } from 'pg';
import { withTenantTransaction } from './transaction';
import { stepContentHash } from '../modules/test-compiler/learned.compiler';
import type { StepAST } from '../types';

/**
 * Shared case-creation path: one implementation of the versioned-steps
 * invariant, two callers (the API's POST /suites/:id/cases and the Test
 * Writer's draft writer).
 *
 * Spec: docs/specs/test-writer/spec-test-writer-service.md §7
 *
 * Generated cases additionally carry a pre-built AST per step (the canonical
 * renderer knows action/target/value definitionally), stored on
 * test_steps.compiled_ast so the run path never has to re-compile them.
 */

export type NewCaseStep = {
  rawText: string;
  /** Pre-built AST for generated steps; null for user-authored text. */
  compiledAst?: StepAST | null;
};

export type NewCase = {
  suiteId: string;
  name: string;
  baseUrl: string;
  steps: NewCaseStep[];
  createdBy?: string | null;
  /** Draft lifecycle (migration 028) — omitted for user-authored cases. */
  status?: 'active' | 'draft' | 'validating' | 'rejected' | 'archived';
  origin?: 'user' | 'generated';
  generationJobId?: string | null;
  archetypeKey?: string | null;
  /**
   * Evidence level, orthogonal to `status` (migration 035). Set by the Test
   * Writer as soon as the case exists so a draft is never ambiguous about why
   * it is a draft; NULL for user-authored cases.
   */
  validationState?: string | null;
  /** Tier-2 expected-fail marker, so RE-runs judge this case correctly too. */
  expectedOutcome?: 'pass' | 'fail' | null;
};

export type CreatedCase = {
  id: string;
  name: string;
  baseUrl: string;
  createdAt: Date;
  updatedAt: Date;
  steps: Array<{ id: string; position: number; rawText: string; contentHash: string }>;
};

/** Creates the case, its immutable step versions, and the active join rows. */
export async function createCase(
  tenantId: string,
  input: NewCase,
  client?: PoolClient,
): Promise<CreatedCase | null> {
  const run = async (db: PoolClient): Promise<CreatedCase | null> => {
    const { rows: suiteRows } = await db.query(
      `SELECT id FROM test_suites WHERE id = $1 AND tenant_id = $2`,
      [input.suiteId, tenantId],
    );
    if (suiteRows.length === 0) return null;

    const { rows: caseRows } = await db.query<{
      id: string; name: string; base_url: string; created_at: Date; updated_at: Date;
    }>(
      // created_by is nullable on purpose: a case created through an API key or
      // by the Test Writer has a tenant but no user behind it.
      `INSERT INTO test_cases (
         tenant_id, suite_id, name, base_url, created_by,
         status, origin, generation_job_id, archetype_key,
         validation_state, expected_outcome
       )
       VALUES ($1, $2, $3, $4, $5, COALESCE($6, 'active'), COALESCE($7, 'user'), $8, $9, $10, $11)
       RETURNING id, name, base_url, created_at, updated_at`,
      [
        tenantId, input.suiteId, input.name, input.baseUrl, input.createdBy ?? null,
        input.status ?? null, input.origin ?? null,
        input.generationJobId ?? null, input.archetypeKey ?? null,
        input.validationState ?? null, input.expectedOutcome ?? null,
      ],
    );
    const created = caseRows[0];

    const steps: CreatedCase['steps'] = [];
    for (let position = 0; position < input.steps.length; position++) {
      const step = input.steps[position];
      const hash = stepContentHash(step.rawText);

      const { rows: stepRes } = await db.query<{ id: string }>(
        `INSERT INTO test_steps (tenant_id, case_id, position, raw_text, content_hash, compiled_ast)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [tenantId, created.id, position, step.rawText, hash,
          step.compiledAst ? JSON.stringify(step.compiledAst) : null],
      );
      const stepId = stepRes[0].id;

      await db.query(
        `INSERT INTO test_case_steps (tenant_id, case_id, step_id, position, is_active)
         VALUES ($1, $2, $3, $4, true)`,
        [tenantId, created.id, stepId, position],
      );

      steps.push({ id: stepId, position, rawText: step.rawText, contentHash: hash });
    }

    return {
      id: created.id,
      name: created.name,
      baseUrl: created.base_url,
      createdAt: created.created_at,
      updatedAt: created.updated_at,
      steps,
    };
  };

  return client ? run(client) : withTenantTransaction(tenantId, run);
}

/**
 * Active steps for a case, with their stored ASTs when present.
 * The run path prefers a stored AST over re-compiling: for generated cases the
 * AST was constructed by the canonical renderer, so compiling its sentence back
 * would spend tokens to rediscover something already known.
 */
export async function loadActiveSteps(
  tenantId: string, caseId: string,
): Promise<Array<{ id: string; rawText: string; compiledAst: StepAST | null }>> {
  return withTenantTransaction(tenantId, async (client) => {
    const { rows } = await client.query<{
      id: string; raw_text: string; compiled_ast: StepAST | null;
    }>(
      `SELECT ts.id, ts.raw_text, ts.compiled_ast
       FROM test_case_steps tcs
       JOIN test_steps ts ON ts.id = tcs.step_id
       WHERE tcs.case_id = $1 AND tcs.tenant_id = $2 AND tcs.is_active = true
       ORDER BY tcs.position`,
      [caseId, tenantId],
    );
    return rows.map((r) => ({ id: r.id, rawText: r.raw_text, compiledAst: r.compiled_ast }));
  });
}
