import { getPool } from '../../db/pool';
import type { TestWriterJobPayload } from '../../queue';
import type { IObservability } from '../observability/interfaces';
import type { ITestWriterGateway } from '../llm-gateway/testwriter.interfaces';
import type { PlannedScenario, ScenarioRejection, TenantBrief } from '../../types/test-writer';
import type { CrawlReport, PageCapture } from './interfaces';
import { DEFAULT_BUDGETS, HARD_MAX_PAGES } from './interfaces';
import { ReconCrawler } from './recon/crawler';
import { SiteModelRepository } from './site-model.repository';
import { PageClassifier } from './comprehend/classifier';
import { AppBriefSynthesizer } from './comprehend/synthesizer';
import { TestPlanner } from './plan/test-planner';
import { ScenarioWriter, type WrittenScenario } from './write/scenario-writer';
import { dedupeScenarios } from './write/dedup';
import { ValidationRunner } from './validate/validation-runner';
import { FORM_DATA_TOKENS } from '../test-data/generate';

/**
 * Test Writer pipeline — RECON → COMPREHEND → PLAN → [approval] → WRITE → VALIDATE.
 * Spec: docs/specs/test-writer/spec-test-writer-service.md §8
 *       docs/specs/test-writer/spec-generation-pipeline.md
 *
 * The plan-approval checkpoint sits between PLAN and WRITE deliberately: it is
 * the point where a human can still stop the expensive half (browser minutes,
 * not tokens, are the real cost) and it mirrors how a QA lead signs off a test
 * plan before anyone writes tests.
 */

export type TestWriterPipelineDeps = {
  crawler: ReconCrawler;
  repository: SiteModelRepository;
  obs: IObservability;
  gateway: ITestWriterGateway;
  classifier: PageClassifier;
  synthesizer: AppBriefSynthesizer;
  planner: TestPlanner;
  writer: ScenarioWriter;
  validator: ValidationRunner;
};

type JobRow = {
  status: string;
  target_url: string;
  suite_id: string;
  options: TestWriterJobPayload['options'];
  test_plan: { scenarios?: PlannedScenario[] } | null;
  plan_notes: string | null;
  report: Record<string, unknown> | null;
};

export async function runTestWriterJob(
  payload: TestWriterJobPayload,
  deps: TestWriterPipelineDeps,
): Promise<void> {
  const pool = getPool();
  const { rows } = await pool.query<JobRow>(
    `SELECT status, target_url, suite_id, options, test_plan, plan_notes, report
     FROM generation_jobs WHERE id = $1 AND tenant_id = $2`,
    [payload.jobId, payload.tenantId],
  );
  const job = rows[0];
  if (!job) {
    deps.obs.log('warn', 'testwriter.job_row_missing', { jobId: payload.jobId });
    return;
  }

  // P3 gate: authenticated crawling is not built. Fail loudly rather than
  // silently degrading to an unauthenticated crawl that LOOKS authenticated.
  if (payload.scope === 'authenticated') {
    await finishJob(payload.jobId, 'blocked', null,
      'Authenticated scope is not yet supported (planned: P3).');
    return;
  }

  try {
    if (payload.resumeFromPlan) {
      await runGenerationPhases(payload, deps, job);
      return;
    }

    await pool.query(
      `UPDATE generation_jobs SET status = 'running', started_at = now() WHERE id = $1`,
      [payload.jobId],
    );

    // Progress is written as it happens so the UI can show real counts instead
    // of a fake bar. Phases before PLAN otherwise report nothing at all.
    const progress = makeProgressWriter(payload.jobId);
    await progress({ phase: 'recon' });

    const recon = await runRecon(payload, deps, progress);
    await progress({ phase: 'comprehend', pagesCrawled: recon.pagesCrawled });
    if (recon.pagesCrawled === 0) {
      await finishJob(payload.jobId, 'blocked', { recon },
        'All reachable pages were blocked (challenge/robots).');
      return;
    }

    // ── COMPREHEND ──────────────────────────────────────────────────────────
    const tenantBrief = await loadTenantBrief(payload.tenantId, payload.suiteId);
    const classification = await deps.classifier.classifySuite(
      payload.tenantId, payload.suiteId, recon.pagesCrawled,
    );
    const synthesis = await deps.synthesizer.synthesize(
      payload.tenantId, payload.suiteId, payload.jobId, tenantBrief,
    );

    // ── PLAN ────────────────────────────────────────────────────────────────
    const pages = await deps.repository.listClassifiedPages(payload.tenantId, payload.suiteId);
    const consent = await loadSuiteConsent(payload.tenantId, payload.suiteId);
    const existingCaseNames = await loadExistingCaseNames(payload.tenantId, payload.suiteId);

    const plan = await deps.planner.plan({
      tenantId: payload.tenantId,
      appBrief: synthesis.brief,
      tenantBrief,
      pages,
      existingCaseNames,
      scope: payload.scope,
      syntheticDataConsent: consent,
      maxScenarios: payload.options.maxScenarios,
    });

    const report = {
      recon,
      comprehend: {
        pagesClassified: classification.classified,
        pagesReusedFromCache: classification.skipped,
        classificationFailures: classification.failed,
        journeys: synthesis.brief.journeys.length,
        journeysDropped: synthesis.journeysDropped,
        coverageGaps: synthesis.coverageGaps,
        appBriefVersion: synthesis.version,
      },
      plan: {
        scenariosPlanned: plan.scenarios.length,
        fromCatalog: plan.catalogCount,
        fromLlm: plan.llmCount,
        dropped: plan.dropped,
      },
    };

    await pool.query(
      `UPDATE generation_jobs SET test_plan = $2, report = $3 WHERE id = $1`,
      [payload.jobId, JSON.stringify({ scenarios: plan.scenarios }), JSON.stringify(report)],
    );

    if (plan.scenarios.length === 0) {
      await finishJob(payload.jobId, 'completed', report, 'No scenarios could be planned.');
      return;
    }

    // ── Checkpoint ──────────────────────────────────────────────────────────
    if (payload.options.planApproval !== 'auto') {
      await pool.query(
        `UPDATE generation_jobs SET status = 'awaiting_plan_approval' WHERE id = $1`,
        [payload.jobId],
      );
      deps.obs.log('info', 'testwriter.awaiting_plan_approval', {
        jobId: payload.jobId, scenarios: plan.scenarios.length,
      });
      return;   // resumes via POST /testwriter/jobs/:id/plan-approval
    }

    await runGenerationPhases(payload, deps, {
      ...job,
      test_plan: { scenarios: plan.scenarios },
      report,
    } as JobRow);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.obs.log('error', 'testwriter.job_failed', { jobId: payload.jobId, error: message });
    deps.obs.increment('testwriter.jobs_failed');
    await finishJob(payload.jobId, 'failed', null, message);
  }
}

// ─── RECON ───────────────────────────────────────────────────────────────────

/**
 * Live progress, merged into `generation_jobs.report.progress`.
 * Honest by construction: it only ever reports counts the pipeline actually
 * observed — the UI shows elapsed time alone rather than an invented percentage.
 */
export type JobProgress = {
  phase: 'recon' | 'comprehend' | 'plan' | 'write' | 'validate';
  pagesCrawled?: number;
  scenariosWritten?: number;
  scenariosTotal?: number;
  validationRunsDone?: number;
  validationRunsTotal?: number;
};

function makeProgressWriter(jobId: string): (p: JobProgress) => Promise<void> {
  return async (p) => {
    await getPool().query(
      `UPDATE generation_jobs
       SET report = COALESCE(report, '{}'::jsonb) || jsonb_build_object('progress', $2::jsonb)
       WHERE id = $1`,
      [jobId, JSON.stringify(p)],
    ).catch(() => { /* progress is a nicety; never fail a job over it */ });
  };
}

async function runRecon(
  payload: TestWriterJobPayload,
  deps: TestWriterPipelineDeps,
  progress: (p: JobProgress) => Promise<void>,
): Promise<CrawlReport & { linksInserted: number }> {
  const budgets = {
    ...DEFAULT_BUDGETS,
    maxPages: Math.min(payload.options.maxPages || DEFAULT_BUDGETS.maxPages, HARD_MAX_PAGES),
  };
  const edges: Array<{ fromUrl: string; toUrl: string; viaElementName: string }> = [];

  const report = await deps.crawler.crawl(
    { tenantId: payload.tenantId, jobId: payload.jobId, targetUrl: payload.targetUrl, budgets },
    async (capture: PageCapture, pageIndex: number) => {
      await deps.repository.upsertPage(payload.tenantId, payload.suiteId, capture);
      for (const link of capture.outgoingLinks) {
        edges.push({
          fromUrl: capture.urlNormalized,
          toUrl: link.toUrlNormalized,
          viaElementName: link.viaElementName,
        });
      }
      // Every few pages, not every page: the crawl is rate-limited anyway and
      // the UI polls at 2s.
      if (pageIndex % 3 === 0) await progress({ phase: 'recon', pagesCrawled: pageIndex + 1 });
    },
  );

  const linksInserted = await deps.repository.insertLinks(payload.tenantId, payload.suiteId, edges);
  deps.obs.log('info', 'testwriter.recon_completed', { jobId: payload.jobId, ...report, linksInserted });
  return { ...report, linksInserted };
}

// ─── WRITE → JUDGE → DEDUP → VALIDATE ────────────────────────────────────────

async function runGenerationPhases(
  payload: TestWriterJobPayload,
  deps: TestWriterPipelineDeps,
  job: JobRow,
): Promise<void> {
  const pool = getPool();
  await pool.query(`UPDATE generation_jobs SET status = 'running' WHERE id = $1`, [payload.jobId]);

  const planned = job.test_plan?.scenarios ?? [];
  // An explicit empty array means "the human discarded this plan" — it must not
  // fall through to "approve everything". Only an ABSENT list means auto mode.
  const approved = payload.approvedScenarios === undefined
    ? planned
    : planned.filter((s) => payload.approvedScenarios!.includes(s.name));

  if (approved.length === 0) {
    await finishJob(payload.jobId, 'completed', job.report ?? null, 'No scenarios were approved.');
    return;
  }

  const consent = await loadSuiteConsent(payload.tenantId, payload.suiteId);
  const rejected: ScenarioRejection[] = [];
  const written: WrittenScenario[] = [];
  const progress = makeProgressWriter(payload.jobId);
  await progress({ phase: 'write', scenariosWritten: 0, scenariosTotal: approved.length });

  // ── WRITE (sequential: each call is small, and ordering keeps the report readable)
  for (const plan of approved) {
    const grounding = await deps.repository.getGroundingElements(
      payload.tenantId, payload.suiteId, plan.targetPages,
    );
    if (grounding.length === 0) {
      rejected.push({ name: plan.name, stage: 'schema', reason: 'no observed elements on the target pages' });
      continue;
    }
    const formSummaries = await deps.repository.getFormSummaries(
      payload.tenantId, payload.suiteId, plan.targetPages,
    );

    const outcome = await deps.writer.write({
      tenantId: payload.tenantId,
      plan,
      grounding,
      formSummaries,
      pagePath: plan.targetPages,
      seedTokens: [...FORM_DATA_TOKENS],
      steeringNotes: job.plan_notes,
      safeMode: payload.options.safeMode,
      maxSteps: 10,
    });

    if (outcome.ok) written.push(outcome.scenario);
    else rejected.push({ name: plan.name, stage: outcome.failure.stage, reason: outcome.failure.reason });
    await progress({
      phase: 'write', scenariosWritten: written.length, scenariosTotal: approved.length,
    });
  }

  // ── DEDUP (kind-aware, against each other and the suite's existing cases)
  const existing = await loadExistingCaseSteps(payload.tenantId, payload.suiteId);
  const dedup = dedupeScenarios(
    written.map((w) => ({
      planRef: w.plan.name, kind: w.kind, name: w.name, steps: w.steps.map((s) => s.text),
    })),
    existing,
  );
  for (const drop of dedup.dropped) {
    rejected.push({ name: drop.name, stage: 'dedup', reason: `duplicate of "${drop.duplicateOf}"` });
  }
  const keptRefs = new Set(dedup.kept.map((k) => k.planRef));
  const deduped = written.filter((w) => keptRefs.has(w.plan.name));

  // ── JUDGE (one batched call — the value filter VALIDATE cannot provide)
  let survivors = deduped;
  if (deduped.length > 0) {
    try {
      const verdicts = await deps.gateway.judgeScenarios({
        scenarios: deduped.map((w) => ({
          planRef: w.plan.name, name: w.name, kind: w.kind,
          steps: w.steps.map((s) => s.text), rationale: w.rationale,
        })),
        lintFindings: Object.fromEntries(deduped.map((w) => [w.plan.name, w.lintFindings])),
      }, payload.tenantId);

      const byRef = new Map(verdicts.map((v) => [v.planRef, v]));
      survivors = deduped.filter((w) => {
        const verdict = byRef.get(w.plan.name);
        if (!verdict || verdict.verdict === 'PROPOSE') return true;
        if (verdict.verdict === 'REVISE') return true;   // proposed with findings on the report
        const failed = verdict.dimensions?.filter((d) => !d.pass).map((d) => `${d.dimension}: ${d.reason}`);
        rejected.push({
          name: w.name, stage: 'judge',
          reason: failed?.join('; ') || 'rejected by the quality judge',
        });
        return false;
      });
    } catch (err) {
      // A judge outage must not block the pipeline — validation still guards
      // executability; only the value filter is missing for this job.
      deps.obs.log('warn', 'testwriter.judge_failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── VALIDATE
  await progress({
    phase: 'validate', validationRunsDone: 0, validationRunsTotal: survivors.length,
  });
  const validation = await deps.validator.validateAll({
    tenantId: payload.tenantId,
    suiteId: payload.suiteId,
    jobId: payload.jobId,
    baseUrl: job.target_url,
    scenarios: survivors,
    syntheticDataConsent: consent,
    validate: payload.options.validate,
  });

  const report = {
    ...(job.report ?? {}),
    write: {
      attempted: approved.length,
      written: written.length,
      deduped: dedup.dropped.length,
      judged: deduped.length,
      survivedJudge: survivors.length,
    },
    validate: {
      proposed: validation.proposed.length,
      validated: validation.proposed.filter((p) => p.validated).length,
      unvalidated: validation.proposed.filter((p) => !p.validated).length,
    },
    rejected: [...rejected, ...validation.rejected],
    harvest: validation.harvest,
  };

  await finishJob(payload.jobId, 'completed', report, null, payload.tenantId);
  deps.obs.increment('testwriter.jobs_completed');
}

// ─── helpers ─────────────────────────────────────────────────────────────────

async function loadTenantBrief(tenantId: string, suiteId: string): Promise<TenantBrief | null> {
  const { rows } = await getPool().query<{ tenant_brief: TenantBrief | null }>(
    `SELECT tenant_brief FROM test_suites WHERE id = $1 AND tenant_id = $2`,
    [suiteId, tenantId],
  );
  return rows[0]?.tenant_brief ?? null;
}

async function loadSuiteConsent(tenantId: string, suiteId: string): Promise<boolean> {
  const { rows } = await getPool().query<{ allow_synthetic_data: boolean }>(
    `SELECT allow_synthetic_data FROM test_suites WHERE id = $1 AND tenant_id = $2`,
    [suiteId, tenantId],
  );
  return rows[0]?.allow_synthetic_data ?? false;
}

async function loadExistingCaseNames(tenantId: string, suiteId: string): Promise<string[]> {
  const { rows } = await getPool().query<{ name: string }>(
    `SELECT name FROM test_cases WHERE tenant_id = $1 AND suite_id = $2 AND status <> 'rejected'`,
    [tenantId, suiteId],
  );
  return rows.map((r) => r.name);
}

async function loadExistingCaseSteps(
  tenantId: string, suiteId: string,
): Promise<Array<{ kind: string; steps: string[]; name: string }>> {
  const { rows } = await getPool().query<{ name: string; steps: string[] }>(
    `SELECT tc.name, ARRAY_AGG(ts.raw_text ORDER BY tcs.position) AS steps
     FROM test_cases tc
     JOIN test_case_steps tcs ON tcs.case_id = tc.id AND tcs.is_active = true
     JOIN test_steps ts ON ts.id = tcs.step_id
     WHERE tc.tenant_id = $1 AND tc.suite_id = $2 AND tc.status IN ('active', 'draft')
     GROUP BY tc.id, tc.name`,
    [tenantId, suiteId],
  );
  // Existing cases carry no kind marker; compare them against both kinds.
  return rows.flatMap((r) => [
    { kind: 'positive', steps: r.steps, name: r.name },
    { kind: 'negative', steps: r.steps, name: r.name },
  ]);
}

/**
 * What the job actually spent, per phase. Read from billing_events rather than
 * counted in-process because that is the source of truth the tenant is billed
 * from — a number the report invented could disagree with the invoice.
 * Attributed by time window, which is exact for a single job and approximate
 * only if two jobs for one tenant overlap.
 */
async function tokenUsage(jobId: string, tenantId: string): Promise<Record<string, number>> {
  const { rows } = await getPool().query<{ purpose: string; tokens: string }>(
    `SELECT COALESCE(be.metadata->>'purpose', 'other') AS purpose,
            SUM(be.quantity)::bigint AS tokens
     FROM billing_events be
     JOIN generation_jobs gj ON gj.id = $1
     WHERE be.tenant_id = $2
       AND be.event_type = 'LLM_CALL'
       AND be.created_at >= COALESCE(gj.started_at, gj.created_at)
     GROUP BY 1`,
    [jobId, tenantId],
  ).catch(() => ({ rows: [] as Array<{ purpose: string; tokens: string }> }));

  const usage: Record<string, number> = {};
  let total = 0;
  for (const row of rows) {
    const phase = row.purpose.replace(/^testwriter\./, '');
    usage[phase] = Number(row.tokens);
    total += Number(row.tokens);
  }
  usage.total = total;
  return usage;
}

async function finishJob(
  jobId: string,
  status: 'completed' | 'failed' | 'blocked',
  report: Record<string, unknown> | null,
  error: string | null,
  tenantId?: string,
): Promise<void> {
  const withUsage = report && tenantId
    ? { ...report, tokenUsage: await tokenUsage(jobId, tenantId) }
    : report;
  await getPool().query(
    `UPDATE generation_jobs
     SET status = $2, report = COALESCE($3, report), error = $4, finished_at = now()
     WHERE id = $1`,
    [jobId, status, withUsage ? JSON.stringify(withUsage) : null, error],
  );
}
