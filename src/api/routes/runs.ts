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
   * GET /runs/:id
   *
   * Returns the current state of a run.
   * Clients poll this until status is 'passed' | 'failed' | 'cancelled'.
   */
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

    return reply.send(rows[0]);
  });
}
