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
});

const CreateCaseBody = z.object({
  name:    z.string().min(1).max(300),
  baseUrl: z.string().url(),
  steps:   z.array(z.string().min(1)).min(1, 'At least one step is required'),
});

const UpdateCaseBody = z.object({
  name:    z.string().min(1).max(300).optional(),
  baseUrl: z.string().url().optional(),
  steps:   z.array(z.string().min(1)).optional(),
});

const RunCaseBody = z.object({
  baseUrl: z.string().url().optional(), // overrides case.base_url if provided
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
                ts.created_at, ts.updated_at,
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

    values.push(suiteId);
    values.push(tenantId);

    const suite = await withTenantTransaction(tenantId, async (client) => {
      const { rows } = await client.query<{
        id: string; name: string; description: string | null; tags: string[];
        created_at: Date; updated_at: Date;
      }>(
        `UPDATE test_suites SET ${updates.join(', ')}
         WHERE id = $${i} AND tenant_id = $${i + 1}
         RETURNING id, name, description, tags, created_at, updated_at`,
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

    const cases = await withTenantTransaction(tenantId, async (client) => {
      const { rows } = await client.query<{
        id: string; name: string; base_url: string;
        created_at: Date; updated_at: Date;
        last_run_id: string | null; last_run_status: string | null; last_run_completed_at: Date | null;
        last_run_duration_ms: number | null; last_run_total_tokens: number | null;
      }>(
        `SELECT tc.id, tc.name, tc.base_url, tc.created_at, tc.updated_at,
                lr.id            AS last_run_id,
                lr.status        AS last_run_status,
                lr.completed_at  AS last_run_completed_at,
                lr.duration_ms   AS last_run_duration_ms,
                lr.total_tokens  AS last_run_total_tokens
         FROM test_cases tc
         LEFT JOIN LATERAL (
           SELECT r.id, r.status, r.completed_at,
                  (EXTRACT(EPOCH FROM (r.completed_at - r.started_at)) * 1000)::int AS duration_ms,
                  (SELECT SUM(quantity)::int FROM billing_events 
                   WHERE tenant_id = tc.tenant_id 
                     AND event_type = 'LLM_CALL' 
                     AND created_at >= r.started_at 
                     AND created_at <= COALESCE(r.completed_at, now())
                  ) AS total_tokens
           FROM runs r
           WHERE r.case_id = tc.id
           ORDER BY r.created_at DESC
           LIMIT 1
         ) lr ON true
         WHERE tc.suite_id = $1 AND tc.tenant_id = $2
         ORDER BY tc.created_at DESC`,
        [suiteId, tenantId],
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
        `INSERT INTO test_cases (tenant_id, suite_id, name, base_url)
         VALUES ($1, $2, $3, $4)
         RETURNING id, name, base_url, created_at, updated_at`,
        [tenantId, suiteId, name, baseUrl],
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
      }>(
        `SELECT id, name, base_url, suite_id, created_at, updated_at FROM test_cases WHERE id = $1 AND tenant_id = $2`,
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
                (SELECT SUM(quantity)::int FROM billing_events 
                 WHERE tenant_id = tc.tenant_id 
                   AND event_type = 'LLM_CALL' 
                   AND created_at >= r.started_at 
                   AND created_at <= COALESCE(r.completed_at, now())
                ) AS total_tokens
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
      const caseUpdates: string[] = ['updated_at = now()'];
      const caseVals: unknown[]   = [];
      let vi = 1;
      if (parsed.data.name    !== undefined) { caseUpdates.push(`name     = $${vi++}`); caseVals.push(parsed.data.name); }
      if (parsed.data.baseUrl !== undefined) { caseUpdates.push(`base_url = $${vi++}`); caseVals.push(parsed.data.baseUrl); }
      caseVals.push(caseId);
      caseVals.push(tenantId);

      const { rows: caseRows } = await client.query<{
        id: string; name: string; base_url: string; suite_id: string;
        created_at: Date; updated_at: Date;
      }>(
        `UPDATE test_cases SET ${caseUpdates.join(', ')}
         WHERE id = $${vi} AND tenant_id = $${vi + 1} RETURNING id, name, base_url, suite_id, created_at, updated_at`,
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

    return reply.send({
      case: {
        id:        result.case.id,
        name:      result.case.name,
        baseUrl:   result.case.base_url,
        suiteId:   result.case.suite_id,
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

      await client.query(`DELETE FROM test_case_steps WHERE case_id = $1`, [caseId]);
      await client.query(`DELETE FROM test_steps WHERE case_id = $1`,      [caseId]);
      await client.query(`UPDATE runs SET case_id = NULL WHERE case_id = $1`, [caseId]);
      await client.query(`DELETE FROM test_cases WHERE id = $1`,            [caseId]);
    });

    return reply.status(204).send();
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
        id: string; suite_id: string; base_url: string;
      }>(
        `SELECT id, suite_id, base_url FROM test_cases WHERE id = $1 AND tenant_id = $2`,
        [caseId, tenantId],
      );
      if (caseRows.length === 0) return null;

      const { rows: stepRows } = await client.query<{ raw_text: string }>(
        `SELECT ts.raw_text
         FROM test_case_steps tcs
         JOIN test_steps ts ON ts.id = tcs.step_id
         WHERE tcs.case_id = $1 AND tcs.is_active = true
         ORDER BY tcs.position`,
        [caseId],
      );

      return { ...caseRows[0], steps: stepRows.map((r) => r.raw_text) };
    });

    if (!caseData) return reply.status(404).send({ error: 'CASE_NOT_FOUND' });

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

    // Compile natural-language steps → AST
    const compiledSteps = await compiler.compileMany(caseData.steps);

    // Create run record and enqueue
    const { rows } = await getPool().query<{ id: string }>(
      `INSERT INTO runs (tenant_id, suite_id, case_id, triggered_by, status, environment_url)
       VALUES ($1, $2, $3, 'web', 'queued', $4)
       RETURNING id`,
      [tenantId, caseData.suite_id, caseId, baseUrl],
    );
    const runId = rows[0].id;

    await queue.add('run', { runId, tenantId, compiledSteps, baseUrl });

    return reply.status(202).send({ runId, status: 'queued' });
  });
}

// ─── Mappers ──────────────────────────────────────────────────────────────────

function mapSuite(row: {
  id: string; name: string; description: string | null; tags: string[];
  created_at: Date; updated_at: Date; case_count: number;
}) {
  return {
    id:          row.id,
    name:        row.name,
    description: row.description,
    tags:        row.tags ?? [],
    caseCount:   row.case_count,
    createdAt:   row.created_at,
    updatedAt:   row.updated_at,
  };
}

function mapCaseSummary(row: {
  id: string; name: string; base_url: string;
  created_at: Date; updated_at: Date;
  last_run_id: string | null; last_run_status: string | null;
  last_run_completed_at: Date | null;
  last_run_duration_ms: number | null;
  last_run_total_tokens: number | null;
}) {
  return {
    id:        row.id,
    name:      row.name,
    baseUrl:   row.base_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastRun: row.last_run_id ? {
      id:          row.last_run_id,
      status:      row.last_run_status,
      completedAt: row.last_run_completed_at,
      durationMs:  row.last_run_duration_ms,
      totalTokens: row.last_run_total_tokens,
    } : null,
  };
}
