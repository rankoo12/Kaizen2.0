import { createHash } from 'crypto';
import type { BrowserPool } from '../../../workers/browser-pool';
import type { IPageSurveyor } from '../../dom-pruner/interfaces';
import type { IChallengeDetector } from '../../execution-engine/challenge-detector';
import type { IObservability } from '../../observability/interfaces';
import type { ScreenshotService } from '../../media/screenshot.service';
import type { CrawlBudgets, CrawlReport, LinkCapture, PageCapture } from '../interfaces';
import { classifyInteraction, isSessionEndingUrl, sensitiveTier } from './safety';
import { runProbes } from './probe';
import { capturePageMeta, captureForms, captureLinks, condenseOutline } from './page-capture';
import { normalizeUrl, isSameOrigin, pathOf } from './url-normalizer';
import { fetchRobots, isAllowed } from './robots';
import { acquireSession, isSessionLoss, type AuthSessionDeps, type LoginStep } from './auth-session';
import { scrubCapture } from './capture-scrub';

/**
 * RECON crawler — bounded, same-origin BFS with safety-gated interactive
 * probing. Explores like a QA engineer on day one: reads everything, reveals
 * hidden states, never performs an action with side effects.
 * Spec ref: docs/specs/test-writer/spec-recon-crawler.md §2, §4
 *
 * P1 supports scope 'public' only; the authenticated login-recipe flow is P3
 * (spec §5) and is rejected upstream by the pipeline until then.
 */

export type CrawlParams = {
  tenantId: string;
  jobId: string;
  targetUrl: string;
  budgets: CrawlBudgets;
  /**
   * Present only for consented authenticated jobs. The pipeline constructs this
   * from the generation_jobs ROW (never from the queue payload — spec §10.1), so
   * the crawler cannot be talked into signing in by a forged message.
   */
  auth?: {
    loginCaseId: string;
    steps: LoginStep[];
  };
};

/** Called once per captured page, in crawl order — persist incrementally so a
 *  crashed job loses at most one page (spec §2.6). */
export type PageSink = (capture: PageCapture, pageIndex: number) => Promise<void>;

export type ReconCrawlerDeps = {
  pool: BrowserPool;
  surveyor: IPageSurveyor;
  challenges: IChallengeDetector;
  obs: IObservability;
  /** Optional — when absent, screenshotKey stays null (local dev without GCS). */
  screenshots?: ScreenshotService;
  /**
   * Execution seam for the login recipe. Required only when CrawlParams.auth is
   * set; a public crawl never constructs it.
   */
  auth?: Pick<AuthSessionDeps, 'engine' | 'resolver'>;
};

/** What the authenticated crawl reports back. Absent on public jobs. */
export type AuthCrawlReport = {
  sessionVerification: 'assertion+heuristic' | 'heuristic' | null;
  loginSteps: { total: number; passed: number };
  reloginCount: number;
  signInCount: number;
  pagesBehindAuth: number;
  probesSuppressed: number;
  captureSuppressed: number;
  sessionEndingBlocked: number;
  endedEarly: 'session_lost' | null;
  blockedReason: 'login_failed' | 'login_challenge' | 'login_budget_exhausted' | null;
  blockedDetail: string | null;
  /** Set by the pipeline, which knows the suite's history (spec §5.3). */
  publicPartitionUnverified?: boolean;
};

/** Ceiling on sign-ins per job — see spec §5.1. Crawl + re-login only; proving
 *  runs are counted by the validation runner against the same budget. */
const MAX_SIGN_INS_PER_CRAWL = 3;

const SURVEY_CAP = 60;

export class ReconCrawler {
  constructor(private readonly deps: ReconCrawlerDeps) {}

  async crawl(params: CrawlParams, sink: PageSink): Promise<CrawlReport> {
    const { pool, surveyor, challenges, obs, screenshots } = this.deps;
    const { budgets } = params;

    const rootNormalized = normalizeUrl(params.targetUrl);
    if (!rootNormalized) throw new Error(`Invalid target URL: ${params.targetUrl}`);
    const rootOrigin = new URL(rootNormalized).origin;

    const robots = await fetchRobots(rootOrigin);

    const authed = !!params.auth;
    const report: CrawlReport = {
      pagesCrawled: 0,
      pagesBlocked: 0,
      probesPerformed: 0,
      authScope: authed ? 'authenticated' : 'public',
      urlsSkippedByBudget: 0,
    };
    const auth: AuthCrawlReport | null = authed
      ? {
          sessionVerification: null,
          loginSteps: { total: params.auth!.steps.length, passed: 0 },
          reloginCount: 0,
          signInCount: 0,
          pagesBehindAuth: 0,
          probesSuppressed: 0,
          captureSuppressed: 0,
          sessionEndingBlocked: 0,
          endedEarly: null,
          blockedReason: null,
          blockedDetail: null,
        }
      : null;

    const startedAt = Date.now();
    const visited = new Set<string>();
    const queue: Array<{ url: string; depth: number }> = [{ url: rootNormalized, depth: 0 }];
    let pageIndex = 0;
    let lastNavAt = 0;

    const browser = await pool.acquire();
    // Downloads off, popups auto-closed, dialogs dismissed (never accepted —
    // the crawler must not confirm anything). Spec §4.3.
    const context = await browser.newContext({ acceptDownloads: false });

    // __name shim — same guard the worker uses (worker.ts): tsx/esbuild wraps
    // named inner declarations inside evaluate() callbacks with __name(...),
    // which doesn't exist in the browser; without the shim, page-capture and
    // probe evaluates throw and reveals silently vanish. No-op under tsc.
    await context.addInitScript(() => {
      const g = globalThis as unknown as { __name?: (fn: unknown) => unknown };
      g.__name = g.__name || ((fn) => fn);
    });

    const page: any = await context.newPage();
    // Registered AFTER newPage() so the main page's own 'page' event (fired
    // during creation) can't reach the popup-closer.
    context.on('page', (extra: any) => {
      if (extra !== page) void extra.close().catch(() => {});
    });
    page.on('dialog', (dialog: any) => void dialog.dismiss().catch(() => {}));

    // ── Session acquisition (authenticated scope only) ──────────────────────
    // Runs BEFORE the BFS so every navigation below is made as a signed-in user,
    // on this same context. Spec §4.
    let loginPageUrl: string | null = null;
    const signIn = async (): Promise<boolean> => {
      if (!params.auth || !auth) return false;
      if (auth.signInCount >= MAX_SIGN_INS_PER_CRAWL) {
        auth.blockedReason = 'login_budget_exhausted';
        auth.blockedDetail =
          `Kaizen stopped after ${auth.signInCount} sign-ins to avoid tripping your app's rate limits.`;
        return false;
      }
      auth.signInCount++;
      const result = await acquireSession(page, {
        tenantId: params.tenantId,
        rootOrigin,
        steps: params.auth.steps,
        domain: new URL(rootNormalized).hostname,
        pageTimeoutMs: budgets.pageTimeoutMs,
      }, { ...this.deps.auth!, challenges, obs });

      auth.loginSteps.passed = result.stepsPassed;
      if (!result.verified) {
        auth.blockedReason = result.reason;
        auth.blockedDetail = result.detail;
        return false;
      }
      auth.sessionVerification = result.sessionVerification;
      loginPageUrl = result.loginPageUrl;
      return true;
    };

    try {
      if (authed) {
        if (!await signIn()) {
          report.auth = auth!;
          return report;   // blocked — the pipeline surfaces auth.blockedReason
        }
        // The landed page is worth exploring too: it is the app's signed-in
        // entry point, and it costs one page of budget.
        const landed = normalizeUrl(page.url());
        if (landed && landed !== rootNormalized && isSameOrigin(landed, rootOrigin)) {
          queue.push({ url: landed, depth: 0 });
        }
      }

      while (queue.length > 0) {
        if (report.pagesCrawled + report.pagesBlocked >= budgets.maxPages) break;
        if (Date.now() - startedAt > budgets.jobTimeoutMs) {
          obs.log('warn', 'testwriter.crawl_job_timeout', { jobId: params.jobId });
          break;
        }

        const { url, depth } = queue.shift()!;
        if (visited.has(url)) continue;
        visited.add(url);

        // Never navigate to a logout URL, in ANY scope. The BFS queue — not the
        // click path — is how a crawler ends its own session: the classic logout
        // is an icon link with no accessible name that classifies as ordinary
        // navigation. A public-scope GET /logout is harmless only by luck.
        //
        // Filtered at enqueue (below) AND here: the seed URL and the post-login
        // landing URL enter the queue without passing that filter.
        if (isSessionEndingUrl(url)) {
          obs.increment('testwriter.session_ending_url_blocked');
          continue;
        }

        if (!isAllowed(robots, pathOf(url))) {
          report.pagesBlocked++;
          await sink(blockedCapture(url, 'robots'), pageIndex++);
          continue;
        }

        // Rate limit: ≥ minPageIntervalMs between navigations.
        const wait = budgets.minPageIntervalMs - (Date.now() - lastNavAt);
        if (wait > 0) await page.waitForTimeout(wait);
        lastNavAt = Date.now();

        try {
          await page.goto(url, { timeout: budgets.pageTimeoutMs, waitUntil: 'domcontentloaded' });
        } catch (err) {
          obs.log('warn', 'testwriter.crawl_goto_failed', {
            url, error: err instanceof Error ? err.message : String(err),
          });
          obs.increment('testwriter.crawl_goto_failed');
          continue;
        }
        await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});

        const challenge = await challenges.detect(page);
        if (challenge) {
          report.pagesBlocked++;
          await sink(blockedCapture(url, 'challenge'), pageIndex++);
          continue; // never attempt bypass (spec §2.2)
        }

        let meta = await capturePageMeta(page);
        let landed = normalizeUrl(page.url()) ?? url;

        // ── Session-loss detection (authenticated scope) ─────────────────────
        // Same predicate the public crawler uses for auth walls, plus: landing
        // on the recorded login URL is a loss whether or not the form rendered.
        // One re-login, then stop with a partial model — everything captured so
        // far is already persisted, and partial knowledge is still knowledge.
        if (auth && isSessionLoss(landed, url, loginPageUrl, meta.hasVisiblePasswordInput)) {
          if (auth.reloginCount >= 1 || !await signIn()) {
            auth.endedEarly = 'session_lost';
            obs.log('warn', 'testwriter.crawl_session_lost', {
              jobId: params.jobId, pagesCrawled: report.pagesCrawled,
            });
            break;
          }
          auth.reloginCount++;
          try {
            await page.goto(url, { timeout: budgets.pageTimeoutMs, waitUntil: 'domcontentloaded' });
            await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
          } catch {
            continue;
          }
          meta = await capturePageMeta(page);
          landed = normalizeUrl(page.url()) ?? url;
          // Still walled after a fresh sign-in: this page is simply not ours to see.
          if (isSessionLoss(landed, url, loginPageUrl, meta.hasVisiblePasswordInput)) {
            await sink(authWallCapture(url), pageIndex++);
            report.pagesCrawled++;
            continue;
          }
        }

        // Auth-wall detection (public scope): a redirect that lands on a page
        // with a password input is a login wall — record the requested URL as
        // requires_auth and do NOT crawl beyond it. Spec §5.
        if (!auth && landed !== url && meta.hasVisiblePasswordInput) {
          await sink(authWallCapture(url), pageIndex++);
          report.pagesCrawled++;
          continue;
        }

        // ── Tier A: reading IS the exposure ─────────────────────────────────
        // /api-keys and /billing render live secrets on a signed-in account.
        // Record URL + title only: no survey, no forms, no screenshot, no
        // ax_outline, and therefore no classification call. Spec §5.2.
        if (auth && sensitiveTier(landed) === 'capture-suppressed') {
          auth.captureSuppressed++;
          auth.pagesBehindAuth++;
          await sink(suppressedCapture(landed, meta.title), pageIndex++);
          report.pagesCrawled++;
          obs.increment('testwriter.capture_suppressed');
          continue;
        }

        // Redirect onto an already-captured page — nothing new to record.
        if (landed !== url && visited.has(landed)) continue;
        visited.add(landed);

        const survey = await surveyor.survey(page, SURVEY_CAP);
        const forms = await captureForms(page);
        const links = await captureLinks(page, page.url(), rootOrigin);

        // Safety gate: ONLY safe-reveal candidates are ever probed.
        const safeReveals = survey.filter(
          (c) => classifyInteraction(c, { rootOrigin, pageUrl: page.url() }) === 'safe-reveal',
        );
        // Tier B: capture the page, but never probe it. On a settings page a
        // misclassified toggle IS the user's configuration — reading is safe,
        // revealing is not. One auditable decision per page. Spec §5.2.
        const passiveOnly = !!auth && sensitiveTier(landed) === 'passive-only';
        if (passiveOnly && auth) auth.probesSuppressed++;
        const { reveals, probesPerformed } = await runProbes(
          page, passiveOnly ? [] : safeReveals, budgets.probesPerPage,
          { pageUrl: page.url(), rootOrigin, obs },
        );
        report.probesPerformed += probesPerformed;

        // Links revealed by probing join the outgoing set (and the BFS queue).
        const outgoing = mergeLinks(links, reveals.flatMap((r) =>
          r.revealedLinks.map((to) => ({ toUrlNormalized: to, viaElementName: r.trigger.name }))));

        const { outline, contentHash } = condenseOutline(survey, forms, meta.title, meta.headings);

        // Tier B screenshots are off by default: on a signed-in members or
        // profile page the PNG is the densest PII artifact in the system, and
        // /media is readable by every workspace member. Re-enabled only by the
        // P6 per-suite screenshot control. Spec §5.2.
        let screenshotKey: string | null = null;
        if (screenshots && !passiveOnly) {
          try {
            const png: Buffer = await page.screenshot({ timeout: 10_000 });
            screenshotKey = await screenshots.upload(
              png, params.tenantId, `recon-${params.jobId}`, pageIndex, 'after',
            );
          } catch {
            obs.increment('testwriter.screenshot_failed');
          }
        }

        let capture: PageCapture & { axOutline?: Record<string, unknown> } = {
          urlNormalized: landed,
          title: meta.title,
          headings: meta.headings,
          survey,
          forms,
          outgoingLinks: outgoing,
          revealedStates: reveals,
          contentHash,
          screenshotKey,
          // Everything seen while signed in is private until proven otherwise.
          // The repository preserves a prior public `false` so an authenticated
          // re-crawl of the marketing pages cannot vandalise public knowledge.
          requiresAuth: authed,
          blocked: null,
        };
        // ax_outline rides on the capture via condenseOutline in the repository;
        // pass it along without widening the shared type.
        capture.axOutline = outline;

        // Tier B: redact secrets and PII before this reaches storage OR a prompt.
        if (passiveOnly) capture = scrubCapture(capture);

        if (auth) auth.pagesBehindAuth++;
        await sink(capture, pageIndex++);
        report.pagesCrawled++;

        if (depth + 1 <= budgets.maxDepth) {
          for (const link of outgoing) {
            if (visited.has(link.toUrlNormalized)) continue;
            if (!isSameOrigin(link.toUrlNormalized, rootOrigin)) continue;
            // Suppressed HERE, at enqueue — this is the audit point, because a
            // logout URL that never enters the queue is never dequeued either.
            if (isSessionEndingUrl(link.toUrlNormalized)) {
              if (auth) auth.sessionEndingBlocked++;
              obs.increment('testwriter.session_ending_url_blocked');
              continue;
            }
            queue.push({ url: link.toUrlNormalized, depth: depth + 1 });
          }
        }
      }

      report.urlsSkippedByBudget = queue.filter((q) => !visited.has(q.url)).length;
      if (auth) report.auth = auth;
      return report;
    } finally {
      await context.close().catch(() => {});
      await pool.release();
    }
  }
}

function blockedCapture(url: string, blocked: 'challenge' | 'robots'): PageCapture {
  return {
    urlNormalized: url,
    title: '',
    headings: [],
    survey: [],
    forms: [],
    outgoingLinks: [],
    revealedStates: [],
    contentHash: createHash('sha256').update(`blocked:${blocked}:${url}`).digest('hex'),
    screenshotKey: null,
    requiresAuth: false,
    blocked,
  };
}

/**
 * A Tier A sensitive page: recorded so the site model is honest that it exists,
 * with nothing captured from it. No survey, no forms, no screenshot, no outline
 * — and because there is no outline, COMPREHEND never sends it to a prompt.
 * Spec: docs/specs/test-writer/spec-authenticated-scope.md §5.2
 */
function suppressedCapture(url: string, title: string): PageCapture {
  return {
    urlNormalized: url,
    title,
    headings: [],
    survey: [],
    forms: [],
    outgoingLinks: [],
    revealedStates: [],
    contentHash: createHash('sha256').update(`capture-suppressed:${url}`).digest('hex'),
    screenshotKey: null,
    requiresAuth: true,
    blocked: 'capture-suppressed',
  };
}

function authWallCapture(url: string): PageCapture {
  return {
    urlNormalized: url,
    title: '',
    headings: [],
    survey: [],
    forms: [],
    outgoingLinks: [],
    revealedStates: [],
    contentHash: createHash('sha256').update(`auth-wall:${url}`).digest('hex'),
    screenshotKey: null,
    requiresAuth: true,
    blocked: null,
  };
}

function mergeLinks(base: LinkCapture[], extra: LinkCapture[]): LinkCapture[] {
  const seen = new Set(base.map((l) => l.toUrlNormalized));
  const merged = [...base];
  for (const link of extra) {
    if (!seen.has(link.toUrlNormalized)) {
      seen.add(link.toUrlNormalized);
      merged.push(link);
    }
  }
  return merged;
}
