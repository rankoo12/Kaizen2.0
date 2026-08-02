'use client';
/* The Brain — design markup from `Kaizen (1)/native/screen-brain.jsx`, reading the real
   selector memory (GET /brain/selectors → selector_cache).

   Read-only by design. The design had Pin / Block / Promote buttons on every row; the
   only write the backend actually supports is the per-step verdict, which lives on the
   run's step inspector (PATCH /runs/:id/steps/:id/verdict) and is wired there. Rather
   than fake three buttons here, each row links back to the step that taught it.
   Also dropped: the "was X% a month ago" comparison — nothing records cache-hit history. */
/* eslint-disable @typescript-eslint/no-explicit-any */
import * as React from 'react';
import { I } from './icons';
import { Toolbar, Seg, Stat, Ring } from './chrome';
import { fmt, SOURCES } from './data';
import { useAuth } from '@/context/auth-context';

const { useState: uSb, useEffect: uEb, useMemo: uMb } = React;

type Entry = {
  id: string;
  intent: string | null;
  domain: string;
  selector: string | null;
  strategy: string | null;
  selectorCount: number;
  confidence: number;
  scope: 'tenant' | 'global';
  uses: number;
  ok: number;
  failCountWindow: number;
  pinned: boolean;
  lastVerifiedAt: string | null;
  lastFailedAt: string | null;
  updatedAt: string;
  // Provenance. Null on shared entries no step of this workspace has used yet.
  caseId: string | null;
  caseName: string | null;
  suiteName: string | null;
  lastRunId: string | null;
  lastStepResultId: string | null;
  lastUsedAt: string | null;
  /** resolution_source of the FIRST time this target was resolved. */
  learnedVia: string | null;
  learnedAt: string | null;
  caseCount: number;
};

function relWhen(iso?: string | null): string {
  if (!iso) return 'never';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24); if (d === 1) return 'yesterday'; if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

/** The tier that first produced this selector, in the run screen's vocabulary. */
const LEARNED_VIA: Record<string, string> = {
  archetype: 'pattern', redis: 'cache', db_exact: 'cache',
  pgvector_step: 'vector', pgvector_element: 'global', llm: 'llm',
};

function SourceChip({ source }: { source: string }) {
  const s = SOURCES[LEARNED_VIA[source] ?? ''];
  if (!s) return <span className="num" style={{ fontSize: 11, color: 'var(--text-3)' }}>{source}</span>;
  return (
    <span className="badge" title={s.note} style={{ background: 'var(--fill)', color: s.color, gap: 5 }}>
      <span className="dot" style={{ width: 5, height: 5, background: s.color }} />{s.short}
    </span>
  );
}

/** Confidence reads as a number, not a bar — the value carries the meaning and the
 *  colour carries the verdict; a meter beside it was duplicating both. */
function Confidence({ v }: { v: number }) {
  const c = v >= .9 ? 'var(--pass)' : v >= .75 ? 'var(--warn)' : 'var(--fail)';
  return <span className="num" style={{ fontSize: 13, color: c, fontWeight: 600 }}>{v ? v.toFixed(2) : '—'}</span>;
}

/** An entry is worth a human's attention only while its confidence is still below the
 *  bar and nobody has vouched for it.
 *
 *  Two things it deliberately does NOT consider:
 *  · fail_count_window — the resolver only ever increments it (it never resets on a
 *    success despite the name), so once an entry had a single bad run it would ask for
 *    review forever, even after a dozen clean ones.
 *  · past failures in general — confidence is already recomputed from the outcome
 *    window on every run, so recovery raises it and the flag clears by itself.
 *  A pin is a human saying "this one is right", which settles the question outright. */
const REVIEW_THRESHOLD = 0.75;
const needsReview = (b: Entry) => !b.pinned && b.confidence < REVIEW_THRESHOLD;

function BrainRow({ b, open, onToggle, onOpenStep }: { b: Entry; open: boolean; onToggle: () => void; onOpenStep?: OpenStep }) {
  const shaky = needsReview(b);
  return (
    <>
      <div className="row" onClick={onToggle} style={{ background: open ? 'var(--fill)' : undefined }}>
        <span style={{ width: 15, flex: 'none', display: 'grid', color: 'var(--text-3)' }}>
          {open ? <I.chevronDown size={12} /> : <I.chevron size={12} />}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="row-t" title={b.intent ?? undefined} style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {b.intent ?? (
                <span style={{ color: 'var(--text-3)', fontStyle: 'italic' }}>
                  {b.scope === 'global' ? 'ready, unused' : 'step since deleted'}
                </span>
              )}
            </span>
            {b.pinned && <I.pin size={11} style={{ color: 'var(--pass)', flex: 'none' }} />}
            {shaky && <span className="badge" style={{ background: 'var(--warn-soft)', color: 'var(--warn)', flex: 'none' }}>NEEDS REVIEW</span>}
          </div>
          <div className="row-s num" title={b.selector ?? undefined} style={{ marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.selector ?? '—'}</div>
          {/* Which test taught this — the first thing you want when a selector looks wrong. */}
          {b.caseName && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 3, fontSize: 11, color: 'var(--text-3)', minWidth: 0 }}>
              <I.tests size={10} style={{ flex: 'none' }} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.caseName}</span>
              {b.caseCount > 1 && <span className="num" style={{ flex: 'none' }}>+{b.caseCount - 1} more</span>}
            </div>
          )}
        </div>
        <span className="num hide-md" style={{ width: 140, flex: 'none', fontSize: 11, color: 'var(--text-3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.domain}</span>
        <span style={{ width: 96, flex: 'none' }}>
          <span className="badge" style={{ background: b.scope === 'global' ? 'var(--accent-soft)' : 'var(--fill)', color: b.scope === 'global' ? 'var(--accent-text)' : 'var(--text-2)' }}>
            {b.scope === 'global' ? <I.cloud size={9} /> : <I.db size={9} />}{b.scope === 'global' ? 'GLOBAL' : 'WORKSPACE'}
          </span>
        </span>
        <span style={{ width: 104, flex: 'none' }}><Confidence v={b.confidence} /></span>
        <span className="num" style={{ width: 78, flex: 'none', textAlign: 'right', fontSize: 12 }}>{fmt.n(b.uses)}</span>
        <span className="num hide-lg" style={{ width: 66, flex: 'none', textAlign: 'right', fontSize: 11, color: 'var(--text-3)' }}>{relWhen(b.lastVerifiedAt)}</span>
      </div>
      {open && (
        <div style={{ padding: '13px 16px 15px 42px', background: 'var(--content-2)', borderTop: '.5px solid var(--sep)', display: 'flex', gap: 22, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <div style={{ minWidth: 240, flex: 1 }}>
            <div className="label">Selector Kaizen learned</div>
            <div className="num" style={{ fontSize: 12, background: 'var(--fill)', padding: '8px 10px', borderRadius: 7, marginTop: 5, wordBreak: 'break-all' }}>{b.selector ?? '—'}</div>
            <div style={{ display: 'flex', gap: 20, marginTop: 13, flexWrap: 'wrap' }}>
              <div>
                <div className="label">Outcomes</div>
                <div className="num" style={{ fontSize: 13, marginTop: 3 }}>{fmt.n(b.ok)} good · {fmt.n(b.uses - b.ok)} bad</div>
              </div>
              <div>
                <div className="label">Success rate</div>
                <div className="num" style={{ fontSize: 13, marginTop: 3, color: b.uses && b.ok / b.uses > .95 ? 'var(--pass)' : 'var(--warn)' }}>
                  {b.uses ? fmt.pct(b.ok / b.uses * 100) : '—'}
                </div>
              </div>
              <div>
                <div className="label">Last failure</div>
                <div className="num" style={{ fontSize: 13, marginTop: 3, color: b.lastFailedAt ? 'var(--warn)' : 'var(--text-2)' }}>{relWhen(b.lastFailedAt)}</div>
              </div>
            </div>
          </div>
          {/* Where it came from — the step that named it, the test it belongs to, and how
              it was first found. All of it real: the step text is recovered through
              step_results.target_hash, and learnedVia is the resolution_source of the
              earliest run that resolved this target. */}
          <div style={{ flex: '1 1 260px', minWidth: 240 }}>
            <div className="label">Where it came from</div>
            {b.intent ? (
              <>
                <div style={{ fontSize: 13, marginTop: 5, lineHeight: 1.45 }}>{b.intent}</div>
                {b.caseName && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, fontSize: 12, color: 'var(--text-2)', flexWrap: 'wrap' }}>
                    <I.tests size={11} style={{ flex: 'none', color: 'var(--text-3)' }} />
                    <span>{b.caseName}</span>
                    {b.suiteName && <span style={{ color: 'var(--text-3)' }}>· {b.suiteName}</span>}
                  </div>
                )}
                <div style={{ display: 'flex', gap: 20, marginTop: 12, flexWrap: 'wrap' }}>
                  <div>
                    <div className="label">First learned</div>
                    <div style={{ fontSize: 13, marginTop: 3, display: 'flex', alignItems: 'center', gap: 6 }}>
                      {b.learnedVia ? <SourceChip source={b.learnedVia} /> : <span className="num" style={{ color: 'var(--text-3)' }}>—</span>}
                      <span className="num" style={{ fontSize: 11, color: 'var(--text-3)' }}>{relWhen(b.learnedAt)}</span>
                    </div>
                  </div>
                  <div>
                    <div className="label">Last used</div>
                    <div className="num" style={{ fontSize: 13, marginTop: 3 }}>{relWhen(b.lastUsedAt)}</div>
                  </div>
                  <div>
                    <div className="label">Tests relying on it</div>
                    <div className="num" style={{ fontSize: 13, marginTop: 3 }}>{b.caseCount || '—'}</div>
                  </div>
                </div>
                {/* Straight to the step that used it — the evidence you want the moment a
                    selector looks wrong. */}
                {onOpenStep && b.caseId && b.lastRunId && (
                  <button className="btn" style={{ marginTop: 12 }}
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpenStep(b.caseId!, b.lastRunId, b.lastStepResultId, b.caseName ?? 'Run');
                    }}>
                    <I.runs size={12} />Open the step that used it
                  </button>
                )}
              </>
            ) : (
              <div style={{ fontSize: 12.5, color: 'var(--text-3)', marginTop: 5, lineHeight: 1.5 }}>
                {b.scope === 'global'
                  ? 'No step in this workspace has used it yet — it is waiting in the shared pool for this site.'
                  : 'The step that taught this has since been deleted. The entry survives because the site has not changed.'}
              </div>
            )}
          </div>
          <div style={{ flex: 'none', width: 230, fontSize: 12, color: 'var(--text-3)', lineHeight: 1.55 }}>
            {b.strategy && <div style={{ marginBottom: 7 }}>Found by <span className="num" style={{ color: 'var(--text-2)' }}>{b.strategy}</span>.</div>}
            {b.scope === 'global'
              ? 'Shared across every workspace for this site. Verified before it was promoted.'
              : 'Private to this workspace.'}
            {b.pinned
              ? ' A human pinned it, so healing and fresh AI resolution never overwrite it.'
              : ' Pin or block it from the step that used it, on any run.'}
          </div>
        </div>
      )}
    </>
  );
}

export type OpenStep = (caseId: string, runId: string | null, stepResultId: string | null, caseName: string) => void;

export function BrainScreen({ onOpenStep }: { onOpenStep?: OpenStep }) {
  const { user } = useAuth();
  const [entries, setEntries] = uSb<Entry[]>([]);
  const [loading, setLoading] = uSb(true);
  const [scope, setScope] = uSb('all');
  const [q, setQ] = uSb('');
  const [open, setOpen] = uSb<string | null>(null);

  uEb(() => {
    if (!user?.id) return;
    fetch('/api/proxy/brain/selectors?limit=300', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((b) => setEntries(b.entries ?? []))
      .catch(() => setEntries([]))
      .finally(() => setLoading(false));
  }, [user?.id]);

  const rows = uMb(() => entries.filter((b) => {
    if (scope === 'tenant' && b.scope !== 'tenant') return false;
    if (scope === 'global' && b.scope !== 'global') return false;
    if (scope === 'review' && !needsReview(b)) return false;
    if (q && !`${b.intent ?? ''} ${b.selector ?? ''} ${b.domain}`.toLowerCase().includes(q.toLowerCase())) return false;
    return true;
  }), [entries, scope, q]);

  const uses = entries.reduce((a, b) => a + b.uses, 0);
  const ok = entries.reduce((a, b) => a + b.ok, 0);
  const hit = uses ? Math.round(ok / uses * 100) : 0;
  const scored = entries.filter((b) => b.uses > 0);
  const avgConf = scored.length ? scored.reduce((a, b) => a + b.confidence, 0) / scored.length : 0;

  return (
    <>
      <Toolbar title="The Brain" sub="Every element Kaizen has learned, and how much it stops you paying">
        <div style={{ position: 'relative', width: 200 }} className="hide-narrow">
          <I.search size={13} style={{ position: 'absolute', left: 9, top: 8.5, color: 'var(--text-3)' }} />
          <input className="field" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search what it knows" style={{ height: 28, paddingLeft: 27, fontSize: 13 }} />
        </div>
        <Seg value={scope} onChange={setScope} options={[
          { value: 'all', label: 'All' }, { value: 'tenant', label: 'Workspace' },
          { value: 'global', label: 'Global' }, { value: 'review', label: 'Needs review' },
        ]} />
      </Toolbar>

      <div className="scroll" style={{ flex: 1, padding: '18px 22px 40px' }}>
        <div className="card rise" style={{ display: 'flex', alignItems: 'center', marginBottom: 16, overflow: 'hidden', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 13, padding: '13px 18px', borderRight: '.5px solid var(--sep)', flex: '1 1 300px' }}>
            <Ring value={hit} label={`${hit}%`} sub="Reliable" color="var(--cache)" size={64} />
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 15, fontWeight: 600, letterSpacing: '-.015em' }}>
                {uses ? `${hit}% of recalls worked first time` : 'Nothing learned yet'}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 2, lineHeight: 1.45 }}>
                {uses
                  ? `${fmt.n(ok)} of ${fmt.n(uses)} remembered resolutions held up. The rest triggered healing.`
                  : 'Run a test and every element it finds is written here.'}
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', flex: '1 1 auto', minWidth: 0 }}>
            <div style={{ flex: '1 1 148px', minWidth: 0, borderRight: '.5px solid var(--sep)' }}>
              <Stat label="Learned elements" icon="brain" value={entries.length}
                sub={`${entries.filter((b) => b.scope === 'global').length} from the global brain`} />
            </div>
            <div style={{ flex: '1 1 148px', minWidth: 0, borderRight: '.5px solid var(--sep)' }}>
              <Stat label="Avg confidence" icon="target" value={avgConf ? avgConf.toFixed(2) : '—'} sub="entries that have been used" />
            </div>
            <div style={{ flex: '1 1 148px', minWidth: 0 }}>
              <Stat label="Recalls" icon="sparkle" value={fmt.k(uses)} tone="var(--cache)" sub="times it answered from memory" />
            </div>
          </div>
        </div>

        <div className="list">
          <div className="list-h">
            <span style={{ width: 15 }} /><span style={{ flex: 1 }}>WHAT IT MEANS · SELECTOR</span>
            <span className="hide-md" style={{ width: 140 }}>SITE</span><span style={{ width: 96 }}>SCOPE</span>
            {/* "Recalls" everywhere: this column and the header stat count the same
                thing (times the entry answered from memory), so they share a name. */}
            <span style={{ width: 104 }}>CONFIDENCE</span><span style={{ width: 78, textAlign: 'right' }}>RECALLS</span>
            <span className="hide-lg" style={{ width: 66, textAlign: 'right' }}>VERIFIED</span>
          </div>
          {rows.map((b) => (
            <BrainRow key={b.id} b={b} open={open === b.id} onOpenStep={onOpenStep}
              onToggle={() => setOpen(open === b.id ? null : b.id)} />
          ))}
          {!rows.length && (
            <div style={{ padding: '48px 16px', textAlign: 'center' }}>
              <I.brain size={24} style={{ color: 'var(--text-3)' }} />
              <div style={{ fontSize: 14, fontWeight: 600, marginTop: 9 }}>
                {loading ? 'Reading the brain…' : entries.length ? 'Nothing matches' : 'The brain is empty'}
              </div>
              {!loading && !entries.length && (
                <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 4, lineHeight: 1.5, maxWidth: 380, margin: '4px auto 0' }}>
                  Every element a run resolves gets written here with its selector, its confidence and its
                  track record. Run a test and this fills up.
                </div>
              )}
            </div>
          )}
        </div>

        <div style={{ display: 'flex', gap: 9, alignItems: 'flex-start', marginTop: 14, padding: '0 4px' }}>
          <I.info size={13} style={{ color: 'var(--text-3)', marginTop: 2, flex: 'none' }} />
          <div style={{ fontSize: 12, color: 'var(--text-3)', lineHeight: 1.55, maxWidth: 660 }}>
            Kaizen resolves cheapest-first: known patterns, then this workspace&rsquo;s cache, then similarity search over past
            resolutions, then the global brain of verified selectors, and only then the AI. Every success is written back here.
          </div>
        </div>
      </div>
    </>
  );
}
