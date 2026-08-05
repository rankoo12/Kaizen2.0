'use client';
/* Run detail — design markup from `Kaizen (1)/native/screen-run.jsx`, wired to real runs.

   What changed from the design, and why:
   · The "live replay" was a scripted animation over mock steps. Here it's genuinely
     live: useRunDetail polls every 2s while the run is non-terminal, so steps land as
     the worker writes step_results rows.
   · Evidence shows the real screenshot for the step (/api/proxy/media?key=…). The API
     stores one shot per step, so the design's Before/After toggle is gone rather than
     showing the same image twice.
   · Pin / block writes the real verdict (PATCH /runs/:id/steps/:stepId/verdict) and the
     button state reflects step_results.user_verdict.
   · The heal panel shows the real failure class and the selector that worked. The API
     doesn't record the selector that broke, so there's no "was → now" diff.
   · History is the case's real recentRuns. */
/* eslint-disable @typescript-eslint/no-explicit-any */
import * as React from 'react';
import { createPortal } from 'react-dom';
import { I, STATUS, StatusBadge, StatusDot } from './icons';
import { Toolbar, Seg, Stat, Sparkline, Menu, Disclose, ConfirmSheet } from './chrome';
import { fmt, SOURCES } from './data';
import { LineView } from './line-view';
import { RunCompleteHUD, type RunPayoff } from './game';
import { useCaseDetail } from '@/hooks/use-case-detail';
import { useRunDetail } from '@/hooks/use-run-detail';
import { resolutionTier } from '@/lib/resolution-source';
import { TERMINAL_RUN_STATUSES } from '@/types/api';
import type { CaseDetail, HealingEvent, RunDetail, RunSummary, StepResult } from '@/types/api';

const { useState: uSr, useEffect: uEr, useMemo: uMr, useRef: uRr } = React;

/** One row in the timeline: a real step result, or a step that hasn't run yet. */
type Row = {
  i: number;
  text: string;
  status: string;
  landed: boolean;
  sr: StepResult | null;
};

const VERB = /^(navigate|go to|open|reload|go back|type|enter|fill|click|double-click|right-click|press|select|choose|check|uncheck|drag|drop|scroll|wait|switch to|dismiss|verify|assert|expect|confirm|remember|capture)/;
const VERB_LABEL: Record<string, string> = {
  navigate: 'Navigate', 'go to': 'Navigate', open: 'Navigate', reload: 'Navigate', 'go back': 'Navigate',
  type: 'Type', enter: 'Type', fill: 'Type',
  click: 'Click', 'double-click': 'Click', 'right-click': 'Click', press: 'Key',
  select: 'Select', choose: 'Select', check: 'Check', uncheck: 'Check',
  drag: 'Drag', drop: 'Drag', scroll: 'Scroll', wait: 'Wait',
  'switch to': 'Tabs', dismiss: 'Click',
  verify: 'Assert', assert: 'Assert', expect: 'Assert', confirm: 'Assert',
  remember: 'Capture', capture: 'Capture',
};
function verbOf(text: string): string {
  const m = (text || '').trim().toLowerCase().match(VERB);
  return m ? VERB_LABEL[m[1]] ?? 'Step' : 'Step';
}

function relWhen(iso?: string | null): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24); if (d === 1) return 'yesterday'; if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

function StepPill({ verb }: { verb: string }) {
  return <span className="mono-chip" style={{ minWidth: 54, justifyContent: 'center', textAlign: 'center', display: 'inline-block', fontSize: 11, fontWeight: 700, letterSpacing: '.04em' }}>{verb.toUpperCase()}</span>;
}

/* Real resolver tiers → the design's source vocabulary. The design colours each tier
   differently on purpose: memory (PATTERN/CACHE) is a neutral dark, anything that
   reasoned about the page (SIMILAR/GLOBAL) is the accent, and the AI is the warn colour
   because it's the only one that costs money. Collapsing these to cached-vs-not, as the
   first port did, throws away the story the screen exists to tell.
   The L-number stays on the tooltip so the tier is still recoverable. */
const SOURCE_OF: Record<string, string> = {
  archetype: 'pattern',        // L0 — structural pattern Kaizen already trusts
  redis: 'cache',              // L1 — hot cache
  db_exact: 'cache',           // L2 — exact targetHash hit
  pgvector_step: 'vector',     // L3 — similarity over past step resolutions
  pgvector_element: 'global',  // L4 — element-level vector / shared pool
  llm: 'llm',                  // L5 — the model read the page
};

function SourceBadge({ source, tokens }: { source: string | null; tokens: number }) {
  const tier = resolutionTier(source);
  const key = source ? SOURCE_OF[source] : null;
  const s = key ? SOURCES[key] : null;

  if (!s) {
    // An unmapped source still shouldn't silently drop a token cost.
    return tokens
      ? <span className="badge" style={{ background: 'var(--fill)', color: 'var(--warn)', gap: 5 }}>
          <span className="dot" style={{ width: 5, height: 5, background: 'var(--warn)' }} />
          <span className="num">{fmt.n(tokens)} tok</span>
        </span>
      : null;
  }
  return (
    <span className="badge" title={tier ? `${tier.code} · ${tier.label} — ${s.note}` : s.note}
      style={{ background: 'var(--fill)', color: s.color, gap: 5 }}>
      <span className="dot" style={{ width: 5, height: 5, background: s.color }} />{s.short}
      <span style={{ color: 'var(--text-3)', fontFamily: 'var(--font-num)', fontWeight: 500 }}>
        {tokens ? `${fmt.n(tokens)} tok` : '0 tok'}
      </span>
    </span>
  );
}

function StepRow({ row, sel, onSelect }: { row: Row; sel: boolean; onSelect: () => void }) {
  const st = STATUS[row.status] ?? STATUS.pending;
  const sr = row.sr;
  const healed = row.status === 'healed';
  // The heal that produced the selector now in use — the only one worth diffing.
  const heal = sr?.healingEvents?.find((h) => h.succeeded && h.newSelector) ?? null;
  /* A step lands once and animates once: `rise` for a normal step, the longer
     `heal-flash` for a healed one so the eye is pulled to it. Both are keyframe
     animations on a node React only creates when the row flips from pending to
     landed (the key changes from `p<i>` to the step-result id), so live polling
     re-renders can't replay them. */
  return (
    <div className={`row focus-row${sel ? ' sel' : ''}${row.landed && healed ? ' heal-row' : ''}`}
      onClick={row.landed ? onSelect : undefined} tabIndex={row.landed ? 0 : -1}
      onKeyDown={(e) => { if (e.key === 'Enter' && row.landed) onSelect(); }}
      style={{
        alignItems: 'flex-start', padding: '9px 13px', opacity: row.landed ? 1 : .32,
        animation: row.landed && !healed ? 'rise .3s cubic-bezier(.32,.72,0,1) both' : undefined,
      }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, paddingTop: 2, flex: 'none' }}>
        {row.landed && row.status !== 'pending' && row.status !== 'running'
          ? <span style={{ color: st.c, display: 'grid' }}>{React.createElement(I[st.icon], { size: 13 })}</span>
          : <span className="spinner" style={{ width: 12, height: 12 }} />}
        <span className="num" style={{ fontSize: 11, color: 'var(--text-3)' }}>{String(row.i).padStart(2, '0')}</span>
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', gap: 7, alignItems: 'center', flexWrap: 'wrap' }}>
          <StepPill verb={verbOf(row.text)} />
          <span style={{ fontSize: 13, color: 'var(--text)', letterSpacing: '-.005em' }}>{row.text}</span>
        </div>
        {sr && (
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 5, flexWrap: 'wrap' }}>
            <SourceBadge source={sr.resolutionSource} tokens={sr.tokens} />
            {sr.durationMs != null && <span className="num" style={{ fontSize: 11, color: 'var(--text-3)' }}>{fmt.ms(sr.durationMs)}</span>}
            {healed && <span className="badge" style={{ background: 'var(--heal-soft)', color: 'var(--heal)' }}><I.heal size={9} />Self-healed</span>}
            {sr.capturedName && <span className="badge" style={{ background: 'var(--accent-soft)', color: 'var(--accent-text)' }}>{'{{'}{sr.capturedName}{'}}'} = {sr.capturedValue}</span>}
            {sr.userVerdict === 'passed' && <span className="badge" style={{ background: 'var(--pass-soft)', color: 'var(--pass)' }}><I.pin size={9} />Pinned</span>}
            {sr.userVerdict === 'failed' && <span className="badge" style={{ background: 'var(--fail-soft)', color: 'var(--fail)' }}><I.block size={9} />Blocked</span>}
            {sr.failureClass && row.status === 'failed' && <span className="num" style={{ fontSize: 11, color: 'var(--fail)' }}>{sr.failureClass}</span>}
          </div>
        )}
        {/* The heal story, in place: the selector that died, struck through, and the one
            that replaced it. `.heal-old`/`.heal-arrow`/`.heal-new` stagger themselves. */}
        {row.landed && heal?.oldSelector && heal.newSelector ? (
          <div className="num" style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 6, fontSize: 11, minWidth: 0 }}>
            <span className="heal-old" style={{ color: 'var(--text-3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{heal.oldSelector}</span>
            <span className="heal-arrow" style={{ color: 'var(--heal)', display: 'grid', flex: 'none' }}><I.chevron size={10} /></span>
            <span className="heal-new" style={{ color: 'var(--heal)', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{heal.newSelector}</span>
          </div>
        ) : sr?.selectorUsed ? (
          <div className="num" style={{ marginTop: 5, fontSize: 11, color: 'var(--text-3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {sr.selectorUsed}
          </div>
        ) : null}
      </div>
      {sel && <I.chevron size={12} style={{ color: 'var(--accent)', flex: 'none', marginTop: 3 }} />}
    </div>
  );
}

function Evidence({ sr }: { sr: StepResult }) {
  const [zoom, setZoom] = uSr(false);
  uEr(() => {
    if (!zoom) return;
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') setZoom(false); };
    document.addEventListener('keydown', k);
    return () => document.removeEventListener('keydown', k);
  }, [zoom]);

  if (!sr.screenshotKey) {
    return (
      <div>
        <span className="label">Evidence</span>
        <div style={{ marginTop: 8, border: '.5px dashed var(--sep-strong)', borderRadius: 9, padding: '22px 12px', textAlign: 'center' }}>
          <I.frame size={18} style={{ color: 'var(--text-3)' }} />
          <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 6 }}>No screenshot was captured for this step.</div>
        </div>
      </div>
    );
  }
  const src = `/api/proxy/media?key=${encodeURIComponent(sr.screenshotKey)}`;
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span className="label">Evidence</span>
        <div style={{ flex: 1 }} />
        <span className="num" style={{ fontSize: 11, color: 'var(--text-3)' }}>after the step</span>
      </div>
      <button className="shot zoomable" onClick={() => setZoom(true)}
        style={{ display: 'block', width: '100%', padding: 0, border: '.5px solid var(--sep)', cursor: 'zoom-in', background: '#fff' }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt={`Step ${sr.stepId} screenshot`} style={{ display: 'block', width: '100%' }} />
      </button>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 7, fontSize: 11, color: 'var(--text-3)' }}>
        <I.search size={11} />What the page looked like when the step finished. Click to enlarge.
      </div>
      {zoom && typeof document !== 'undefined' && createPortal((
        <div className="zoom-scrim" onClick={() => setZoom(false)}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={src} alt="Step screenshot" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', borderRadius: 10, boxShadow: 'var(--shadow-win)' }} />
        </div>
      ), document.body)}
    </div>
  );
}

function Inspector({ sr, text, runId, onVerdict, showToast }: any) {
  const [busy, setBusy] = uSr<string | null>(null);
  const tier = resolutionTier(sr.resolutionSource);
  const verdict = sr.userVerdict as 'passed' | 'failed' | null;
  /* Only pgvector_element and pgvector_step write similarity_score — measured across
     13,198 live step_results rows, where every other source was null (§5 of
     docs/specs/roadmap/spec-phase-0-plumbing.md). Gate on the source rather than on the
     value so a stray number from another tier can't be presented as a match score. */
  const isVectorTier = sr.resolutionSource === 'pgvector_element' || sr.resolutionSource === 'pgvector_step';

  async function setVerdict(v: 'passed' | 'failed') {
    setBusy(v);
    try {
      const r = await fetch(`/api/proxy/runs/${runId}/steps/${sr.id}/verdict`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ verdict: v }),
      });
      if (!r.ok) throw new Error();
      showToast(v === 'passed' ? 'Element pinned — always reused for this step' : 'Pattern blocked — the brain will not use it again', v === 'passed' ? 'success' : 'error');
      onVerdict();
    } catch {
      showToast('Could not save the verdict', 'error');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="scroll slide-in inspector" key={sr.id} style={{ flex: 'none', borderLeft: '.5px solid var(--sep)', background: 'var(--content)', padding: '15px 16px 40px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <StepPill verb={verbOf(text)} />
        <div style={{ flex: 1 }} />
        <StatusBadge status={sr.status} />
      </div>
      <div style={{ fontSize: 15, fontWeight: 600, marginTop: 9, letterSpacing: '-.014em', lineHeight: 1.35 }}>{text}</div>

      <div style={{ marginTop: 16 }}><Evidence sr={sr} /></div>

      {sr.selectorUsed && (
        <div style={{ marginTop: 18, padding: 13, borderRadius: 10, background: 'var(--fill)' }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>Was this the right element?</div>
          <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 3, lineHeight: 1.45 }}>
            Pinning always reuses it; blocking retires the pattern for good.
          </div>
          <div style={{ display: 'flex', gap: 7, marginTop: 10 }}>
            <button className="btn" disabled={!!busy} style={{ flex: 1, ...(verdict === 'passed' ? { background: 'var(--pass)', color: '#fff', borderColor: 'transparent' } : null) }}
              onClick={() => setVerdict('passed')}>
              {busy === 'passed' ? <span className="spinner" style={{ width: 11, height: 11 }} /> : <I.pin size={12} />}Yes — pin it
            </button>
            <button className="btn danger" disabled={!!busy} style={{ flex: 1, ...(verdict === 'failed' ? { background: 'var(--fail)', color: '#fff', borderColor: 'transparent' } : null) }}
              onClick={() => setVerdict('failed')}>
              {busy === 'failed' ? <span className="spinner" style={{ width: 11, height: 11 }} /> : <I.block size={12} />}No — block it
            </button>
          </div>
        </div>
      )}

      <div style={{ marginTop: 16 }}>
        {/* Boolean-coerce: `healingEvents.length` of 0 is falsy but React renders "0". */}
        {(sr.status === 'healed' || !!sr.failureClass || (sr.healingEvents?.length ?? 0) > 0) && (() => {
          const events: HealingEvent[] = sr.healingEvents ?? [];
          const won = events.find((h) => h.succeeded);
          const cls = won?.failureClass ?? sr.failureClass ?? sr.errorType;
          const tone = sr.status === 'healed' ? 'var(--heal)' : 'var(--fail)';
          return (
            <Disclose title={sr.status === 'healed' ? 'What broke, how it recovered' : 'What went wrong'} defaultOpen
              accent={tone}
              badge={<span className="num" style={{ fontSize: 11, fontWeight: 700, color: tone }}>{cls}</span>}>
              <div style={{ fontSize: 13, lineHeight: 1.5, color: 'var(--text-2)' }}>
                {won
                  ? `The first attempt failed. ${won.strategyUsed} re-found the element after ${won.attempts} attempt${won.attempts === 1 ? '' : 's'} and re-learned the selector, so the next run starts from the one below.`
                  : events.length
                    ? `Healing ran (${events.map((h) => h.strategyUsed).join(', ')}) but could not recover the step.`
                    : 'The step could not complete. The class above is how Kaizen categorised the failure.'}
              </div>
              {won?.oldSelector && won.newSelector && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '11px 0 2px', fontSize: 11 }}>
                  <span className="num" style={{ textDecoration: 'line-through', color: 'var(--text-3)', wordBreak: 'break-all' }}>{won.oldSelector}</span>
                  <I.chevron size={11} style={{ color: 'var(--heal)', flex: 'none' }} />
                  <span className="num" style={{ color: 'var(--heal)', fontWeight: 600, wordBreak: 'break-all' }}>{won.newSelector}</span>
                </div>
              )}
              {/* When healing failed there's no new selector, but the selector that was
                  tried is still the most useful thing to show. */}
              {!won && events[0]?.oldSelector && (
                <div className="num" style={{ fontSize: 11, marginTop: 10, color: 'var(--text-3)', wordBreak: 'break-all' }}>
                  tried <span style={{ color: 'var(--fail)' }}>{events[0].oldSelector}</span>
                </div>
              )}
              {events.length > 0 && (
                <div style={{ display: 'flex', marginTop: 12, border: '.5px solid var(--sep)', borderRadius: 8, overflow: 'hidden' }}>
                  {[['Attempts', String(events.reduce((a, h) => a + h.attempts, 0))],
                    ['Strategies', String(new Set(events.map((h) => h.strategyUsed)).size)],
                    ['Healing time', fmt.ms(events.reduce((a, h) => a + (h.durationMs ?? 0), 0))]].map(([l, v], k) => (
                    <div key={l} style={{ flex: 1, padding: '8px 11px', borderRight: k < 2 ? '.5px solid var(--sep)' : 'none' }}>
                      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-3)' }}>{l}</div>
                      <div className="num" style={{ fontSize: 13, fontWeight: 600, marginTop: 1 }}>{v}</div>
                    </div>
                  ))}
                </div>
              )}
              {sr.errorType && sr.errorType !== cls && (
                <div className="num" style={{ fontSize: 12, marginTop: 9, color: 'var(--text-3)' }}>{sr.errorType}</div>
              )}
            </Disclose>
          );
        })()}

        <Disclose title="How it was resolved" defaultOpen
          badge={<span className="num" style={{ fontSize: 11, color: sr.tokens ? 'var(--warn)' : 'var(--text-2)', fontWeight: 600 }}>
            {tier ? tier.label : '—'} · {sr.tokens ? `${fmt.n(sr.tokens)} tok` : '0 tok'}</span>}>
          {tier
            ? <div style={{ fontSize: 13, color: 'var(--text-2)', lineHeight: 1.5 }}>
                {tier.cached
                  ? `Recalled from memory (${tier.code} · ${tier.label}) — no model call, no tokens.`
                  : 'No memory matched, so the model read the page and picked the element. It is learned now.'}
                {/* Only the two vector tiers measure a similarity; every other tier matched
                    an exact key or a pattern, where a percentage would be invented. */}
                {isVectorTier && sr.similarityScore != null && (
                  <> The nearest remembered element scored{' '}
                    <span className="num" style={{ fontWeight: 600, color: 'var(--cache)' }}>
                      {(sr.similarityScore * 100).toFixed(1)}%
                    </span>{' '}similarity.</>
                )}
              </div>
            : <div style={{ fontSize: 13, color: 'var(--text-3)', lineHeight: 1.5 }}>This step did not need to find an element.</div>}
          {sr.selectorUsed && <>
            <div className="label" style={{ marginTop: 11, marginBottom: 4 }}>Selector used</div>
            <div className="num" style={{ fontSize: 12, background: 'var(--fill)', padding: '8px 10px', borderRadius: 7, wordBreak: 'break-all', lineHeight: 1.5 }}>{sr.selectorUsed}</div>
          </>}
          <div style={{ display: 'flex', marginTop: 11, border: '.5px solid var(--sep)', borderRadius: 8, overflow: 'hidden' }}>
            {([['Duration', sr.durationMs != null ? fmt.ms(sr.durationMs) : '—'],
              ['Tokens', sr.tokens ? fmt.n(sr.tokens) : '0'],
              ['Candidates', sr.domCandidates ? String(sr.domCandidates.length) : '—'],
              // Omitted rather than shown as '—' on the ~97% of steps that have no
              // similarity: an empty cell reads as a missing measurement, when in fact
              // the tier never takes one.
              ...(isVectorTier && sr.similarityScore != null
                ? [['Match', `${(sr.similarityScore * 100).toFixed(1)}%`]] : []),
            ] as [string, string][]).map(([l, v], k, arr) => (
              <div key={l} style={{ flex: 1, padding: '8px 11px', borderRight: k < arr.length - 1 ? '.5px solid var(--sep)' : 'none' }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-3)' }}>{l}</div>
                <div className="num" style={{ fontSize: 13, fontWeight: 600, marginTop: 1 }}>{v}</div>
              </div>
            ))}
          </div>
        </Disclose>

        {sr.capturedName && (
          <Disclose title="Captured for later steps" badge={<span className="num" style={{ fontSize: 11, color: 'var(--accent-text)' }}>{'{{'}{sr.capturedName}{'}}'}</span>}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--fill)', padding: '9px 11px', borderRadius: 8 }}>
              <span className="num" style={{ fontSize: 12, color: 'var(--accent-text)' }}>{'{{'}{sr.capturedName}{'}}'}</span>
              <span style={{ color: 'var(--text-3)' }}>=</span>
              <span style={{ fontSize: 13, fontWeight: 500 }}>{sr.capturedValue}</span>
            </div>
          </Disclose>
        )}

        {sr.domCandidates?.length ? (
          <Disclose title="What the model was shown" badge={<span className="num" style={{ fontSize: 11, color: 'var(--text-2)' }}>{sr.domCandidates.length}</span>}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              {sr.domCandidates.slice(0, 12).map((c: any) => (
                <div key={c.kaizenId} style={{ display: 'flex', gap: 7, alignItems: 'baseline', fontSize: 12,
                  background: c.kaizenId === sr.llmPickedKaizenId ? 'var(--accent-soft)' : 'var(--fill)', padding: '6px 9px', borderRadius: 7 }}>
                  <span className="num" style={{ fontSize: 11, color: 'var(--text-3)', flex: 'none' }}>{c.role}</span>
                  <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name || <em style={{ color: 'var(--text-3)' }}>no name</em>}</span>
                  {c.kaizenId === sr.llmPickedKaizenId && <span className="badge" style={{ marginLeft: 'auto', background: 'transparent', color: 'var(--accent-text)' }}>picked</span>}
                </div>
              ))}
            </div>
          </Disclose>
        ) : null}
      </div>
    </div>
  );
}

function ActivityFeed({ rows }: { rows: Row[] }) {
  const events: any[] = [];
  for (const r of rows) {
    if (!r.sr) continue;
    const tier = resolutionTier(r.sr.resolutionSource);
    if (tier) events.push({ t: r.i, kind: 'resolve', text: `Found the element for “${r.text}”`, sub: `${tier.code} · ${tier.label}` });
    if (r.status === 'healed') events.push({ t: r.i, kind: 'heal', text: `${r.sr.failureClass || 'Failure'} — healed`, sub: 'Re-found the element and re-learned it' });
    events.push({
      t: r.i, kind: r.status, text: `${verbOf(r.text)} ${r.status}`,
      sub: `${r.sr.durationMs != null ? fmt.ms(r.sr.durationMs) : '—'} · ${r.sr.tokens ? `${fmt.n(r.sr.tokens)} tokens` : 'no tokens'}`,
    });
  }
  if (!events.length) return <div className="card" style={{ padding: '40px 20px', textAlign: 'center', fontSize: 13, color: 'var(--text-3)' }}>Nothing has happened yet.</div>;
  return (
    <div className="list" style={{ margin: '0 0 16px' }}>
      {events.map((e, k) => {
        const color = e.kind === 'heal' ? 'var(--heal)' : e.kind === 'resolve' ? 'var(--text-3)' : (STATUS[e.kind] || STATUS.pending).c;
        return (
          <div className="row" key={k} style={{ cursor: 'default', padding: '7px 13px', alignItems: 'flex-start' }}>
            <span className="num" style={{ fontSize: 11, color: 'var(--text-3)', width: 22, flex: 'none', paddingTop: 2 }}>{String(e.t).padStart(2, '0')}</span>
            <span className="dot" style={{ background: color, marginTop: 6 }} />
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 13 }}>{e.text}</div>
              <div style={{ fontSize: 11, color: 'var(--text-3)' }}>{e.sub}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function HistoryTab({ runs, activeRunId, onOpen }: { runs: RunSummary[]; activeRunId: string | null; onOpen: (id: string) => void }) {
  const costed = runs.filter((r) => r.totalTokens != null).slice().reverse();
  const first = costed[0]?.totalTokens ?? null;
  const last = costed[costed.length - 1]?.totalTokens ?? null;
  const cheaper = first && last != null && first > 0 ? Math.round((1 - last / first) * 100) : null;
  // Nothing to plot when every kept run was free — a flat zero line just looks broken.
  const maxCost = Math.max(0, ...costed.map((h) => h.totalTokens ?? 0));

  return (
    <>
      {costed.length > 1 && maxCost > 0 && (
        <div className="card" style={{ marginBottom: 14, padding: '14px 16px' }}>
          <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12 }}>
            <div>
              <div className="card-t">Cost per run</div>
              <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 2 }}>
                This test cost {fmt.n(first as number)} tokens on the oldest run kept and {fmt.n(last as number)} on the newest.
              </div>
            </div>
            {cheaper != null && cheaper > 0 && (
              <span className="badge" style={{ background: 'var(--pass-soft)', color: 'var(--pass)', flex: 'none' }}>
                <I.arrowDown size={9} />{cheaper}% CHEAPER
              </span>
            )}
          </div>
          <div style={{ marginTop: 12, overflow: 'hidden' }}>
            <Sparkline data={costed.map((h) => h.totalTokens ?? 0)} w={720} h={64} color="var(--cache)" />
          </div>
        </div>
      )}
      <div className="list">
        <div className="list-h">
          <span style={{ width: 8 }} /><span style={{ flex: 1 }}>RUN</span>
          <span className="hide-md" style={{ width: 90 }}>STATUS</span>
          <span className="hide-lg" style={{ width: 80, textAlign: 'right' }}>DURATION</span>
          <span style={{ width: 80, textAlign: 'right' }}>TOKENS</span>
          <span style={{ width: 100, textAlign: 'right' }}>WHEN</span>
          <span style={{ width: 30 }} />
        </div>
        {runs.map((h) => (
          <div className={`row${h.id === activeRunId ? ' sel' : ''}`} key={h.id} onClick={() => onOpen(h.id)}>
            <StatusDot status={h.status} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="row-t num">#{h.id.slice(0, 8)}</div>
              <div className="row-s">{h.triggeredBy}{h.id === activeRunId ? ' · showing' : ''}</div>
            </div>
            <span className="hide-md" style={{ width: 90 }}><StatusBadge status={h.status} size="sm" /></span>
            <span className="num hide-lg" style={{ width: 80, textAlign: 'right', fontSize: 12 }}>{h.durationMs != null ? fmt.ms(h.durationMs) : '—'}</span>
            <span className="num" style={{ width: 80, textAlign: 'right', fontSize: 12, color: h.totalTokens === 0 ? 'var(--cache)' : 'var(--text)' }}>
              {h.totalTokens == null ? '—' : h.totalTokens === 0 ? 'free' : fmt.n(h.totalTokens)}
            </span>
            <span className="num" style={{ width: 100, textAlign: 'right', fontSize: 12, color: 'var(--text-2)' }}>{relWhen(h.completedAt || h.createdAt)}</span>
            <span style={{ width: 30, display: 'grid', placeItems: 'center' }}><I.chevron size={12} style={{ color: 'var(--text-3)' }} /></span>
          </div>
        ))}
        {!runs.length && <div style={{ padding: '34px 16px', textAlign: 'center', fontSize: 13, color: 'var(--text-3)' }}>No runs yet.</div>}
      </div>
    </>
  );
}

export function RunScreen({ caseId, runId: initialRunId, initialStepId, caseName, onBack, onEdit, onRerun, showToast }: {
  caseId: string;
  runId: string | null;
  /** Step result to select on arrival (deep link from the Brain). */
  initialStepId?: string | null;
  caseName?: string;
  /** Opens this test in the step editor. */
  onEdit?: () => void;
  onBack: () => void;
  onRerun: () => Promise<string | null>;
  showToast: (msg: string, kind?: string) => void;
}) {
  const [tab, setTab] = uSr('steps');
  const [runId, setRunId] = uSr<string | null>(initialRunId);
  const [selId, setSelId] = uSr<string | null>(initialStepId ?? null);
  const [menu, setMenu] = uSr(false);
  const [rerunning, setRerunning] = uSr(false);
  const [confirmCancel, setConfirmCancel] = uSr(false);
  const [payoff, setPayoff] = uSr<RunPayoff | null>(null);
  /* The HUD is a reward for watching a run finish, so it only fires when this screen
     saw the transition from running to terminal. Opening a historical run must not
     replay it, and neither must a poll that arrives after it's already been shown. */
  const sawRunning = uRr(false);
  const hudShownFor = uRr<string | null>(null);

  const { data: detail, refetch: refetchCase } = useCaseDetail(caseId) as { data: CaseDetail | null; refetch: () => void };
  // No run was passed in (e.g. opened straight from a "never run" row) — fall back to
  // the newest run the case knows about, so the screen isn't empty for no reason.
  const effectiveRunId = runId ?? detail?.lastRun?.id ?? detail?.recentRuns?.[0]?.id ?? null;
  const { data: run, refetch: refetchRun } = useRunDetail(effectiveRunId) as { data: RunDetail | null; refetch: () => void };

  const rows: Row[] = uMr(() => {
    const out: Row[] = [];
    const results = run?.stepResults ?? [];
    results.forEach((sr, i) => {
      out.push({ i: i + 1, text: sr.rawText || `Step ${i + 1}`, status: sr.status, landed: true, sr });
    });
    // Pad with the case's remaining steps so a running test shows what's still coming.
    const planned = detail?.steps ?? [];
    for (let i = results.length; i < planned.length; i++) {
      out.push({ i: i + 1, text: planned[i].rawText, status: 'pending', landed: false, sr: null });
    }
    return out;
  }, [run?.stepResults, detail?.steps]);

  // Select the most interesting step by default: the failure, else the last one that ran.
  uEr(() => {
    if (selId || !run?.stepResults?.length) return;
    const bad = run.stepResults.find((s) => s.status === 'failed') ?? run.stepResults.find((s) => s.status === 'healed');
    setSelId((bad ?? run.stepResults[run.stepResults.length - 1]).id);
  }, [run?.stepResults, selId]);

  // The case detail (step list, run history) is fetched once on mount, so a run that
  // was still going when we arrived would leave History showing it as "running"
  // forever. Refresh the case once each run reaches a terminal status.
  const settled = React.useRef<string | null>(null);
  uEr(() => {
    const s = run?.status;
    if (!run?.id || !s || !TERMINAL_RUN_STATUSES.includes(s)) return;
    if (settled.current === run.id) return;
    settled.current = run.id;
    refetchCase();
  }, [run?.id, run?.status, refetchCase]);

  // Preload every screenshot so switching steps doesn't stall on a fetch + decode.
  uEr(() => {
    const seen = new Set<string>();
    for (const sr of run?.stepResults ?? []) {
      if (sr.screenshotKey && !seen.has(sr.screenshotKey)) {
        seen.add(sr.screenshotKey);
        const img = new Image();
        img.src = `/api/proxy/media?key=${encodeURIComponent(sr.screenshotKey)}`;
      }
    }
  }, [run?.id, run?.stepResults]);

  /* The design's summary strip compares against the previous run ("was 4,620 last run",
     "2.11s faster than last"). recentRuns is ordered newest-first, so the previous run is
     the first completed one that isn't the one on screen. */
  const prev = (detail?.recentRuns ?? []).find(
    (r) => r.id !== effectiveRunId && TERMINAL_RUN_STATUSES.includes(r.status),
  ) ?? null;

  const landed = rows.filter((r) => r.landed).length;
  const total = Math.max(rows.length, landed, 1);
  const done = !!run && TERMINAL_RUN_STATUSES.includes(run.status);
  const status = run?.status ?? 'queued';
  const st = STATUS[status] ?? STATUS.queued;
  const tokens = (run?.stepResults ?? []).reduce((a, s) => a + (s.tokens || 0), 0);
  const ms = run?.durationMs ?? (run?.stepResults ?? []).reduce((a, s) => a + (s.durationMs || 0), 0);
  const cacheSteps = (run?.stepResults ?? []).filter((s) => s.resolutionSource && s.resolutionSource !== 'llm').length;
  const lookupSteps = (run?.stepResults ?? []).filter((s) => s.resolutionSource).length;

  /* Fire the payoff HUD once, when a run we watched running reaches a terminal state.
     "Learned" counts what this run actually added to memory: every element the model had
     to resolve (now cached) plus every successful heal (a re-learned selector). */
  uEr(() => {
    if (!run || !effectiveRunId) return;
    if (!TERMINAL_RUN_STATUSES.includes(run.status)) { sawRunning.current = true; return; }
    if (!sawRunning.current || hudShownFor.current === effectiveRunId) return;
    hudShownFor.current = effectiveRunId;
    const results = run.stepResults ?? [];
    const learned = results.filter((s) => s.resolutionSource === 'llm').length
      + results.reduce((a, s) => a + (s.healingEvents ?? []).filter((h) => h.succeeded && h.newSelector).length, 0);
    const t = setTimeout(() => setPayoff({
      status: run.status, steps: results.length, cacheSteps, tokens, ms, learned,
      prevTokens: prev?.totalTokens ?? null,
      prevMs: prev?.durationMs ?? null,
    }), 340);
    return () => clearTimeout(t);
  }, [run?.status, effectiveRunId]);

  // A different run is on screen — let its own completion show a fresh HUD.
  uEr(() => { sawRunning.current = false; setPayoff(null); }, [effectiveRunId]);
  const selRow = rows.find((r) => r.sr?.id === selId) ?? null;

  async function rerun() {
    setRerunning(true);
    const id = await onRerun();
    setRerunning(false);
    if (id) { setRunId(id); setSelId(null); setTab('steps'); }
  }

  /* Cancel signals the worker via Redis and answers 202 — the run reaches `cancelled`
     when the worker next checks between steps, which useRunDetail's 2s poll picks up.
     The refetch here only removes that lag. A 409 means the run finished between render
     and click: the user's intent is already satisfied, so say what happened instead of
     showing an error. */
  async function cancelRun() {
    if (!effectiveRunId) return;
    try {
      // No Content-Type and no body: Fastify 400s an empty body when the header claims
      // JSON, and this endpoint takes no payload.
      const res = await fetch(`/api/proxy/runs/${effectiveRunId}/cancel`, { method: 'POST' });
      if (res.status === 202) {
        showToast('Cancelling — the run stops after the current step', 'success');
      } else if (res.status === 200) {
        showToast('That run was already cancelled', 'info');   // idempotent re-cancel
      } else if (res.status === 409) {
        showToast('That run had already finished', 'info');    // passed / failed / healed
      } else {
        showToast('Could not cancel that run', 'error');
      }
    } catch {
      showToast('Could not cancel that run', 'error');
    }
    refetchRun();
  }

  // The case detail is authoritative; caseName is only the label we arrived with.
  const title = detail?.name || caseName || 'Run';

  /* What this run actually executed against, not what the case points at today. The two
     diverge when a run overrides baseUrl, or when the case is edited after the fact —
     showing the case's current URL would misattribute the evidence on screen. */
  const runEnv = (run?.environmentUrl || detail?.baseUrl || '').replace(/^https?:\/\//, '');
  const cancellable = !!run && !TERMINAL_RUN_STATUSES.includes(run.status);

  return (
    <>
      <Toolbar back={onBack} title={title}
        sub={<span className="num">{effectiveRunId ? `#${effectiveRunId.slice(0, 8)} · ` : ''}{runEnv}{run?.triggeredBy ? ` · ${run.triggeredBy}` : ''}</span>}>
        <Seg value={tab} onChange={setTab} options={[
          { value: 'steps', label: 'Steps' }, { value: 'line', label: 'Line' },
          { value: 'activity', label: 'Activity' }, { value: 'history', label: 'History' },
        ]} />
        <button className="btn" onClick={rerun} disabled={rerunning}>
          {rerunning ? <span className="spinner" style={{ width: 11, height: 11 }} /> : <I.play size={12} />}Re-run
        </button>
        <div style={{ position: 'relative' }}>
          <button className="btn icon" onClick={() => setMenu(!menu)}><I.more size={14} /></button>
          {menu && <Menu onClose={() => setMenu(false)} style={{ top: 30, right: 0 }} items={[
            { label: 'Edit steps', icon: 'settings', onClick: () => onEdit && onEdit() },
            { label: 'Refresh now', icon: 'runs', onClick: refetchRun },
            { label: 'Copy run id', icon: 'copy', onClick: () => { if (effectiveRunId) { navigator.clipboard?.writeText(effectiveRunId); showToast('Run id copied', 'success'); } } },
            // Only offered while the run can actually be cancelled — a terminal run gets
            // no affordance at all, rather than one that errors when pressed.
            ...(cancellable ? [{ label: 'Cancel run', icon: 'x', onClick: () => setConfirmCancel(true) }] : []),
          ]} />}
        </div>
      </Toolbar>

      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <div className="scroll" style={{ flex: 1, padding: '16px 20px 40px', minWidth: 0 }}>
          {!effectiveRunId ? (
            <div className="card" style={{ padding: '54px 20px', textAlign: 'center' }}>
              <I.runs size={26} style={{ color: 'var(--text-3)' }} />
              <div style={{ fontSize: 15, fontWeight: 600, marginTop: 10 }}>This test has never run</div>
              <div style={{ fontSize: 13, color: 'var(--text-3)', marginTop: 3, marginBottom: 14 }}>Run it once and every step, selector and screenshot shows up here.</div>
              <button className="btn pri lg" onClick={rerun} disabled={rerunning}><I.play size={13} />Run it now</button>
            </div>
          ) : (
            <>
              <div className="card" style={{ display: 'flex', alignItems: 'center', marginBottom: 14, overflow: 'hidden', flexWrap: 'wrap' }}>
                <div style={{ padding: '13px 17px', display: 'flex', alignItems: 'center', gap: 12, borderRight: '.5px solid var(--sep)', minWidth: 0, flex: '1 1 210px' }}>
                  {!done
                    ? <span className="spinner working" style={{ width: 22, height: 22, borderWidth: 2.4 }} />
                    : <span style={{ width: 26, height: 26, borderRadius: '50%', background: st.s, color: st.c, display: 'grid', placeItems: 'center', flex: 'none' }}>
                        {React.createElement(I[st.icon], { size: 14 })}
                      </span>}
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 15, fontWeight: 600, letterSpacing: '-.01em' }}>
                      {!done
                        ? (status === 'queued' ? 'Queued — waiting for a browser' : `Running step ${Math.min(landed + 1, total)} of ${total}`)
                        : status === 'healed' ? 'Passed, self-healed' : st.label}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 1 }}>
                      {done ? `${landed} steps · ${relWhen(run?.completedAt || run?.createdAt)}` : 'Polling every 2s'}
                    </div>
                  </div>
                </div>
                <div style={{ display: 'flex', flex: '1 1 auto', minWidth: 0 }}>
                  <div style={{ flex: '1 1 148px', minWidth: 0, borderRight: '.5px solid var(--sep)' }}>
                    <Stat label="Duration" value={ms ? fmt.ms(ms) : '—'}
                      sub={done && ms && prev?.durationMs
                        ? (prev.durationMs > ms
                            ? `${fmt.ms(prev.durationMs - ms)} faster than last`
                            : `${fmt.ms(ms - prev.durationMs)} slower than last`)
                        : run?.durationMs != null ? 'wall clock' : 'steps so far'} />
                  </div>
                  <div style={{ flex: '1 1 148px', minWidth: 0, borderRight: '.5px solid var(--sep)' }}>
                    <Stat label="Tokens spent" value={fmt.n(tokens)} tone={tokens ? 'var(--warn)' : 'var(--cache)'}
                      sub={prev?.totalTokens != null
                        ? `was ${fmt.n(prev.totalTokens)} last run`
                        : tokens ? 'this run' : lookupSteps ? 'all from memory' : 'nothing yet'} />
                  </div>
                  <div className="hide-md" style={{ flex: '1 1 148px', minWidth: 0, borderRight: '.5px solid var(--sep)' }}>
                    <Stat label="From memory" value={lookupSteps ? `${cacheSteps}/${lookupSteps}` : '—'} tone="var(--cache)" sub={lookupSteps ? 'needed no AI' : 'no lookups yet'} />
                  </div>
                  <div className="hide-lg" style={{ flex: 'none', width: 150, padding: '13px 15px' }}>
                    <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-3)' }}>Progress</div>
                    <div className="meter" style={{ marginTop: 9 }}><i style={{ width: `${landed / total * 100}%`, background: st.c }} /></div>
                    <div className="num" style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 6 }}>{landed}/{total} steps</div>
                  </div>
                </div>
              </div>

              {status === 'healed' && done && tab !== 'line' && (
                <div className="card rise" style={{ display: 'flex', gap: 11, alignItems: 'flex-start', padding: '12px 15px', marginBottom: 14, background: 'var(--heal-soft)', boxShadow: 'none' }}>
                  <I.heal size={15} style={{ color: 'var(--heal)', marginTop: 1, flex: 'none' }} />
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>A step healed itself, so nobody has to fix this test</div>
                    <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 3, lineHeight: 1.5 }}>
                      Kaizen re-found the element, re-learned the selector, and the run passed. The next run resolves it from memory.
                    </div>
                  </div>
                  <button className="btn" style={{ flex: 'none', marginLeft: 'auto' }}
                    onClick={() => { const h = rows.find((r) => r.status === 'healed'); if (h?.sr) { setTab('steps'); setSelId(h.sr.id); } }}>
                    See the step
                  </button>
                </div>
              )}

              {tab === 'steps' && (
                <div className="list">
                  <div className="list-h"><span style={{ flex: 1 }}>STEPS · IN ORDER, STOPS ON FIRST UNHEALED FAILURE</span><span className="num">{landed}/{total}</span></div>
                  {rows.map((r) => (
                    <StepRow key={r.sr?.id ?? `p${r.i}`} row={r} sel={selId === r.sr?.id} onSelect={() => r.sr && setSelId(r.sr.id)} />
                  ))}
                  {!rows.length && <div style={{ padding: '34px 16px', textAlign: 'center', fontSize: 13, color: 'var(--text-3)' }}>Waiting for the first step…</div>}
                </div>
              )}
              {tab === 'line' && (
                <LineView live={!done} sel={selRow?.i ?? null}
                  onSelect={(i) => { const r = rows.find((x) => x.i === i); if (r?.sr) setSelId(r.sr.id); }}
                  steps={rows.map((r) => ({
                    i: r.i,
                    verb: verbOf(r.text),
                    source: r.sr?.resolutionSource ? SOURCE_OF[r.sr.resolutionSource] ?? null : null,
                    tokens: r.sr?.tokens ?? 0,
                    healed: r.status === 'healed',
                    failed: r.status === 'failed' || r.status === 'cancelled',
                    landed: r.landed,
                  }))} />
              )}
              {tab === 'activity' && <ActivityFeed rows={rows} />}
              {tab === 'history' && (
                <HistoryTab runs={detail?.recentRuns ?? []} activeRunId={effectiveRunId}
                  onOpen={(id) => { setRunId(id); setSelId(null); setTab('steps'); }} />
              )}
            </>
          )}
        </div>

        {/* The line view is the full-width story; the inspector would crowd it out. */}
        {tab !== 'history' && tab !== 'line' && selRow?.sr && (
          <Inspector sr={selRow.sr} text={selRow.text} runId={effectiveRunId}
            onVerdict={refetchRun} showToast={showToast} />
        )}
      </div>

      {payoff && <RunCompleteHUD payoff={payoff} onClose={() => setPayoff(null)} />}

      {confirmCancel && (
        <ConfirmSheet title="Cancel this run?"
          message="The run stops after the step it's on. Steps that already finished keep their results and screenshots; the rest never execute."
          confirmLabel="Cancel run"
          dismissLabel="Keep running"
          onConfirm={cancelRun}
          onClose={() => setConfirmCancel(false)} />
      )}
    </>
  );
}
