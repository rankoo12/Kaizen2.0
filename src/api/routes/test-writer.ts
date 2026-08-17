/**
 * Test Writer routes.
 * Spec ref: docs/specs/test-writer/spec-test-writer-service.md §5
 *
 *   POST /suites/:suiteId/analyze   — start a recon(+generation) job
 *   POST /suites/:suiteId/suggest   — scoped generation against ONE page
 *   GET  /testwriter/jobs/:jobId    — job status + report + test plan (UI polls)
 *   GET  /suites/:suiteId/jobs      — job history for a suite
 *   GET  /suites/:suiteId/coverage  — pages known vs pages an active test touches
 *   GET  /suites/:suiteId/app-brief — what Kaizen understands about the app
 *
 * All routes require JWT auth. Authenticated scope additionally requires an
 * admin/owner role, a non-impersonated session, an eligible login recipe, and
 * explicit consent recorded with the consenting user and timestamp — the last
 * of which migration 034 CHECK-constrains, so the audit trail is a schema
 * guarantee rather than a convention this route happens to follow.
 * Spec: docs/specs/test-writer/spec-authenticated-scope.md §3.1, §8
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { withTenantTransaction, tenantQuery } from '../../db/transaction';
import { createTestWriterQueue } from '../../queue';
import { usageThisMonth } from '../../modules/billing-meter/usage';
import { HARD_MAX_PAGES } from '../../modules/test-writer/interfaces';
import { prepareBrief, MAX_BRIEF_CHARS } from '../../modules/test-writer/brief-intake';
import { OpenAITestWriterGateway } from '../../modules/llm-gateway/testwriter.gateway';
import { PostgresBillingMeter } from '../../modules/billing-meter/postgres.billing-meter';
import { PinoObservability } from '../../modules/observability/pino.observability';
import { FORM_DATA_TOKENS } from '../../modules/test-data/generate';
import { blockedDestinationReason } from '../../modules/test-writer/recon/destination-guard';

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

/**
 * Scoped Suggest — "what am I missing on THIS page?"
 *
 * Deliberately not a trimmed AnalyzeBody: `maxPages` is absent because a scoped
 * job's page budget is 1 by definition, and accepting the field would invite a
 * "suggestion" that quietly crawls the whole site.
 * Spec: docs/specs/test-writer/spec-scoped-suggest.md §3.1
 */
const SuggestBody = z.object({
  pageUrl: z.string().url(),
  scope: z.enum(['public', 'authenticated']).default('public'),
  loginCaseId: z.string().uuid().optional(),
  authConsent: z.boolean().default(false),
  options: z.object({
    maxScenarios: z.number().int().min(1).max(5).default(3),
    includeNegative: z.boolean().default(true),
    validate: z.boolean().default(true),
    // Defaults to 'auto', unlike analyze. The checkpoint gates blast radius and
    // spend before irreversible work; a scoped job is one page and at most five
    // scenarios, and the user answered "is this worth attempting" by choosing
    // the page. Synthetic-data consent still governs anything that writes, and
    // the delivery still gates what joins the suite. Exposed, so a tenant that
    // wants the checkpoint keeps it. Spec §2.5
    planApproval: z.enum(['review', 'auto']).default('auto'),
  }).default({}),
});

const PlanApprovalBody = z.object({
  /** Empty array = discard the plan: nothing is written, the job closes cleanly. */
  approvedScenarios: z.array(z.string().min(1)),
  notes: z.string().max(2000).optional(),
});

/**
 * Canonical origin for an app instance.
 * Spec: docs/specs/test-writer/spec-authenticated-scope.md §3.1
 *
 * v1 is the identity function. The indirection exists for a collision that is
 * already visible: B11 (CI integration) runs against PREVIEW deploys
 * (`app-pr-123.vercel.app`) while the tenant's sign-in test lives on
 * `app.example.com`, so a literal `===` would reject every CI-triggered
 * authenticated job — exactly the case that matters most. B11 §5.1 defines a
 * tenant-owner-configured alias table; when it exists this consults it and the
 * integration point is one function rather than a change to the gate itself.
 * Recorded in COORDINATION.md (2026-08-07).
 */
function resolveCanonicalOrigin(rawUrl: string): string | null {
  try {
    return new URL(rawUrl).origin;
  } catch {
    return null;
  }
}

type EligibilityError = { error: string; message: string };

/**
 * Validates the login recipe before a job is ever created — a job that cannot
 * sign in should never be enqueued. Returns null when the case is usable.
 */
async function checkLoginCase(
  tenantId: string,
  loginCaseId: string,
  targetUrl: string,
): Promise<EligibilityError | null> {
  const { rows } = await tenantQuery<{
    status: string | null; base_url: string; steps: string[];
  }>(
    tenantId,
    `SELECT c.status, c.base_url,
            COALESCE(ARRAY_AGG(ts.raw_text ORDER BY tcs.position)
                     FILTER (WHERE ts.raw_text IS NOT NULL), '{}') AS steps
     FROM test_cases c
     LEFT JOIN test_case_steps tcs ON tcs.case_id = c.id AND tcs.is_active = true
     LEFT JOIN test_steps ts ON ts.id = tcs.step_id
     WHERE c.id = $1 AND c.tenant_id = $2
     GROUP BY c.id, c.status, c.base_url`,
    [loginCaseId, tenantId],
  );

  const found = rows[0];
  if (!found) {
    return { error: 'LOGIN_CASE_NOT_FOUND', message: "That sign-in test wasn't found." };
  }

  // Drafts, validating and archived cases are unproven or retired; a sign-in
  // recipe must be one the tenant actually trusts.
  if ((found.status ?? 'active') !== 'active') {
    return {
      error: 'LOGIN_CASE_NOT_ACTIVE',
      message: 'The sign-in test must be an approved, active test — this one is not.',
    };
  }

  const caseOrigin = resolveCanonicalOrigin(found.base_url);
  const targetOrigin = resolveCanonicalOrigin(targetUrl);
  if (!caseOrigin || !targetOrigin || caseOrigin !== targetOrigin) {
    return {
      error: 'LOGIN_CASE_ORIGIN_MISMATCH',
      message: "The sign-in test runs against a different site than the one you're analyzing.",
    };
  }

  // base_url is metadata; the STEPS are what execute. A navigate step can point
  // anywhere, including cloud metadata or an internal service reachable from the
  // Test Writer container. auth-session re-enforces this at execution time.
  const offOrigin = found.steps.find((text) => {
    const match = /\b(?:https?:\/\/[^\s"'<>]+)/i.exec(text ?? '');
    if (!match) return false;
    const origin = resolveCanonicalOrigin(match[0].replace(/["'.,)]+$/, ''));
    return origin !== null && origin !== targetOrigin;
  });
  if (offOrigin) {
    return {
      error: 'LOGIN_CASE_NAVIGATES_OFF_ORIGIN',
      message: `That sign-in test navigates outside the site being analyzed ("${offOrigin.slice(0, 80)}").`,
    };
  }

  // Validation runs inject random per-run values for the seed tokens
  // (RunJobPayload.seedVariables), so a recipe typing {{password}} would sign in
  // with a random string and fail every proving run.
  const seedCollision = found.steps.find((text) =>
    SEED_TOKEN_PATTERN.test(text ?? ''));
  if (seedCollision) {
    return {
      error: 'LOGIN_CASE_USES_SEED_TOKENS',
      message:
        'This sign-in test uses {{email}}/{{password}} placeholders — Kaizen fills those with random data on proving runs. Use a test with fixed credentials or a sign-in button.',
    };
  }

  return null;
}

const SEED_TOKEN_PATTERN = new RegExp(
  `\\{\\{\\s*(?:${FORM_DATA_TOKENS.join('|')})\\s*\\}\\}`, 'i');

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

    // Kaizen fetches this URL from inside our own network and hands back what it
    // saw as page structure and screenshots — so an unbounded target is a
    // server-side request forgery primitive: `http://169.254.169.254/latest/
    // meta-data/iam/...` would return cloud credentials through the site model.
    // Applies to EVERY scope. The public crawler carried this exposure since P1;
    // the P3 dogfood is what surfaced it. Private networks are allowed only when
    // the deployment opts in (local dev, self-hosted).
    const blockedTarget = blockedDestinationReason(body.targetUrl);
    if (blockedTarget) {
      return reply.status(400).send({
        error: 'TARGET_NOT_ALLOWED',
        message: `Kaizen will not analyze a ${blockedTarget} address. Point it at a reachable public URL for the app you want tested.`,
      });
    }

    if (body.scope === 'authenticated') {
      if (!body.loginCaseId || !body.authConsent) {
        return reply.status(400).send({
          error: 'AUTH_CONSENT_REQUIRED',
          message: 'Signed-in analysis needs a sign-in test and your explicit consent.',
        });
      }

      // Consenting to Kaizen acting as a signed-in user on the tenant's own
      // systems is an administrative grant, the same class as member management.
      // Written positively rather than as a rank comparison: requireRole's
      // `order[request.role] < order[minimum]` evaluates FALSE when role is
      // undefined (the API-key path sets a tenant but no role), so a rank check
      // here would fail OPEN if this route ever moves to requireTenant.
      if (request.role !== 'admin' && request.role !== 'owner') {
        return reply.status(403).send({
          error: 'AUTH_SCOPE_REQUIRES_ADMIN',
          message: 'Signed-in exploration can only be enabled by a workspace admin or owner.',
        });
      }

      // An impersonated support session must not be able to grant this: the
      // audit row would attribute the product's largest grant to a customer
      // employee who never clicked it, which is worse than no audit trail.
      if (request.isImpersonation) {
        return reply.status(403).send({
          error: 'AUTH_SCOPE_NOT_VIA_IMPERSONATION',
          message: "Signed-in exploration can't be enabled from a support session.",
        });
      }

      const eligibility = await checkLoginCase(tenantId, body.loginCaseId, body.targetUrl);
      if (eligibility) return reply.status(400).send(eligibility);
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
    const { rows: budgetRows } = await tenantQuery<{ llm_budget_tokens_monthly: string }>(
      tenantId, `SELECT llm_budget_tokens_monthly FROM tenants WHERE id = $1`, [tenantId]);
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
        await tenantQuery(
          tenantId,
          `UPDATE test_suites SET tenant_brief = $3 WHERE id = $1 AND tenant_id = $2`,
          [suiteId, tenantId, JSON.stringify(tenantBrief)],
        );
      } catch {
        briefWarnings.push('Your description could not be processed and was skipped.');
      }
    }

    if (typeof body.allowSyntheticData === 'boolean') {
      await tenantQuery(
        tenantId,
        `UPDATE test_suites SET allow_synthetic_data = $3 WHERE id = $1 AND tenant_id = $2`,
        [suiteId, tenantId, body.allowSyntheticData],
      );
    }

    // Consent is stamped with WHO granted it and WHEN — migration 034's CHECK
    // refuses an authenticated job that names no consenter, so this is a schema
    // guarantee rather than a convention this route happens to follow.
    const isAuth = body.scope === 'authenticated';
    const { rows } = await tenantQuery<{ id: string }>(
      tenantId,
      `INSERT INTO generation_jobs (
         tenant_id, suite_id, target_url, scope, auth_consent, login_case_id,
         auth_consented_by, auth_consented_at, options)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [tenantId, suiteId, body.targetUrl, body.scope, body.authConsent,
        body.loginCaseId ?? null,
        isAuth ? request.userId : null,
        isAuth ? new Date() : null,
        JSON.stringify(body.options)],
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

  // ── POST /suites/:suiteId/suggest ──────────────────────────────────────────
  /**
   * Scoped generation against one page, reusing the site model the suite
   * already has. The cheap, repeatable, in-the-flow half of the product: the
   * only way accumulated knowledge pays off between full analyses.
   *
   * NOT a second pipeline. It is the same job, the same gate stack, the same
   * judge and the same proving runs, with a one-page budget and a focused PLAN.
   * A test proposed here carries identical evidence to one from an analyze —
   * there is no quick mode that lowers the bar, because two code paths that
   * both write tests will drift and the one used more often will drift further
   * from the one that was audited.
   * Spec: docs/specs/test-writer/spec-scoped-suggest.md
   */
  app.post('/suites/:suiteId/suggest', { preHandler: [requireAuth] }, async (request, reply) => {
    const { suiteId } = request.params as { suiteId: string };
    const parsed = SuggestBody.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ error: 'INVALID_REQUEST', details: parsed.error.issues });
    }
    const body = parsed.data;
    const { tenantId } = request;

    // Same SSRF boundary as analyze — a scoped job fetches from inside our
    // network exactly like a full one.
    const blockedTarget = blockedDestinationReason(body.pageUrl);
    if (blockedTarget) {
      return reply.status(400).send({
        error: 'TARGET_NOT_ALLOWED',
        message: `Kaizen will not analyze a ${blockedTarget} address. Point it at a reachable public URL for the app you want tested.`,
      });
    }

    // The authenticated grant is the SAME grant, checked by the same helpers.
    // Suggest gets no shortcut into a customer's signed-in system.
    if (body.scope === 'authenticated') {
      if (!body.loginCaseId || !body.authConsent) {
        return reply.status(400).send({
          error: 'AUTH_CONSENT_REQUIRED',
          message: 'Signed-in analysis needs a sign-in test and your explicit consent.',
        });
      }
      if (request.role !== 'admin' && request.role !== 'owner') {
        return reply.status(403).send({
          error: 'AUTH_SCOPE_REQUIRES_ADMIN',
          message: 'Signed-in exploration can only be enabled by a workspace admin or owner.',
        });
      }
      if (request.isImpersonation) {
        return reply.status(403).send({
          error: 'AUTH_SCOPE_NOT_VIA_IMPERSONATION',
          message: "Signed-in exploration can't be enabled from a support session.",
        });
      }
      const eligibility = await checkLoginCase(tenantId, body.loginCaseId, body.pageUrl);
      if (eligibility) return reply.status(400).send(eligibility);
    }

    const suiteExists = await withTenantTransaction(tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT id FROM test_suites WHERE id = $1 AND tenant_id = $2`, [suiteId, tenantId]);
      return rows.length > 0;
    });
    if (!suiteExists) return reply.status(404).send({ error: 'SUITE_NOT_FOUND' });

    // One at a time keeps the site model coherent. The UI has enforced this for
    // analyze by hiding the button; Suggest is a one-click action in the middle
    // of authoring, so the API has to mean it.
    const { rows: running } = await tenantQuery<{ id: string }>(
      tenantId,
      `SELECT id FROM generation_jobs
        WHERE tenant_id = $1 AND suite_id = $2
          AND status IN ('queued', 'running', 'awaiting_plan_approval')
        LIMIT 1`,
      [tenantId, suiteId],
    );
    if (running[0]) {
      return reply.status(409).send({
        error: 'JOB_ALREADY_RUNNING',
        message: 'An analysis is already running for this suite. One at a time keeps the site knowledge coherent.',
        jobId: running[0].id,
      });
    }

    const { rows: budgetRows } = await tenantQuery<{ llm_budget_tokens_monthly: string }>(
      tenantId, `SELECT llm_budget_tokens_monthly FROM tenants WHERE id = $1`, [tenantId]);
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

    // Does this suite know the app yet? Recon-first is non-negotiable, so with
    // no model this becomes a full analyze — and the caller is TOLD, because a
    // "suggestion" that silently turns into a three-minute thirty-page crawl is
    // a broken promise about both time and spend. Spec §2.2
    const pageOrigin = resolveCanonicalOrigin(body.pageUrl);
    const known = await withTenantTransaction(tenantId, async (client) => {
      const { rows } = await client.query<{ url_normalized: string }>(
        `SELECT url_normalized FROM site_pages WHERE tenant_id = $1 AND suite_id = $2`,
        [tenantId, suiteId],
      );
      return rows.map((r) => r.url_normalized);
    });
    const sameOrigin = known.filter((u) => resolveCanonicalOrigin(u) === pageOrigin);

    // Knowledge of a DIFFERENT app is not knowledge of this one. Suggesting
    // against a stranger inside a suite that models something else produces
    // grounded-looking nonsense; the honest answer is "analyze that app first".
    if (known.length > 0 && sameOrigin.length === 0) {
      return reply.status(400).send({
        error: 'PAGE_OFF_MODEL',
        message: 'This suite models a different app. Run a full analysis on this site first.',
      });
    }

    const scoped = sameOrigin.length > 0;
    const options = {
      // A scoped job's budget is one page: itself. It is re-captured rather
      // than read from the model so a page that changed since the last crawl
      // cannot ground WRITE on elements that no longer exist — which would
      // surface as "referenced an element the crawl never saw" when the truth
      // is "your page changed". One page-load, no tokens. Spec §2.1
      maxPages: scoped ? 1 : 30,
      maxScenarios: body.options.maxScenarios,
      includeNegative: body.options.includeNegative,
      safeMode: true,
      validate: body.options.validate,
      planApproval: body.options.planApproval,
      ...(scoped ? { focusUrl: body.pageUrl } : {}),
      mode: 'suggest' as const,
    };

    const isAuth = body.scope === 'authenticated';
    const { rows } = await tenantQuery<{ id: string }>(
      tenantId,
      `INSERT INTO generation_jobs (
         tenant_id, suite_id, target_url, scope, auth_consent, login_case_id,
         auth_consented_by, auth_consented_at, options)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [tenantId, suiteId, body.pageUrl, body.scope, body.authConsent,
        body.loginCaseId ?? null,
        isAuth ? request.userId : null,
        isAuth ? new Date() : null,
        JSON.stringify(options)],
    );
    const jobId = rows[0].id;

    await queue.add('testwriter', {
      jobId,
      tenantId,
      suiteId,
      targetUrl: body.pageUrl,
      scope: body.scope,
      loginCaseId: body.loginCaseId,
      authConsent: body.authConsent,
      options,
    });

    return reply.status(202).send({
      jobId,
      status: 'queued',
      mode: scoped ? 'scoped' : 'analyze',
      warnings: [],
    });
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

    const { rows } = await tenantQuery<{
      status: string; suite_id: string; target_url: string; scope: string;
      auth_consent: boolean; login_case_id: string | null;
      options: Record<string, unknown>; test_plan: { scenarios?: Array<{ name: string }> } | null;
    }>(
      tenantId,
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

    // What the human declined, kept alongside what the machine dropped.
    // Without this the only trace of a review is the shorter list that came out
    // of it: a scenario a person looked at and rejected became indistinguishable
    // from one that was never planned. Same shape as report.plan.dropped so both
    // render through one component, and reason-bearing so a future "why" has
    // somewhere to go without a shape change.
    // Spec: docs/specs/tests-ux/spec-testwriter-ux.md §11.6-c
    const declined = [...plannedNames]
      .filter((name) => !approved.includes(name))
      .map((name) => ({ name, reason: 'user_deselected' }));

    await tenantQuery(
      tenantId,
      `UPDATE generation_jobs
          SET plan_approved_at = now(),
              plan_notes = $2,
              report = COALESCE(report, '{}'::jsonb)
                       || jsonb_build_object('plan',
                            COALESCE(report->'plan', '{}'::jsonb)
                            || jsonb_build_object('declined', $3::jsonb))
        WHERE id = $1`,
      [jobId, parsed.data.notes ?? null, JSON.stringify(declined)],
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
        `SELECT id, suite_id, target_url, scope, login_case_id, status, options, test_plan, report, error,
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

  // ── GET /suites/:suiteId/coverage ──────────────────────────────────────────
  // What Kaizen knows exists, against what this suite actually touches.
  // Designed in the master plan, never built — so the only answer a customer
  // could get about coverage came from a tenant brief that no suite has ever
  // had. Read-only: one LEFT JOIN over data already present.
  // Spec: docs/specs/test-writer/spec-findings-and-coverage.md §4
  app.get('/suites/:suiteId/coverage', { preHandler: [requireAuth] }, async (request, reply) => {
    const { suiteId } = request.params as { suiteId: string };
    const { tenantId } = request;

    const result = await withTenantTransaction(tenantId, async (client) => {
      const { rows: suites } = await client.query(
        `SELECT id FROM test_suites WHERE id = $1 AND tenant_id = $2`, [suiteId, tenantId],
      );
      if (suites.length === 0) return null;

      // A page counts as tested when an ACTIVE case in this suite names its URL
      // in a step. Deliberately literal: a page is covered because a test goes
      // there, not because a model thought the two sounded related.
      //
      // Matched as a whole URL, not as a substring. A plain `position()` test
      // made every page a prefix of its own children — "https://shop.com/"
      // occurs inside "navigate to https://shop.com/products", so the landing
      // page counted as covered by a test that never visits it, and on a real
      // site the root page came out covered by literally every test. That
      // inflates the single number this endpoint exists to report honestly.
      //
      // So: pull the URLs out of the step text and compare them for equality,
      // tolerating a trailing slash and trailing sentence punctuation. The
      // pattern is a constant — no stored URL is ever interpolated into a
      // regex, where a `?` or `+` from a query string would be read as a
      // quantifier.
      const { rows: pages } = await client.query<{
        url_normalized: string; purpose_tag: string | null; requires_auth: boolean; case_count: string;
      }>(
        `SELECT sp.url_normalized, sp.purpose_tag, sp.requires_auth,
                count(DISTINCT tc.id)::text AS case_count
         FROM site_pages sp
         LEFT JOIN test_case_steps tcs
           ON tcs.tenant_id = sp.tenant_id AND tcs.is_active = true
         LEFT JOIN test_steps ts
           ON ts.id = tcs.step_id
          AND EXISTS (
                SELECT 1
                FROM regexp_matches(ts.raw_text, 'https?://[^\\s"''<>)]+', 'g') AS m(u)
                WHERE rtrim(m.u[1], '.,;:!)"''')
                      IN (sp.url_normalized, sp.url_normalized || '/', rtrim(sp.url_normalized, '/'))
              )
         LEFT JOIN test_cases tc
           ON tc.id = tcs.case_id AND tc.suite_id = $2 AND tc.status = 'active' AND ts.id IS NOT NULL
         WHERE sp.tenant_id = $1 AND sp.suite_id = $2
         GROUP BY sp.url_normalized, sp.purpose_tag, sp.requires_auth
         ORDER BY sp.url_normalized`,
        [tenantId, suiteId],
      );

      // Was the model built from a crawl that actually saw the app? A one-page
      // crawl of an SPA behind robots.txt must never render as "100% covered" —
      // the honest answer to "what is my coverage" is sometimes "unknown".
      const { rows: lastJob } = await client.query<{ blocked: boolean; pages_blocked: number }>(
        `SELECT (status = 'blocked') AS blocked,
                COALESCE((report->'recon'->>'pagesBlocked')::int, 0) AS pages_blocked
         FROM generation_jobs
         WHERE tenant_id = $1 AND suite_id = $2
         ORDER BY created_at DESC LIMIT 1`,
        [tenantId, suiteId],
      );
      return { pages, lastJob: lastJob[0] ?? null };
    });

    if (!result) return reply.status(404).send({ error: 'SUITE_NOT_FOUND' });

    const pages = result.pages.map((p) => ({
      url: p.url_normalized,
      purposeTag: p.purpose_tag,
      requiresAuth: p.requires_auth,
      caseCount: Number(p.case_count),
      tested: Number(p.case_count) > 0,
    }));
    const tested = pages.filter((p) => p.tested).length;
    const thin = pages.length <= 2 || result.lastJob?.blocked === true
      || (result.lastJob?.pages_blocked ?? 0) > 0;

    return reply.send({
      coverage: {
        pages,
        summary: { total: pages.length, tested, untested: pages.length - tested },
        // 'unknown' is a real answer, not a degraded one: it says the map itself
        // is incomplete, so any percentage drawn from it would mislead.
        coverageConfidence: thin ? 'unknown' : 'observed',
        confidenceReason: thin
          ? `Only ${pages.length} page${pages.length === 1 ? '' : 's'} could be reached, so this is not a complete picture of the app.`
          : null,
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
  login_case_id?: string | null;
  options: unknown; test_plan: unknown; report: unknown; error: string | null;
  created_at: Date; started_at: Date | null; finished_at: Date | null;
}) {
  return {
    id: row.id,
    suiteId: row.suite_id,
    targetUrl: row.target_url,
    scope: row.scope,
    // The recipe that was used, so a job blocked on sign-in can point at the test
    // that needs fixing rather than leaving the user to guess which one it was.
    loginCaseId: row.login_case_id ?? null,
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
