/**
 * Spec ref: docs/spec-integration.md §3.1 — Backend: Missing Test-Case/Suite Routes
 *
 * Routes:
 *   GET    /suites                        — list suites for tenant (with case count)
 *   POST   /suites                        — create suite
 *   PATCH  /suites/:suiteId               — update suite name / description / tags
 *   DELETE /suites/:suiteId               — delete suite and all its cases
 *
 *   GET    /suites/:suiteId/cases         — list cases with last run status
 *   POST   /suites/:suiteId/cases         — create case with initial steps
 *   GET    /cases/:caseId                 — single case with active steps + recent runs
 *   PATCH  /cases/:caseId                 — update name / base_url / steps (versioned)
 *   DELETE /cases/:caseId                 — hard-delete case
 *   POST   /cases/:caseId/run             — enqueue a run for this case
 *
 * All routes require JWT auth (requireAuth middleware → request.tenantId, request.userId).
 * All DB operations use withTenantTransaction for RLS enforcement.
 */

import { createHash } from 'crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { withTenantTransaction } from '../../db/transaction';
import { getPool } from '../../db/pool';
import { createRunQueue } from '../../queue';
import { LearnedCompiler } from '../../modules/test-compiler/learned.compiler';
import { OpenAIGateway } from '../../modules/llm-gateway/openai.gateway';
import { PostgresBillingMeter } from '../../modules/billing-meter/postgres.billing-meter';
import { usageThisMonth } from '../../modules/billing-meter/usage';
import { PinoObservability } from '../../modules/observability/pino.observability';
import { generateFormData } from '../../modules/test-data/generate';
import type { StepAST } from '../../types';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function contentHash(rawText: string): string {
  return createHash('sha256').update(rawText.toLowerCase().trim()).digest('hex');
}

// ─── Zod schemas ─────────────────────────────────────────────────────────────

const CreateSuiteBody = z.object({
  name:        z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  tags:        z.array(z.string()).optional(),
});

const UpdateSuiteBody = z.object({
  name:        z.string().min(1).max(200).optional(),
  description: z.string().max(1000).nullable().optional(),
  tags:        z.array(z.string()).optional(),
  /**
   * Consent for generated tests that create throwaway records (signup, cart).
   * Off by default; set from the analyze dialog or the plan-review footer.
   * Spec: docs/specs/test-writer/spec-generation-pipeline.md §6.2
   */
  allowSyntheticData: z.boolean().optional(),
});

const CreateCaseBody = z.object({
  name:    z.string().min(1).max(300),
  baseUrl: z.string().url(),
  steps:   z.array(z.string().min(1)).min(1, 'At least one step is required'),
});

const CaseListQuery = z.object({
  /**
   * Comma-separated subset of the case statuses
   * (active | draft | validating | rejected | archived).
   * Defaults to active,draft,validating — what a user can act on.
   */
  status: z.string().optional(),
});

/**
 * Transitions the API will perform. `validating` and `rejected` are written only
 * by the Test Writer — a user can archive a rejected case, never resurrect one
 * into the suite without a fresh proving run.
 * Spec: docs/specs/tests-ux/spec-draft-review-ux.md §1
 */
const ALLOWED_STATUS_TRANSITIONS: Record<string, readonly string[]> = {
  draft:    ['active', 'archived'],
  active:   ['archived'],
  archived: ['draft'],          // restore / undo an accept
  rejected: ['archived'],
};

const UpdateCaseBody = z.object({
  name:    z.string().min(1).max(300).optional(),
  baseUrl: z.string().url().optional(),
  steps:   z.array(z.string().min(1)).optional(),
  /** Draft lifecycle: accept (draft→active), dismiss (→archived), restore/undo. */
  status:  z.enum(['active', 'draft', 'archived']).optional(),
});

const RunCaseBody = z.object({
  baseUrl: z.string().url().optional(), // overrides case.base_url if provided
});

const DuplicateCaseBody = z.object({
  name: z.string().min(1).max(300).optional(), // defaults to "<original> (copy)"
});

// ─── Route registration ───────────────────────────────────────────────────────

export async function testCasesRoutes(app: FastifyInstance): Promise<void> {
  const obs     = new PinoObservability(app.log as any);
  const billing = new PostgresBillingMeter(obs);
  const llm     = new OpenAIGateway(billing, obs);
  const compiler = new LearnedCompiler(llm, obs);
  const queue   = createRunQueue();

  // ── GET /suites ─────────────────────────────────────────────────────────────
  app.get('/suites', { preHandler: [requireAuth] }, async (request, reply) => {
    const { tenantId } = request;

    const suites = await withTenantTransaction(tenantId, async (client) => {
      const { rows } = await client.query<{
        id: string; name: string; description: string | null; tags: string[];
        created_at: Date; updated_at: Date; case_count: number;
      }>(
        `SELECT ts.id, ts.name, ts.description, ts.tags,
                ts.created_at, ts.updated_at, ts.allow_synthetic_data,
                COUNT(tc.id)::int AS case_count
         FROM test_suites ts
         LEFT JOIN test_cases tc ON tc.suite_id = ts.id
         WHERE ts.tenant_id = $1
         GROUP BY ts.id
         ORDER BY ts.created_at DESC`,
        [tenantId]
      );
      return rows;
    });

    return reply.send({ suites: suites.map(mapSuite) });
  });

  // ── POST /suites ─────────────────────────────────────────────────────────────
  app.post('/suites', { preHandler: [requireAuth] }, async (request, reply) => {
    const parsed = CreateSuiteBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'INVALID_REQUEST', details: parsed.error.issues });
    }
    const { name, description, tags } = parsed.data;
    const { tenantId } = request;

    const suite = await withTenantTransaction(tenantId, async (client) => {
      const { rows } = await client.query<{
        id: string; name: string; description: string | null; tags: string[];
        created_at: Date; updated_at: Date;
      }>(
        `INSERT INTO test_suites (tenant_id, name, description, tags)
         VALUES ($1, $2, $3, $4)
         RETURNING id, name, description, tags, created_at, updated_at`,
        [tenantId, name, description ?? null, tags ?? []],
      );
      return rows[0];
    });

    return reply.status(201).send({ suite: mapSuite({ ...suite, case_count: 0 }) });
  });

  // ── PATCH /suites/:suiteId ───────────────────────────────────────────────────
  app.patch('/suites/:suiteId', { preHandler: [requireAuth] }, async (request, reply) => {
    const { suiteId } = request.params as { suiteId: string };
    const parsed = UpdateSuiteBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'INVALID_REQUEST', details: parsed.error.issues });
    }
    const { tenantId } = request;
    const updates: string[] = ['updated_at = now()'];
    const values: unknown[]  = [];
    let i = 1;
    if (parsed.data.name        !== undefined) { updates.push(`name        = $${i++}`); values.push(parsed.data.name); }
    if (parsed.data.description !== undefined) { updates.push(`description = $${i++}`); values.push(parsed.data.description); }
    if (parsed.data.tags        !== undefined) { updates.push(`tags        = $${i++}`); values.push(parsed.data.tags); }
    if (parsed.data.allowSyntheticData !== undefined) {
      updates.push(`allow_synthetic_data = $${i++}`); values.push(parsed.data.allowSyntheticData);
    }

    values.push(suiteId);
    values.push(tenantId);

    const suite = await withTenantTransaction(tenantId, async (client) => {
      const { rows } = await client.query<{
        id: string; name: string; description: string | null; tags: string[];
        created_at: Date; updated_at: Date; allow_synthetic_data: boolean;
      }>(
        `UPDATE test_suites SET ${updates.join(', ')}
         WHERE id = $${i} AND tenant_id = $${i + 1}
         RETURNING id, name, description, tags, created_at, updated_at, allow_synthetic_data`,
        values,
      );
      if (rows.length === 0) return null;
      return rows[0];
    });

    if (!suite) return reply.status(404).send({ error: 'SUITE_NOT_FOUND' });
    return reply.send({ suite: mapSuite({ ...suite, case_count: 0 }) });
  });

  // ── DELETE /suites/:suiteId ──────────────────────────────────────────────────
  app.delete('/suites/:suiteId', { preHandler: [requireAuth] }, async (request, reply) => {
    const { suiteId } = request.params as { suiteId: string };
    const { tenantId } = request;

    await withTenantTransaction(tenantId, async (client) => {
      const { rows } = await client.query(`SELECT id FROM test_suites WHERE id = $1 AND tenant_id = $2`, [suiteId, tenantId]);
      if (rows.length === 0) return;

      // Delete join rows and steps before cases (FK order)
      await client.query(
        `DELETE FROM test_case_steps WHERE case_id IN (SELECT id FROM test_cases WHERE suite_id = $1)`,
        [suiteId],
      );
      await client.query(
        `DELETE FROM test_steps WHERE case_id IN (SELECT id FROM test_cases WHERE suite_id = $1)`,
        [suiteId],
      );
      // Detach runs from this suite (runs are kept as historical records)
      await client.query(
        `UPDATE runs SET case_id = NULL, suite_id = NULL WHERE suite_id = $1`,
        [suiteId],
      );
      await client.query(`DELETE FROM test_cases WHERE suite_id = $1`,  [suiteId]);
      await client.query(`DELETE FROM test_suites WHERE id = $1`, [suiteId]);
    });

    return reply.status(204).send();
  });

  // ── GET /suites/:suiteId/cases ───────────────────────────────────────────────
  app.get('/suites/:suiteId/cases', { preHandler: [requireAuth] }, async (request, reply) => {
    const { suiteId } = request.params as { suiteId: string };
    const { tenantId } = request;

    // Default view: what a user acts on — their tests plus anything Kaizen is
    // proposing. `rejected`/`archived` are report-only and must be asked for.
    const parsedQuery = CaseListQuery.safeParse(request.query ?? {});
    if (!parsedQuery.success) {
      return reply.status(400).send({ error: 'INVALID_REQUEST', details: parsedQuery.error.issues });
    }
    const statuses = parsedQuery.data.status
      ? parsedQuery.data.status.split(',').map((s) => s.trim()).filter(Boolean)
      : ['active', 'draft', 'validating'];

    const cases = await withTenantTransaction(tenantId, async (client) => {
      const { rows } = await client.query<{
        id: string; name: string; base_url: string;
        created_at: Date; updated_at: Date;
        status: string; origin: string;
        validation_run_id: string | null; generation_job_id: string | null;
        archetype_key: string | null; validation_state: string | null;
        last_run_id: string | null; last_run_status: string | null; last_run_completed_at: Date | null;
        last_run_duration_ms: number | null; last_run_total_tokens: number | null;
        author_id: string | null; author_name: string | null; author_email: string | null;
        runs: string | null; passed: string | null; healed: string | null; failed: string | null;
        avg_duration_ms: number | null;
        lookups: string | null; cached: string | null;
        first_run_tokens: string | null;
      }>(
        // LEFT JOIN, not inner: cases predating migration 030 have no created_by, and so
        // do cases created through an API key. They must still appear in the list.
        `SELECT tc.id, tc.name, tc.base_url, tc.created_at, tc.updated_at,
                -- Draft lifecycle (migration 028/032): without these the web cannot
                -- tell a Kaizen-written draft from a test the user owns.
                tc.status, tc.origin, tc.validation_run_id, tc.generation_job_id, tc.archetype_key,
                tc.validation_state,
                st.runs, st.passed, st.healed, st.failed, st.avg_duration_ms,
                ch.lookups, ch.cached,
                ft.tokens        AS first_run_tokens,
                au.id            AS author_id,
                au.display_name  AS author_name,
                au.email         AS author_email,
                lr.id            AS last_run_id,
                lr.status        AS last_run_status,
                lr.completed_at  AS last_run_completed_at,
                lr.duration_ms   AS last_run_duration_ms,
                lr.total_tokens  AS last_run_total_tokens
         FROM test_cases tc
         LEFT JOIN LATERAL (
           SELECT r.id, r.status, r.completed_at,
                  (EXTRACT(EPOCH FROM (r.completed_at - r.started_at)) * 1000)::int AS duration_ms,
                  -- Tokens come from the run's own step results, which carry a run_id.
                  -- This used to sum billing_events falling inside the run's time window;
                  -- billing_events has no run_id, so a row written a moment after
                  -- completed_at was dropped and the run reported "free" while its steps
                  -- plainly showed an AI resolution. Two sources, two answers.
                  COALESCE((SELECT SUM(sr.tokens_used)::int FROM step_results sr
                             WHERE sr.run_id = r.id), 0) AS total_tokens
           FROM runs r
           WHERE r.case_id = tc.id
           ORDER BY r.created_at DESC
           LIMIT 1
         ) lr ON true
         LEFT JOIN users au ON au.id = tc.created_by
         -- Per-case aggregates. Computed rather than read from a rollup table: measured
         -- at ~1.1ms for a whole tenant, against a rollup's cost of a write seam in
         -- worker.ts and a staleness class of bug.
         -- Spec: docs/specs/roadmap/spec-cost-history-and-case-stats.md §2
         LEFT JOIN LATERAL (
           SELECT COUNT(*)                                              AS runs,
                  COUNT(*) FILTER (WHERE ar.status = 'passed')          AS passed,
                  COUNT(*) FILTER (WHERE ar.status = 'healed')          AS healed,
                  COUNT(*) FILTER (WHERE ar.status = 'failed')          AS failed,
                  AVG(EXTRACT(EPOCH FROM (ar.completed_at - ar.started_at)) * 1000)
                    FILTER (WHERE ar.completed_at IS NOT NULL)::int     AS avg_duration_ms
             FROM runs ar
            WHERE ar.case_id = tc.id
         ) st ON true
         -- Lookups vs. lookups that avoided the model. resolution_source, not
         -- step_results.cache_hit — that column has never been written.
         LEFT JOIN LATERAL (
           SELECT COUNT(*) FILTER (WHERE sr2.resolution_source IS NOT NULL) AS lookups,
                  COUNT(*) FILTER (WHERE sr2.resolution_source IS NOT NULL
                                     AND sr2.resolution_source <> 'llm')    AS cached
             FROM runs ar2
             JOIN step_results sr2 ON sr2.run_id = ar2.id
            WHERE ar2.case_id = tc.id
         ) ch ON true
         -- The pair that shows the claim on one row: what learning cost, what it costs now.
         LEFT JOIN LATERAL (
           SELECT (SELECT COALESCE(SUM(s.tokens_used), 0) FROM step_results s WHERE s.run_id = fr.id) AS tokens
             FROM runs fr WHERE fr.case_id = tc.id ORDER BY fr.created_at ASC LIMIT 1
         ) ft ON true
         WHERE tc.suite_id = $1 AND tc.tenant_id = $2
           AND tc.status = ANY($3::text[])
         ORDER BY tc.created_at DESC`,
        [suiteId, tenantId, statuses],
      );
      return rows;
    });

    return reply.send({ cases: cases.map(mapCaseSummary) });
  });

  // ── POST /suites/:suiteId/cases ──────────────────────────────────────────────
  app.post('/suites/:suiteId/cases', { preHandler: [requireAuth] }, async (request, reply) => {
    const { suiteId } = request.params as { suiteId: string };
    const parsed = CreateCaseBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'INVALID_REQUEST', details: parsed.error.issues });
    }
    const { name, baseUrl, steps } = parsed.data;
    const { tenantId } = request;

    const result = await withTenantTransaction(tenantId, async (client) => {
      // Verify suite belongs to tenant
      const { rows: suiteRows } = await client.query(
        `SELECT id FROM test_suites WHERE id = $1 AND tenant_id = $2`,
        [suiteId, tenantId],
      );
      if (suiteRows.length === 0) return null;

      // Create case
      const { rows: caseRows } = await client.query<{
        id: string; name: string; base_url: string; created_at: Date; updated_at: Date;
      }>(
        // created_by is nullable on purpose: a case created through an API key has a
        // tenant but no user behind it, and inventing one would be worse than none.
        // Spec: docs/specs/roadmap/spec-keys-quota-authorship.md §6
        `INSERT INTO test_cases (tenant_id, suite_id, name, base_url, created_by)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, name, base_url, created_at, updated_at, created_by`,
        [tenantId, suiteId, name, baseUrl, request.userId ?? null],
      );
      const newCase = caseRows[0];

      // Insert steps and join rows
      const stepRows: { id: string; position: number; raw_text: string; content_hash: string }[] = [];
      for (let pos = 0; pos < steps.length; pos++) {
        const rawText = steps[pos];
        const hash    = contentHash(rawText);

        const { rows: stepRes } = await client.query<{ id: string }>(
          `INSERT INTO test_steps (tenant_id, case_id, position, raw_text, content_hash)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id`,
          [tenantId, newCase.id, pos, rawText, hash],
        );
        const stepId = stepRes[0].id;

        await client.query(
          `INSERT INTO test_case_steps (tenant_id, case_id, step_id, position, is_active)
           VALUES ($1, $2, $3, $4, true)`,
          [tenantId, newCase.id, stepId, pos],
        );

        stepRows.push({ id: stepId, position: pos, raw_text: rawText, content_hash: hash });
      }

      return { case: newCase, steps: stepRows };
    });

    if (!result) return reply.status(404).send({ error: 'SUITE_NOT_FOUND' });

    return reply.status(201).send({
      case: {
        id:        result.case.id,
        name:      result.case.name,
        baseUrl:   result.case.base_url,
        suiteId,
        createdAt: result.case.created_at,
        updatedAt: result.case.updated_at,
        steps:     result.steps.map((s) => ({
          id:          s.id,
          position:    s.position,
          rawText:     s.raw_text,
          contentHash: s.content_hash,
        })),
        lastRun: null,
      },
    });
  });

  // ── GET /cases/:caseId ────────────────────────────────────────────────────────
  app.get('/cases/:caseId', { preHandler: [requireAuth] }, async (request, reply) => {
    const { caseId } = request.params as { caseId: string };
    const { tenantId } = request;

    const result = await withTenantTransaction(tenantId, async (client) => {
      const { rows: caseRows } = await client.query<{
        id: string; name: string; base_url: string; suite_id: string;
        created_at: Date; updated_at: Date;
        author_id: string | null; author_name: string | null; author_email: string | null;
      }>(
        `SELECT tc.id, tc.name, tc.base_url, tc.suite_id, tc.created_at, tc.updated_at,
                au.id AS author_id, au.display_name AS author_name, au.email AS author_email
           FROM test_cases tc
           LEFT JOIN users au ON au.id = tc.created_by
          WHERE tc.id = $1 AND tc.tenant_id = $2`,
        [caseId, tenantId],
      );
      if (caseRows.length === 0) return null;

      const { rows: stepRows } = await client.query<{
        id: string; position: number; raw_text: string; content_hash: string;
      }>(
        `SELECT ts.id, tcs.position, ts.raw_text, ts.content_hash
         FROM test_case_steps tcs
         JOIN test_steps ts ON ts.id = tcs.step_id
         WHERE tcs.case_id = $1 AND tcs.is_active = true
         ORDER BY tcs.position`,
        [caseId],
      );

      const { rows: runRows } = await client.query<{
        id: string; status: string; triggered_by: string;
        created_at: Date; completed_at: Date | null;
        duration_ms: number | null; total_tokens: number | null;
      }>(
        `SELECT r.id, r.status, r.triggered_by, r.created_at, r.completed_at,
                (EXTRACT(EPOCH FROM (r.completed_at - r.started_at)) * 1000)::int AS duration_ms,
                -- Same run-scoped sum as the case list; see the note there.
                COALESCE((SELECT SUM(sr.tokens_used)::int FROM step_results sr
                           WHERE sr.run_id = r.id), 0) AS total_tokens
         FROM runs r
         JOIN test_cases tc ON tc.id = r.case_id
         WHERE r.case_id = $1
         ORDER BY r.created_at DESC LIMIT 10`,
        [caseId],
      );

      return { case: caseRows[0], steps: stepRows, recentRuns: runRows };
    });

    if (!result) return reply.status(404).send({ error: 'CASE_NOT_FOUND' });

    return reply.send({
      case: {
        id:         result.case.id,
        name:       result.case.name,
        baseUrl:    result.case.base_url,
        suiteId:    result.case.suite_id,
        createdAt:  result.case.created_at,
        updatedAt:  result.case.updated_at,
        // Null for pre-030 cases and API-key-created ones. Rendered as nothing.
        createdBy:  result.case.author_id ? {
          id:          result.case.author_id,
          displayName: result.case.author_name,
          email:       result.case.author_email ?? '',
        } : null,
        steps:      result.steps.map((s) => ({
          id:          s.id,
          position:    s.position,
          rawText:     s.raw_text,
          contentHash: s.content_hash,
        })),
        recentRuns: result.recentRuns.map((r) => ({
          id:          r.id,
          status:      r.status,
          triggeredBy: r.triggered_by,
          createdAt:   r.created_at,
          completedAt: r.completed_at,
          durationMs:  r.duration_ms,
          totalTokens: r.total_tokens,
        })),
      },
    });
  });

  // ── PATCH /cases/:caseId ──────────────────────────────────────────────────────
  app.patch('/cases/:caseId', { preHandler: [requireAuth] }, async (request, reply) => {
    const { caseId } = request.params as { caseId: string };
    const parsed = UpdateCaseBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'INVALID_REQUEST', details: parsed.error.issues });
    }
    const { tenantId } = request;

    const result = await withTenantTransaction(tenantId, async (client) => {
      // A status change is a lifecycle transition, not a field write: check what
      // the case is now before allowing where it may go.
      if (parsed.data.status !== undefined) {
        const { rows: current } = await client.query<{ status: string }>(
          `SELECT status FROM test_cases WHERE id = $1 AND tenant_id = $2`,
          [caseId, tenantId],
        );
        if (current.length === 0) return null;
        const from = current[0].status;
        const to = parsed.data.status;
        if (from !== to && !(ALLOWED_STATUS_TRANSITIONS[from] ?? []).includes(to)) {
          return { invalidTransition: { from, to } } as const;
        }
      }

      const caseUpdates: string[] = ['updated_at = now()'];
      const caseVals: unknown[]   = [];
      let vi = 1;
      if (parsed.data.name    !== undefined) { caseUpdates.push(`name     = $${vi++}`); caseVals.push(parsed.data.name); }
      if (parsed.data.baseUrl !== undefined) { caseUpdates.push(`base_url = $${vi++}`); caseVals.push(parsed.data.baseUrl); }
      if (parsed.data.status  !== undefined) { caseUpdates.push(`status   = $${vi++}`); caseVals.push(parsed.data.status); }
      caseVals.push(caseId);
      caseVals.push(tenantId);

      const { rows: caseRows } = await client.query<{
        id: string; name: string; base_url: string; suite_id: string; status: string;
        created_at: Date; updated_at: Date;
      }>(
        `UPDATE test_cases SET ${caseUpdates.join(', ')}
         WHERE id = $${vi} AND tenant_id = $${vi + 1}
         RETURNING id, name, base_url, suite_id, status, created_at, updated_at`,
        caseVals,
      );
      if (caseRows.length === 0) return null;

      // Replace steps using versioning protocol if new steps array provided
      if (parsed.data.steps !== undefined) {
        const newSteps = parsed.data.steps;

        // Deactivate all current active steps
        await client.query(
          `UPDATE test_case_steps SET is_active = false WHERE case_id = $1 AND is_active = true`,
          [caseId],
        );

        // Insert new step versions
        for (let pos = 0; pos < newSteps.length; pos++) {
          const rawText = newSteps[pos];
          const hash    = contentHash(rawText);

          // Check if step with same content_hash already exists for this case
          const { rows: existingStep } = await client.query<{ id: string }>(
            `SELECT id FROM test_steps WHERE case_id = $1 AND content_hash = $2 LIMIT 1`,
            [caseId, hash],
          );

          let stepId: string;
          if (existingStep.length > 0) {
            stepId = existingStep[0].id;
          } else {
            const { rows: newStepRows } = await client.query<{ id: string }>(
              `INSERT INTO test_steps (tenant_id, case_id, position, raw_text, content_hash)
               VALUES ($1, $2, $3, $4, $5) RETURNING id`,
              [tenantId, caseId, pos, rawText, hash],
            );
            stepId = newStepRows[0].id;
          }

          await client.query(
            `INSERT INTO test_case_steps (tenant_id, case_id, step_id, position, is_active)
             VALUES ($1, $2, $3, $4, true)
             ON CONFLICT DO NOTHING`,
            [tenantId, caseId, stepId, pos],
          );
        }
      }

      // Return updated steps
      const { rows: stepRows } = await client.query<{
        id: string; position: number; raw_text: string; content_hash: string;
      }>(
        `SELECT ts.id, tcs.position, ts.raw_text, ts.content_hash
         FROM test_case_steps tcs
         JOIN test_steps ts ON ts.id = tcs.step_id
         WHERE tcs.case_id = $1 AND tcs.is_active = true
         ORDER BY tcs.position`,
        [caseId],
      );

      return { case: caseRows[0], steps: stepRows };
    });

    if (!result) return reply.status(404).send({ error: 'CASE_NOT_FOUND' });
    if ('invalidTransition' in result && result.invalidTransition) {
      const { from, to } = result.invalidTransition;
      return reply.status(400).send({
        error: 'INVALID_STATUS_TRANSITION',
        message: `A case cannot go from ${from} to ${to}.`,
      });
    }

    return reply.send({
      case: {
        id:        result.case.id,
        name:      result.case.name,
        baseUrl:   result.case.base_url,
        suiteId:   result.case.suite_id,
        status:    result.case.status,
        createdAt: result.case.created_at,
        updatedAt: result.case.updated_at,
        steps:     result.steps.map((s) => ({
          id:          s.id,
          position:    s.position,
          rawText:     s.raw_text,
          contentHash: s.content_hash,
        })),
      },
    });
  });

  // ── DELETE /cases/:caseId ─────────────────────────────────────────────────────
  app.delete('/cases/:caseId', { preHandler: [requireAuth] }, async (request, reply) => {
    const { caseId } = request.params as { caseId: string };
    const { tenantId } = request;

    await withTenantTransaction(tenantId, async (client) => {
      const { rows } = await client.query(`SELECT id FROM test_cases WHERE id = $1 AND tenant_id = $2`, [caseId, tenantId]);
      if (rows.length === 0) return;

      // Order matters: step_results reference test_steps (and healing_events
      // reference step_results), so evidence has to go before the steps that
      // produced it. Skipping this made DELETE fail with a 23503 FK violation on
      // any case that had ever run — i.e. every case worth deleting.
      await client.query(
        `DELETE FROM healing_events
          WHERE step_result_id IN (
            SELECT sr.id FROM step_results sr
             WHERE sr.run_id IN (SELECT id FROM runs WHERE case_id = $1)
                OR sr.step_id IN (SELECT id FROM test_steps WHERE case_id = $1))`,
        [caseId],
      );
      await client.query(
        `DELETE FROM step_results
          WHERE run_id IN (SELECT id FROM runs WHERE case_id = $1)
             OR step_id IN (SELECT id FROM test_steps WHERE case_id = $1)`,
        [caseId],
      );
      /* test_cases.validation_run_id and the generation_jobs table belong to the
         test-writer feature, whose migrations (028_test_writer, 029_site_model) live on
         an unmerged branch. A database built from db/migrations/ — production, CI, any
         fresh clone — does not have them, and referencing a missing column aborts the
         whole transaction, so DELETE returned 500 on every case there while working
         locally on machines that had the extra migrations applied.

         Probing the catalog keeps one code path correct on both schemas. When the
         test-writer branch merges, both flags become permanently true and this can
         collapse back to unconditional statements.
         Spec: docs/specs/roadmap/spec-keys-quota-authorship.md §3 */
      const { rows: [caps] } = await client.query<{ has_validation_col: boolean; has_generation_jobs: boolean }>(
        `SELECT
           EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'test_cases'
                      AND column_name = 'validation_run_id') AS has_validation_col,
           to_regclass('public.generation_jobs') IS NOT NULL   AS has_generation_jobs`,
      );

      // A run can be another case's validation run; release that pointer first.
      if (caps?.has_validation_col) {
        await client.query(
          `UPDATE test_cases SET validation_run_id = NULL
            WHERE validation_run_id IN (SELECT id FROM runs WHERE case_id = $1)`,
          [caseId],
        );
      }
      // run_events cascade from runs.
      await client.query(`DELETE FROM runs WHERE case_id = $1`, [caseId]);
      if (caps?.has_generation_jobs) {
        await client.query(`UPDATE generation_jobs SET login_case_id = NULL WHERE login_case_id = $1`, [caseId]);
      }
      await client.query(`DELETE FROM test_case_steps WHERE case_id = $1`, [caseId]);
      await client.query(`DELETE FROM test_steps WHERE case_id = $1`,      [caseId]);
      await client.query(`DELETE FROM test_cases WHERE id = $1`,           [caseId]);
    });

    return reply.status(204).send();
  });

  // ── POST /cases/:caseId/duplicate ─────────────────────────────────────────────
  // Clones a case's active steps + config into a new case in the same suite.
  // Run history, step_results, and screenshots are NOT copied.
  // Spec: docs/specs/tests-ux/spec-duplicate-case-and-generated-data.md §1
  app.post('/cases/:caseId/duplicate', { preHandler: [requireAuth] }, async (request, reply) => {
    const { caseId } = request.params as { caseId: string };
    const parsed = DuplicateCaseBody.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ error: 'INVALID_REQUEST', details: parsed.error.issues });
    }
    const { tenantId } = request;

    const result = await withTenantTransaction(tenantId, async (client) => {
      // Source case
      const { rows: srcRows } = await client.query<{
        id: string; suite_id: string; name: string; base_url: string;
      }>(
        `SELECT id, suite_id, name, base_url FROM test_cases WHERE id = $1 AND tenant_id = $2`,
        [caseId, tenantId],
      );
      if (srcRows.length === 0) return null;
      const src = srcRows[0];

      // Source active steps in order
      const { rows: srcSteps } = await client.query<{ raw_text: string; content_hash: string; position: number }>(
        `SELECT ts.raw_text, ts.content_hash, tcs.position
         FROM test_case_steps tcs
         JOIN test_steps ts ON ts.id = tcs.step_id
         WHERE tcs.case_id = $1 AND tcs.is_active = true
         ORDER BY tcs.position`,
        [caseId],
      );

      const newName = parsed.data.name ?? `${src.name} (copy)`;

      const { rows: caseRows } = await client.query<{
        id: string; name: string; base_url: string; created_at: Date; updated_at: Date;
      }>(
        // The duplicate's author is whoever duplicated it, not the original's author —
        // it is a new test that this person is now responsible for.
        `INSERT INTO test_cases (tenant_id, suite_id, name, base_url, created_by)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, name, base_url, created_at, updated_at, created_by`,
        [tenantId, src.suite_id, newName, src.base_url, request.userId ?? null],
      );
      const newCase = caseRows[0];

      const stepRows: { id: string; position: number; raw_text: string; content_hash: string }[] = [];
      for (const s of srcSteps) {
        const { rows: stepRes } = await client.query<{ id: string }>(
          `INSERT INTO test_steps (tenant_id, case_id, position, raw_text, content_hash)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id`,
          [tenantId, newCase.id, s.position, s.raw_text, s.content_hash],
        );
        const stepId = stepRes[0].id;
        await client.query(
          `INSERT INTO test_case_steps (tenant_id, case_id, step_id, position, is_active)
           VALUES ($1, $2, $3, $4, true)`,
          [tenantId, newCase.id, stepId, s.position],
        );
        stepRows.push({ id: stepId, position: s.position, raw_text: s.raw_text, content_hash: s.content_hash });
      }

      return { case: newCase, suiteId: src.suite_id, steps: stepRows };
    });

    if (!result) return reply.status(404).send({ error: 'CASE_NOT_FOUND' });

    return reply.status(201).send({
      case: {
        id:        result.case.id,
        name:      result.case.name,
        baseUrl:   result.case.base_url,
        suiteId:   result.suiteId,
        createdAt: result.case.created_at,
        updatedAt: result.case.updated_at,
        steps:     result.steps.map((s) => ({
          id: s.id, position: s.position, rawText: s.raw_text, contentHash: s.content_hash,
        })),
        lastRun: null,
      },
    });
  });

  // ── POST /cases/:caseId/run ───────────────────────────────────────────────────
  app.post('/cases/:caseId/run', { preHandler: [requireAuth] }, async (request, reply) => {
    const { caseId } = request.params as { caseId: string };
    const parsed = RunCaseBody.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ error: 'INVALID_REQUEST', details: parsed.error.issues });
    }
    const { tenantId } = request;

    // Fetch case + active steps inside tenant transaction
    const caseData = await withTenantTransaction(tenantId, async (client) => {
      const { rows: caseRows } = await client.query<{
        id: string; suite_id: string; base_url: string; status: string;
      }>(
        `SELECT id, suite_id, base_url, status FROM test_cases WHERE id = $1 AND tenant_id = $2`,
        [caseId, tenantId],
      );
      if (caseRows.length === 0) return null;

      // Select ts.id alongside raw_text so the worker can populate
      // step_results.step_id — without it, runs.ts can't LEFT JOIN to recover
      // the step's natural-language text for the timeline display.
      // Spec: docs/specs/workers/spec-live-run-updates.md §5.1.1
      // compiled_ast is populated for Test-Writer-generated steps: the canonical
      // renderer built the AST definitionally, so re-compiling its own sentence
      // would spend tokens rediscovering what is already known.
      // Spec: docs/specs/test-writer/spec-generation-pipeline.md §3
      const { rows: stepRows } = await client.query<{
        id: string; raw_text: string; compiled_ast: StepAST | null;
      }>(
        `SELECT ts.id, ts.raw_text, ts.compiled_ast
         FROM test_case_steps tcs
         JOIN test_steps ts ON ts.id = tcs.step_id
         WHERE tcs.case_id = $1 AND tcs.is_active = true
         ORDER BY tcs.position`,
        [caseId],
      );

      return {
        ...caseRows[0],
        steps:   stepRows.map((r) => r.raw_text),
        stepIds: stepRows.map((r) => r.id),
        storedAsts: stepRows.map((r) => r.compiled_ast),
      };
    });

    if (!caseData) return reply.status(404).send({ error: 'CASE_NOT_FOUND' });

    // A draft has not been accepted into the suite yet, and a rejected case
    // failed its proving run — neither is part of what "green" means here.
    if (caseData.status !== 'active') {
      return reply.status(400).send({
        error: 'CASE_NOT_ACTIVE',
        message: caseData.status === 'draft'
          ? 'This test is a draft Kaizen proposed. Accept it into the suite before running it.'
          : `A ${caseData.status} test cannot be run.`,
        status: caseData.status,
      });
    }

    const { rows: budgetRows } = await getPool().query<{ llm_budget_tokens_monthly: string }>(
      `SELECT llm_budget_tokens_monthly FROM tenants WHERE id = $1`,
      [tenantId],
    );
    const budget = Number(budgetRows[0]?.llm_budget_tokens_monthly ?? 0);
    if (budget <= 0) {
      return reply.status(402).send({
        error: 'INSUFFICIENT_TOKENS',
        message: 'This account has no LLM tokens allocated. Contact the workspace owner to enable runs.',
      });
    }

    const used = await usageThisMonth(tenantId);
    if (used >= budget) {
      return reply.status(402).send({
        error: 'TOKEN_LIMIT_REACHED',
        message: `Token limit reached (${budget.toLocaleString()}). Used ${used.toLocaleString()} this month.`,
        used,
        budget,
      });
    }

    const baseUrl = parsed.data.baseUrl ?? caseData.base_url;

    // Compile natural-language steps → AST, reusing any stored AST as-is.
    const compiledSteps = await Promise.all(
      caseData.steps.map(async (rawText, i) => caseData.storedAsts[i] ?? compiler.compile(rawText)),
    );

    // Create run record and enqueue
    const { rows } = await getPool().query<{ id: string }>(
      // total_steps: the run's length at the moment it was created. Not derivable
      // later — the case's active steps can change mid-run now that tests are
      // editable. Spec: docs/specs/roadmap/spec-phase-0-plumbing.md §3
      `INSERT INTO runs (tenant_id, suite_id, case_id, triggered_by, status, environment_url, total_steps)
       VALUES ($1, $2, $3, 'web', 'queued', $4, $5)
       RETURNING id`,
      [tenantId, caseData.suite_id, caseId, baseUrl, compiledSteps.length],
    );
    const runId = rows[0].id;

    await queue.add('run', {
      runId,
      tenantId,
      compiledSteps,
      // Parallel array: stepIds[i] is the test_steps.id corresponding to
      // compiledSteps[i]. The worker writes step_results.step_id from this so
      // the runs API can LEFT JOIN test_steps and surface the original text.
      stepIds: caseData.stepIds,
      baseUrl,
      // Generated form data ({{firstName}}, {{email}}, …) seeded into the run
      // context so steps register unique data each run.
      // Spec: docs/specs/tests-ux/spec-duplicate-case-and-generated-data.md §2
      seedVariables: generateFormData(),
    });

    return reply.status(202).send({ runId, status: 'queued' });
  });
}

// ─── Mappers ──────────────────────────────────────────────────────────────────

function mapSuite(row: {
  id: string; name: string; description: string | null; tags: string[];
  created_at: Date; updated_at: Date; case_count: number;
  allow_synthetic_data?: boolean;
}) {
  return {
    id:          row.id,
    name:        row.name,
    description: row.description,
    tags:        row.tags ?? [],
    caseCount:   row.case_count,
    allowSyntheticData: row.allow_synthetic_data ?? false,
    createdAt:   row.created_at,
    updatedAt:   row.updated_at,
  };
}

function mapCaseSummary(row: {
  id: string; name: string; base_url: string;
  created_at: Date; updated_at: Date;
  status?: string; origin?: string;
  validation_run_id?: string | null; generation_job_id?: string | null;
  archetype_key?: string | null; validation_state?: string | null;
  last_run_id: string | null; last_run_status: string | null;
  last_run_completed_at: Date | null;
  last_run_duration_ms: number | null;
  last_run_total_tokens: number | null;
  author_id?: string | null;
  author_name?: string | null;
  author_email?: string | null;
  runs?: string | null;
  passed?: string | null;
  healed?: string | null;
  failed?: string | null;
  avg_duration_ms?: number | null;
  lookups?: string | null;
  cached?: string | null;
  first_run_tokens?: string | null;
}) {
  return {
    id:        row.id,
    name:      row.name,
    baseUrl:   row.base_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // Draft lifecycle + provenance. A generated test keeps its origin and the id
    // of the run that proved it for as long as it exists.
    status:    row.status ?? 'active',
    origin:    row.origin ?? 'user',
    validationRunId:  row.validation_run_id ?? null,
    // The EVIDENCE behind a draft, which validationRunId alone cannot express:
    // a healed run and a clean one both have an id (migration 035).
    validationState:  row.validation_state ?? null,
    generationJobId:  row.generation_job_id ?? null,
    archetypeKey:     row.archetype_key ?? null,
    // null for cases written before migration 030 and for anything created through an
    // API key. The UI shows nothing at all rather than "Unknown" — an absent author is
    // a fact about the record, not a person we failed to name.
    createdBy: row.author_id ? {
      id:          row.author_id,
      displayName: row.author_name ?? null,
      email:       row.author_email ?? '',
    } : null,
    lastRun: row.last_run_id ? {
      id:          row.last_run_id,
      status:      row.last_run_status,
      completedAt: row.last_run_completed_at,
      durationMs:  row.last_run_duration_ms,
      totalTokens: row.last_run_total_tokens,
    } : null,
    stats: (() => {
      const lookups = Number(row.lookups ?? 0);
      return {
        runs:   Number(row.runs   ?? 0),
        passed: Number(row.passed ?? 0),
        healed: Number(row.healed ?? 0),
        failed: Number(row.failed ?? 0),
        avgDurationMs: row.avg_duration_ms ?? null,
        // null, not 0, when nothing has ever been looked up. Zero means "every lookup
        // needed the model", which is the opposite of "nothing measured yet", and the
        // Tests screen must not render them the same.
        cacheHitPct: lookups > 0 ? Math.round((Number(row.cached ?? 0) / lookups) * 100) : null,
        // What learning cost, beside what it costs now — the product's claim on one row.
        firstRunTokens: row.first_run_tokens != null ? Number(row.first_run_tokens) : null,
        lastRunTokens:  row.last_run_total_tokens ?? null,
      };
    })(),
  };
}
