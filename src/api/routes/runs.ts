import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Redis } from 'ioredis';
import { getPool } from '../../db/pool';
import { createRunQueue } from '../../queue';
import { cancelKey } from '../../workers/cancel-keys';
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
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');

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

    // Fetch granular step results.
    // LEFT JOIN test_steps so the raw English text travels with the step result.
    // Necessary because test_steps rows are immutable (versioned via parent_step_id),
    // and a run can reference a step row that's no longer in the case's active set —
    // looking up rawText via the case's current steps would miss those.
    const { rows: stepRows } = await pool.query(
      `SELECT sr.id, sr.step_id, sr.status, sr.cache_hit, sr.selector_used, sr.duration_ms, sr.error_type, sr.failure_class, sr.healing_event_id, sr.screenshot_key, sr.content_hash, sr.target_hash, sr.user_verdict, sr.resolution_source, sr.similarity_score, sr.dom_candidates, sr.llm_picked_kaizen_id, sr.tokens_used, sr.created_at,
              ts.raw_text AS step_raw_text
       FROM step_results sr
       LEFT JOIN test_steps ts ON ts.id = sr.step_id
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

    // Fetch tokens used by this tenant during the run.
    // Use created_at as fallback lower bound when started_at is NULL (worker hasn't
    // called markRunRunning yet) to avoid returning 0 tokens for in-progress runs.
    const { rows: llmRows } = await pool.query(
      `SELECT id, quantity as tokens, created_at, metadata->>'purpose' as purpose
       FROM billing_events
       WHERE tenant_id = $1
         AND event_type = 'LLM_CALL'
         AND created_at >= COALESCE($2::timestamptz, $4::timestamptz)
         AND created_at <= COALESCE($3::timestamptz, now())
       ORDER BY created_at ASC`,
      [run.tenant_id, run.started_at, run.completed_at, run.created_at]
    );

    run.stepResults = stepRows.map((step: any) => ({
      ...step,
      rawText: step.step_raw_text,
      healingEvents: healingRows.filter((h: any) => h.step_result_id === step.id),
      tokens: step.tokens_used ?? 0,
    }));

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

      // Fetch the step result.
      // content_hash    — links to compiled_ast_cache (cleared on verdict=failed so
      //                   a stale wrong compilation gets evicted and recompiled next run)
      // target_hash     — links to selector_cache
      // archetype_name  — populated when the step was resolved at L0; triggers an
      //                   archetype_failures cooldown row on verdict=failed
      // environment_url — host domain for the cooldown row (matches how worker
      //                   derives domain at run time)
      const { rows } = await pool.query(
        `SELECT sr.id, sr.content_hash, sr.target_hash, sr.selector_used,
                sr.archetype_name, r.tenant_id, r.environment_url
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
          // Human says this selector is wrong. Purge it from every cache layer so
          // the next run resolves fresh via LLM.

          // 1. Delete tenant-scoped Postgres row by targetHash.
          await pool.query(
            `DELETE FROM selector_cache
             WHERE content_hash = $1 AND tenant_id = $2 AND pinned_at IS NULL`,
            [stepResult.target_hash, stepResult.tenant_id],
          );

          // 2. Purge the shared-pool row contributed by this entry (tenant_id IS NULL,
          //    is_shared = true). Without this, other tenants on L4 keep getting the
          //    wrong selector indefinitely.
          await pool.query(
            `DELETE FROM selector_cache
             WHERE content_hash = $1 AND is_shared = true AND pinned_at IS NULL`,
            [stepResult.target_hash],
          );

          // 2b. Evict every other cache row (for this tenant OR shared) whose
          //     selectors array contains the exact wrong selector.
          //
          //     Why this is necessary: the element_embedding (L2.5 vector search)
          //     is keyed by the DOM element's semantic identity, not the step hash.
          //     A sibling element that shares a mislabeled accessible name (e.g.
          //     two inputs where the wrong <label for> points both to "city") can
          //     have an element_embedding that appears nearly identical to the
          //     current step's target element.  Deleting only by targetHash leaves
          //     that sibling row intact, so the vector search keeps returning the
          //     bad selector on every subsequent run even after the user marks fail.
          if (stepResult.selector_used) {
            await pool.query(
              `DELETE FROM selector_cache
               WHERE (tenant_id = $1 OR is_shared = true)
                 AND $2 = ANY(
                   SELECT s->>'selector'
                   FROM jsonb_array_elements(selectors::jsonb) AS s
                 )
                 AND pinned_at IS NULL`,
              [stepResult.tenant_id, stepResult.selector_used],
            );
          }

          // 3. Delete the compiled_ast_cache entry so the step is recompiled on
          //    the next run. Without this, a wrong compilation (e.g. action:"click"
          //    instead of action:"select") persists forever because the cache uses
          //    ON CONFLICT DO NOTHING and is never rewritten after the first LLM call.
          if (stepResult.content_hash) {
            await pool.query(
              `DELETE FROM compiled_ast_cache WHERE content_hash = $1`,
              [stepResult.content_hash],
            );
          }

          // 4. Evict Redis across all tenant slots for this targetHash.
          //    Clears two key namespaces:
          //    a) sel:{tenantId}:{targetHash}:{domain}  — L1 selector cache
          //    b) llm:dedup:{targetHash}:{sha256}       — LLM prompt dedup cache
          //    Without (b), the next run hits the 1-hour dedup cache and reuses the
          //    stale wrong LLM answer, showing "LLM" badge with 0 tokens.
          try {
            const selPattern   = `sel:*:${stepResult.target_hash}:*`;
            const dedupPattern = `llm:dedup:${stepResult.target_hash}:*`;
            const keysToDelete: string[] = [];
            for (const pattern of [selPattern, dedupPattern]) {
              let cursor = '0';
              do {
                const [next, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', '100');
                cursor = next;
                keysToDelete.push(...batch);
              } while (cursor !== '0');
            }
            if (keysToDelete.length > 0) {
              await redis.del(...keysToDelete);
            }
          } catch {
            // Best-effort — Postgres rows are already gone; Redis TTL will expire naturally.
          }

          // 5. Archetype cooldown: if the step was resolved at L0, record a row
          //    in archetype_failures so the resolver skips this archetype for
          //    the same (tenant, domain, target_hash) until the 24h window elapses.
          //    This closes the cross-process gap — the resolver instance lives in
          //    the worker, the verdict arrives at the API, and without this write
          //    user "fail" clicks on L0 hits had no effect.
          if (stepResult.archetype_name && stepResult.selector_used && stepResult.environment_url) {
            try {
              const cooldownDomain = new URL(stepResult.environment_url).hostname;
              await pool.query(
                `INSERT INTO archetype_failures
                   (tenant_id, domain, target_hash, archetype_name, selector_used)
                 VALUES ($1, $2, $3, $4, $5)
                 ON CONFLICT (tenant_id, domain, target_hash, archetype_name)
                 DO UPDATE SET selector_used = EXCLUDED.selector_used, created_at = now()`,
                [
                  stepResult.tenant_id,
                  cooldownDomain,
                  stepResult.target_hash,
                  stepResult.archetype_name,
                  stepResult.selector_used,
                ],
              );
              obs.increment('archetype_resolver.verdict_failure_recorded');
            } catch (e: any) {
              obs.increment('archetype_resolver.verdict_failure_record_error');
              obs.log('warn', 'verdict.archetype_failure_record_failed', { error: e.message });
            }
          }
        }
      }

      return reply.status(200).send({ ok: true, verdict });
    },
  );

  /**
   * POST /runs/:id/cancel
   *
   * Signals the worker to stop after the current step finishes.
   * Sets a Redis flag (cancel:{runId}) that the worker polls between steps.
   * The run status transitions to "cancelled" once the worker acknowledges.
   *
   * Only valid for runs in status "queued" or "running".
   */
  app.post<{ Params: { id: string } }>('/runs/:id/cancel', async (request, reply) => {
    const { id: runId } = request.params;
    const pool = getPool();

    const { rows } = await pool.query(
      `SELECT id, status FROM runs WHERE id = $1`,
      [runId],
    );

    if (rows.length === 0) {
      return reply.status(404).send({ error: 'NOT_FOUND' });
    }

    const { status } = rows[0];

    if (status === 'cancelled') {
      return reply.status(200).send({ ok: true, status: 'cancelled' });
    }

    if (status !== 'queued' && status !== 'running') {
      return reply.status(409).send({
        error: 'CANNOT_CANCEL',
        message: `Run is already ${status}.`,
      });
    }

    // Set the cancellation signal in Redis — the worker polls this between steps.
    // TTL: 5 minutes. If the worker never picks it up (e.g. it crashed before
    // reading), the key expires automatically and doesn't pollute future runs.
    await redis.setex(cancelKey(runId), 300, '1');

    // For queued runs that haven't been picked up yet, also mark them cancelled
    // immediately in the DB so the UI reflects the change without waiting.
    if (status === 'queued') {
      await pool.query(
        `UPDATE runs SET status = 'cancelled', completed_at = now() WHERE id = $1`,
        [runId],
      );
    }

    return reply.status(202).send({ ok: true, message: 'Cancellation requested.' });
  });

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
