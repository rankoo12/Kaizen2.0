/**
 * Test Writer routes.
 * Spec ref: docs/specs/test-writer/spec-test-writer-service.md §5
 *
 *   POST /suites/:suiteId/analyze   — start a recon(+generation) job
 *   GET  /testwriter/jobs/:jobId    — job status + report + test plan (UI polls)
 *   GET  /suites/:suiteId/jobs      — job history for a suite
 *
 * All routes require JWT auth. Authenticated scope requires BOTH a login case
 * AND an explicit consent flag (also CHECK-constrained in migration 028) —
 * P1 additionally rejects it outright until the login-recipe flow (P3) lands.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { withTenantTransaction } from '../../db/transaction';
import { getPool } from '../../db/pool';
import { createTestWriterQueue } from '../../queue';
import { usageThisMonth } from '../../modules/billing-meter/usage';
import { HARD_MAX_PAGES } from '../../modules/test-writer/interfaces';

const AnalyzeBody = z.object({
  targetUrl: z.string().url(),
  scope: z.enum(['public', 'authenticated']).default('public'),
  loginCaseId: z.string().uuid().optional(),
  authConsent: z.boolean().default(false),
  options: z.object({
    maxPages: z.number().int().min(1).max(HARD_MAX_PAGES).default(30),
    maxScenarios: z.number().int().min(1).max(10).default(6),
    includeNegative: z.boolean().default(true),
    safeMode: z.boolean().default(true),
    validate: z.boolean().default(true),
  }).default({}),
});

export async function testWriterRoutes(app: FastifyInstance): Promise<void> {
  const queue = createTestWriterQueue();

  // ── POST /suites/:suiteId/analyze ──────────────────────────────────────────
  app.post('/suites/:suiteId/analyze', { preHandler: [requireAuth] }, async (request, reply) => {
    const { suiteId } = request.params as { suiteId: string };
    const parsed = AnalyzeBody.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ error: 'INVALID_REQUEST', details: parsed.error.issues });
    }
    const body = parsed.data;
    const { tenantId } = request;

    if (body.scope === 'authenticated') {
      if (!body.loginCaseId || !body.authConsent) {
        return reply.status(400).send({
          error: 'AUTH_CONSENT_REQUIRED',
          message: 'Authenticated analysis requires a login case AND explicit consent (authConsent: true).',
        });
      }
      // P3 gate — do not accept a job the pipeline cannot honor yet.
      return reply.status(400).send({
        error: 'AUTH_SCOPE_NOT_SUPPORTED',
        message: 'Authenticated analysis is not available yet. Run a public analysis for now.',
      });
    }

    const suiteExists = await withTenantTransaction(tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT id FROM test_suites WHERE id = $1 AND tenant_id = $2`, [suiteId, tenantId]);
      return rows.length > 0;
    });
    if (!suiteExists) return reply.status(404).send({ error: 'SUITE_NOT_FOUND' });

    // Same tenant token-budget gate as run triggers. Recon itself spends no
    // LLM tokens in P1, but the analyze contract includes generation phases —
    // gate up front so a job never starts work it cannot finish.
    const { rows: budgetRows } = await getPool().query<{ llm_budget_tokens_monthly: string }>(
      `SELECT llm_budget_tokens_monthly FROM tenants WHERE id = $1`, [tenantId]);
    const budget = Number(budgetRows[0]?.llm_budget_tokens_monthly ?? 0);
    if (budget <= 0) {
      return reply.status(402).send({
        error: 'INSUFFICIENT_TOKENS',
        message: 'This account has no LLM tokens allocated. Contact the workspace owner.',
      });
    }
    const used = await usageThisMonth(tenantId);
    if (used >= budget) {
      return reply.status(402).send({
        error: 'TOKEN_LIMIT_REACHED',
        message: `Token limit reached (${budget.toLocaleString()}). Used ${used.toLocaleString()} this month.`,
        used, budget,
      });
    }

    const { rows } = await getPool().query<{ id: string }>(
      `INSERT INTO generation_jobs (tenant_id, suite_id, target_url, scope, auth_consent, login_case_id, options)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [tenantId, suiteId, body.targetUrl, body.scope, body.authConsent,
        body.loginCaseId ?? null, JSON.stringify(body.options)],
    );
    const jobId = rows[0].id;

    await queue.add('testwriter', {
      jobId,
      tenantId,
      suiteId,
      targetUrl: body.targetUrl,
      scope: body.scope,
      loginCaseId: body.loginCaseId,
      authConsent: body.authConsent,
      options: body.options,
    });

    return reply.status(202).send({ jobId, status: 'queued' });
  });

  // ── GET /testwriter/jobs/:jobId ────────────────────────────────────────────
  app.get('/testwriter/jobs/:jobId', { preHandler: [requireAuth] }, async (request, reply) => {
    const { jobId } = request.params as { jobId: string };
    const { tenantId } = request;

    const job = await withTenantTransaction(tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT id, suite_id, target_url, scope, status, options, test_plan, report, error,
                created_at, started_at, finished_at
         FROM generation_jobs WHERE id = $1 AND tenant_id = $2`,
        [jobId, tenantId],
      );
      return rows[0] ?? null;
    });
    if (!job) return reply.status(404).send({ error: 'JOB_NOT_FOUND' });

    return reply.send({ job: mapJob(job) });
  });

  // ── GET /suites/:suiteId/jobs ──────────────────────────────────────────────
  app.get('/suites/:suiteId/jobs', { preHandler: [requireAuth] }, async (request, reply) => {
    const { suiteId } = request.params as { suiteId: string };
    const { tenantId } = request;

    const jobs = await withTenantTransaction(tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT id, suite_id, target_url, scope, status, options, test_plan, report, error,
                created_at, started_at, finished_at
         FROM generation_jobs
         WHERE suite_id = $1 AND tenant_id = $2
         ORDER BY created_at DESC
         LIMIT 50`,
        [suiteId, tenantId],
      );
      return rows;
    });

    return reply.send({ jobs: jobs.map(mapJob) });
  });
}

function mapJob(row: {
  id: string; suite_id: string; target_url: string; scope: string; status: string;
  options: unknown; test_plan: unknown; report: unknown; error: string | null;
  created_at: Date; started_at: Date | null; finished_at: Date | null;
}) {
  return {
    id: row.id,
    suiteId: row.suite_id,
    targetUrl: row.target_url,
    scope: row.scope,
    status: row.status,
    options: row.options,
    testPlan: row.test_plan,
    report: row.report,
    error: row.error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}
