'use client';
/* The QA-engineer screen. One screen, four faces keyed off the job's status —
   the job is one continuous story the user re-enters repeatedly over minutes, so
   they must always land on "where things are now" without picking a destination.
   Spec: docs/specs/tests-ux/spec-testwriter-ux.md §2.1, §4.3–§4.5, §5.1 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import * as React from 'react';
import { Toolbar, Stat, Disclose } from './chrome';
import { I } from './icons';
import { useGenerationJob, useSuiteJobs } from './use-generation-job';
import { ARCHETYPE_SKELETONS } from './writer-catalog';
import type { Finding, GenerationJob, PlannedScenario, ScenarioRejection } from '@/types/api';

const { useState, useMemo } = React;

// ─── shared bits ─────────────────────────────────────────────────────────────

const KIND_TONE: Record<string, string> = {
  happy: 'var(--pass)', negative: 'var(--accent)', edge: 'var(--idle)',
};

function Chip({ text, tone, title }: { text: string; tone?: string; title?: string }) {
  return (
    <span className="badge" title={title}
      style={{ color: tone ?? 'var(--text-2)', borderColor: 'var(--sep)', fontSize: 10 }}>
      {text}
    </span>
  );
}

/**
 * What a draft's evidence actually amounts to, in the reviewer's language.
 * Every one of these used to render as either "PROVEN — ran green against your
 * site" or "UNPROVEN — needs consent", and only one of the seven was ever
 * either of those things.
 */
const EVIDENCE = {
  healed: {
    chip: 'HEALED',
    caption: 'Passed only after Kaizen repaired a selector mid-run — worth reading the run before you trust it.',
  },
  weak_oracle: {
    chip: 'WEAK CHECK',
    caption: 'Ran green, but the model chose which element the final check looks at. Confirm it checks the right thing.',
  },
  flaky: {
    chip: 'FLAKY',
    caption: 'Failed once and passed on retry. Something here is not stable yet.',
  },
  unproven_signin: {
    chip: 'SIGN-IN UNPROVEN',
    caption: 'Kaizen could not confirm it was actually signed in during this run, so the result proves nothing either way.',
  },
  consent_held: {
    chip: 'NOT RUN',
    caption: 'Would create real data, and throwaway data is off for this suite.',
  },
  unvalidated: {
    chip: 'NOT RUN',
    caption: 'Proposed without a proving run.',
  },
} as const;

/** Rejections are shown, never counted silently: refusing to propose a weak test
 *  demonstrates the quality bar better than any accepted one. */
const REJECTION_COPY: Record<string, string> = {
  safety: 'Skipped for safety — it would have activated something that changes real data.',
  schema: 'Referenced an element the crawl never saw. Rather than guess, Kaizen dropped it.',
  render: 'Couldn’t be expressed as runnable steps.',
  compile: 'Couldn’t be expressed as runnable steps.',
  dedup: 'You already have this covered.',
  judge: 'Didn’t meet the quality bar.',
  validation: 'Failed its proving run.',
  consent: 'Needs permission to create throwaway data before it can be proven.',
};

// ─── PROGRESS face ───────────────────────────────────────────────────────────

const PHASES = [
  { key: 'recon', label: 'EXPLORE' },
  { key: 'comprehend', label: 'UNDERSTAND' },
  { key: 'plan', label: 'PLAN' },
  { key: 'approval', label: 'YOU' },
  { key: 'write', label: 'WRITE' },
  { key: 'validate', label: 'PROVE' },
];

const PHASE_COPY: Record<string, string> = {
  recon: 'Visiting your pages at about one per second. Reading only: no form is ever submitted, no button that changes data is pressed.',
  comprehend: 'Working out what each page is for, and how a user moves through the app.',
  plan: 'Choosing what a QA engineer would test first — and why.',
  write: 'Writing steps that reference only elements the crawl actually saw.',
  validate: 'Running each test for real. Only green survivors are proposed.',
};

function phaseIndex(job: GenerationJob): number {
  if (job.status === 'awaiting_plan_approval') return 3;
  const p = job.report?.progress?.phase;
  if (p === 'validate') return 5;
  if (p === 'write') return 4;
  if (p === 'plan') return 2;
  if (p === 'comprehend') return 1;
  return 0;
}

function elapsed(job: GenerationJob): string {
  const start = job.startedAt ?? job.createdAt;
  const ms = Date.now() - new Date(start).getTime();
  if (Number.isNaN(ms) || ms < 0) return '';
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function ProgressFace({ job }: { job: GenerationJob }) {
  const active = phaseIndex(job);
  const progress = job.report?.progress;
  const authScope = job.scope === 'authenticated';
  // An authenticated crawl signs in before the loop starts, so the first page
  // count IS the evidence that sign-in succeeded. Saying "signed in" before one
  // arrives would be a claim the job has not yet earned.
  const signingIn = authScope && progress?.phase === 'recon' && !progress.pagesCrawled;
  // Counts are shown only when the pipeline actually reported them — an invented
  // percentage on a job whose denominator is unknowable would be theater.
  const detail =
    signingIn
      ? 'signing in…'
      : progress?.phase === 'recon' && progress.pagesCrawled
        ? `${authScope ? 'signed in · ' : ''}${progress.pagesCrawled} pages so far`
        : progress?.phase === 'write' && progress.scenariosTotal
        ? `${progress.scenariosWritten ?? 0} of ${progress.scenariosTotal} written`
        : progress?.phase === 'validate' && progress.validationRunsTotal
          ? `${progress.validationRunsDone ?? 0} of ${progress.validationRunsTotal} proven`
          : '';

  return (
    <div className="card" style={{ padding: '18px 20px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 16 }}>
        {PHASES.map((p, i) => (
          <React.Fragment key={p.key}>
            {i > 0 && <span style={{ width: 18, height: 1, background: 'var(--sep)' }} />}
            <span className="label" style={{
              color: i < active ? 'var(--pass)' : i === active ? 'var(--accent)' : 'var(--text-3)',
              fontWeight: i === active ? 700 : 600,
            }}>
              {i < active ? '✓ ' : i === active ? '● ' : '○ '}{p.label}
            </span>
          </React.Fragment>
        ))}
      </div>

      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <div style={{ fontSize: 14, fontWeight: 600 }}>
          {job.status === 'queued' ? 'Waiting for a writer' : PHASES[active].label.toLowerCase()}
          {detail && <span style={{ color: 'var(--text-2)', fontWeight: 500 }}> — {detail}</span>}
        </div>
        <div style={{ flex: 1 }} />
        <span className="num" style={{ fontSize: 12, color: 'var(--text-3)' }}>{elapsed(job)}</span>
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-2)', lineHeight: 1.55, marginTop: 6 }}>
        {PHASE_COPY[progress?.phase ?? 'recon']}
      </div>

      <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 16, lineHeight: 1.5 }}>
        You can leave — this keeps running. We&apos;ll flag the sidebar and the tab title
        when it&apos;s your turn.
      </div>
    </div>
  );
}

// ─── PLAN REVIEW face ────────────────────────────────────────────────────────

function PlanRow({ s, checked, onToggle, consent }: {
  s: PlannedScenario; checked: boolean; onToggle: () => void; consent: boolean;
}) {
  const [open, setOpen] = useState(false);
  const skeleton = s.source.kind === 'catalog' ? ARCHETYPE_SKELETONS[s.source.archetypeKey] : null;
  const approach = skeleton ?? s.outline ?? '';
  const needsConsent = s.requiresSyntheticData && !consent;

  return (
    <div className="row" style={{ padding: '11px 14px', alignItems: 'flex-start', opacity: checked ? 1 : .55 }}>
      <input type="checkbox" checked={checked} onChange={onToggle}
        style={{ marginTop: 3, flex: 'none', accentColor: 'var(--accent)' }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="row-t">{s.name}</div>
        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', margin: '5px 0 6px' }}>
          <Chip text={s.kind.toUpperCase()} tone={KIND_TONE[s.kind]} />
          <Chip text={s.priority.toUpperCase()} />
          <Chip text={s.source.kind === 'catalog' ? 'CATALOG' : 'AI'}
            tone={s.source.kind === 'catalog' ? 'var(--text-2)' : 'var(--accent)'}
            title={s.source.kind === 'catalog'
              ? 'From Kaizen’s curated pattern library — a proven test shape, bound to your app’s real pages'
              : 'Written specifically for this app — no library pattern covered it'} />
          {needsConsent && <Chip text="NEEDS DATA CONSENT" tone="var(--warn)" />}
        </div>
        {s.rationale && (
          <div style={{ fontSize: 12, color: 'var(--text-2)', lineHeight: 1.5 }}>
            <span style={{ color: 'var(--text-3)' }}>Why: </span>{s.rationale}
          </div>
        )}
        {approach && (
          <>
            <button onClick={() => setOpen(!open)}
              style={{ background: 'none', border: 'none', padding: '5px 0 0', cursor: 'pointer' }}>
              <span className="label" style={{ color: 'var(--accent)' }}>
                {open ? '▾' : '▸'} Planned approach
              </span>
            </button>
            {open && (
              <div className="rise" style={{ fontSize: 11.5, color: 'var(--text-2)', lineHeight: 1.6,
                whiteSpace: 'pre-wrap', paddingTop: 4 }}>
                {approach}
                <div style={{ color: 'var(--text-3)', marginTop: 6 }}>
                  Final steps are written after your approval and may differ where the page demands it.
                </div>
              </div>
            )}
          </>
        )}
      </div>
      <div className="num hide-md" style={{ width: 120, flex: 'none', fontSize: 11, color: 'var(--text-3)', textAlign: 'right' }}>
        {s.targetPages.slice(0, 1).map((p) => { try { return new URL(p).pathname; } catch { return p; } })}
        {s.targetPages.length > 1 && ` +${s.targetPages.length - 1}`}
      </div>
    </div>
  );
}

function PlanFace({ job, onApprove, onDiscard, busy, consent, onEnableConsent }: {
  job: GenerationJob;
  onApprove: (names: string[], notes: string) => void;
  onDiscard: () => void;
  busy: boolean;
  consent: boolean;
  onEnableConsent: () => void;
}) {
  const scenarios = job.testPlan?.scenarios ?? [];
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [notes, setNotes] = useState('');
  const selected = scenarios.filter((s) => !excluded.has(s.name));
  const comprehend = job.report?.comprehend;
  const gaps = comprehend?.coverageGaps ?? [];
  const consentNeeded = selected.filter((s) => s.requiresSyntheticData).length;

  const host = useMemo(() => {
    try { return new URL(job.targetUrl).host; } catch { return job.targetUrl; }
  }, [job.targetUrl]);

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div className="card" style={{ padding: '14px 16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 6 }}>
          <I.sparkle size={14} style={{ color: 'var(--accent)' }} />
          <span style={{ fontSize: 13.5, fontWeight: 600 }}>What Kaizen understood</span>
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-2)', lineHeight: 1.55 }}>
          {comprehend
            ? `${comprehend.pagesClassified + comprehend.pagesReusedFromCache} pages · ${comprehend.journeys} verified ${comprehend.journeys === 1 ? 'journey' : 'journeys'}`
            : 'Exploration complete.'}
        </div>
        {gaps.length > 0 && (
          <div style={{ fontSize: 12, color: 'var(--warn)', lineHeight: 1.55, marginTop: 8 }}>
            ⚠ You described {gaps.map((g) => `“${g}”`).join(', ')} — the crawl never reached it.
            Likely behind sign-in; signed-in exploration is coming.
          </div>
        )}
      </div>

      <div>
        <div className="label" style={{ marginBottom: 8 }}>
          The plan — {scenarios.length} scenarios · nothing has been executed yet
        </div>
        <div className="list">
          {scenarios.map((s) => (
            <PlanRow key={s.name} s={s} consent={consent}
              checked={!excluded.has(s.name)}
              onToggle={() => setExcluded((cur) => {
                const next = new Set(cur);
                if (next.has(s.name)) next.delete(s.name); else next.add(s.name);
                return next;
              })} />
          ))}
        </div>
      </div>

      <label style={{ display: 'block' }}>
        <span className="label" style={{ display: 'block', marginBottom: 5 }}>
          Steering notes — optional, applies to the whole batch
        </span>
        <textarea className="field" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)}
          placeholder={'e.g. "skip newsletter tests; assert cart totals, not just item names"'}
          style={{ width: '100%', fontSize: 12.5, resize: 'vertical', fontFamily: 'inherit' }} />
      </label>

      <div className="card" style={{ padding: '13px 16px' }}>
        {consentNeeded > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
            <div style={{ flex: 1, fontSize: 12, color: 'var(--warn)', lineHeight: 1.5 }}>
              {consentNeeded} selected {consentNeeded === 1 ? 'test creates' : 'tests create'} throwaway
              data and consent is off — they&apos;ll be written but not proven.
            </div>
            <button className="btn" onClick={onEnableConsent}>Allow throwaway data</button>
          </div>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button className="btn" onClick={onDiscard} disabled={busy}>Discard plan</button>
          <div style={{ flex: 1 }} />
          <div style={{ textAlign: 'right' }}>
            <button className="btn lg pri" disabled={busy || selected.length === 0}
              onClick={() => onApprove(selected.map((s) => s.name), notes)}>
              <I.sparkle size={13} />
              {busy ? 'Starting…' : `Write & prove ${selected.length} ${selected.length === 1 ? 'test' : 'tests'}`}
            </button>
            <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 5 }}>
              real runs against {host} · nothing runs that you didn&apos;t approve
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

const SEVERITY_TONE: Record<Finding['severity'], string> = {
  high: 'var(--fail)', medium: 'var(--warn)', low: 'var(--idle)', info: 'var(--idle)',
};

/**
 * What Kaizen found that is not a test.
 *
 * This exists because a job that proposes nothing used to render as a blank
 * shrug, while the pipeline privately held a 500ing page, five unlabelled
 * buttons and an unverified login boundary. A QA engineer has a good day on a
 * day like that — they hand you the list.
 */
function FindingsSection({ findings, onOpenRun }: {
  findings: Finding[];
  onOpenRun: (caseId: string, runId: string) => void;
}) {
  if (findings.length === 0) return null;
  return (
    <div>
      <div className="label" style={{ marginBottom: 8 }}>
        What Kaizen found — {findings.length} {findings.length === 1 ? 'thing' : 'things'} worth your attention
      </div>
      <div className="list">
        {findings.map((f, i) => (
          <div key={`${f.kind}-${i}`} className="row" style={{ padding: '11px 14px', alignItems: 'flex-start' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="row-t">{f.title}</div>
              <div style={{ fontSize: 12, color: 'var(--text-2)', lineHeight: 1.5, marginTop: 3 }}>
                {f.detail}
              </div>
              {f.evidence.repro && f.evidence.repro.length > 0 && (
                <Disclose title="Steps to reproduce">
                  <ol style={{ margin: 0, paddingLeft: 18, fontSize: 11.5, color: 'var(--text-2)', lineHeight: 1.7 }}>
                    {f.evidence.repro.map((step, j) => <li key={j}>{step}</li>)}
                  </ol>
                </Disclose>
              )}
            </div>
            <Chip text={f.severity.toUpperCase()} tone={SEVERITY_TONE[f.severity]} />
            {f.evidence.runId && (
              <button className="btn" style={{ flex: 'none' }}
                onClick={() => onOpenRun(f.evidence.caseId ?? '', f.evidence.runId!)}>See it run</button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── DELIVERY face ───────────────────────────────────────────────────────────

function DeliveryFace({ job, drafts, onAcceptAll, onAccept, onDismiss, onOpenRun, busy }: {
  job: GenerationJob;
  drafts: any[];
  onAcceptAll: () => void;
  onAccept: (id: string) => void;
  onDismiss: (id: string) => void;
  onOpenRun: (caseId: string, runId: string) => void;
  busy: boolean;
}) {
  const validate = job.report?.validate;
  const rejected: ScenarioRejection[] = job.report?.rejected ?? [];
  // "It ran and a run id exists" is not the same as "it was proven". A draft
  // that only passed after self-healing, whose oracle the LLM anchored, or whose
  // sign-in was never confirmed all carry a run id — and all three used to be
  // presented as PROVEN. Only a clean audit on a clean run earns that word.
  const proven = drafts.filter((d) => d.validationState === 'validated');
  const unproven = drafts.filter((d) => d.validationState !== 'validated');
  const findings = job.report?.findings ?? [];
  const auth = job.report?.auth ?? null;

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div className="card" style={{ display: 'flex', flexWrap: 'wrap' }}>
        <Stat label="PROVEN" value={proven.length} sub="green runs" tone="var(--pass)" />
        <Stat label="NEEDS REVIEW" value={unproven.length} sub="see why on each" tone={unproven.length ? 'var(--warn)' : undefined} />
        <Stat label="REJECTED" value={rejected.length} sub="with reasons" />
        <Stat label="PROPOSED" value={validate?.proposed ?? drafts.length} sub="in this delivery" />
        {auth && (
          <Stat label="BEHIND SIGN-IN" value={auth.pagesBehindAuth} sub="pages explored"
            tone="var(--accent)" />
        )}
      </div>

      {/* What Kaizen did while holding a session. The scariest fact about the
          feature — a robot signed into my system — becomes the most reassuring
          one only if everything it touched is on the page. Spec §11.4 */}
      {auth && (
        <div className="card" style={{ padding: '0 16px' }}>
          <Disclose title={`Signed-in exploration — ${auth.signInCount} ${auth.signInCount === 1 ? 'sign-in' : 'sign-ins'}, ${auth.pagesBehindAuth} pages behind the login`}>
            <div style={{ display: 'grid', gap: 6, fontSize: 11.5, color: 'var(--text-2)', lineHeight: 1.55 }}>
              <div>
                Signed in with {auth.loginSteps.passed} of {auth.loginSteps.total} recipe steps passing
                {auth.sessionVerification
                  ? `, confirmed by ${auth.sessionVerification === 'assertion+heuristic'
                      ? 'the recipe’s own assertion' : 'page heuristics'}.`
                  : ', never confirmed.'}
              </div>
              {auth.sessionEndingBlocked > 0 && (
                <div>
                  Refused {auth.sessionEndingBlocked} sign-out {auth.sessionEndingBlocked === 1 ? 'link' : 'links'} —
                  Kaizen never ends the session it was lent.
                </div>
              )}
              {auth.captureSuppressed > 0 && (
                <div>
                  {auth.captureSuppressed} sensitive {auth.captureSuppressed === 1 ? 'page was' : 'pages were'} recorded
                  as address and title only — reading them is itself the exposure.
                </div>
              )}
              {auth.probesSuppressed > 0 && (
                <div>{auth.probesSuppressed} pages were read without probing controls.</div>
              )}
              {auth.reloginCount > 0 && (
                <div>
                  The session dropped and was renewed {auth.reloginCount === 1 ? 'once' : `${auth.reloginCount} times`} during exploration.
                </div>
              )}
              {auth.publicPartitionUnverified && (
                <div style={{ color: 'var(--warn)' }}>
                  No public analysis has ever run on this suite, so “behind sign-in” is a
                  conservative default rather than something Kaizen observed. One public run
                  settles it in both directions.
                </div>
              )}
            </div>
          </Disclose>
        </div>
      )}

      {auth?.endedEarly === 'session_lost' && (
        <div className="card" style={{ padding: '12px 16px', fontSize: 12, color: 'var(--warn)', lineHeight: 1.55 }}>
          The session was lost part-way through and could not be restored, so exploration stopped
          early. What Kaizen saw before that is below — but this is not a complete picture of the app.
        </div>
      )}

      {proven.length > 0 && (
        <div className="card" style={{ padding: '13px 16px', display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ flex: 1, fontSize: 12.5, color: 'var(--text-2)' }}>
            Every test below ran green against your site and its final check held up to inspection.
          </div>
          <button className="btn lg pri" onClick={onAcceptAll} disabled={busy}>
            <I.check size={13} />Add all {proven.length} to the suite
          </button>
        </div>
      )}

      {proven.length > 0 && (
        <div>
          <div className="label" style={{ marginBottom: 8 }}>Proven</div>
          <div className="list">
            {proven.map((d) => (
              <div key={d.id} className="row" style={{ padding: '11px 14px' }}>
                <I.sparkle size={13} style={{ color: 'var(--accent)', flex: 'none' }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="row-t">{d.name}</div>
                  <div className="row-s">
                    {d.archetypeKey ? <span className="num">{d.archetypeKey}</span> : 'written for this app'}
                  </div>
                </div>
                <Chip text="PROVEN" tone="var(--pass)" />
                <div style={{ display: 'flex', gap: 4, flex: 'none' }}>
                  {d.validationRunId && (
                    <button className="btn" onClick={() => onOpenRun(d.id, d.validationRunId)}>See it run</button>
                  )}
                  <button className="btn" onClick={() => onAccept(d.id)} disabled={busy}>Accept</button>
                  <button className="btn icon ghost" title="Dismiss" onClick={() => onDismiss(d.id)}>
                    <I.x size={13} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {unproven.length > 0 && (
        <div>
          <div className="label" style={{ marginBottom: 8, color: 'var(--warn)' }}>Needs a decision</div>
          <div className="list">
            {unproven.map((d) => {
              const evidence = EVIDENCE[d.validationState as keyof typeof EVIDENCE] ?? EVIDENCE.unvalidated;
              return (
                <div key={d.id} className="row" style={{ padding: '11px 14px' }}>
                  <I.sparkle size={13} style={{ color: 'var(--warn)', flex: 'none' }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="row-t">{d.name}</div>
                    <div className="row-s">{evidence.caption}</div>
                  </div>
                  <Chip text={evidence.chip} tone="var(--warn)" />
                  <div style={{ display: 'flex', gap: 4, flex: 'none' }}>
                    {d.validationRunId && (
                      <button className="btn" onClick={() => onOpenRun(d.id, d.validationRunId!)}>See it run</button>
                    )}
                    <button className="btn" onClick={() => onAccept(d.id)} disabled={busy}>Accept anyway</button>
                    <button className="btn icon ghost" title="Dismiss" onClick={() => onDismiss(d.id)}>
                      <I.x size={13} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {drafts.length === 0 && (
        <div className="card" style={{ padding: '20px 16px', textAlign: 'center' }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
            {findings.length > 0
              ? `No tests this time — but Kaizen found ${findings.length} ${findings.length === 1 ? 'thing' : 'things'} worth your attention`
              : 'Kaizen didn’t propose anything this time'}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-2)', lineHeight: 1.55 }}>
            {findings.length > 0
              ? 'It wrote tests and rejected them rather than propose something weak. What it noticed about your app is below.'
              : 'It wrote tests and rejected them rather than propose something weak. The reasons are below — steering notes on a fresh plan usually fix this.'}
          </div>
        </div>
      )}

      <FindingsSection findings={findings} onOpenRun={onOpenRun} />

      {rejected.length > 0 && (
        <div className="card" style={{ padding: '0 16px' }}>
          <Disclose title={`${rejected.length} ${rejected.length === 1 ? 'scenario was' : 'scenarios were'} rejected — Kaizen shows its work`}>
            <div style={{ display: 'grid', gap: 10 }}>
              {rejected.map((r, i) => (
                <div key={`${r.name}-${i}`}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                    <span style={{ fontSize: 12.5, fontWeight: 600 }}>{r.name}</span>
                    <Chip text={r.stage.toUpperCase()} tone="var(--fail)" />
                  </div>
                  <div style={{ fontSize: 11.5, color: 'var(--text-2)', lineHeight: 1.5, marginTop: 2 }}>
                    {REJECTION_COPY[r.stage] ?? ''} {r.reason}
                  </div>
                </div>
              ))}
            </div>
          </Disclose>
        </div>
      )}
    </div>
  );
}

// ─── HALTED face ─────────────────────────────────────────────────────────────

function HaltedFace({ job, onRetry, onOpenCase, onOpenRun }: {
  job: GenerationJob; onRetry: () => void; onOpenCase?: (caseId: string) => void;
  onOpenRun: (caseId: string, runId: string) => void;
}) {
  const blocked = job.status === 'blocked';
  const authBlock = job.report?.auth?.blockedReason ?? null;
  // A sign-in failure is not an anti-bot wall, and telling a user their site
  // fought Kaizen off when their login test simply broke sends them to fix the
  // wrong thing. The remedy is the recipe, so the button goes there.
  const signInFailed = authBlock === 'login_failed' || authBlock === 'login_challenge';
  const findings = job.report?.findings ?? [];
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div className="card" style={{ padding: '22px 20px', textAlign: 'center' }}>
        <div style={{ fontSize: 20, marginBottom: 8 }}>{blocked ? '⃠' : '⚠'}</div>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>
          {signInFailed ? 'Kaizen couldn’t sign in'
            : blocked ? 'Kaizen couldn’t get in' : 'The analysis stopped'}
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.6, maxWidth: 520, margin: '0 auto' }}>
          {job.error ?? 'Something broke mid-job.'}
          {blocked && !signInFailed && ' Kaizen never tries to defeat anti-bot challenges — that’s your site’s call.'}
          {!blocked && ' Nothing was left half-done: drafts only appear after a green proof.'}
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 16 }}>
          {signInFailed && job.loginCaseId && onOpenCase && (
            <button className="btn lg" onClick={() => onOpenCase(job.loginCaseId!)}>
              Open the sign-in test
            </button>
          )}
          <button className="btn lg pri" onClick={onRetry}>
            <I.sparkle size={13} />Try a different URL
          </button>
        </div>
      </div>
      {/* A job must never return nothing, and the job that stopped early is the
          one with least to show for the user's spend — so what it DID see has to
          survive the halt. Spec: spec-findings-and-coverage.md §0, §3.1 */}
      <FindingsSection findings={findings} onOpenRun={onOpenRun} />
    </div>
  );
}

// ─── the screen ──────────────────────────────────────────────────────────────

/** Cost, shown because a job that produced nothing still spent something. */
function CostLine({ usage }: { usage?: Record<string, number> }) {
  if (!usage?.total) return null;
  const phases = Object.entries(usage)
    .filter(([k, v]) => k !== 'total' && v > 0)
    .sort((a, b) => b[1] - a[1]);
  return (
    <div className="card" style={{ padding: '0 16px' }}>
      <Disclose title={`Cost — ${(usage.total / 1000).toFixed(1)}k tokens`}>
        <div style={{ display: 'grid', gap: 5 }}>
          {phases.map(([phase, tokens]) => (
            <div key={phase} style={{ display: 'flex', fontSize: 11.5 }}>
              <span style={{ flex: 1, color: 'var(--text-2)' }}>{phase}</span>
              <span className="num" style={{ color: 'var(--accent)' }}>
                {(tokens / 1000).toFixed(1)}k
              </span>
            </div>
          ))}
        </div>
      </Disclose>
    </div>
  );
}

/** Past analyses of this suite — the audit surface, and the way back to one. */
function HistoryStrip({ suiteId, currentJobId, onPick }: {
  suiteId: string; currentJobId: string; onPick: (jobId: string) => void;
}) {
  const { jobs } = useSuiteJobs(suiteId);
  if (jobs.length <= 1) return null;
  return (
    <div className="card" style={{ padding: '0 16px' }}>
      <Disclose title={`Past analyses (${jobs.length})`}>
        <div className="list">
          {jobs.map((j) => (
            <button key={j.id} className="row" onClick={() => onPick(j.id)}
              style={{ width: '100%', textAlign: 'left', background: 'none', border: 'none',
                cursor: 'pointer', padding: '9px 12px',
                opacity: j.id === currentJobId ? 1 : .7 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="row-t num" style={{ fontSize: 12 }}>
                  {(() => { try { return new URL(j.targetUrl).host; } catch { return j.targetUrl; } })()}
                </div>
                <div className="row-s">{new Date(j.createdAt).toLocaleString()}</div>
              </div>
              <Chip text={j.status.replace(/_/g, ' ').toUpperCase()}
                tone={j.status === 'completed' ? 'var(--pass)'
                  : j.status === 'awaiting_plan_approval' ? 'var(--accent)'
                    : j.status === 'failed' || j.status === 'blocked' ? 'var(--fail)' : 'var(--idle)'} />
              <span className="num" style={{ width: 74, textAlign: 'right', fontSize: 11, color: 'var(--text-3)' }}>
                {j.report?.validate?.proposed ?? 0} proposed
              </span>
            </button>
          ))}
        </div>
      </Disclose>
    </div>
  );
}

export function WriterScreen({ suiteId, jobId: initialJobId, suiteName, onBack, onOpenRun, onOpenCase, onAnalyzeAgain, showToast, onCasesChanged }: {
  suiteId: string;
  jobId: string;
  suiteName: string;
  onBack: () => void;
  onOpenRun: (caseId: string, runId: string) => void;
  /** Opens a test in the editor — the way out of a failed sign-in recipe. */
  onOpenCase?: (caseId: string) => void;
  onAnalyzeAgain: () => void;
  showToast?: (message: string, kind?: string) => void;
  onCasesChanged?: () => void;
}) {
  // The screen owns which job it shows, so the history strip can switch between
  // past analyses without the shell having to re-navigate.
  const [jobId, setJobId] = useState(initialJobId);
  React.useEffect(() => { setJobId(initialJobId); }, [initialJobId]);

  const { job, isLoading, error, refetch } = useGenerationJob(jobId);
  const [busy, setBusy] = useState(false);
  const [drafts, setDrafts] = useState<any[]>([]);
  const [consent, setConsent] = useState(false);

  // Drafts are read once the job lands — they are the delivery's payload.
  React.useEffect(() => {
    if (job?.status !== 'completed') return;
    void (async () => {
      try {
        const r = await fetch(`/api/proxy/suites/${suiteId}/cases?status=draft,validating`);
        if (!r.ok) return;
        const { cases } = await r.json();
        setDrafts((cases ?? []).filter((c: any) => c.generationJobId === jobId));
      } catch { /* the report still stands without them */ }
    })();
  }, [job?.status, suiteId, jobId]);

  React.useEffect(() => {
    void (async () => {
      try {
        const r = await fetch('/api/proxy/suites');
        if (!r.ok) return;
        const { suites } = await r.json();
        setConsent(!!suites?.find((s: any) => s.id === suiteId)?.allowSyntheticData);
      } catch { /* default off is the safe reading */ }
    })();
  }, [suiteId]);

  async function approve(names: string[], notes: string) {
    setBusy(true);
    try {
      const r = await fetch(`/api/proxy/testwriter/jobs/${jobId}/plan-approval`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approvedScenarios: names, notes: notes || undefined }),
      });
      if (!r.ok) {
        const b = await r.json().catch(() => ({}));
        showToast?.(b.message ?? 'Could not start writing', 'error');
      } else {
        showToast?.(names.length ? `Writing ${names.length} tests` : 'Plan discarded', 'info');
      }
      await refetch();
    } finally {
      setBusy(false);
    }
  }

  async function setCaseStatus(caseId: string, status: string) {
    const r = await fetch(`/api/proxy/cases/${caseId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    return r.ok;
  }

  async function acceptAll() {
    setBusy(true);
    const proven = drafts.filter((d) => d.validationState === 'validated');
    const results = await Promise.all(proven.map((d) => setCaseStatus(d.id, 'active')));
    const ok = results.filter(Boolean).length;
    setDrafts((cur) => cur.filter((d) => d.validationState !== 'validated'));
    showToast?.(`${ok} ${ok === 1 ? 'test' : 'tests'} added to ${suiteName}`, 'success');
    onCasesChanged?.();
    setBusy(false);
  }

  async function accept(caseId: string) {
    setBusy(true);
    if (await setCaseStatus(caseId, 'active')) {
      setDrafts((cur) => cur.filter((d) => d.id !== caseId));
      showToast?.(`Added to ${suiteName}`, 'success');
      onCasesChanged?.();
    }
    setBusy(false);
  }

  async function dismiss(caseId: string) {
    if (await setCaseStatus(caseId, 'archived')) {
      setDrafts((cur) => cur.filter((d) => d.id !== caseId));
      onCasesChanged?.();
    }
  }

  async function enableConsent() {
    const r = await fetch(`/api/proxy/suites/${suiteId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ allowSyntheticData: true }),
    });
    if (r.ok) { setConsent(true); showToast?.('Throwaway data allowed on this suite', 'info'); }
  }

  const host = (() => {
    try { return job ? new URL(job.targetUrl).host : ''; } catch { return job?.targetUrl ?? ''; }
  })();

  const body = !job
    ? <div className="card" style={{ padding: 24, textAlign: 'center', color: 'var(--text-2)', fontSize: 12.5 }}>
        {isLoading ? 'Loading…' : error === 'gone' ? 'This job no longer exists.' : 'Could not reach Kaizen.'}
      </div>
    : job.status === 'awaiting_plan_approval'
      ? <PlanFace job={job} onApprove={approve} onDiscard={() => approve([], '')} busy={busy}
          consent={consent} onEnableConsent={enableConsent} />
      : job.status === 'completed'
        ? <DeliveryFace job={job} drafts={drafts} busy={busy}
            onAcceptAll={acceptAll} onAccept={accept} onDismiss={dismiss} onOpenRun={onOpenRun} />
        : job.status === 'failed' || job.status === 'blocked'
          ? <HaltedFace job={job} onRetry={onAnalyzeAgain} onOpenCase={onOpenCase}
              onOpenRun={onOpenRun} />
          : <ProgressFace job={job} />;

  return (
    <>
      <Toolbar
        title={job?.status === 'awaiting_plan_approval' ? `Test plan — ${suiteName}` : `QA engineer — ${suiteName}`}
        sub={host}
        back={onBack}
      />
      <div style={{ flex: 1, overflow: 'auto', padding: '14px 16px 22px' }}>
        <div style={{ display: 'grid', gap: 14 }}>
          {body}
          {job && <CostLine usage={job.report?.tokenUsage} />}
          <HistoryStrip suiteId={suiteId} currentJobId={jobId} onPick={setJobId} />
        </div>
      </div>
    </>
  );
}
