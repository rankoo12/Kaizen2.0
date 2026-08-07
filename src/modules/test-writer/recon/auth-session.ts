import type { StepAST, SelectorSet } from '../../../types';
import type { IExecutionEngine } from '../../execution-engine/interfaces';
import type { IElementResolver } from '../../element-resolver/interfaces';
import type { IChallengeDetector } from '../../execution-engine/challenge-detector';
import type { IObservability } from '../../observability/interfaces';
import { isSecretStep } from '../secret-steps';
import { normalizeUrl } from './url-normalizer';

/**
 * Session acquisition — executes a tenant's login recipe to obtain a signed-in
 * browser context for the crawl.
 * Spec: docs/specs/test-writer/spec-authenticated-scope.md §4
 *
 * The recipe is an ordinary Kaizen test case the tenant already owns and trusts.
 * Kaizen stores no new secrets: credentials live only where they already live,
 * in that case's steps. The steps run IN-PROCESS on the crawler's own page —
 * the P1 crawler uses one BrowserContext and one Page for the whole BFS, so
 * cookies set here persist for the entire crawl with no session material ever
 * serialized, exported, or crossing a process boundary.
 *
 * Deliberately NOT wired here: the HealingEngine. A login case that needs
 * healing needs FIXING — papering over it would silently degrade the recipe the
 * customer's real suite depends on, and the blocked message says so.
 */

export type LoginStep = { rawText: string; ast: StepAST };

export type AuthSessionParams = {
  tenantId: string;
  /** Origin the crawl is authorised for — every navigate step must stay inside it. */
  rootOrigin: string;
  steps: LoginStep[];
  /** Domain key for the selector cache (the crawl target's hostname). */
  domain: string;
  pageTimeoutMs: number;
};

export type AuthSessionDeps = {
  engine: IExecutionEngine;
  resolver: IElementResolver;
  challenges: IChallengeDetector;
  obs: IObservability;
};

export type AuthSessionResult =
  | {
      verified: true;
      /** Which signals proved the session — recorded on the job report. */
      sessionVerification: 'assertion+heuristic' | 'heuristic';
      /** Where the sign-in form lived; a later navigation landing here is session loss. */
      loginPageUrl: string;
      /** Where the recipe finished — becomes a BFS seed alongside the target. */
      landedUrl: string;
      stepsTotal: number;
      stepsPassed: number;
    }
  | {
      verified: false;
      reason: 'login_failed' | 'login_challenge';
      /** Operator-facing detail: which step, and why. Never contains a value. */
      detail: string;
      stepsTotal: number;
      stepsPassed: number;
    };

/** Actions that need no element resolution — mirrors the worker's set. */
const NO_ELEMENT_ACTIONS = new Set([
  'navigate', 'press_key', 'wait', 'go_back', 'go_forward', 'reload',
  'assert_url', 'assert_title',
]);

/** Actions that can legitimately raise a dialog (§4.2 — the accept window). */
const DIALOG_RAISING = new Set(['click', 'double_click', 'press_key']);

const ASSERTION_PREFIX = 'assert';

/**
 * Destinations a login recipe may never reach, whatever its origin says.
 *
 * The recipe's steps execute verbatim on the crawler's page, so a `navigate`
 * step is an arbitrary-navigation primitive inside Kaizen's own infrastructure:
 * cloud metadata (169.254.169.254), loopback services, anything on the container
 * network. Checked at the API (spec §3.1) and again here, because the API check
 * is advisory once a job is running.
 */
function isBlockedDestination(rawUrl: string, baseUrl?: string): string | null {
  let host: string;
  try {
    host = (baseUrl ? new URL(rawUrl, baseUrl) : new URL(rawUrl)).hostname.toLowerCase();
  } catch {
    return 'unparseable URL';
  }
  // Strip IPv6 brackets.
  const h = host.replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return 'loopback';
  if (h === '::1' || h === '0:0:0:0:0:0:0:1') return 'IPv6 loopback';
  if (h.endsWith('.internal') || h.endsWith('.local')) return 'internal hostname';
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 127) return 'loopback';
    if (a === 10) return 'private network';
    if (a === 169 && b === 254) return 'link-local / cloud metadata';
    if (a === 172 && b >= 16 && b <= 31) return 'private network';
    if (a === 192 && b === 168) return 'private network';
    if (a === 0) return 'unspecified address';
  }
  return null;
}

/**
 * Runs the login recipe on `page` and verifies a session exists afterwards.
 * `page` is typed loosely for the same reason IExecutionEngine does it: this
 * layer must not take a compile-time dependency on playwright.
 */
export async function acquireSession(
  page: any,
  params: AuthSessionParams,
  deps: AuthSessionDeps,
): Promise<AuthSessionResult> {
  const { engine, resolver, challenges, obs } = deps;
  const { steps, rootOrigin, tenantId, domain } = params;

  let stepsPassed = 0;
  const stepsTotal = steps.length;
  let loginPageUrl: string | null = null;
  let sawTerminalAssertionPass = false;
  let navigatedAtLeastOnce = false;

  const fail = (
    reason: 'login_failed' | 'login_challenge',
    detail: string,
  ): AuthSessionResult => {
    obs.increment('testwriter.auth_session_failed', { reason });
    return { verified: false, reason, detail, stepsTotal, stepsPassed };
  };

  // The crawler dismisses dialogs; the worker accepts them. A login proven under
  // the worker may legitimately raise one, so accept — but only for the duration
  // of a step that can raise one, never as a window left open across the recipe.
  // Otherwise a post-login "Discard unsaved changes?" prompt gets auto-confirmed
  // on an account we are only supposed to be reading.
  let acceptDialogs = false;
  const dialogHandler = (dialog: any) => {
    // Never log dialog.message() — it is behind-login text.
    obs.increment('testwriter.auth_session_dialog', { type: String(dialog.type?.() ?? 'unknown') });
    void (acceptDialogs ? dialog.accept() : dialog.dismiss()).catch(() => {});
  };
  page.on('dialog', dialogHandler);

  try {
    for (let i = 0; i < steps.length; i++) {
      const { ast } = steps[i];
      const human = `step ${i + 1} of the sign-in test`;

      // Guard every navigation, not just the case's base_url (spec §3.1).
      if (ast.action === 'navigate') {
        const target = ast.url ?? ast.value ?? '';
        const blocked = isBlockedDestination(target, page.url());
        if (blocked) {
          return fail('login_failed',
            `${human} navigates to a ${blocked} address, which Kaizen will not open`);
        }
        try {
          const resolved = new URL(target, page.url());
          if (resolved.origin !== rootOrigin) {
            return fail('login_failed',
              `${human} navigates to ${resolved.origin}, which is not the site being analyzed`);
          }
        } catch {
          return fail('login_failed', `${human} has an unusable URL`);
        }
      }

      // Record where the credential was entered — the anchor for session-loss
      // detection. For a credential-free recipe (the recommended button flow)
      // this never fires and the fallback below supplies the value.
      if (isSecretStep(ast) && !loginPageUrl) {
        loginPageUrl = normalizeUrl(page.url());
      }

      let selectorSet: SelectorSet = {
        selectors: [], resolutionSource: 'cache', tokensUsed: 0,
      } as unknown as SelectorSet;

      if (!NO_ELEMENT_ACTIONS.has(ast.action)) {
        try {
          selectorSet = await resolver.resolve(ast, {
            tenantId,
            domain,
            page,
            pageUrl: page.url(),
            // Nothing learned signing in may reach the shared pool or the global
            // archetype library: this is the customer's private auth boundary.
            behindAuth: true,
          });
        } catch (err) {
          return fail('login_failed',
            `${human} could not find its element: ${errText(err)}`);
        }
        if (!selectorSet.selectors?.length) {
          return fail('login_failed',
            `${human} could not find "${ast.targetDescription ?? 'its element'}" on the page`);
        }
      }

      acceptDialogs = DIALOG_RAISING.has(ast.action);
      let result;
      try {
        result = await engine.executeStep(ast, selectorSet, page);
      } catch (err) {
        return fail('login_failed', `${human} failed: ${errText(err)}`);
      } finally {
        acceptDialogs = false;
      }

      if (result.status !== 'passed') {
        // No healing by design — see the module header.
        return fail('login_failed',
          `${human} failed: ${result.errorMessage ?? result.errorType ?? 'the step did not pass'}`);
      }
      stepsPassed++;

      if (ast.action === 'navigate') {
        navigatedAtLeastOnce = true;
        // Fallback anchor for recipes that never type a password: the landed URL
        // after the first navigation, post-redirect (`/` → `/login` yields the
        // useful value). Spec §4.3.
        if (!loginPageUrl) loginPageUrl = normalizeUrl(page.url());

        // A bot check on the sign-in flow is not something to work around.
        const challenge = await challenges.detect(page);
        if (challenge) {
          return fail('login_challenge',
            `your sign-in flow is protected by a bot check (${challenge.type})`);
        }
      }

      if (ast.action.startsWith(ASSERTION_PREFIX) && i === steps.length - 1) {
        sawTerminalAssertionPass = true;
      }
    }

    // Challenge gate again after the final step — some flows only present the
    // check once credentials are submitted.
    const finalChallenge = await challenges.detect(page);
    if (finalChallenge) {
      return fail('login_challenge',
        `your sign-in flow is protected by a bot check (${finalChallenge.type})`);
    }

    // ── Verification (spec §4.3) ────────────────────────────────────────────
    // The recipe's own assertion proves what its author chose to assert, which
    // is not necessarily "a session exists". So an independent heuristic runs
    // too, and the two are reported separately.
    const landedUrl = normalizeUrl(page.url()) ?? page.url();
    if (!loginPageUrl) loginPageUrl = navigatedAtLeastOnce ? landedUrl : normalizeUrl(page.url());

    const passwordStillVisible = await hasVisiblePasswordInput(page);
    if (passwordStillVisible) {
      return fail('login_failed',
        'the sign-in form is still on screen after the test finished — the credentials were probably rejected');
    }

    const urlChanged = landedUrl !== loginPageUrl;
    if (!urlChanged && !sawTerminalAssertionPass) {
      // Neither signal exists. Failing CLOSED is the only safe move: a false
      // "verified" spends the whole crawl budget producing a PUBLIC crawl
      // mislabeled authenticated, which is worse than a blocked job.
      return fail('login_failed',
        'your sign-in test never leaves the sign-in URL and has no final assertion, so Kaizen cannot confirm a session was created — add an assertion that proves you are signed in (for example, verify the dashboard is visible)');
    }

    obs.increment('testwriter.auth_session_verified');
    return {
      verified: true,
      sessionVerification: sawTerminalAssertionPass ? 'assertion+heuristic' : 'heuristic',
      loginPageUrl: loginPageUrl ?? landedUrl,
      landedUrl,
      stepsTotal,
      stepsPassed,
    };
  } finally {
    page.off?.('dialog', dialogHandler);
  }
}

/**
 * Mid-crawl session-loss predicate (spec §5.1).
 *
 * The public crawler's auth-wall rule — redirected AND a password input is
 * showing — is reused unchanged, plus one clause: landing on the recorded login
 * URL is a loss whether or not the form has rendered yet (some apps load it
 * lazily, and by the time we looked the field may not exist).
 */
export function isSessionLoss(
  landedUrl: string,
  requestedUrl: string,
  loginPageUrl: string | null,
  hasPasswordInput: boolean,
): boolean {
  if (landedUrl !== requestedUrl && hasPasswordInput) return true;
  if (loginPageUrl && landedUrl === loginPageUrl && requestedUrl !== loginPageUrl) return true;
  return false;
}

async function hasVisiblePasswordInput(page: any): Promise<boolean> {
  try {
    return await page.evaluate(() =>
      Array.from(document.querySelectorAll('input[type="password"]')).some((el) => {
        const rect = (el as HTMLElement).getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }));
  } catch {
    return false;
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const __testing = { isBlockedDestination };
