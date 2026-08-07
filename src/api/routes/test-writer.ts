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
import { prepareBrief, MAX_BRIEF_CHARS } from '../../modules/test-writer/brief-intake';
import { OpenAITestWriterGateway } from '../../modules/llm-gateway/testwriter.gateway';
import { PostgresBillingMeter } from '../../modules/billing-meter/postgres.billing-meter';
import { PinoObservability } from '../../modules/observability/pino.observability';

const AnalyzeBody = z.object({
  targetUrl: z.string().url(),
  scope: z.enum(['public', 'authenticated']).default('public'),
  loginCaseId: z.string().uuid().optional(),
  authConsent: z.boolean().default(false),
  /** "Describe your app" — steers priorities; never invents testable UI. */
  initBrief: z.string().max(MAX_BRIEF_CHARS).optional(),
  /** Per-suite opt-in for tests that create throwaway records. */
  allowSyntheticData: z.boolean().optional(),
  options: z.object({
    maxPages: z.number().int().min(1).max(HARD_MAX_PAGES).default(30),
    maxScenarios: z.number().int().min(1).max(10).default(6),
    includeNegative: z.boolean().default(true),
    safeMode: z.boolean().default(true),
    validate: z.boolean().default(true),
    planApproval: z.enum(['review', 'auto']).default('review'),
  }).default({}),
});

const PlanApprovalBody = z.object({
  /** Empty array = discard the plan: nothing is written, the job closes cleanly. */
  approvedScenarios: z.array(z.string().min(1)),
  notes: z.string().max(2000).optional(),
});

export async function testWriterRoutes(app: FastifyInstance): Promise<void> {
  const queue = createTestWriterQueue();
  const obs = new PinoObservability(app.log as never);
  const gateway = new OpenAITestWriterGateway(new PostgresBillingMeter(obs), obs);

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

    // Init Brief: scrub secrets BEFORE storage or any prompt, then distil into
    // structure. What never enters the system cannot leak from it.
    const briefWarnings: string[] = [];
    const prepared = prepareBrief(body.initBrief);
    if (prepared) {
      if (prepared.redactions.length > 0) {
        briefWarnings.push(
          `Removed suspected secrets from your description (${prepared.redactions.join(', ')}). ` +
          'Kaizen never needs credentials in the brief.',
        );
      }
      try {
        const tenantBrief = await gateway.distillBrief(prepared.text, tenantId);
        await getPool().query(
          `UPDATE test_suites SET tenant_brief = $3 WHERE id = $1 AND tenant_id = $2`,
          [suiteId, tenantId, JSON.stringify(tenantBrief)],
        );
      } catch {
        briefWarnings.push('Your description could not be processed and was skipped.');
      }
    }

    if (typeof body.allowSyntheticData === 'boolean') {
      await getPool().query(
        `UPDATE test_suites SET allow_synthetic_data = $3 WHERE id = $1 AND tenant_id = $2`,
        [suiteId, tenantId, body.allowSyntheticData],
      );
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

    return reply.status(202).send({ jobId, status: 'queued', warnings: briefWarnings });
  });

  // ── POST /testwriter/jobs/:jobId/plan-approval ─────────────────────────────
  // Resumes a job paused at the checkpoint. Only approved scenarios are written
  // and validated — everything expensive happens after this call, never before.
  app.post('/testwriter/jobs/:jobId/plan-approval', { preHandler: [requireAuth] }, async (request, reply) => {
    const { jobId } = request.params as { jobId: string };
    const parsed = PlanApprovalBody.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ error: 'INVALID_REQUEST', details: parsed.error.issues });
    }
    const { tenantId } = request;

    const { rows } = await getPool().query<{
      status: string; suite_id: string; target_url: string; scope: string;
      auth_consent: boolean; login_case_id: string | null;
      options: Record<string, unknown>; test_plan: { scenarios?: Array<{ name: string }> } | null;
    }>(
      `SELECT status, suite_id, target_url, scope, auth_consent, login_case_id, options, test_plan
       FROM generation_jobs WHERE id = $1 AND tenant_id = $2`,
      [jobId, tenantId],
    );
    const job = rows[0];
    if (!job) return reply.status(404).send({ error: 'JOB_NOT_FOUND' });
    if (job.status !== 'awaiting_plan_approval') {
      return reply.status(409).send({
        error: 'JOB_NOT_AWAITING_APPROVAL',
        message: `Job is ${job.status}; only a job awaiting plan approval can be resumed.`,
      });
    }

    const plannedNames = new Set((job.test_plan?.scenarios ?? []).map((s) => s.name));
    const approved = parsed.data.approvedScenarios.filter((n) => plannedNames.has(n));
    const discarding = parsed.data.approvedScenarios.length === 0;
    if (approved.length === 0 && !discarding) {
      return reply.status(400).send({
        error: 'NO_VALID_SCENARIOS',
        message: 'None of the approved names match this job\'s test plan.',
      });
    }

    await getPool().query(
      `UPDATE generation_jobs SET plan_approved_at = now(), plan_notes = $2 WHERE id = $1`,
      [jobId, parsed.data.notes ?? null],
    );

    await queue.add('testwriter', {
      jobId,
      tenantId,
      suiteId: job.suite_id,
      targetUrl: job.target_url,
      scope: job.scope as 'public' | 'authenticated',
      loginCaseId: job.login_case_id ?? undefined,
      authConsent: job.auth_consent,
      options: job.options as never,
      resumeFromPlan: true,
      approvedScenarios: approved,
    });

    return reply.status(202).send({ jobId, status: 'queued', approved: approved.length });
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

  // ── GET /suites/:suiteId/app-brief ─────────────────────────────────────────
  // What Kaizen understands about this app: a durable, versioned artifact, not
  // a job byproduct. Journeys here were verified against the observed link graph.
  app.get('/suites/:suiteId/app-brief', { preHandler: [requireAuth] }, async (request, reply) => {
    const { suiteId } = request.params as { suiteId: string };
    const { version } = request.query as { version?: string };
    const { tenantId } = request;

    const brief = await withTenantTransaction(tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT version, app_type, summary, core_entities, journeys, generation_job_id, created_at
         FROM app_briefs
         WHERE tenant_id = $1 AND suite_id = $2
           AND ($3::int IS NULL OR version = $3::int)
         ORDER BY version DESC LIMIT 1`,
        [tenantId, suiteId, version ? Number(version) : null],
      );
      if (rows.length === 0) return null;
      const { rows: versions } = await client.query<{ version: number; created_at: Date }>(
        `SELECT version, created_at FROM app_briefs
         WHERE tenant_id = $1 AND suite_id = $2 ORDER BY version DESC`,
        [tenantId, suiteId],
      );
      return { row: rows[0], versions };
    });

    if (!brief) return reply.status(404).send({ error: 'APP_BRIEF_NOT_FOUND' });

    return reply.send({
      appBrief: {
        version: brief.row.version,
        appType: brief.row.app_type,
        summary: brief.row.summary,
        coreEntities: brief.row.core_entities ?? [],
        journeys: brief.row.journeys ?? [],
        generationJobId: brief.row.generation_job_id,
        createdAt: brief.row.created_at,
        history: brief.versions.map((v) => ({ version: v.version, createdAt: v.created_at })),
      },
    });
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
