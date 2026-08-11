/**
 * Secret-step detection — the single definition of "this step is typing a credential".
 * Spec: docs/specs/test-writer/spec-authenticated-scope.md §12.2, §12.3
 *
 * Kaizen never asked for a password, but customers put them in login tests as
 * literal step text ("type \"Hunter2!\" into the password field"), and until P3
 * that literal leaked by three routes:
 *
 *   1. the worker's resolve log — into `run_events.data.value` AND into the log
 *      MESSAGE, which embeds the raw sentence;
 *   2. `compiled_ast_cache` — a GLOBAL table (content_hash PK, no tenant_id, no
 *      RLS) whose ast_json stores `value`, so a cache miss published the
 *      credential cross-tenant, permanently;
 *   3. the L5 resolver and compileStep prompts, which send the raw sentence to
 *      the model provider.
 *
 * All three predate the Test Writer. P3 is where they get closed, because
 * authenticated drafts replay a login prefix through every one of them on every
 * proving run — turning incidental leaks into guaranteed ones.
 *
 * Deliberately dependency-free: the compiler, the worker and the gateway all
 * import this, and none of them should acquire a Test Writer dependency to
 * redact a password.
 */

/** Field descriptions that mean "the value typed here is a credential". */
const SECRET_TARGETS = [
  'password', 'passwd', 'passcode', 'pass phrase', 'passphrase',
  'pin', 'secret', 'token', 'api key', 'apikey', 'api-key',
  'credential', 'private key', 'security code', 'cvv', 'cvc',
] as const;

export const REDACTED = '[redacted]';

/** True when a target description names a field whose value must never be recorded. */
export function isSecretTarget(targetDescription: string | null | undefined): boolean {
  if (!targetDescription) return false;
  const t = targetDescription.toLowerCase();
  return SECRET_TARGETS.some((s) => t.includes(s));
}

/**
 * True when this step types a credential.
 *
 * Two triggers, because the field name is the reliable signal but not the only
 * one: a `type` step carrying a literal (non-`{{token}}`) value into a
 * secret-named field is the common case, and a secret-named field alone is
 * enough — a `{{password}}` token is not itself a secret, but treating it as
 * one costs nothing and keeps the rule simple to reason about.
 */
export function isSecretStep(step: {
  action: string;
  targetDescription?: string | null;
  value?: string | null;
}): boolean {
  if (step.action !== 'type') return false;
  return isSecretTarget(step.targetDescription);
}

/** Whether a value is a seed/run token rather than a literal. */
export function isTokenValue(value: string | null | undefined): boolean {
  return !!value && /^\s*\{\{[^}]+\}\}\s*$/.test(value);
}

/**
 * Redacts a credential out of a raw step sentence.
 *
 * The worker's resolve log writes `step N · type · "<rawText>"`, so redacting
 * `data.value` while leaving the message intact just moves the password one
 * column over.
 *
 * Prefers redacting the KNOWN value — the caller has the interpolated step, so
 * this is exact and cannot mangle an unrelated apostrophe ("the user's profile").
 * Falls back to stripping quoted runs only when no value is available, which is
 * the case for a step whose credential arrived by interpolation the log never saw.
 *   `type "Hunter2!" into the password field`
 *     → `type "[redacted]" into the password field`
 */
export function redactStepText(rawText: string, value?: string | null): string {
  if (value && value.length > 0) {
    // Split/join rather than a built regex — a credential can contain any
    // character, and escaping it into a pattern is a needless footgun.
    return rawText.split(value).join(REDACTED);
  }
  // Paired quote forms, listed explicitly: curly quotes are asymmetric, so a
  // backreference (which requires the same character to open and close) misses them.
  return rawText.replace(/"[^"]*"|'[^']*'|“[^”]*”|‘[^’]*’/g, `"${REDACTED}"`);
}
