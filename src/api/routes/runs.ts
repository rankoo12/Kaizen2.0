import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPool } from '../../db/pool';
import { createRunQueue } from '../../queue';
import { LearnedCompiler } from '../../modules/test-compiler/learned.compiler';
import { OpenAIGateway } from '../../modules/llm-gateway/openai.gateway';
import { PostgresBillingMeter } from '../../modules/billing-meter/postgres.billing-meter';
import { PinoObservability } from '../../modules/observability/pino.observability';

const PostRunsBody = z.object({
  tenantId: z.string().uuid('tenantId must be a valid UUID'),
  steps: z.array(z.string().min(1)).min(1, 'at least one step is required'),
  baseUrl: z.string().url('baseUrl must be a valid URL'),
});

export async function runsRoutes(app: FastifyInstance): Promise<void> {
  // Module instances are shared across requests within this process.
  // Phase 2: wire through a proper DI container.
  const obs = new PinoObservability(app.log as any);
  const billing = new PostgresBillingMeter(obs);
  const llm = new OpenAIGateway(billing, obs);
  const compiler = new LearnedCompiler(llm, obs);
  const queue = createRunQueue();

  /**
   * POST /runs
   *
   * Accepts a flat list of natural-language steps, compiles them,
   * creates a run record, and enqueues the job for a worker to pick up.
   *
   * Phase 1: no auth. tenantId is passed explicitly in the body.
   * The tenant must exist in the DB (seed it first).
   *
   * Returns: { runId, status: 'queued' }
   */
  app.post('/runs', async (request, reply) => {
    const parsed = PostRunsBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'INVALID_REQUEST', details: parsed.error.issues });
    }

    const { tenantId, steps, baseUrl } = parsed.data;

    // Compile all steps (cache-first → LLM fallback)
    const compiledSteps = await compiler.compileMany(steps);

    // Persist run record
    const pool = getPool();
    const { rows } = await pool.query(
      `INSERT INTO runs (tenant_id, triggered_by, status, environment_url)
       VALUES ($1, 'api', 'queued', $2)
       RETURNING id`,
      [tenantId, baseUrl],
    );
    const runId: string = rows[0].id;

    // Enqueue for worker
    await queue.add('run', { runId, tenantId, compiledSteps, baseUrl });

    // Billing: fire-and-forget — must not block the response
    void billing.emit({ tenantId, eventType: 'TEST_RUN_STARTED', quantity: 1, unit: 'runs' });

    app.log.info({ event: 'run_enqueued', runId, tenantId, stepCount: steps.length });
    return reply.status(202).send({ runId, status: 'queued' });
  });

  /**
   * GET /runs
   *
   * Lists runs for the authenticated tenant with optional filters.
   * Requires JWT auth — tenantId resolved from token.
   *
   * Query params: suiteId?, caseId?, status?, page? (default 1), limit? (default 20, max 100)
   */
  const { requireAuth } = await import('../middleware/auth');

  app.get('/runs', { preHandler: [requireAuth] }, async (request, reply) => {
    const query = request.query as {
      suiteId?: string; caseId?: string; status?: string;
      page?: string; limit?: string;
    };
    const { tenantId } = request;

    const page  = Math.max(1, parseInt(query.page  ?? '1',  10));
    const limit = Math.min(100, Math.max(1, parseInt(query.limit ?? '20', 10)));
    const offset = (page - 1) * limit;

    const conditions: string[] = ['r.tenant_id = $1'];
    const values: unknown[]    = [tenantId];
    let vi = 2;

    if (query.suiteId) { conditions.push(`r.suite_id = $${vi++}`); values.push(query.suiteId); }
    if (query.caseId)  { conditions.push(`r.case_id  = $${vi++}`); values.push(query.caseId); }
    if (query.status)  { conditions.push(`r.status   = $${vi++}`); values.push(query.status); }

    const where = conditions.join(' AND ');
    values.push(limit, offset);

    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT r.id, r.case_id, r.suite_id, r.status, r.triggered_by,
              r.created_at, r.completed_at,
              tc.name AS case_name,
              ts.name AS suite_name
       FROM runs r
       LEFT JOIN test_cases  tc ON tc.id = r.case_id
       LEFT JOIN test_suites ts ON ts.id = r.suite_id
       WHERE ${where}
       ORDER BY r.created_at DESC
       LIMIT $${vi++} OFFSET $${vi}`,
      values,
    );

    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*)::int AS total FROM runs r WHERE ${where}`,
      values.slice(0, -2), // exclude limit/offset
    );

    const total = countRows[0].total;
    return reply.send({
      runs: rows.map((r) => ({
        id:          r.id,
        caseId:      r.case_id,
        caseName:    r.case_name,
        suiteId:     r.suite_id,
        suiteName:   r.suite_name,
        status:      r.status,
        triggeredBy: r.triggered_by,
        createdAt:   r.created_at,
        completedAt: r.completed_at,
      })),
      total,
      page,
      totalPages: Math.ceil(total / limit),
    });
  });

  app.get<{ Params: { id: string } }>('/runs/:id', async (request, reply) => {
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT id, tenant_id, status, triggered_by, started_at, completed_at, environment_url, created_at
       FROM runs
       WHERE id = $1`,
      [request.params.id],
    );

    if (rows.length === 0) {
      return reply.status(404).send({ error: 'NOT_FOUND' });
    }

    const run = rows[0];

    // Fetch granular step results
    const { rows: stepRows } = await pool.query(
      `SELECT sr.id, sr.step_id, sr.status, sr.cache_hit, sr.selector_used, sr.duration_ms, sr.error_type, sr.failure_class, sr.healing_event_id, sr.screenshot_key, sr.content_hash, sr.target_hash, sr.user_verdict, sr.resolution_source, sr.similarity_score, sr.dom_candidates, sr.llm_picked_kaizen_id, sr.created_at
       FROM step_results sr
       WHERE sr.run_id = $1
       ORDER BY sr.created_at ASC`,
      [request.params.id]
    );

    let healingRows: any[] = [];
    if (stepRows.length > 0) {
      const stepIds = stepRows.map((s: { id: string }) => s.id);
      const healingQuery = await pool.query(
        `SELECT id, step_result_id, failure_class, strategy_used, attempts, succeeded, duration_ms
         FROM healing_events
         WHERE step_result_id = ANY($1::uuid[])`,
        [stepIds]
      );
      healingRows = healingQuery.rows;
    }

    // Fetch tokens used by this tenant during the run
    const { rows: llmRows } = await pool.query(
      `SELECT id, quantity as tokens, created_at, metadata->>'purpose' as purpose
       FROM billing_events
       WHERE tenant_id = $1 
         AND event_type = 'LLM_CALL' 
         AND created_at >= $2 
         AND created_at <= COALESCE($3, now())
       ORDER BY created_at ASC`,
      [run.tenant_id, run.started_at, run.completed_at]
    );

    let lastTime = new Date(run.started_at || run.created_at);
    run.stepResults = stepRows.map((step: any) => {
      const stepTime = new Date(step.created_at);
      const stepLlmCalls = llmRows.filter((r: any) => {
        const t = new Date(r.created_at);
        return t > lastTime && t <= stepTime;
      });
      lastTime = stepTime;

      const tokens = stepLlmCalls.reduce((sum: number, r: any) => sum + Number(r.tokens || 0), 0);

      return {
        ...step,
        healingEvents: healingRows.filter((h: any) => h.step_result_id === step.id),
        tokens
      };
    });

    // Also attach general total tokens to run itself
    run.total_tokens = llmRows.reduce((sum: number, r: any) => sum + Number(r.tokens || 0), 0);


    return reply.send(run);
  });

  const screenshots = new (require('../../modules/media/screenshot.service').ScreenshotService)(obs);

  /**
   * PATCH /runs/:runId/steps/:stepId/verdict
   *
   * Records a human pass/fail verdict for a step result from the QA dashboard.
   * When verdict = 'passed', the selector used by that step is pinned in
   * selector_cache so healing and re-resolution never overwrite it.
   */
  const VerdictBody = z.object({
    verdict: z.enum(['passed', 'failed']),
  });

  app.patch<{ Params: { runId: string; stepId: string } }>(
    '/runs/:runId/steps/:stepId/verdict',
    async (request, reply) => {
      const parsed = VerdictBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'INVALID_REQUEST', details: parsed.error.issues });
      }

      const { verdict } = parsed.data;
      const { runId, stepId } = request.params;
      const pool = getPool();

      // Fetch the step result — target_hash links to selector_cache.content_hash
      const { rows } = await pool.query(
        `SELECT sr.id, sr.target_hash, sr.selector_used, r.tenant_id
         FROM step_results sr
         JOIN runs r ON r.id = sr.run_id
         WHERE sr.id = $1 AND sr.run_id = $2`,
        [stepId, runId],
      );

      if (rows.length === 0) {
        return reply.status(404).send({ error: 'NOT_FOUND' });
      }

      const stepResult = rows[0];

      // Record the verdict on the step result
      await pool.query(
        `UPDATE step_results SET user_verdict = $1 WHERE id = $2`,
        [verdict, stepId],
      );

      if (stepResult.target_hash) {
        if (verdict === 'passed' && stepResult.selector_used) {
          // Pin this selector_cache row — healing and re-resolution will never overwrite it.
          await pool.query(
            `UPDATE selector_cache
             SET pinned_at = now()
             WHERE content_hash = $1
               AND tenant_id = $2
               AND $3 = ANY(
                 SELECT s->>'selector'
                 FROM jsonb_array_elements(selectors::jsonb) AS s
               )`,
            [stepResult.target_hash, stepResult.tenant_id, stepResult.selector_used],
          );
        } else if (verdict === 'failed') {
          // Human says this selector is wrong — delete it so the next run resolves fresh via LLM.
          await pool.query(
            `DELETE FROM selector_cache
             WHERE content_hash = $1 AND tenant_id = $2 AND pinned_at IS NULL`,
            [stepResult.target_hash, stepResult.tenant_id],
          );
        }
      }

      return reply.status(200).send({ ok: true, verdict });
    },
  );

  /**
   * GET /media?key=...
   * Resolves a screenshot from memory/GCS and streams it back
   */
  app.get<{ Querystring: { key: string } }>('/media', async (request, reply) => {
    if (!request.query.key) return reply.status(400).send({ error: 'Missing key' });
    const buffer = await screenshots.download(request.query.key);
    if (!buffer) return reply.status(404).send({ error: 'Not found' });
    
    reply.header('Content-Type', 'image/png');
    return reply.send(buffer);
  });
}
