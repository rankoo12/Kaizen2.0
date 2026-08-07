import { createHash } from 'crypto';
import type { BrowserPool } from '../../../workers/browser-pool';
import type { IPageSurveyor } from '../../dom-pruner/interfaces';
import type { IChallengeDetector } from '../../execution-engine/challenge-detector';
import type { IObservability } from '../../observability/interfaces';
import type { ScreenshotService } from '../../media/screenshot.service';
import type { CrawlBudgets, CrawlReport, LinkCapture, PageCapture } from '../interfaces';
import { classifyInteraction } from './safety';
import { runProbes } from './probe';
import { capturePageMeta, captureForms, captureLinks, condenseOutline } from './page-capture';
import { normalizeUrl, isSameOrigin, pathOf } from './url-normalizer';
import { fetchRobots, isAllowed } from './robots';

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
};

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

    const report: CrawlReport = {
      pagesCrawled: 0,
      pagesBlocked: 0,
      probesPerformed: 0,
      authScope: 'public',
      urlsSkippedByBudget: 0,
    };

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

    try {
      while (queue.length > 0) {
        if (report.pagesCrawled + report.pagesBlocked >= budgets.maxPages) break;
        if (Date.now() - startedAt > budgets.jobTimeoutMs) {
          obs.log('warn', 'testwriter.crawl_job_timeout', { jobId: params.jobId });
          break;
        }

        const { url, depth } = queue.shift()!;
        if (visited.has(url)) continue;
        visited.add(url);

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

        const meta = await capturePageMeta(page);
        const landed = normalizeUrl(page.url()) ?? url;

        // Auth-wall detection (public scope): a redirect that lands on a page
        // with a password input is a login wall — record the requested URL as
        // requires_auth and do NOT crawl beyond it. Spec §5.
        if (landed !== url && meta.hasVisiblePasswordInput) {
          await sink(authWallCapture(url), pageIndex++);
          report.pagesCrawled++;
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
        const { reveals, probesPerformed } = await runProbes(
          page, safeReveals, budgets.probesPerPage, { pageUrl: page.url(), rootOrigin, obs },
        );
        report.probesPerformed += probesPerformed;

        // Links revealed by probing join the outgoing set (and the BFS queue).
        const outgoing = mergeLinks(links, reveals.flatMap((r) =>
          r.revealedLinks.map((to) => ({ toUrlNormalized: to, viaElementName: r.trigger.name }))));

        const { outline, contentHash } = condenseOutline(survey, forms, meta.title, meta.headings);

        let screenshotKey: string | null = null;
        if (screenshots) {
          try {
            const png: Buffer = await page.screenshot({ timeout: 10_000 });
            screenshotKey = await screenshots.upload(
              png, params.tenantId, `recon-${params.jobId}`, pageIndex, 'after',
            );
          } catch {
            obs.increment('testwriter.screenshot_failed');
          }
        }

        const capture: PageCapture = {
          urlNormalized: landed,
          title: meta.title,
          headings: meta.headings,
          survey,
          forms,
          outgoingLinks: outgoing,
          revealedStates: reveals,
          contentHash,
          screenshotKey,
          requiresAuth: false,
          blocked: null,
        };
        // ax_outline rides on the capture via condenseOutline in the repository;
        // pass it along without widening the shared type.
        (capture as PageCapture & { axOutline?: Record<string, unknown> }).axOutline = outline;

        await sink(capture, pageIndex++);
        report.pagesCrawled++;

        if (depth + 1 <= budgets.maxDepth) {
          for (const link of outgoing) {
            if (!visited.has(link.toUrlNormalized) && isSameOrigin(link.toUrlNormalized, rootOrigin)) {
              queue.push({ url: link.toUrlNormalized, depth: depth + 1 });
            }
          }
        }
      }

      report.urlsSkippedByBudget = queue.filter((q) => !visited.has(q.url)).length;
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
