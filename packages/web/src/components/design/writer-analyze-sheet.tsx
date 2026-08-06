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

export function AnalyzeSheet({ suites, defaultSuiteId, defaultUrl, onClose, onStarted, showToast }: {
  suites: DesignSuite[];
  defaultSuiteId?: string | null;
  defaultUrl?: string;
  onClose: () => void;
  onStarted: (suiteId: string, jobId: string) => void;
  showToast?: (message: string, kind?: string) => void;
}) {
  const [suiteId, setSuiteId] = useState(defaultSuiteId ?? suites[0]?.id ?? '');
  const [url, setUrl] = useState(defaultUrl ?? '');
  const [brief, setBrief] = useState('');
  const [consent, setConsent] = useState(false);
  const [maxPages, setMaxPages] = useState(30);
  const [maxScenarios, setMaxScenarios] = useState(6);
  const [review, setReview] = useState(true);
  const [validate, setValidate] = useState(true);
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = !!suiteId && /^https?:\/\/.+/i.test(url.trim()) && !busy;

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/api/proxy/suites/${suiteId}/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetUrl: url.trim(),
          initBrief: brief.trim() || undefined,
          allowSyntheticData: consent,
          options: {
            maxPages, maxScenarios, includeNegative: true, safeMode: true,
            validate, planApproval: review ? 'review' : 'auto',
          },
        }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(body.message || body.error || 'Could not start the analysis.');
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
      <button className="btn lg pri" disabled={!canSubmit} onClick={submit}>
        <I.sparkle size={13} />{busy ? 'Starting…' : 'Start exploring'}
      </button>
    </>}>
      <div style={{ fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.55, marginBottom: 14 }}>
        Kaizen explores it read-only, shows you a test plan, and writes only what you approve.
      </div>

      {suites.length > 1 && (
        <label className="field" style={{ display: 'block', marginBottom: 10 }}>
          <span className="label" style={{ display: 'block', marginBottom: 5 }}>Suite</span>
          <select value={suiteId} onChange={(e) => setSuiteId(e.target.value)}
            style={{ width: '100%', background: 'transparent', border: 'none', color: 'var(--text)', fontSize: 13 }}>
            {suites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
      )}

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
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, opacity: .5 }}>
            <span className="label" style={{ flex: 1 }}>Signed-in exploration</span>
            <span className="badge">soon</span>
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
