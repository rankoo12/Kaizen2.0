import type { LoginStep } from '../recon/auth-session';
import { renderIntent } from '../write/canonical-templates';

/**
 * A sign-in recipe that ends on "click Login" proves nothing by itself: there
 * is no final check for a proving run to pass, nothing for the signed-out
 * probe to fail, and so every draft in the job is labelled unproven — which is
 * exactly what happened to four green saucedemo drafts.
 *
 * Recon already saw where sign-in LANDS. When the recipe has no terminal
 * assertion and the landing URL differs from the login page, this appends the
 * witness recon observed — `verify the url contains "/inventory.html"` — to the
 * prefix. It rides in every proving run (the run itself proves the session),
 * it is the assertion the signed-out probe runs (bounced to the login page ⇒
 * url lacks the path ⇒ fails ⇒ private), and it reads as an ordinary step in
 * the draft. Nothing is invented: only what the crawl watched happen.
 *
 * Spec: docs/specs/test-writer/spec-validation-trust.md §5 (amended 2026-08-18)
 */
export function withSigninWitness(
  prefix: LoginStep[],
  auth: { loginPageUrl?: string | null; landedUrl?: string | null } | null | undefined,
): { prefix: LoginStep[]; witness: string | null } {
  if (prefix.length === 0) return { prefix, witness: null };
  const last = prefix[prefix.length - 1];
  if (last.ast.action.startsWith('assert_')) return { prefix, witness: null };

  const token = distinctivePath(auth?.landedUrl, auth?.loginPageUrl);
  if (!token) return { prefix, witness: null };

  const rendered = renderIntent({ action: 'assert_url', value: token }, new Map());
  return {
    prefix: [...prefix, { rawText: rendered.text, ast: rendered.ast }],
    witness: rendered.text,
  };
}

/**
 * The part of the landing URL a signed-out visitor will not have. Path only —
 * query strings and hashes are session-specific noise. Null when the landing
 * is the site root or the same path as the login page: nothing to witness.
 */
export function distinctivePath(landedUrl?: string | null, loginPageUrl?: string | null): string | null {
  if (!landedUrl) return null;
  let landed: URL;
  try { landed = new URL(landedUrl); } catch { return null; }
  const path = landed.pathname.replace(/\/+$/, '');
  if (!path || path === '') return null;
  if (loginPageUrl) {
    try {
      const login = new URL(loginPageUrl);
      if (login.pathname.replace(/\/+$/, '') === path) return null;
    } catch { /* unparseable login url — the landing path still stands */ }
  }
  return path;
}
