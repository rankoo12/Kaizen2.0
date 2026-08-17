'use client';
/* The entry dialog for "Kaizen as a QA engineer". Sets honest expectations about
   time, cost and what Kaizen will DO to the user's site, and asks for consent
   where consent is actually owed. Spec: docs/specs/tests-ux/spec-testwriter-ux.md §4.2 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import * as React from 'react';
import { Sheet, Disclose, Switch, Seg } from './chrome';
import { I } from './icons';
import type { DesignSuite } from './use-design-data';

const { useState } = React;

/** Hosts that look like production get a softer, specific notice — never a block:
 *  we cannot actually verify an environment, and pretending to would be theater. */
function looksLikeProduction(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return !/staging|stage|dev|test|preview|localhost|127\.|\.local/i.test(host);
  } catch {
    return false;
  }
}

const DEPTHS = [
  { value: 10, label: 'Quick' },
  { value: 30, label: 'Standard' },
  { value: 50, label: 'Deep' },
];

/** An active test that could serve as a login recipe. From `GET /cases?status=active`. */
type LoginCandidate = {
  id: string; name: string; baseUrl: string; suiteId: string; suiteName: string;
};

/**
 * Everything the user has typed, so a trip to the new-test screen to author a
 * sign-in recipe returns them to the form rather than to a blank one. The empty
 * picker is the most likely moment for a first-time user to need that trip — a
 * dead end there would land exactly on the flagship upgrade.
 * Spec: docs/specs/test-writer/spec-authenticated-scope.md §11.2
 */
export type AnalyzeDraft = {
  suiteId: string; url: string; brief: string; consent: boolean;
  maxPages: number; maxScenarios: number; review: boolean; validate: boolean;
  authScope: boolean; loginCaseId: string | null;
};

/** The three-step recipe the empty state offers to create. Credential-free by
 *  design: a sign-in button flow keeps passwords out of test text entirely,
 *  which is the pattern §3.2 recommends over typing them. */
export function signInTemplate(url: string): { name: string; url: string; steps: string[] } {
  const host = (() => { try { return new URL(url).host; } catch { return 'the app'; } })();
  return {
    name: `Sign in to ${host}`,
    url: url || 'https://',
    steps: [
      `navigate to ${url || 'https://'}`,
      'click the sign in button',
      'verify the account menu is visible',
    ],
  };
}

/**
 * One sentence per way the API can refuse a login recipe.
 *
 * A generic "could not start" throws away the whole eligibility check: the user
 * learns something is wrong but not what to change. Where the client knows more
 * than the server said — the case's name, the two hosts — it says so.
 * Spec: docs/specs/test-writer/spec-authenticated-scope.md §11.5
 */
function loginErrorCopy(
  code: string,
  ctx: { caseName?: string; caseHost?: string; targetHost?: string },
  serverMessage?: string,
): string {
  const name = ctx.caseName ? `“${ctx.caseName}”` : 'That sign-in test';
  switch (code) {
    case 'AUTH_CONSENT_REQUIRED':
      return 'Turn on signed-in exploration and pick a sign-in test first.';
    case 'AUTH_SCOPE_REQUIRES_ADMIN':
      return 'Only a workspace admin or owner can let Kaizen sign in. Ask one of them to start this analysis.';
    case 'AUTH_SCOPE_NOT_VIA_IMPERSONATION':
      return 'This is a support session. Signed-in exploration has to be started by someone from your own workspace.';
    case 'LOGIN_CASE_NOT_FOUND':
      return `${name} no longer exists. Pick another one.`;
    case 'LOGIN_CASE_NOT_ACTIVE':
      return `${name} is a draft. A sign-in recipe has to be a test you’ve accepted and run.`;
    case 'LOGIN_CASE_ORIGIN_MISMATCH':
      return ctx.caseHost && ctx.targetHost
        ? `${name} signs in to ${ctx.caseHost}, not ${ctx.targetHost}. Pick a sign-in test for this site.`
        : `${name} signs in to a different site than the one you’re analyzing.`;
    case 'LOGIN_CASE_NAVIGATES_OFF_ORIGIN':
      return `${name} navigates off this site partway through. Kaizen won’t run a sign-in flow that leaves the site it’s testing.`;
    case 'LOGIN_CASE_USES_SEED_TOKENS':
      return `${name} uses {{…}} placeholders that Kaizen fills with random values on every run — it would try to sign in with a random password. Put the real test-account values in the step text, or use a sign-in button flow.`;
    default:
      return serverMessage || 'Could not start the analysis.';
  }
}

const LOGIN_ERROR_CODES = new Set([
  'AUTH_CONSENT_REQUIRED', 'AUTH_SCOPE_REQUIRES_ADMIN', 'AUTH_SCOPE_NOT_VIA_IMPERSONATION',
  'LOGIN_CASE_NOT_FOUND', 'LOGIN_CASE_NOT_ACTIVE', 'LOGIN_CASE_ORIGIN_MISMATCH',
  'LOGIN_CASE_NAVIGATES_OFF_ORIGIN', 'LOGIN_CASE_USES_SEED_TOKENS',
]);

function hostOf(url: string): string | null {
  try { return new URL(url).host; } catch { return null; }
}

function originOf(url: string): string | null {
  try { return new URL(url).origin; } catch { return null; }
}

export function AnalyzeSheet({
  suites: suiteProp, defaultSuiteId, defaultUrl, role, draft,
  onClose, onStarted, onCreateLoginTest, showToast,
}: {
  suites: DesignSuite[];
  defaultSuiteId?: string | null;
  defaultUrl?: string;
  /** Membership role, for the admin-only signed-in grant. Presentation only —
   *  the API returns 403 regardless of what the client believes. */
  role?: string | null;
  /** Restores a form the user left to go and author a sign-in test. */
  draft?: AnalyzeDraft | null;
  onClose: () => void;
  onStarted: (suiteId: string, jobId: string) => void;
  /** Hands the current form back so it can be restored, and asks the shell to
   *  open the authoring screen on a sign-in template. */
  onCreateLoginTest?: (draft: AnalyzeDraft, template: ReturnType<typeof signInTemplate>) => void;
  showToast?: (message: string, kind?: string) => void;
}) {
  const [suiteId, setSuiteId] = useState(draft?.suiteId ?? defaultSuiteId ?? suiteProp[0]?.id ?? '');
  const [url, setUrl] = useState(draft?.url ?? defaultUrl ?? '');
  const [brief, setBrief] = useState(draft?.brief ?? '');
  const [consent, setConsent] = useState(draft?.consent ?? false);
  const [maxPages, setMaxPages] = useState(draft?.maxPages ?? 30);
  const [maxScenarios, setMaxScenarios] = useState(draft?.maxScenarios ?? 6);
  const [review, setReview] = useState(draft?.review ?? true);
  const [validate, setValidate] = useState(draft?.validate ?? true);
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creatingSuite, setCreatingSuite] = useState(suiteProp.length === 0);
  const [newSuiteName, setNewSuiteName] = useState('');
  const [extraSuites, setExtraSuites] = useState<{ id: string; name: string }[]>([]);
  /** Suites created in this dialog appear immediately, without a round trip. */
  const suites = [...suiteProp, ...extraSuites];

  // ── signed-in exploration ──────────────────────────────────────────────────
  const isAdmin = role === 'admin' || role === 'owner';
  const [authScope, setAuthScope] = useState(draft?.authScope ?? false);
  const [loginCaseId, setLoginCaseId] = useState<string | null>(draft?.loginCaseId ?? null);
  const [candidates, setCandidates] = useState<LoginCandidate[] | null>(null);
  const [hasAnyCase, setHasAnyCase] = useState<boolean | null>(null);
  const [loginError, setLoginError] = useState<string | null>(null);
  const targetOrigin = originOf(url);
  const targetHost = hostOf(url);

  /* Candidates are fetched only once the grant is switched on: a tenant-wide
     case listing is not something an unopened card should be pulling. When the
     origin filter comes back empty we ask again unfiltered — purely so the empty
     state can tell "you have no sign-in test for THIS site" apart from "you have
     no tests yet", which are different problems with different fixes. */
  React.useEffect(() => {
    if (!authScope || !isAdmin) return;
    let alive = true;
    setCandidates(null);
    setHasAnyCase(null);
    void (async () => {
      try {
        const q = targetOrigin ? `&origin=${encodeURIComponent(targetOrigin)}` : '';
        const r = await fetch(`/api/proxy/cases?status=active${q}`);
        if (!r.ok) throw new Error();
        const { cases } = (await r.json()) as { cases: LoginCandidate[] };
        if (!alive) return;
        setCandidates(cases ?? []);
        if ((cases ?? []).length > 0 || !targetOrigin) { setHasAnyCase((cases ?? []).length > 0); return; }
        const all = await fetch('/api/proxy/cases?status=active');
        if (!alive) return;
        setHasAnyCase(all.ok ? (((await all.json()).cases ?? []).length > 0) : false);
      } catch {
        if (alive) { setCandidates([]); setHasAnyCase(false); }
      }
    })();
    return () => { alive = false; };
  }, [authScope, isAdmin, targetOrigin]);

  // A case chosen for one target must not survive a CHANGE of target: the origin
  // gate would reject it, and silently sending it is a worse experience than
  // making the user re-pick from a list that now shows the right site's tests.
  // Skipped on mount, or restoring a parked draft would immediately discard the
  // recipe the user just went away and authored.
  const seenOrigin = React.useRef<string | null | undefined>(undefined);
  React.useEffect(() => {
    if (seenOrigin.current === undefined) { seenOrigin.current = targetOrigin; return; }
    if (seenOrigin.current === targetOrigin) return;
    seenOrigin.current = targetOrigin;
    setLoginCaseId(null);
    setLoginError(null);
  }, [targetOrigin]);

  const chosen = candidates?.find((c) => c.id === loginCaseId) ?? null;
  const currentDraft = (): AnalyzeDraft => ({
    suiteId, url, brief, consent, maxPages, maxScenarios, review, validate,
    authScope, loginCaseId,
  });

  /** A suite created here is selected immediately — the dialog is where the user
   *  already is, so bouncing them to another screen to make one would be rude. */
  async function createSuite() {
    const name = newSuiteName.trim();
    if (!name) return;
    try {
      const r = await fetch('/api/proxy/suites', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!r.ok) throw new Error();
      const { suite } = await r.json();
      setExtraSuites((cur) => [...cur, { id: suite.id, name: suite.name }]);
      setSuiteId(suite.id);
      setCreatingSuite(false);
      setNewSuiteName('');
    } catch {
      setError('Could not create that suite.');
    }
  }

  // The grant is incomplete without a recipe, so the button says so rather than
  // letting the user submit into a 400 they have to read to understand.
  const authIncomplete = authScope && !loginCaseId;
  const canSubmit = !!suiteId && /^https?:\/\/.+/i.test(url.trim()) && !authIncomplete && !busy;

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    setLoginError(null);
    try {
      const r = await fetch(`/api/proxy/suites/${suiteId}/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetUrl: url.trim(),
          initBrief: brief.trim() || undefined,
          allowSyntheticData: consent,
          // Consent for signed-in exploration travels with the request that acts
          // on it, never as a saved preference: the API stamps who granted it and
          // when, and a per-job grant is the only kind that audit can mean.
          ...(authScope && loginCaseId
            ? { scope: 'authenticated', loginCaseId, authConsent: true }
            : {}),
          options: {
            maxPages, maxScenarios, includeNegative: true, safeMode: true,
            validate, planApproval: review ? 'review' : 'auto',
          },
        }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {
        const copy = loginErrorCopy(
          body.error,
          { caseName: chosen?.name, caseHost: chosen ? hostOf(chosen.baseUrl) ?? undefined : undefined,
            targetHost: targetHost ?? undefined },
          body.message,
        );
        // Anything about the sign-in grant belongs beside the card that caused
        // it; everything else stays at the foot of the sheet.
        if (LOGIN_ERROR_CODES.has(body.error)) setLoginError(copy);
        else setError(copy);
        setBusy(false);
        return;
      }
      // Secret scrubbing happens server-side on intake; surface what was removed
      // so the user knows their paste was handled, not silently swallowed.
      (body.warnings ?? []).forEach((w: string) => showToast?.(w, 'info'));
      onStarted(suiteId, body.jobId);
    } catch {
      setError('Could not reach Kaizen. Try again in a moment.');
      setBusy(false);
    }
  }

  return (
    <Sheet title="Analyze an app" onClose={onClose} width={580} footer={<>
      <button className="btn lg" onClick={onClose}>Cancel</button>
      <button className="btn lg pri" disabled={!canSubmit} onClick={submit}
        title={authIncomplete ? 'Pick the test that signs in, or turn signed-in exploration off' : undefined}>
        <I.sparkle size={13} />{busy ? 'Starting…' : 'Start exploring'}
      </button>
    </>}>
      <div style={{ fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.55, marginBottom: 14 }}>
        Kaizen explores it read-only, shows you a test plan, and writes only what you approve.
      </div>

      <div style={{ marginBottom: 12 }}>
        <span className="label" style={{ display: 'block', marginBottom: 5 }}>Suite</span>
        {creatingSuite ? (
          <div style={{ display: 'flex', gap: 6 }}>
            <input className="field" autoFocus value={newSuiteName}
              onChange={(e) => setNewSuiteName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void createSuite(); if (e.key === 'Escape') setCreatingSuite(false); }}
              placeholder="New suite name" style={{ flex: 1, fontSize: 13 }} />
            <button className="btn" onClick={() => void createSuite()} disabled={!newSuiteName.trim()}>Create</button>
            <button className="btn ghost" onClick={() => setCreatingSuite(false)}>Cancel</button>
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 6 }}>
            {/* The field class belongs on the control, not on a wrapper — putting it
                on the label drew the box around the caption too. */}
            <select className="field" value={suiteId} onChange={(e) => setSuiteId(e.target.value)}
              style={{ flex: 1, fontSize: 13, color: 'var(--text)' }}>
              {suites.length === 0 && <option value="">No suites yet</option>}
              {suites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            <button className="btn" onClick={() => setCreatingSuite(true)} title="Create a new suite">
              <I.plus size={12} />New
            </button>
          </div>
        )}
      </div>

      <label style={{ display: 'block', marginBottom: 4 }}>
        <span className="label" style={{ display: 'block', marginBottom: 5 }}>App URL</span>
        <input className="field" value={url} onChange={(e) => setUrl(e.target.value)}
          placeholder="https://staging.your-app.com" spellCheck={false}
          style={{ width: '100%', fontSize: 13 }} />
      </label>
      <div style={{ fontSize: 11.5, color: 'var(--text-3)', lineHeight: 1.5, marginBottom: 14 }}>
        {looksLikeProduction(url)
          ? 'This looks like a production URL. Exploration is read-only, and nothing that creates data runs without the consent box below — but proofs are real runs. A staging environment is the calmer choice.'
          : 'Use a staging URL if you have one. Kaizen never mutates data without your say-so, but proving tests means really running them.'}
      </div>

      <label style={{ display: 'block', marginBottom: 4 }}>
        <span className="label" style={{ display: 'block', marginBottom: 5 }}>
          Describe your app — optional, but it makes the plan sharper
        </span>
        <textarea className="field" value={brief} onChange={(e) => setBrief(e.target.value)} rows={4}
          maxLength={8000}
          placeholder={'What it does, the flows that matter, business rules, what to test hardest.\ne.g. "B2C shop. Checkout is revenue-critical. Coupons ship next week — hit search and cart hard. Never touch /admin."'}
          style={{ width: '100%', fontSize: 12.5, lineHeight: 1.5, resize: 'vertical', fontFamily: 'inherit' }} />
      </label>
      <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginBottom: 14 }}>
        Don&apos;t paste credentials — they&apos;re detected and removed.
      </div>

      <div className="card" style={{ padding: '12px 14px', marginBottom: 12 }}>
        <div className="label" style={{ marginBottom: 9 }}>What Kaizen may do on your site</div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
          <Switch checked={consent} onChange={setConsent} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12.5, fontWeight: 600 }}>Allow tests that create throwaway data</div>
            <div style={{ fontSize: 11.5, color: 'var(--text-2)', lineHeight: 1.5, marginTop: 3 }}>
              {consent
                ? 'Kaizen may create unique per-run records — accounts like kaizen+8f31@…, cart items, form submissions — while proving tests on this suite. Recorded on every job for audit.'
                : 'Off: signup and cart tests are still written, but proposed unproven instead of executed.'}
            </div>
          </div>
        </div>
        <Disclose title="What exploration does — and never does">
          <div style={{ fontSize: 11.5, color: 'var(--text-2)', lineHeight: 1.6 }}>
            Kaizen visits your pages the way a careful QA engineer would on day one: it follows
            links, opens menus, tabs and dialogs, and reads forms — it never submits them. It obeys
            robots.txt, stays on your domain, visits about one page per second, and stops at the
            page cap. Buttons that could change data — delete, pay, publish, save — are classified
            and never pressed. Checkout tests walk up to the payment step and stop. Everything it
            does is recorded on the job. Proving a test is different: that&apos;s a real run of the
            finished test, and anything that would create data first needs the consent above.
          </div>
        </Disclose>
      </div>

      {/* The second grant, in the main form rather than in Advanced. It is the
          larger of the two — Kaizen acting as a signed-in user on the customer's
          own system — and burying the bigger ask under a disclosure triangle
          would misrepresent its weight. Spec §11.1 */}
      <div className="card" style={{ padding: '12px 14px', marginBottom: 12 }}>
        <div className="label" style={{ marginBottom: 9 }}>Signed-in exploration</div>
        {/* The row keeps full contrast when disabled — the switch carries the
            unavailable state, and the sentence explaining WHY is the part a
            blocked user most needs to be able to read. */}
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
          <Switch checked={authScope} onChange={setAuthScope} disabled={!isAdmin}
            title={isAdmin ? undefined : 'Only a workspace admin can enable signed-in exploration'} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12.5, fontWeight: 600 }}>Let Kaizen sign in and explore as a user</div>
            <div style={{ fontSize: 11.5, color: 'var(--text-2)', lineHeight: 1.5, marginTop: 3 }}>
              {isAdmin
                ? 'The flows worth testing usually live behind a login. Off: Kaizen sees only what a signed-out visitor sees.'
                : 'Only a workspace admin can enable signed-in exploration.'}
            </div>
          </div>
        </div>

        {authScope && isAdmin && (
          <div className="rise" style={{ marginTop: 12, display: 'grid', gap: 10 }}>
            <div>
              <span className="label" style={{ display: 'block', marginBottom: 5 }}>
                Which test signs in?
              </span>
              {candidates === null ? (
                <div style={{ fontSize: 12, color: 'var(--text-3)' }}>Looking for sign-in tests…</div>
              ) : candidates.length > 0 ? (
                <select className="field" value={loginCaseId ?? ''}
                  onChange={(e) => { setLoginCaseId(e.target.value || null); setLoginError(null); }}
                  style={{ width: '100%', fontSize: 13, color: 'var(--text)' }}>
                  <option value="">Choose a test…</option>
                  {Object.entries(
                    candidates.reduce<Record<string, LoginCandidate[]>>((acc, c) => {
                      (acc[c.suiteName] ??= []).push(c);
                      return acc;
                    }, {}),
                  ).map(([suiteName, group]) => (
                    <optgroup key={suiteName} label={suiteName}>
                      {group.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </optgroup>
                  ))}
                </select>
              ) : (
                /* Not a dead end. The tenant most likely to switch this on for the
                   first time is precisely the one with no eligible recipe yet —
                   a login test has to be authored, run and accepted before it
                   qualifies. Spec §11.2 */
                <div style={{ fontSize: 12, color: 'var(--text-2)', lineHeight: 1.55 }}>
                  {hasAnyCase
                    ? `No sign-in test for ${targetHost ?? 'this site'} yet — your other tests run against a different site.`
                    : 'No sign-in test yet.'}
                  {' '}A sign-in recipe is an ordinary Kaizen test that logs in; Kaizen runs it to
                  get a session and stores no credentials of its own.
                  {/* Wrapped rather than styled: `.btn` is a flex row, so `display:block`
                      stacks its label under its icon and inline-flex leaves it embedded
                      mid-sentence. The wrapper gives it its own line and leaves the
                      button's own layout alone. */}
                  {onCreateLoginTest && (
                    <div style={{ marginTop: 8 }}>
                      <button className="btn"
                        onClick={() => onCreateLoginTest(currentDraft(), signInTemplate(url.trim()))}>
                        <I.plus size={12} />Write a sign-in test
                      </button>
                    </div>
                  )}
                  <div style={{ color: 'var(--text-3)', marginTop: 7 }}>
                    A test that clicks a sign-in button beats one that types a password —
                    it keeps credentials out of test text entirely.
                  </div>
                </div>
              )}
            </div>

            {chosen && (
              <div style={{ fontSize: 11.5, color: 'var(--text-2)', lineHeight: 1.6 }}>
                Kaizen will run <strong style={{ fontWeight: 600 }}>{chosen.name}</strong> to sign in,
                then explore and read pages as that user — following links, opening menus and
                dialogs, never submitting forms, never signing out, and never touching settings or
                billing actions. It will sign in about {1 + maxScenarios} times during this analysis
                (once to explore, once per test it proves). Recorded on the job with your name and
                the time. Use a dedicated test account on a staging environment — not a personal or
                production account.
              </div>
            )}

            <Disclose title="Who will be able to see what Kaizen finds">
              <div style={{ fontSize: 11.5, color: 'var(--text-2)', lineHeight: 1.6 }}>
                Everyone in this workspace — including viewers and API keys — will be able to see
                the screenshots and page content Kaizen captured while signed in. Page text and
                structure are sent to Kaizen&apos;s LLM provider under a no-training agreement.
                Signing in may also log the same account out elsewhere, if your app allows only one
                session — another reason for a dedicated test account.
              </div>
            </Disclose>

            {loginError && (
              <div style={{ fontSize: 12, color: 'var(--fail)', lineHeight: 1.5 }}>{loginError}</div>
            )}
          </div>
        )}
      </div>

      <button onClick={() => setAdvanced(!advanced)}
        style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, marginBottom: advanced ? 10 : 0 }}>
        <span className="label" style={{ color: 'var(--text-2)' }}>{advanced ? '▾' : '▸'} Advanced</span>
      </button>
      {advanced && (
        <div className="rise" style={{ display: 'grid', gap: 10, marginBottom: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span className="label" style={{ width: 130 }}>Exploration depth</span>
            <Seg value={maxPages} onChange={setMaxPages}
              options={DEPTHS.map((d) => ({ value: d.value, label: `${d.label} ${d.value}` }))} />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span className="label" style={{ width: 130 }}>Tests to plan</span>
            <input className="field" type="number" min={1} max={10} value={maxScenarios}
              onChange={(e) => setMaxScenarios(Math.min(10, Math.max(1, Number(e.target.value) || 1)))}
              style={{ width: 70, fontSize: 12.5 }} />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span className="label" style={{ flex: 1 }}>Pause for my approval after planning</span>
            <Switch checked={review} onChange={setReview} />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span className="label" style={{ flex: 1 }}>Prove each test with a real run</span>
            <Switch checked={validate} onChange={setValidate} />
          </div>
        </div>
      )}

      <div style={{ fontSize: 11.5, color: 'var(--text-3)', lineHeight: 1.5, marginTop: 12 }}>
        Standard depth usually takes 2–5 minutes and well under 50k tokens of your budget.
        Deep scans can take up to 20 minutes.
      </div>

      {error && (
        <div style={{ marginTop: 12, fontSize: 12, color: 'var(--fail)', lineHeight: 1.5 }}>{error}</div>
      )}
    </Sheet>
  );
}
