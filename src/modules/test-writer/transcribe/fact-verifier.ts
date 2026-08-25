import type { IObservability } from '../../observability/interfaces';
import type { IExecutionEngine } from '../../execution-engine/interfaces';
import type { IElementResolver } from '../../element-resolver/interfaces';
import type { IChallengeDetector } from '../../execution-engine/challenge-detector';
import type { BrowserPool } from '../../../workers/browser-pool';
import type { GroundingElement, StepIntent } from '../../../types/test-writer';
import { acquireSession, type LoginStep } from '../recon/auth-session';
import { capturePageMeta } from '../recon/page-capture';
import { settleAfterNavigation } from '../../execution-engine/settle';
import { substituteFixture, type FactScenario } from './fact-transcriber';

/**
 * FACT VERIFIER — the batch half of the fact tier.
 * Spec: docs/specs/test-writer/spec-agentic-testwriter.md §4
 *
 * One browser session verifies MANY facts: open the screen, replay a fact's
 * steps against the selectors recon recorded, read the answer, next fact. No
 * model in the loop and no engine run — that is what makes 300 facts cost
 * minutes instead of hours. The engine is still the judge of the journey tier
 * and of the audit sample; this tier's honesty lives in its label
 * (validation_state 'verified_batch', never 'validated').
 *
 * Execution rules mirror the crawler's conservatism: dialogs are DISMISSED
 * (a destructive confirm cancels itself), navigation is origin-guarded, and a
 * session loss re-signs-in at most once per batch.
 */

export type FactVerdict = {
  fact: FactScenario;
  ok: boolean;
  /** 0-based index into bodyIntents when a step failed. */
  stepIndex?: number;
  reason?: string;
};

export type FactVerifierAuthDeps = {
  engine: IExecutionEngine;
  resolver: IElementResolver;
  challenges: IChallengeDetector;
};

const DEFAULT_STEP_TIMEOUT_MS = 5_000;
/** §4 (spec-parallel-pipeline): concurrent verification contexts. */
const VERIFY_CONTEXTS = 3;
const ROW_ROLES = new Set(['row', 'listitem', 'gridcell', 'cell', 'treeitem', 'option']);
const POLL_MS = 250;

export class FactVerifier {
  private readonly stepTimeoutMs: number;

  constructor(
    private readonly pool: Pick<BrowserPool, 'acquire' | 'release'>,
    private readonly obs: IObservability,
    private readonly auth?: FactVerifierAuthDeps,
    opts?: { stepTimeoutMs?: number },
  ) {
    this.stepTimeoutMs = opts?.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
  }

  async verifyAll(params: {
    tenantId: string;
    baseUrl: string;
    facts: FactScenario[];
    elements: Map<string, GroundingElement>;
    loginSteps?: LoginStep[];
    onProgress?: (done: number, total: number) => Promise<void> | void;
  }): Promise<FactVerdict[]> {
    if (params.facts.length === 0) return [];
    const rootOrigin = new URL(params.baseUrl).origin;
    const domain = new URL(params.baseUrl).hostname;

    // §4 (spec-parallel-pipeline): facts grouped by SCREEN (the fixture key),
    // groups dealt across up to VERIFY_CONTEXTS contexts, shards verified
    // concurrently. A screen's facts live in exactly one shard, so
    // one-fixture-per-screen holds by construction; verdicts are indexed by
    // the fact's original position, so the report order is unchanged.
    const groups = new Map<string, Array<{ fact: FactScenario; idx: number }>>();
    params.facts.forEach((fact, idx) => {
      const key = `${fact.gotoUrl}|${JSON.stringify(fact.hops)}`;
      const list = groups.get(key) ?? [];
      list.push({ fact, idx });
      groups.set(key, list);
    });
    const shardCount = Math.max(1, Math.min(VERIFY_CONTEXTS, groups.size));
    const shards: Array<Array<{ fact: FactScenario; idx: number }>> =
      Array.from({ length: shardCount }, () => []);
    // Biggest group onto the emptiest shard, so shard sizes stay even.
    const ordered = [...groups.values()].sort((a, b) => b.length - a.length);
    for (const group of ordered) {
      let smallest = shards[0];
      for (const shard of shards) if (shard.length < smallest.length) smallest = shard;
      smallest.push(...group);
    }

    const browser = await this.pool.acquire();
    const verdicts: FactVerdict[] = new Array<FactVerdict>(params.facts.length);
    const contexts: any[] = [];
    let done = 0;

    try {
      const makeContext = async (storageState?: unknown): Promise<{ context: any; page: any }> => {
        const context = await browser.newContext({
          acceptDownloads: false,
          viewport: { width: 1366, height: 900 },
          ...(storageState ? { storageState: storageState as never } : {}),
        });
        contexts.push(context);
        // __name shim — same guard the worker and crawler carry: tsx/esbuild
        // (keepNames) wraps named inner declarations inside evaluate() callbacks
        // with __name(...), which does not exist in the browser. Without it the
        // ENGINE's assert_text ($eval) throws ReferenceError inside the page and
        // reads as "text not found" — run 34's login recipe ended in assert_text
        // and one such false negative failed all 285 facts.
        await context.addInitScript(() => {
          const g = globalThis as unknown as { __name?: (fn: unknown) => unknown };
          g.__name = g.__name || ((fn) => fn);
        });
        const page = await context.newPage();
        page.setDefaultTimeout(this.stepTimeoutMs);
        page.on('dialog', (dialog: any) => {
          // Dismiss, always: a confirm this tier triggers is a confirm it cancels.
          void dialog.dismiss().catch(() => {});
        });
        return { context, page };
      };

      const signIn = async (page: any): Promise<string | null> => {
        if (!params.loginSteps?.length) return null;
        if (!this.auth) return 'this deployment has no sign-in executor for the fact verifier';
        const session = await acquireSession(page, {
          tenantId: params.tenantId,
          rootOrigin,
          steps: params.loginSteps,
          domain,
          pageTimeoutMs: 15_000,
        }, { ...this.auth, obs: this.obs });
        return session.verified ? null : `signing in failed: ${session.detail}`;
      };

      // Context 0 signs in for everyone; the others start from its exported
      // storageState — one credential submission for the whole batch (§2b's
      // one-sign-in rule, applied in-process).
      const first = await makeContext();
      // The whole batch hangs off this one sign-in: a transient (slow page,
      // rate limit) must not fail hundreds of facts. Three attempts.
      let signinError: string | null = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        signinError = await signIn(first.page);
        if (!signinError) break;
        this.obs.increment('testwriter.fact_verify_signin_retry');
        await first.page.waitForTimeout(3_000).catch(() => {});
      }
      if (signinError) {
        // Nothing can be verified without the session; say so per fact.
        return params.facts.map((fact) => ({ ok: false, fact, reason: signinError }));
      }
      const sharedState = params.loginSteps?.length
        ? await first.context.storageState().catch(() => undefined)
        : undefined;
      const shardPages: any[] = [first.page];
      for (let i = 1; i < shards.length; i++) {
        shardPages.push((await makeContext(sharedState)).page);
      }

      const runShard = async (
        items: Array<{ fact: FactScenario; idx: number }>,
        page: any,
      ): Promise<void> => {
        let reloginsLeft = 1;
        // One fixture per screen, created once with a unique name and shared by
        // every fact of that screen that references it. A fixture that cannot
        // be created fails those facts with its own reason — the facts are not
        // wrong, the app refused the record.
        const fixtures = new Map<string, { name: string; error: string | null }>();
        const fixtureFor = async (fact: FactScenario): Promise<{ name: string; error: string | null }> => {
          const key = `${fact.gotoUrl}|${JSON.stringify(fact.hops)}`;
          const existing = fixtures.get(key);
          if (existing) return existing;
          const name = `Kaizen fixture ${Math.random().toString(36).slice(2, 8)}`;
          let error: string | null = null;
          try {
            await this.goto(page, fact.gotoUrl, rootOrigin);
            for (const hop of fact.hops) {
              const before = page.url();
              await this.clickHop(page, hop);
              await settleAfterNavigation(page, before);
            }
            for (const step of substituteFixture(fact.fixtureIntents ?? [], name)) {
              await this.executeIntent(page, step, params.elements, rootOrigin);
            }
            this.obs.increment('testwriter.fact_fixture_created');
          } catch (err) {
            error = `fixture could not be created: ${errText(err)}`;
            this.obs.increment('testwriter.fact_fixture_failed');
          }
          const state = { name, error };
          fixtures.set(key, state);
          return state;
        };

        for (const { fact, idx } of items) {
          let verdict: FactVerdict | null = null;
          let fixtureName: string | null = null;
          if (fact.usesFixture && fact.fixtureIntents?.length) {
            const fixture = await fixtureFor(fact);
            if (fixture.error) verdict = { fact, ok: false, reason: fixture.error };
            else fixtureName = fixture.name;
          }
          if (!verdict) {
            verdict = await this.verifyOne(page, fact, params.elements, rootOrigin, fixtureName);

            // A red fact behind auth may be a lost session, not a wrong fact.
            if (!verdict.ok && params.loginSteps?.length && reloginsLeft > 0) {
              const meta = await capturePageMeta(page).catch(() => null);
              if (meta?.hasVisiblePasswordInput) {
                reloginsLeft--;
                this.obs.increment('testwriter.fact_verify_relogin');
                const again = await signIn(page);
                if (!again) {
                  verdict = await this.verifyOne(page, fact, params.elements, rootOrigin, fixtureName);
                }
              }
            }
          }
          verdicts[idx] = verdict;
          done++;
          await params.onProgress?.(done, params.facts.length);
        }
      };

      await Promise.all(shards.map((items, i) => runShard(items, shardPages[i])));
      return verdicts;
    } finally {
      for (const context of contexts) await context.close().catch(() => {});
      await this.pool.release();
      this.obs.increment('testwriter.fact_verify_session_closed');
    }
  }

  /** One fact: position the browser on its screen, replay, judge. */
  private async verifyOne(
    page: any,
    fact: FactScenario,
    elements: Map<string, GroundingElement>,
    rootOrigin: string,
    fixtureName: string | null = null,
  ): Promise<FactVerdict> {
    try {
      await this.goto(page, fact.gotoUrl, rootOrigin);
      for (const hop of fact.hops) {
        const before = page.url();
        await this.clickHop(page, hop);
        await settleAfterNavigation(page, before);
      }
    } catch (err) {
      return { fact, ok: false, reason: `could not reach the screen: ${errText(err)}` };
    }

    const body = fixtureName ? substituteFixture(fact.bodyIntents, fixtureName) : fact.bodyIntents;
    for (let i = 0; i < body.length; i++) {
      try {
        await this.executeIntent(page, body[i], elements, rootOrigin);
      } catch (err) {
        return { fact, ok: false, stepIndex: i, reason: errText(err) };
      }
    }
    return { fact, ok: true };
  }

  /**
   * One reach hop. A hop is a nav item or a data row by name; a row in a
   * feed can have moved down the list by the time the batch runs (run 28's
   * own validation runs reordered the runs list and seven run-detail facts
   * died on "locator.click timeout"). So: exact name, then containing name,
   * then plain text, each scrolled into view, with twice the step timeout.
   */
  private async clickHop(
    page: any,
    hop: { role: string; name: string; css?: string; xpath?: string },
  ): Promise<void> {
    const name = stripLiveCount(hop.name);
    // The recorded xpath points at the row that was clicked; with its last
    // positional index reset to 1 it points at the FIRST row of the same
    // list — reaching the same screen even after the feed reordered (run 30
    // lost 14 run-detail facts because the surveyed role was heuristic and
    // the bare-role fallback matched nothing).
    const firstSibling = hop.xpath ? hop.xpath.replace(/\[(\d+)\]$/u, '[1]') : null;
    const candidates = [
      page.getByRole(hop.role, { name, exact: true }),
      page.getByRole(hop.role, { name }),
      ...(hop.css ? [page.locator(hop.css)] : []),
      page.getByText(name, { exact: false }),
      // A detail view reached through a data row is about the VIEW, not that
      // record: when the named row has scrolled off a feed, any row of that
      // kind reaches the same screen (run 29 lost seven run-detail facts).
      ...(ROW_ROLES.has(hop.role) ? [page.getByRole(hop.role)] : []),
      ...(hop.xpath ? [page.locator(`xpath=${hop.xpath}`)] : []),
      ...(firstSibling && firstSibling !== hop.xpath
        ? [page.locator(`xpath=${firstSibling}`)] : []),
    ];
    let lastError: unknown = null;
    for (const candidate of candidates) {
      if (await candidate.count().catch(() => 0) === 0) continue;
      try {
        const locator = candidate.first();
        await locator.scrollIntoViewIfNeeded({ timeout: this.stepTimeoutMs }).catch(() => {});
        await locator.click({ timeout: this.stepTimeoutMs * 2 });
        return;
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError ?? new Error(`could not find the ${hop.role} "${hop.name}" to reach the screen`);
  }

  private async goto(page: any, url: string, rootOrigin: string): Promise<void> {
    if (new URL(url).origin !== rootOrigin) {
      throw new Error(`refusing to open ${url}: outside the analyzed site`);
    }
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15_000 });
    await settleAfterNavigation(page, 'about:blank');
  }

  private async executeIntent(
    page: any,
    step: StepIntent,
    elements: Map<string, GroundingElement>,
    rootOrigin: string,
  ): Promise<void> {
    const el = (): GroundingElement => {
      const target = 'target' in step ? step.target : undefined;
      if (!target || target.kind !== 'element') throw new Error('fact step lost its element target');
      const found = elements.get(target.elementId);
      if (!found) throw new Error('element not in the verifier grounding map');
      return found;
    };

    switch (step.action) {
      case 'click': case 'hover': case 'check': case 'uncheck': {
        const locator = await this.mustLocate(page, el());
        const before = page.url();
        if (step.action === 'click') await locator.click({ timeout: this.stepTimeoutMs });
        else if (step.action === 'hover') await locator.hover({ timeout: this.stepTimeoutMs });
        else {
          try {
            await locator.setChecked(step.action === 'check', { timeout: this.stepTimeoutMs });
          } catch {
            await locator.click({ timeout: this.stepTimeoutMs });
          }
        }
        await settleAfterNavigation(page, before);
        if (new URL(page.url()).origin !== rootOrigin) {
          throw new Error(`the click left the analyzed site (${page.url()})`);
        }
        return;
      }
      case 'type': {
        const locator = await this.mustLocateFillable(page, el());
        await locator.fill(step.value, { timeout: this.stepTimeoutMs });
        return;
      }
      case 'select': {
        const locator = await this.mustLocateFillable(page, el());
        try {
          await locator.selectOption({ label: step.value }, { timeout: this.stepTimeoutMs });
        } catch {
          await locator.selectOption(step.value, { timeout: this.stepTimeoutMs });
        }
        return;
      }
      case 'press_key':
        await page.keyboard.press(step.value);
        await page.waitForTimeout(POLL_MS);
        return;

      case 'assert_visible': {
        const locator = await this.mustLocate(page, el());
        await locator.waitFor({ state: 'visible', timeout: this.stepTimeoutMs });
        return;
      }
      case 'assert_not_visible': {
        const locator = await this.tryLocate(page, el());
        if (!locator) return;   // nothing matching at all IS absence
        await locator.waitFor({ state: 'hidden', timeout: this.stepTimeoutMs });
        return;
      }
      case 'assert_enabled': case 'assert_disabled': {
        const locator = await this.mustLocate(page, el());
        const want = step.action === 'assert_enabled';
        await this.poll(
          async () => (await locator.isEnabled()) === want,
          `the element is ${want ? 'not enabled' : 'not disabled'}`,
        );
        return;
      }
      case 'assert_checked': case 'assert_not_checked': {
        const locator = await this.mustLocate(page, el());
        const want = step.action === 'assert_checked';
        await this.poll(
          async () => (await locator.isChecked()) === want,
          `the element is ${want ? 'not checked' : 'still checked'}`,
        );
        return;
      }
      case 'assert_text': {
        const needle = normalize(step.value);
        await this.poll(async () => {
          const body = await page.evaluate(() => document.body?.innerText ?? '');
          return normalize(String(body)).includes(needle);
        }, `the text "${step.value}" is not on the page`);
        return;
      }
      case 'assert_url': {
        const needle = step.value.toLowerCase();
        await this.poll(
          async () => page.url().toLowerCase().includes(needle),
          `the url is ${page.url()}, which does not contain "${step.value}"`,
        );
        return;
      }
      default:
        throw new Error(`the fact tier cannot execute "${step.action}"`);
    }
  }

  /**
   * elementId → live locator. Recon's recorded selector first; the element's
   * role+name (live count stripped) second. Both empty = the element is gone,
   * which for anything but assert_not_visible fails the fact.
   */
  private async tryLocate(page: any, el: GroundingElement): Promise<any | null> {
    if (el.selector) {
      const bySelector = page.locator(el.selector);
      if (await bySelector.count().catch(() => 0) > 0) return bySelector.first();
    }
    const name = stripLiveCount(el.name);
    if (name) {
      const byRole = page.getByRole(el.role, { name });
      if (await byRole.count().catch(() => 0) > 0) return byRole.first();
      const byText = page.getByText(name, { exact: false });
      if (await byText.count().catch(() => 0) > 0) return byText.first();
    }
    return null;
  }

  /**
   * type/select variant of mustLocate: getByText can land on a field's LABEL
   * text node and fill() then throws "Element is not an <input>" (run 30 lost
   * three fixture facts this way). Only an actually fillable element counts;
   * a matched wrapper or label yields the field inside it.
   */
  private async mustLocateFillable(page: any, el: GroundingElement): Promise<any> {
    const name = stripLiveCount(el.name);
    const deadline = Date.now() + this.stepTimeoutMs;
    for (;;) {
      const candidates = [
        ...(el.selector ? [page.locator(el.selector)] : []),
        ...(name ? [
          page.getByRole('textbox', { name }),
          page.getByRole('searchbox', { name }),
          page.getByRole('combobox', { name }),
          page.getByLabel(name),
          page.getByPlaceholder(name),
        ] : []),
      ];
      for (const candidate of candidates) {
        if (await candidate.count().catch(() => 0) === 0) continue;
        const first = candidate.first();
        const fillable = await first.evaluate((node: any) => {
          const tag = node.tagName;
          return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
            || node.isContentEditable === true;
        }).catch(() => false);
        if (fillable) return first;
        const inner = first.locator('input, textarea, select, [contenteditable="true"]');
        if (await inner.count().catch(() => 0) > 0) return inner.first();
      }
      if (Date.now() >= deadline) {
        throw new Error(`could not find a fillable "${el.name}" field on the live page`);
      }
      await page.waitForTimeout(POLL_MS);
    }
  }

  private async mustLocate(page: any, el: GroundingElement): Promise<any> {
    const deadline = Date.now() + this.stepTimeoutMs;
    for (;;) {
      const locator = await this.tryLocate(page, el);
      if (locator) return locator;
      if (Date.now() >= deadline) {
        throw new Error(`could not find the ${el.role} "${el.name}" on the live page`);
      }
      await page.waitForTimeout(POLL_MS);
    }
  }

  private async poll(check: () => Promise<boolean>, failReason: string): Promise<void> {
    const deadline = Date.now() + this.stepTimeoutMs;
    for (;;) {
      if (await check().catch(() => false)) return;
      if (Date.now() >= deadline) throw new Error(failReason);
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  }
}

/**
 * "Demo 5" was five items at crawl time; the count is the part that drifts.
 * Same reading as the worker's countDriftMatch, applied to lookups.
 */
export function stripLiveCount(name: string): string {
  return name.replace(/\s+\d+$/u, '').trim();
}

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

function errText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  // Playwright timeout messages carry a full call log; the first line says it.
  return msg.split('\n')[0].slice(0, 200);
}
