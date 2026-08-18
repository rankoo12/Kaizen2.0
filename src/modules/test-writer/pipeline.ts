import { tenantQuery } from '../../db/transaction';
import type { TestWriterJobPayload } from '../../queue';
import type { IObservability } from '../observability/interfaces';
import type { ITestWriterGateway } from '../llm-gateway/testwriter.interfaces';
import type { PlannedScenario, ScenarioRejection, TenantBrief } from '../../types/test-writer';
import type { StepAST } from '../../types';
import { reconFindings, rankFindings, collapseFindings } from './findings';
import type { Finding } from '../../types/test-writer';
import type { CrawlReport, PageCapture } from './interfaces';
import { DEFAULT_BUDGETS, HARD_MAX_PAGES } from './interfaces';
import { ReconCrawler } from './recon/crawler';
import { normalizeUrl } from './recon/url-normalizer';
import { SiteModelRepository } from './site-model.repository';
import { PageClassifier } from './comprehend/classifier';
import { AppBriefSynthesizer } from './comprehend/synthesizer';
import { TestPlanner, type PlanLedger } from './plan/test-planner';
import { knownAccounts } from './plan/dossier';
import { ScenarioWriter, type WrittenScenario } from './write/scenario-writer';
import { dedupeScenarios } from './write/dedup';
import { judgeWithRepair } from './write/judge-round';
import { ValidationRunner, type ValidationOutcome } from './validate/validation-runner';
import { withSigninWitness } from './validate/signin-witness';
import { FORM_DATA_TOKENS } from '../test-data/generate';
import { LearnedCompiler } from '../test-compiler/learned.compiler';
import type { ILLMGateway } from '../llm-gateway/interfaces';
import type { LoginStep } from './recon/auth-session';
import { loadActiveSteps } from '../../db/case-writer';
import { sensitiveTier } from './recon/safety';

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
  /**
   * General-purpose LLM seam, used ONLY to compile login-recipe steps that have
   * no stored AST (spec §4.1). Optional: a public-scope deployment never needs
   * it, and an authenticated job without it fails loudly rather than silently
   * skipping the recipe.
   */
  llm?: ILLMGateway;
};

type JobRow = {
  status: string;
  target_url: string;
  suite_id: string;
  options: TestWriterJobPayload['options'];
  test_plan: { scenarios?: PlannedScenario[] } | null;
  plan_notes: string | null;
  report: Record<string, unknown> | null;
  // Consent columns — read from the ROW, never trusted from the payload (§10.1).
  scope: 'public' | 'authenticated';
  auth_consent: boolean;
  login_case_id: string | null;
  auth_consented_by: string | null;
};

/**
 * Decides whether this job may crawl signed in, from the DATABASE ROW.
 * Spec: docs/specs/test-writer/spec-authenticated-scope.md §10.1
 *
 * The tempting version of this check reads the payload — "it says authenticated,
 * so verify payload.authConsent is true" — which validates the payload against
 * itself and proves nothing. The DB CHECK constrains the generation_jobs ROW;
 * the BullMQ payload is unconstrained. Anything that can enqueue (Redis access,
 * a bug in the resume path, a future internal caller) could otherwise send
 * {scope:'authenticated', authConsent:true, loginCaseId:<any case>} against a
 * row recorded public, and the pipeline would sign in with no recorded consent,
 * no consenting user and no role check.
 *
 * So the row decides, the row supplies the login case, and a disagreement is
 * loud rather than silently resolved.
 */
export type ConsentVerdict =
  | { mode: 'public' }
  | { mode: 'authenticated'; loginCaseId: string }
  | { mode: 'mismatch'; detail: string };

export function decideConsent(payload: TestWriterJobPayload, row: {
  scope: string; auth_consent: boolean; login_case_id: string | null; auth_consented_by: string | null;
}): ConsentVerdict {
  const rowWantsAuth = row.scope === 'authenticated';
  const payloadWantsAuth = payload.scope === 'authenticated';

  if (!rowWantsAuth && !payloadWantsAuth) return { mode: 'public' };

  if (payloadWantsAuth !== rowWantsAuth) {
    return {
      mode: 'mismatch',
      detail: `job scope is "${row.scope}" but the queued message asked for "${payload.scope}"`,
    };
  }
  if (!row.auth_consent || !row.login_case_id || !row.auth_consented_by) {
    return {
      mode: 'mismatch',
      detail: 'the job is marked authenticated but carries no recorded consent, consenter or sign-in test',
    };
  }
  // The RECIPE comes from the row too — never payload.loginCaseId.
  return { mode: 'authenticated', loginCaseId: row.login_case_id };
}

export async function runTestWriterJob(
  payload: TestWriterJobPayload,
  deps: TestWriterPipelineDeps,
): Promise<void> {
  const { rows } = await tenantQuery<JobRow>(
    payload.tenantId,
    `SELECT status, target_url, suite_id, options, test_plan, plan_notes, report,
            scope, auth_consent, login_case_id, auth_consented_by
     FROM generation_jobs WHERE id = $1 AND tenant_id = $2`,
    [payload.jobId, payload.tenantId],
  );
  const job = rows[0];
  if (!job) {
    deps.obs.log('warn', 'testwriter.job_row_missing', { jobId: payload.jobId });
    return;
  }

  // The job ROW decides whether this crawl may sign in — see decideConsent.
  const authDecision = decideConsent(payload, job);
  if (authDecision.mode === 'mismatch') {
    deps.obs.increment('testwriter.consent_mismatch');
    deps.obs.log('error', 'testwriter.consent_mismatch', {
      jobId: payload.jobId, detail: authDecision.detail,
    });
    await finishJob(payload.tenantId, payload.jobId, 'blocked', null,
      'This analysis was stopped because its recorded permissions did not match what was requested.');
    return;
  }

  try {
    if (payload.resumeFromPlan) {
      await runGenerationPhases(payload, deps, job);
      return;
    }

    await tenantQuery(
      payload.tenantId,
      `UPDATE generation_jobs SET status = 'running', started_at = now() WHERE id = $1`,
      [payload.jobId],
    );

    // Progress is written as it happens so the UI can show real counts instead
    // of a fake bar. Phases before PLAN otherwise report nothing at all.
    const progress = makeProgressWriter(payload.tenantId, payload.jobId);
    await progress({ phase: 'recon' });

    const recon = await runRecon(payload, deps, progress, authDecision);
    await progress({ phase: 'comprehend', pagesCrawled: recon.pagesCrawled });

    // Sign-in failures are their own outcome, distinct from "everything was
    // blocked": the message names the failing step so the tenant can fix the
    // recipe rather than wonder why nothing happened.
    // A job that ends here has no tests to show, which is precisely when the
    // customer most needs to hear what Kaizen DID see. Spec: findings §0.
    const earlyFindings = async (): Promise<Finding[]> => rankFindings(
      await reconFindings(
        payload.tenantId, payload.suiteId,
        recon.errorPages ?? [],
        recon.auth?.publicPartitionUnverified === true,
      ).catch(() => []),
    );

    if (recon.auth?.blockedReason) {
      await finishJob(payload.tenantId, payload.jobId, 'blocked', { recon, findings: await earlyFindings() },
        authBlockedMessage(recon.auth.blockedReason, recon.auth.blockedDetail));
      return;
    }
    if (recon.pagesCrawled === 0) {
      await finishJob(payload.tenantId, payload.jobId, 'blocked', { recon, findings: await earlyFindings() },
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

    // A scoped suggestion targets one page, and every scenario must reach it.
    // Held here rather than derived inside PLAN so the drop reason and the
    // prompt agree about what "this page" means.
    const focusUrl = payload.options.focusUrl
      ? normalizeUrl(payload.options.focusUrl) ?? payload.options.focusUrl
      : undefined;

    // ── PLAN ────────────────────────────────────────────────────────────────
    // Announced, not silent. PLAN is the longest single stretch before the
    // user's turn, and without this the rail sat on UNDERSTAND throughout —
    // leaving the one segment immediately before the checkpoint as the only one
    // that never lit, which teaches the user the rail is decorative.
    await progress({ phase: 'plan', pagesCrawled: recon.pagesCrawled });

    const pages = await deps.repository.listClassifiedPages(payload.tenantId, payload.suiteId);
    const consent = await loadSuiteConsent(payload.tenantId, payload.suiteId);
    const existingCaseNames = await loadExistingCaseNames(payload.tenantId, payload.suiteId);

    // A whole-app analyze plans PER PAGE, from each page's dossier — the page as
    // an engineer reads it. Scoped Suggest is one page and keeps the focused
    // planner. Spec: docs/specs/test-writer/spec-planner-per-page.md §1
    const plan = focusUrl
      ? await deps.planner.plan({
          tenantId: payload.tenantId,
          appBrief: synthesis.brief,
          tenantBrief,
          pages,
          existingCaseNames,
          scope: payload.scope,
          syntheticDataConsent: consent,
          maxScenarios: payload.options.maxScenarios,
          focusUrl,
        })
      : await deps.planner.planPages({
          tenantId: payload.tenantId,
          appSummary: `${synthesis.brief.appType}: ${synthesis.brief.summary}`,
          tenantBrief,
          pages: await deps.repository.listPageDossiers(payload.tenantId, payload.suiteId),
          existingCaseNames,
          scope: payload.scope,
          syntheticDataConsent: consent,
          maxScenarios: payload.options.maxScenarios,
        });

    const report = {
      recon,
      findings: await earlyFindings(),
      comprehend: {
        appSummary: `${synthesis.brief.appType}: ${synthesis.brief.summary}`,
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
        fromRepertoire: plan.repertoireCount ?? 0,
        pagesPlannedFor: plan.pagesPlannedFor ?? null,
        pagesExcludedByBrief: plan.pagesExcludedByBrief ?? [],
        pagesSkippedAsIndex: plan.pagesSkippedAsIndex ?? [],
        dropped: plan.dropped,
      },
    };

    await tenantQuery(
      payload.tenantId,
      `UPDATE generation_jobs SET test_plan = $2, report = $3 WHERE id = $1`,
      [payload.jobId, JSON.stringify({ scenarios: plan.scenarios }), JSON.stringify(report)],
    );

    if (plan.scenarios.length === 0) {
      await finishJob(payload.tenantId, payload.jobId, 'completed', report, 'No scenarios could be planned.');
      return;
    }

    // ── Checkpoint ──────────────────────────────────────────────────────────
    if (payload.options.planApproval !== 'auto') {
      await tenantQuery(
        payload.tenantId,
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
    await finishJob(payload.tenantId, payload.jobId, 'failed', null, message);
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

function makeProgressWriter(tenantId: string, jobId: string): (p: JobProgress) => Promise<void> {
  return async (p) => {
    await tenantQuery(
      tenantId,
      `UPDATE generation_jobs
       SET report = COALESCE(report, '{}'::jsonb) || jsonb_build_object('progress', $2::jsonb)
       WHERE id = $1`,
      [jobId, JSON.stringify(p)],
    ).catch(() => { /* progress is a nicety; never fail a job over it */ });
  };
}

/** Turns a sign-in failure into something the tenant can act on. */
function authBlockedMessage(
  reason: 'login_failed' | 'login_challenge' | 'login_budget_exhausted',
  detail: string | null,
): string {
  switch (reason) {
    case 'login_challenge':
      return `Couldn't sign in — ${detail ?? 'your sign-in flow is protected by a bot check'}. Kaizen never bypasses these; use a test account without one.`;
    case 'login_budget_exhausted':
      return detail ?? 'Kaizen stopped after repeated sign-ins to avoid tripping your app\'s rate limits.';
    default:
      return `Couldn't sign in — ${detail ?? 'the sign-in test did not complete'}. Fix or re-run that test, then try again.`;
  }
}

async function runRecon(
  payload: TestWriterJobPayload,
  deps: TestWriterPipelineDeps,
  progress: (p: JobProgress) => Promise<void>,
  authDecision: ConsentVerdict,
): Promise<CrawlReport & { linksInserted: number }> {
  const budgets = {
    ...DEFAULT_BUDGETS,
    maxPages: Math.min(payload.options.maxPages || DEFAULT_BUDGETS.maxPages, HARD_MAX_PAGES),
  };
  const edges: Array<{ fromUrl: string; toUrl: string; viaElementName: string }> = [];

  // The login recipe is loaded from the case id the ROW carries (§10.1). Steps
  // with a stored compiled_ast cost nothing; the rest compile through the
  // content-hash cache, billed to this tenant.
  const auth = authDecision.mode === 'authenticated'
    ? {
        loginCaseId: authDecision.loginCaseId,
        steps: await loadLoginSteps(payload.tenantId, authDecision.loginCaseId, deps),
      }
    : undefined;

  // Sampled BEFORE the crawl: an authenticated crawl writes requires_auth marks
  // itself, so asking afterwards would always find one (spec §5.3).
  const hadPublicObservation = auth
    ? await deps.repository.hasPublicObservation(payload.tenantId, payload.suiteId)
    : true;

  const report = await deps.crawler.crawl(
    { tenantId: payload.tenantId, jobId: payload.jobId, targetUrl: payload.targetUrl, budgets, auth },
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

  // Say plainly when every private mark is a conservative default rather than
  // an observation. The remedy is one public analyze, which is authoritative in
  // both directions — cheaper and more accurate than the probing pass we
  // deliberately did not build.
  if (report.auth) report.auth.publicPartitionUnverified = !hadPublicObservation;

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
  await tenantQuery(payload.tenantId,
    `UPDATE generation_jobs SET status = 'running' WHERE id = $1`, [payload.jobId]);

  const planned = job.test_plan?.scenarios ?? [];
  // An explicit empty array means "the human discarded this plan" — it must not
  // fall through to "approve everything". Only an ABSENT list means auto mode.
  const approved = payload.approvedScenarios === undefined
    ? planned
    : planned.filter((s) => payload.approvedScenarios!.includes(s.name));

  if (approved.length === 0) {
    await finishJob(payload.tenantId, payload.jobId, 'completed', job.report ?? null, 'No scenarios were approved.');
    return;
  }

  const consent = await loadSuiteConsent(payload.tenantId, payload.suiteId);
  // Credentials the brief names — a sign-in test types these, not a seed token.
  const accounts = knownAccounts(await loadTenantBrief(payload.tenantId, payload.suiteId));
  const rejected: ScenarioRejection[] = [];
  const written: WrittenScenario[] = [];
  const writeParamsByRef = new Map<string, Parameters<ScenarioWriter['write']>[0]>();
  const progress = makeProgressWriter(payload.tenantId, payload.jobId);
  await progress({ phase: 'write', scenariosWritten: 0, scenariosTotal: approved.length });

  // Where a test must NAVIGATE, as opposed to how a page is identified. Loaded
  // once: only pages whose observed URL differs from the normalized one appear.
  // Spec: docs/specs/test-writer/spec-oracle-delta-and-fidelity.md §4
  const navigable = await deps.repository.getNavigableUrls(payload.tenantId, payload.suiteId);
  const navigableUrl = (url: string): string => navigable.get(url) ?? url;

  // The sign-in prefix, once: dedup ignores it and every proving run carries it.
  // ── DEDUP (kind-aware, against each other and the suite's existing cases)
  // Loaded before dedup rather than at VALIDATE, because dedup needs to know
  // which leading steps are sign-in boilerplate in order to ignore them.
  const reconAuth = (job.report as { recon?: { auth?: { loginPageUrl?: string | null; landedUrl?: string | null } } } | null)
    ?.recon?.auth ?? null;
  let signinWitness: string | null = null;
  let loginPrefixSteps: LoginStep[] | undefined;
  if (job.scope === 'authenticated' && job.login_case_id) {
    const loaded = await loadLoginSteps(payload.tenantId, job.login_case_id, deps);
    // A recipe that ends on the Login click gets the witness recon observed
    // (spec-validation-trust §5): the landing url, as a final assert_url.
    const witnessed = withSigninWitness(loaded, reconAuth);
    loginPrefixSteps = witnessed.prefix;
    signinWitness = witnessed.witness;
    if (signinWitness) {
      deps.obs.increment('testwriter.signin_witness_appended');
      deps.obs.log('info', 'testwriter.signin_witness', { jobId: payload.jobId, witness: signinWitness });
    }
  }

  // ── One ROUND: WRITE → DEDUP → JUDGE → VALIDATE for a set of plans. Round 1
  // is the approved plan; a fill round is what the planner adds for the pages
  // that still have material, so that asking for 30 means 30 and not 'however
  // many survived'. Spec: docs/specs/test-writer/spec-planner-per-page.md §1.5
  const runRound = async (approved: PlannedScenario[], roundNo: number) => {
    const roundWritten: WrittenScenario[] = [];
    // ── WRITE (sequential: each call is small, and ordering keeps the report readable)
    for (const plan of approved) {
      // Sensitive pages are readable knowledge for COMPREHEND but are never
      // writable targets: nothing can be generated against elements that are
      // never handed to WRITE, which is cheaper and stronger than filtering the
      // step that would have used them. Spec §6.5.
      const targetPages = job.scope === 'authenticated'
        ? plan.targetPages.filter((u) => sensitiveTier(u) === null)
        : plan.targetPages;
      if (targetPages.length === 0) {
        rejected.push({
          name: plan.name, stage: 'safety',
          reason: 'targets only settings/billing-class pages, which Kaizen will not write tests against',
        });
        continue;
      }

      const grounding = await deps.repository.getGroundingElements(
        payload.tenantId, payload.suiteId, targetPages,
      );
      // A page with no controls is not an untestable page. the-internet's 404,
      // javascript_error and nested_frames pages carry nothing clickable and were
      // all rejected here — while "navigate there and verify the text 'Not Found'
      // is shown" is exactly the test a QA engineer writes for them.
      // Spec: docs/specs/test-writer/spec-oracle-delta-and-fidelity.md §2
      const pageText = await deps.repository.getPageTexts(
        payload.tenantId, payload.suiteId, targetPages,
      );
      if (grounding.length === 0 && pageText.length === 0) {
        rejected.push({
          name: plan.name, stage: 'schema',
          reason: 'the target pages have neither observed elements nor readable text',
        });
        continue;
      }
      const formSummaries = await deps.repository.getFormSummaries(
        payload.tenantId, payload.suiteId, targetPages,
      );

      const writeParams = {
        tenantId: payload.tenantId,
        // Identity did its job — grounding, forms and text were all fetched by the
        // normalized URLs. From here on the plan is about NAVIGATION, so it
        // carries the URLs the site actually serves.
        plan: { ...plan, targetPages: targetPages.map(navigableUrl) },
        // Same reason: the element list tells the model which page each control is
        // on, and that url must be the one it can navigate to.
        grounding: grounding.map((g) => ({ ...g, pageUrl: navigableUrl(g.pageUrl) })),
        formSummaries,
        // ONLY when there is nothing to click. Offered alongside a full element
        // list it became an escape hatch: the-internet run 2 answered twelve
        // different plans with "navigate to the home page, verify the text
        // 'Welcome to the-internet' is shown", and dedup ate eleven of them.
        // Spec: docs/specs/test-writer/spec-oracle-delta-and-fidelity.md §2.2
        pageText: grounding.length === 0 ? pageText : [],
        pagePath: targetPages.map(navigableUrl),
        seedTokens: [...FORM_DATA_TOKENS],
        steeringNotes: job.plan_notes,
        safeMode: payload.options.safeMode,
        maxSteps: 10,
        scope: job.scope,
        syntheticDataConsent: consent,
        knownAccounts: accounts,
        ...(plan.reachedBy?.length ? { reachedBy: plan.reachedBy } : {}),
      };
      const outcome = await deps.writer.write(writeParams);

      if (outcome.ok) {
        written.push(outcome.scenario);
        roundWritten.push(outcome.scenario);
        // Kept so a judge rewrite can re-run WRITE with the same grounding.
        writeParamsByRef.set(plan.name, writeParams);
      }
      else {
        rejected.push({
          name: plan.name, stage: outcome.failure.stage, reason: outcome.failure.reason,
          ...(outcome.failure.steps?.length ? { steps: outcome.failure.steps } : {}),
        });
      }
      await progress({
        phase: 'write', scenariosWritten: written.length, scenariosTotal: written.length + (approved.length - roundWritten.length),
      });
    }

    const existing = await loadExistingCaseSteps(
      payload.tenantId, payload.suiteId, (loginPrefixSteps ?? []).map((s) => s.rawText),
    );
    const dedup = dedupeScenarios(
      roundWritten.map((w) => ({
        planRef: w.plan.name, kind: w.kind, name: w.name, steps: w.steps.map((s) => s.text),
      })),
      existing,
    );
    const stepsByRef = new Map(roundWritten.map((w) => [w.plan.name, w.steps.map((s) => s.text)]));
    for (const drop of dedup.dropped) {
      rejected.push({
        name: drop.name, stage: 'dedup', reason: `duplicate of "${drop.duplicateOf}"`,
        steps: stepsByRef.get(drop.planRef),
      });
    }
    const keptRefs = new Set(dedup.kept.map((k) => k.planRef));
    const deduped = roundWritten.filter((w) => keptRefs.has(w.plan.name));

    // ── JUDGE (batched, with one repair round — the value filter VALIDATE
    // cannot provide, now able to fix an oracle rather than only delete it).
    // Spec: docs/specs/test-writer/spec-judge-repair-loop.md §2.2
    const judged = await judgeWithRepair(deduped, {
      judge: (batch) => deps.gateway.judgeScenarios({
        scenarios: batch.map((w) => ({
          planRef: w.plan.name, name: w.name, kind: w.kind,
          steps: w.steps.map((s) => s.text), rationale: w.rationale,
          // What was approved, next to what was written — the judge cannot ask
          // "is this the test the plan promised?" without it.
          // Spec: docs/specs/test-writer/spec-oracle-delta-and-fidelity.md §2
          outline: w.plan.outline, expectedOutcome: w.plan.expectedOutcome, targetPages: w.plan.targetPages,
        })),
        lintFindings: Object.fromEntries(batch.map((w) => [w.plan.name, w.lintFindings])),
      }, payload.tenantId),
      rewrite: (w, feedback) => {
        const base = writeParamsByRef.get(w.plan.name);
        if (!base) return Promise.resolve({ ok: false, failure: { plan: w.plan, stage: 'schema', reason: 'no write context' } });
        return deps.writer.write({
          ...base,
          judgeFeedback: feedback,
          previousSteps: w.steps.map((s) => s.text),
        });
      },
      obs: deps.obs,
    });
    const survivors = judged.survivors;
    rejected.push(...judged.rejected);

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
      // Authenticated drafts are self-contained: the sign-in steps ride along so
      // each proving run signs in for itself, from a cold browser (spec §6.2, §7).
      loginPrefix: loginPrefixSteps,
      // Whether the recipe's own final assertion can actually witness a session.
      // Fail-closed on the LABEL, not the work: a recipe that verifies something
      // visible to signed-out visitors still runs, but nothing it carries may be
      // called proven (spec-validation-trust §5).
      signinAssertionProves: loginPrefixSteps
        ? await signinAssertionIsPrivate(payload.tenantId, payload.suiteId, loginPrefixSteps, deps)
        : true,
    });

    return { written: roundWritten, dedup, judged, survivors, validation, roundNo, attempted: approved.length };
  };

  // ── ROUNDS. The requested count is a target, not a ceiling on effort: after
  // round one, if fewer were delivered than asked and pages still hold unspent
  // material, plan again for those pages only, telling the planner what already
  // exists and what already failed. At most two fill rounds; then say honestly
  // what fell short and why.
  const requested = payload.options.maxScenarios;
  const rounds: Array<Awaited<ReturnType<typeof runRound>>> = [];
  let plans = approved;
  let ledgerFill: { pages: number; shortfallReason: string | null } = { pages: 0, shortfallReason: null };
  for (let roundNo = 1; roundNo <= 3; roundNo++) {
    rounds.push(await runRound(plans, roundNo));
    const delivered = rounds.reduce((n, r) => n + r.validation.proposed.length, 0);
    if (delivered >= requested) break;
    if (focusUrlOf(payload) || roundNo === 3) {
      ledgerFill.shortfallReason = roundNo === 3 ? 'two fill rounds ran; the remaining pages produced nothing further' : null;
      break;
    }
    const ledger = await buildLedger(payload, deps, rounds);
    if (ledger.length === 0) {
      ledgerFill.shortfallReason = 'every crawled page has been planned to the depth it supports';
      break;
    }
    const fill = await deps.planner.planPages({
      tenantId: payload.tenantId,
      appSummary: String((job.report as { comprehend?: { appSummary?: string } } | null)?.comprehend?.appSummary ?? ''),
      tenantBrief: await loadTenantBrief(payload.tenantId, payload.suiteId),
      pages: await deps.repository.listPageDossiers(payload.tenantId, payload.suiteId),
      existingCaseNames: await loadExistingCaseNames(payload.tenantId, payload.suiteId),
      scope: payload.scope,
      syntheticDataConsent: consent,
      maxScenarios: requested - delivered,
      ledger,
    });
    if (fill.scenarios.length === 0) {
      ledgerFill.shortfallReason = 'the planner found nothing more worth testing on the remaining pages';
      break;
    }
    ledgerFill.pages = ledger.length;
    deps.obs.increment('testwriter.fill_round', { round: String(roundNo + 1) });
    plans = fill.scenarios.map((s) => ({ ...s, round: roundNo + 1 }));
    // The plan on the job row is what the UI lists and what a reviewer sees:
    // fill-round scenarios join it, marked with their round.
    await tenantQuery(
      payload.tenantId,
      `UPDATE generation_jobs
          SET test_plan = jsonb_set(COALESCE(test_plan, '{}'::jsonb), '{scenarios}',
                COALESCE(test_plan->'scenarios', '[]'::jsonb) || $2::jsonb)
        WHERE id = $1`,
      [payload.jobId, JSON.stringify(plans)],
    );
  }
  const validation = mergeValidation(rounds.map((r) => r.validation));
  const dedupDropped = rounds.reduce((n, r) => n + r.dedup.dropped.length, 0);
  const judgedCount = rounds.reduce((n, r) => n + r.judged.survivors.length + r.judged.rejected.length, 0);
  const repairAttempted = rounds.reduce((n, r) => n + r.judged.repairAttempted, 0);
  const repaired = rounds.reduce((n, r) => n + r.judged.repaired, 0);
  const survivorsCount = rounds.reduce((n, r) => n + r.survivors.length, 0);
  const attempted = rounds.reduce((n, r) => n + r.attempted, 0);

  // What Kaizen noticed that is not a test. Assembled last so it can draw on
  // everything the job saw — the crawl's error pages, the site model's unnamed
  // controls, and whatever validation learned about the app.
  // Spec: docs/specs/test-writer/spec-findings-and-coverage.md
  const recon = (job.report as { recon?: { errorPages?: Array<{ url: string; status: number | null; reason: string }>; auth?: { publicPartitionUnverified?: boolean } } } | null)?.recon;
  const findings = rankFindings(collapseFindings([
    ...await reconFindings(
      payload.tenantId, payload.suiteId,
      recon?.errorPages ?? [],
      recon?.auth?.publicPartitionUnverified === true,
    ).catch(() => []),
    ...validation.findings,
  ]));

  const report = {
    ...(job.report ?? {}),
    findings,
    write: {
      attempted,
      written: written.length,
      deduped: dedupDropped,
      judged: judgedCount,
      judgeRepairAttempted: repairAttempted,
      judgeRepaired: repaired,
      survivedJudge: survivorsCount,
      rounds: rounds.length,
      fillPages: ledgerFill.pages,
      shortfallReason: validation.proposed.length < requested ? ledgerFill.shortfallReason : null,
    },
    validate: {
      proposed: validation.proposed.length,
      validated: validation.proposed.filter((p) => p.validated).length,
      unvalidated: validation.proposed.filter((p) => !p.validated).length,
      ...(validation.signinProbe ? { signinProbe: validation.signinProbe } : {}),
      ...(signinWitness ? { signinWitness } : {}),
    },
    rejected: [...rejected, ...validation.rejected],
    harvest: validation.harvest,
    auditFindings: validation.auditFindings,
  };

  await finishJob(payload.tenantId, payload.jobId, 'completed', report, null, true);
  deps.obs.increment('testwriter.jobs_completed');
}

// ─── helpers ─────────────────────────────────────────────────────────────────

/**
 * Loads the login recipe's steps, compiling any that lack a stored AST.
 * Spec: docs/specs/test-writer/spec-authenticated-scope.md §4.1
 *
 * A login case that has ever run normally arrives fully compiled, so this is
 * usually free. Anything that does compile is billed to THIS tenant (the P2
 * billing-tenant parameterization, finally wired) and — because a login step is
 * exactly the shape that leaks credentials — never lands in the global
 * compiled_ast_cache; LearnedCompiler suppresses that for literal-valued type
 * steps (§12.3).
 */
async function loadLoginSteps(
  tenantId: string,
  loginCaseId: string,
  deps: TestWriterPipelineDeps,
): Promise<LoginStep[]> {
  const rows = await loadActiveSteps(tenantId, loginCaseId);
  if (rows.length === 0) {
    throw new Error('The sign-in test has no active steps.');
  }

  const needsCompile = rows.some((r) => !r.compiledAst);
  if (needsCompile && !deps.llm) {
    throw new Error(
      'The sign-in test has steps that were never compiled, and this deployment has no LLM gateway configured to compile them.',
    );
  }
  const compiler = needsCompile
    ? new LearnedCompiler(deps.llm!, deps.obs, tenantId)
    : null;

  const steps: LoginStep[] = [];
  for (const row of rows) {
    const ast = row.compiledAst ?? await compiler!.compile(row.rawText);
    steps.push({ rawText: row.rawText, ast });
  }
  return steps;
}

async function loadTenantBrief(tenantId: string, suiteId: string): Promise<TenantBrief | null> {
  const { rows } = await tenantQuery<{ tenant_brief: TenantBrief | null }>(
    tenantId,
    `SELECT tenant_brief FROM test_suites WHERE id = $1 AND tenant_id = $2`,
    [suiteId, tenantId],
  );
  return rows[0]?.tenant_brief ?? null;
}

async function loadSuiteConsent(tenantId: string, suiteId: string): Promise<boolean> {
  const { rows } = await tenantQuery<{ allow_synthetic_data: boolean }>(
    tenantId,
    `SELECT allow_synthetic_data FROM test_suites WHERE id = $1 AND tenant_id = $2`,
    [suiteId, tenantId],
  );
  return rows[0]?.allow_synthetic_data ?? false;
}

async function loadExistingCaseNames(tenantId: string, suiteId: string): Promise<string[]> {
  const { rows } = await tenantQuery<{ name: string }>(
    tenantId,
    `SELECT name FROM test_cases WHERE tenant_id = $1 AND suite_id = $2 AND status <> 'rejected'`,
    [tenantId, suiteId],
  );
  return rows.map((r) => r.name);
}

/**
 * Can the login recipe's final assertion tell "signed in" from "still on the
 * login page"? Only if the thing it names lives behind the wall.
 *
 * Unknowable answers are treated as "no": a recipe asserting a url or a title,
 * or naming an element the crawl never catalogued, may be perfectly good — but
 * we cannot say so, and claiming a proof we cannot support is the failure this
 * whole spec exists to stop. Spec: spec-validation-trust.md §5
 */
async function signinAssertionIsPrivate(
  tenantId: string,
  suiteId: string,
  prefix: Array<{ rawText: string; ast: StepAST }>,
  deps: TestWriterPipelineDeps,
): Promise<boolean> {
  const terminal = [...prefix].reverse()
    .find((s) => s.ast.action.startsWith('assert_'));
  const description = terminal?.ast.targetDescription ?? terminal?.ast.value ?? '';
  // Element descriptions carry the accessible name in quotes ('the "Sign out"
  // button', `the text 'Tests'`); anything else gives us no name to look up.
  const quoted = /["'“”‘’]([^"'“”‘’]{2,60})["'“”‘’]/.exec(description);
  if (!quoted) return false;
  return deps.repository.hasSignedInOnlyElement(tenantId, suiteId, quoted[1]).catch(() => false);
}

async function loadExistingCaseSteps(
  tenantId: string, suiteId: string,
  /**
   * The sign-in steps this job prepends to every draft. Existing authenticated
   * cases carry the same prefix baked in, but CANDIDATES are fingerprinted
   * body-only — so a byte-identical scenario scored 0.6 against its own twin
   * and both shipped (observed: two identical drafts eight minutes apart). Strip
   * the prefix so like is compared with like.
   * Spec: docs/specs/test-writer/spec-validation-trust.md §10
   */
  loginPrefixTexts: string[] = [],
): Promise<Array<{ kind: string; steps: string[]; name: string }>> {
  const { rows } = await tenantQuery<{ name: string; steps: string[] }>(
    tenantId,
    `SELECT tc.name, ARRAY_AGG(ts.raw_text ORDER BY tcs.position) AS steps
     FROM test_cases tc
     JOIN test_case_steps tcs ON tcs.case_id = tc.id AND tcs.is_active = true
     JOIN test_steps ts ON ts.id = tcs.step_id
     WHERE tc.tenant_id = $1 AND tc.suite_id = $2 AND tc.status IN ('active', 'draft')
     GROUP BY tc.id, tc.name`,
    [tenantId, suiteId],
  );
  const stripPrefix = (steps: string[]): string[] =>
    loginPrefixTexts.length > 0
      && steps.length > loginPrefixTexts.length
      && loginPrefixTexts.every((text, i) => steps[i] === text)
      ? steps.slice(loginPrefixTexts.length)
      : steps;
  // Existing cases carry no kind marker; compare them against both kinds.
  return rows.flatMap((r) => [
    { kind: 'positive', steps: stripPrefix(r.steps), name: r.name },
    { kind: 'negative', steps: stripPrefix(r.steps), name: r.name },
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
  const { rows } = await tenantQuery<{ purpose: string; tokens: string }>(
    tenantId,
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
  tenantId: string,
  jobId: string,
  status: 'completed' | 'failed' | 'blocked',
  report: Record<string, unknown> | null,
  error: string | null,
  withTokenUsage = false,
): Promise<void> {
  const withUsage = report && withTokenUsage
    ? { ...report, tokenUsage: await tokenUsage(jobId, tenantId) }
    : report;
  await tenantQuery(
    tenantId,
    `UPDATE generation_jobs
     SET status = $2, report = COALESCE($3, report), error = $4, finished_at = now()
     WHERE id = $1`,
    [jobId, status, withUsage ? JSON.stringify(withUsage) : null, error],
  );
}

// ─── fill-round helpers ───────────────────────────────────────────────────────

function focusUrlOf(payload: TestWriterJobPayload): string | undefined {
  return payload.options.focusUrl;
}

/**
 * Per page: what was delivered and what was rejected (with reasons), for the
 * pages that still have material — page-specific controls, and fewer than two
 * delivered tests. Everything else is done. Spec: spec-planner-per-page.md §1.5
 */
async function buildLedger(
  payload: TestWriterJobPayload,
  deps: TestWriterPipelineDeps,
  rounds: Array<{ validation: ValidationOutcome; written: WrittenScenario[] }>,
): Promise<PlanLedger> {
  const dossiers = await deps.repository.listPageDossiers(payload.tenantId, payload.suiteId);
  const pageOfPlan = new Map<string, string>();
  for (const r of rounds) for (const w of r.written) pageOfPlan.set(w.plan.name, w.plan.targetPages[0]);
  const delivered = new Map<string, string[]>();
  const rejected = new Map<string, Array<{ name: string; reason: string }>>();
  for (const r of rounds) {
    for (const p of r.validation.proposed) {
      const page = pageOfPlan.get(p.name) ?? '';
      delivered.set(page, [...(delivered.get(page) ?? []), p.name]);
    }
    for (const x of r.validation.rejected) {
      const page = pageOfPlan.get(x.name) ?? '';
      rejected.set(page, [...(rejected.get(page) ?? []), { name: x.name, reason: x.reason.slice(0, 160) }]);
    }
  }
  // Pages with NOTHING delivered come first — that is where the fill round
  // earns its keep. A page with one good test is only revisited if no bare
  // page is left; sending it every time is how the model re-proposed "Toggle
  // checkbox 1" as "Toggle checkbox 1 state" seven times in one job.
  const rows = dossiers
    .filter((d) => d.elements.length > 0 && (delivered.get(d.urlNormalized)?.length ?? 0) < 2)
    .map((d) => ({
      page: d.urlNormalized,
      delivered: delivered.get(d.urlNormalized) ?? [],
      rejected: rejected.get(d.urlNormalized) ?? [],
    }));
  const bare = rows.filter((r) => r.delivered.length === 0);
  return bare.length > 0 ? bare : rows;
}

function mergeValidation(all: ValidationOutcome[]): ValidationOutcome {
  const out: ValidationOutcome = {
    proposed: [], rejected: [], harvest: {}, auditFindings: {}, findings: [],
  };
  for (const v of all) {
    out.proposed.push(...v.proposed);
    out.rejected.push(...v.rejected);
    Object.assign(out.harvest, v.harvest);
    Object.assign(out.auditFindings, v.auditFindings);
    out.findings.push(...v.findings);
    if (v.signinProbe && !out.signinProbe) out.signinProbe = v.signinProbe;
  }
  return out;
}
