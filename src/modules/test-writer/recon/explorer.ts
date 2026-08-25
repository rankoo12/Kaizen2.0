import type { BrowserPool } from '../../../workers/browser-pool';
import type { IPageSurveyor } from '../../dom-pruner/interfaces';
import type { IChallengeDetector } from '../../execution-engine/challenge-detector';
import type { IObservability } from '../../observability/interfaces';
import type { ITestWriterGateway } from '../../llm-gateway/testwriter.interfaces';
import type { CandidateNode } from '../../../types';
import type { ExploreAction, ExploreControl, TenantBrief } from '../../../types/test-writer';
import type { CrawlBudgets, PageCapture } from '../interfaces';
import {
  classifyInteraction, isSessionEndingUrl, sensitiveTier, matchesAny, SESSION_ENDING,
} from './safety';
import { NOT_A_VIEW, screenUrl, type ReachHop } from './screens';
import { runProbes, rankProbeCandidates } from './probe';
import { capturePageMeta, captureForms, captureLinks, condenseOutline } from './page-capture';
import { normalizeUrl, isSameOrigin, stripFragment } from './url-normalizer';
import { acquireSession, type AuthSessionDeps, type LoginStep } from './auth-session';
import { scrubText } from './capture-scrub';
import { settleDom } from '../../execution-engine/settle';

/**
 * THE EXPLORER — the first subagent of the agentic shape.
 * Spec: docs/specs/test-writer/spec-agentic-testwriter.md §4
 *
 * The crawler walks URLs with rules; a QA engineer walks an app with judgment.
 * This loop gives the model the browser, one move at a time: it sees the
 * current view and the screens recorded so far, chooses a move (click / open /
 * record / home / done), our code executes it, and the result comes back as
 * the next observation. What the model RECORDS becomes a page of the site
 * model — captured with exactly the machinery the crawler uses (survey,
 * forms, links, probes), so every downstream stage reads it the same way.
 *
 * The split of authority is deliberate and fixed:
 *   - the MODEL decides where to go and what counts as a distinct screen;
 *   - OUR CODE decides what may be clicked (the crawler's safety lexicons,
 *     never overridable), what may be recorded (same-origin, not a sensitive
 *     page, not a byte-identical view), and when the budget is spent.
 *
 * Memoryless by construction: the knowledge it builds lives in this run's job
 * report and site model, nowhere else.
 */

export type ExplorerDeps = {
  pool: BrowserPool;
  surveyor: IPageSurveyor;
  challenges: IChallengeDetector;
  obs: IObservability;
  gateway: ITestWriterGateway;
  auth?: Pick<AuthSessionDeps, 'engine' | 'resolver' | 'assertionResolver'>;
};

export type ExploreParams = {
  tenantId: string;
  jobId: string;
  targetUrl: string;
  /** Where exploration begins — the post-login landing page when signed in. */
  startUrl: string;
  budgets: CrawlBudgets;
  auth?: { steps: LoginStep[] };
  appSummary: string;
  tenantBrief: TenantBrief | null;
  maxTurns: number;
  maxScreens: number;
  /** Content hashes of everything the crawler already captured. */
  knownHashes: Set<string>;
  /** Normalized URLs the crawler already captured. */
  knownUrls: Set<string>;
};

export type ExploreReport = {
  turns: number;
  screensRecorded: number;
  clicksMade: number;
  clicksRefused: number;
  recordsRefused: number;
  endedBy: 'done' | 'turns' | 'screens' | 'timeout' | 'session_lost' | 'error' | 'signin_failed';
  error?: string;
  /** The explorer's APP-KNOWLEDGE: every recorded screen with its claims. */
  knowledge: Array<{
    url: string; name: string; purpose: string; claims: string[];
    reachedBy: ReachHop[];
  }>;
};

export type ExploreSink = (capture: PageCapture & { axOutline?: Record<string, unknown> }) => Promise<void>;

const SURVEY_CAP = 60;
const CONTROLS_SHOWN = 70;
const CLICK_TIMEOUT_MS = 5_000;

/** Roles a view-opening control can have. Rows and items open detail views. */
const EXPLORER_ROLES = new Set([
  'button', 'menuitem', 'link', 'tab', 'row', 'treeitem', 'option', 'listitem', 'gridcell', 'cell',
]);

/**
 * What the explorer may click. The crawler's classifier answers first; its
 * "unknown resolves to mutating" default is then relaxed ONLY for named,
 * hrefless view-ish controls whose name passes every lexicon — the sidebar
 * sections and detail rows a crawler cannot reason about and a QA engineer
 * opens first. Nothing that commits, deletes, runs or signs out gets through.
 */
export function isExplorerClickable(
  node: CandidateNode,
  ctx: { rootOrigin: string; pageUrl: string },
): boolean {
  const cls = classifyInteraction(node, ctx);
  if (cls === 'session-ending' || cls === 'external') return false;
  if (cls === 'safe-reveal' || cls === 'navigation') return true;

  const name = node.name.trim().toLowerCase();
  if (!name || name.length > 60) return false;
  if (!EXPLORER_ROLES.has(node.role)) return false;
  const attrs = node.attributes ?? {};
  if (attrs['href'] !== undefined) return false;
  if ((attrs['type'] ?? '').toLowerCase() === 'submit') return false;
  if (matchesAny(name, SESSION_ENDING)) return false;
  // NOT_A_VIEW, not the crawler's destructive lexicon: that one bans "checkout"
  // and "order", which in a sidebar or a row are THINGS ("Checkout smoke",
  // "Orders"), while NOT_A_VIEW carries every commit and irreversible verb.
  if (matchesAny(name, NOT_A_VIEW)) return false;
  return true;
}

/** Shape-check the model's move — anything else is an invalid turn. */
export function parseAction(raw: unknown): ExploreAction | null {
  if (!raw || typeof raw !== 'object') return null;
  const a = raw as Record<string, unknown>;
  const why = typeof a.why === 'string' ? a.why.slice(0, 200) : undefined;
  switch (a.action) {
    case 'click':
      return Number.isInteger(a.control) ? { action: 'click', control: a.control as number, why } : null;
    case 'open':
      return typeof a.url === 'string' ? { action: 'open', url: a.url, why } : null;
    case 'record':
      if (typeof a.name !== 'string' || !a.name.trim()) return null;
      return {
        action: 'record',
        name: a.name.trim().slice(0, 120),
        purpose: typeof a.purpose === 'string' ? a.purpose.slice(0, 300) : '',
        claims: Array.isArray(a.claims) ? a.claims.filter((c): c is string => typeof c === 'string').slice(0, 12) : [],
        why,
      };
    case 'home': return { action: 'home', why };
    case 'done': return { action: 'done', why };
    default: return null;
  }
}

export class Explorer {
  constructor(private readonly deps: ExplorerDeps) {}

  async explore(params: ExploreParams, sink: ExploreSink): Promise<ExploreReport> {
    const { pool, surveyor, challenges, obs, gateway } = this.deps;
    const report: ExploreReport = {
      turns: 0, screensRecorded: 0, clicksMade: 0, clicksRefused: 0, recordsRefused: 0,
      endedBy: 'turns', knowledge: [],
    };
    const rootNormalized = normalizeUrl(params.targetUrl);
    if (!rootNormalized) throw new Error(`Invalid target URL: ${params.targetUrl}`);
    const rootOrigin = new URL(rootNormalized).origin;
    const startedAt = Date.now();
    const deadline = startedAt + params.budgets.jobTimeoutMs;

    const browser = await pool.acquire();
    const context = await browser.newContext({ acceptDownloads: false });
    await context.addInitScript(() => {
      const g = globalThis as unknown as { __name?: (fn: unknown) => unknown };
      g.__name = g.__name || ((fn) => fn);
    });
    const page: any = await context.newPage();
    context.on('page', (extra: any) => {
      if (extra !== page) void extra.close().catch(() => {});
    });
    page.on('dialog', (dialog: any) => void dialog.dismiss().catch(() => {}));

    let reloginsLeft = 1;
    const signIn = async (): Promise<boolean> => {
      if (!params.auth) return true;
      if (!this.deps.auth) return false;
      const result = await acquireSession(page, {
        tenantId: params.tenantId, rootOrigin, steps: params.auth.steps,
        domain: new URL(rootNormalized).hostname, pageTimeoutMs: params.budgets.pageTimeoutMs,
      }, { ...this.deps.auth, challenges, obs });
      return result.verified;
    };

    // Where the browser is, as a page identity, plus the clicks made since the
    // last URL navigation — together they name the current view.
    let base = rootNormalized;
    let hops: ReachHop[] = [];
    const tried = new Set<string>();
    const knownHashes = new Set(params.knownHashes);
    let lastResult: string | null = null;
    let lastHash: string | null = null;
    let consecutiveErrors = 0;

    const settle = async (): Promise<void> => {
      await page.waitForLoadState('networkidle', { timeout: 3_000 }).catch(() => {});
      await settleDom(page);
    };
    const goto = async (url: string): Promise<boolean> => {
      try {
        await page.goto(url, { timeout: params.budgets.pageTimeoutMs, waitUntil: 'domcontentloaded' });
        await settle();
        base = normalizeUrl(stripFragment(page.url())) ?? url;
        hops = [];
        return true;
      } catch (err) {
        lastResult = `could not open ${url}: ${errText(err)}`;
        return false;
      }
    };
    const currentViewUrl = (): string | null => (hops.length ? screenUrl(base, hops) : base);

    try {
      if (params.auth && !await signIn()) {
        report.endedBy = 'signin_failed';
        return report;
      }
      if (!await goto(params.startUrl)) {
        report.endedBy = 'error';
        report.error = lastResult ?? 'could not open the start page';
        return report;
      }

      for (let turn = 1; turn <= params.maxTurns; turn++) {
        if (Date.now() > deadline) { report.endedBy = 'timeout'; break; }
        report.turns = turn;

        // ── Observe ──────────────────────────────────────────────────────────
        const survey: CandidateNode[] = await surveyor.survey(page, SURVEY_CAP);
        const meta = await capturePageMeta(page);
        if (params.auth && meta.hasVisiblePasswordInput) {
          if (reloginsLeft-- <= 0 || !await signIn()) { report.endedBy = 'session_lost'; break; }
          await goto(params.startUrl);
          lastResult = 'the session had been lost; signed in again and returned to the landing page';
          continue;
        }
        const ctx = { rootOrigin, pageUrl: page.url() };
        const controls: ExploreControl[] = [];
        survey.forEach((node, index) => {
          const name = node.name.trim();
          if (!name) return;
          const attrs = node.attributes ?? {};
          controls.push({
            index,
            role: node.role,
            name: name.slice(0, 60),
            ...(attrs['kz-context'] ? { context: String(attrs['kz-context']).slice(0, 60) } : {}),
            ...(attrs['nav-context'] || 'aria-current' in attrs ? { nav: true } : {}),
            clickable: isExplorerClickable(node, ctx),
            ...(tried.has(`${node.role}|${name.toLowerCase()}`) ? { tried: true } : {}),
          });
        });
        const viewUrl = currentViewUrl() ?? base;

        // ── Decide ───────────────────────────────────────────────────────────
        let action: ExploreAction | null;
        try {
          action = parseAction(await gateway.exploreStep({
            appSummary: params.appSummary,
            tenantBrief: params.tenantBrief,
            view: {
              url: viewUrl,
              title: meta.title,
              headings: meta.headings,
              textExcerpt: scrubText(meta.pageText).slice(0, 500),
              hops,
              controls: controls.slice(0, CONTROLS_SHOWN),
            },
            recorded: report.knowledge.map((k) => ({ url: k.url, name: k.name, purpose: k.purpose })),
            lastResult,
            turnsLeft: params.maxTurns - turn,
            screensLeft: params.maxScreens - report.screensRecorded,
          }, params.tenantId));
        } catch (err) {
          // A malformed answer is one lost turn, reported back as the next
          // observation; only a run of them ends the exploration.
          consecutiveErrors++;
          obs.increment('testwriter.explore_gateway_failed');
          if (consecutiveErrors >= 3) {
            report.endedBy = 'error';
            report.error = errText(err);
            break;
          }
          lastResult = `your previous answer could not be used (${errText(err).slice(0, 120)}) — return exactly one JSON move object`;
          continue;
        }
        if (!action) {
          consecutiveErrors++;
          lastResult = 'that was not a valid move — return exactly one of click/open/record/home/done';
          obs.increment('testwriter.explore_invalid_move');
          if (consecutiveErrors >= 3) { report.endedBy = 'error'; report.error = 'three invalid moves in a row'; break; }
          continue;
        }
        consecutiveErrors = 0;
        obs.log('info', 'testwriter.explore_move', {
          jobId: params.jobId, turn, action: action.action, why: action.why ?? null, view: viewUrl,
        });

        // ── Act ──────────────────────────────────────────────────────────────
        if (action.action === 'done') { report.endedBy = 'done'; break; }

        if (action.action === 'home') {
          await goto(params.startUrl);
          lastResult = 'back at the landing page';
          continue;
        }

        if (action.action === 'open') {
          const target = normalizeUrl(action.url);
          if (!target || !isSameOrigin(target, rootOrigin)) {
            lastResult = `refused: ${action.url} is not on the analyzed site`;
            report.clicksRefused++;
            continue;
          }
          if (isSessionEndingUrl(target) || sensitiveTier(target) === 'capture-suppressed') {
            lastResult = `refused: ${action.url} is a sign-out or sensitive address`;
            report.clicksRefused++;
            continue;
          }
          if (await goto(action.url)) lastResult = `opened ${base}`;
          continue;
        }

        if (action.action === 'click') {
          const node = survey[action.control];
          if (!node || !isExplorerClickable(node, ctx)) {
            lastResult = `refused: control ${action.control} is not clickable`;
            report.clicksRefused++;
            continue;
          }
          const name = node.name.trim();
          const key = `${node.role}|${name.toLowerCase()}`;
          const urlBefore = stripFragment(page.url());
          const hashBefore = lastHash ?? condenseOutline(survey, await captureForms(page), meta.title, meta.headings).contentHash;
          let clicked = false;
          try {
            clicked = await clickNode(page, node);
          } catch (err) {
            lastResult = `clicking "${name}" failed: ${errText(err)}`;
          }
          tried.add(key);
          if (!clicked) { report.clicksRefused++; continue; }
          report.clicksMade++;
          await settle();

          // A new URL is a new base; the view is reached by URL, not by hops.
          const urlAfter = stripFragment(page.url());
          if (!isSameOrigin(urlAfter, rootOrigin)) {
            await goto(params.startUrl);
            lastResult = `"${name}" led off the site; returned to the landing page`;
            continue;
          }
          if (urlAfter !== urlBefore) {
            base = normalizeUrl(urlAfter) ?? base;
            hops = [];
            lastHash = null;
            lastResult = `clicked "${name}" — now at ${base}`;
            continue;
          }
          const surveyAfter: CandidateNode[] = await surveyor.survey(page, SURVEY_CAP);
          const metaAfter = await capturePageMeta(page);
          const hashAfter = condenseOutline(surveyAfter, await captureForms(page), metaAfter.title, metaAfter.headings).contentHash;
          lastHash = hashAfter;
          if (hashAfter === hashBefore) {
            lastResult = `clicked "${name}" — the view did not change`;
            continue;
          }
          // A navigation control is global — reachable from anywhere by that
          // one click — so its path restarts at itself rather than growing
          // (run 27 named Usage "analyses/the-brain/usage").
          const isNav = !!(node.attributes ?? {})['nav-context'] || 'aria-current' in (node.attributes ?? {});
          const hop = {
            role: node.role, name,
            ...(node.cssSelector ? { css: node.cssSelector } : {}),
            ...(node.xpath ? { xpath: node.xpath } : {}),
          };
          hops = isNav ? [hop] : [...hops, hop];
          lastResult = `clicked "${name}" — the view changed`
            + (metaAfter.headings[0] ? ` (first heading now "${metaAfter.headings[0].slice(0, 60)}")` : '');
          continue;
        }

        // ── record ───────────────────────────────────────────────────────────
        const url = currentViewUrl();
        if (!url) {
          lastResult = 'refused: the path to this view has a step with no nameable label';
          report.recordsRefused++;
          continue;
        }
        if (hops.length === 0 && params.knownUrls.has(base)) {
          lastResult = `refused: ${base} is a URL page the crawler already captured — explore what it opens`;
          report.recordsRefused++;
          continue;
        }
        if (params.auth && sensitiveTier(base) === 'capture-suppressed') {
          lastResult = 'refused: this is a sensitive page Kaizen records by address only';
          report.recordsRefused++;
          continue;
        }
        const challenge = await challenges.detect(page);
        if (challenge) {
          lastResult = 'refused: this view is a bot check';
          report.recordsRefused++;
          continue;
        }
        const forms = await captureForms(page);
        const links = await captureLinks(page, page.url(), rootOrigin);
        const { outline, contentHash } = condenseOutline(survey, forms, meta.title, meta.headings);
        if (knownHashes.has(contentHash)) {
          lastResult = 'refused: this view is byte-identical to one already recorded';
          report.recordsRefused++;
          continue;
        }

        const passiveOnly = !!params.auth && sensitiveTier(base) === 'passive-only';
        const safeReveals = survey.filter((c) => classifyInteraction(c, ctx) === 'safe-reveal');
        const { reveals } = await runProbes(
          page, passiveOnly ? [] : rankProbeCandidates(safeReveals), params.budgets.probesPerPage,
          { pageUrl: page.url(), rootOrigin, obs },
        );

        const capture: PageCapture & { axOutline?: Record<string, unknown> } = {
          urlNormalized: url,
          urlObserved: stripFragment(page.url()),
          title: meta.title,
          headings: meta.headings,
          pageText: scrubText(meta.pageText),
          survey,
          forms,
          outgoingLinks: links,
          revealedStates: reveals,
          contentHash,
          screenshotKey: null,
          requiresAuth: !!params.auth,
          blocked: null,
          ...(hops.length ? { reachedBy: hops } : {}),
          axOutline: outline,
        };
        await sink(capture);
        knownHashes.add(contentHash);
        report.screensRecorded++;
        report.knowledge.push({
          url, name: action.name, purpose: action.purpose, claims: action.claims, reachedBy: [...hops],
        });
        obs.increment('testwriter.explore_screen_recorded');
        obs.log('info', 'testwriter.explore_screen_recorded', { jobId: params.jobId, url, name: action.name });
        lastResult = `recorded "${action.name}" (${url}) — now explore something else`;
        // Probing may have left menus open; re-establish the view from its recipe.
        const recipe = [...hops];
        await goto(stripFragment(page.url()));
        if (recipe.length && await reachByHops(page, recipe)) hops = recipe;
        lastHash = null;
        if (report.screensRecorded >= params.maxScreens) { report.endedBy = 'screens'; break; }
      }
      return report;
    } catch (err) {
      report.endedBy = 'error';
      report.error = errText(err);
      obs.log('warn', 'testwriter.explore_failed', { jobId: params.jobId, error: report.error });
      return report;
    } finally {
      await context.close().catch(() => {});
      await pool.release();
      obs.log('info', 'testwriter.explore_completed', {
        jobId: params.jobId, ...report, knowledge: report.knowledge.length,
      });
    }
  }
}

/** Click a surveyed node: its recorded selector first, then role + name. */
async function clickNode(page: any, node: CandidateNode): Promise<boolean> {
  const name = node.name.trim();
  if (node.cssSelector) {
    const bySelector = page.locator(node.cssSelector).first();
    if (await bySelector.count().catch(() => 0) > 0) {
      await bySelector.click({ timeout: CLICK_TIMEOUT_MS });
      return true;
    }
  }
  for (const exact of [true, false]) {
    try {
      await page.getByRole(node.role, { name, exact }).first().click({ timeout: CLICK_TIMEOUT_MS });
      return true;
    } catch { /* try the looser match */ }
  }
  return false;
}

async function reachByHops(page: any, hops: ReachHop[]): Promise<boolean> {
  for (const hop of hops) {
    let clicked = false;
    for (const exact of [true, false]) {
      try {
        await page.getByRole(hop.role, { name: hop.name, exact }).first().click({ timeout: CLICK_TIMEOUT_MS });
        clicked = true;
        break;
      } catch { /* try the looser match */ }
    }
    if (!clicked) return false;
    await page.waitForLoadState('networkidle', { timeout: 3_000 }).catch(() => {});
    await settleDom(page);
  }
  return true;
}

function errText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.split('\n')[0].slice(0, 200);
}
