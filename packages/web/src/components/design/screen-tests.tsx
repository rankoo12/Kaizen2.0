'use client';
/* Tests screen — design markup from `Kaizen (1)/native/screen-tests.jsx`, now driven by
   REAL data passed in via props (cases/suites/stats from useDesignData). Fields the API
   does not expose (per-case cache %, step count, CI flag) are omitted rather than faked. */
/* eslint-disable @typescript-eslint/no-explicit-any */
import * as React from 'react';
import { I, StatusBadge } from './icons';
import { Toolbar, Seg, Stat, Ring, Menu, ConfirmSheet } from './chrome';
import { AppBriefCard } from './app-brief-card';
import { fmt } from './data';
import type { DesignCase, DesignSuite } from './use-design-data';

const { useState: uSt, useMemo: uM, useEffect: uEt, useRef: uRt } = React;

function CaseRow({ c, sel, onSelect, onOpen, onRun, onEdit, onDelete, rowRef, onAccept, onProof }: any) {
  const [menu, setMenu] = uSt(false);
  const stop = (e: any) => e.stopPropagation();
  const cost = c.lastCost == null ? '—' : c.lastCost === 0 ? 'free' : fmt.k(c.lastCost);
  const isDraft = c.caseStatus === 'draft';
  const isProving = c.caseStatus === 'validating';
  const generated = c.origin === 'generated';
  return (
    <div className={`row focus-row${sel ? ' sel' : ''}`} ref={rowRef} tabIndex={0}
      style={{ padding: '11px 14px' }}
      onClick={onSelect} onDoubleClick={onOpen}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onOpen(); } }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="row-t" title={c.name} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {/* Provenance never fades: a test Kaizen wrote keeps its mark after it
              has been accepted, so "who wrote this" stays answerable. */}
          {generated && (
            <I.sparkle size={11} style={{ color: 'var(--accent)', flex: 'none' }}
              aria-label="Written by Kaizen" />
          )}
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</span>
          {isDraft && <span className="badge" style={{ color: 'var(--accent)', fontSize: 10, flex: 'none' }}>DRAFT</span>}
          {isProving && <span className="badge" style={{ color: 'var(--idle)', fontSize: 10, flex: 'none' }}>PROVING</span>}
        </div>
        <div className="row-s">
          <span className="num">{c.baseUrl.replace(/^https?:\/\//, '')}</span>
          {/* Omitted entirely when unknown — a pre-030 case has no author, and "Unknown"
              would read as a person rather than an absent record. */}
          {c.author && <><span style={{ margin: '0 6px', color: 'var(--text-3)' }}>·</span>{c.author}</>}
        </div>
      </div>
      {/* From memory: the share of this case's lookups that avoided the model. Blank when
          nothing has been looked up yet — 0% would claim a measurement we don't have. */}
      <div className="num hide-md" style={{ width: 66, flex: 'none', textAlign: 'right', fontSize: 12, fontWeight: 600,
        color: c.cacheHitPct == null ? 'var(--text-3)' : c.cacheHitPct === 100 ? 'var(--cache)' : 'var(--text-2)' }}
        title={c.cacheHitPct == null ? 'No element lookups yet' : `${c.cacheHitPct}% of lookups came from memory`}>
        {c.cacheHitPct == null ? '—' : `${c.cacheHitPct}%`}
      </div>
      <div className="num" style={{ width: 74, flex: 'none', textAlign: 'right', fontSize: 12, fontWeight: 600, color: c.lastCost === 0 || c.lastCost == null ? 'var(--text-2)' : 'var(--text)' }}
        title={c.firstRunTokens != null && c.runCount > 1
          ? `First run cost ${c.firstRunTokens} tokens to learn; latest cost ${c.lastCost ?? 0}`
          : undefined}>
        {cost}
      </div>
      <div style={{ width: 82, flex: 'none' }}><StatusBadge status={c.status} size="sm" /></div>
      <div className="num" style={{ width: 70, flex: 'none', fontSize: 11, color: 'var(--text-2)', textAlign: 'right' }}>{c.lastRun || 'never'}</div>

      <div className="row-actions" style={{ display: 'flex', gap: 4, flex: 'none', position: 'relative' }} onClick={stop} onDoubleClick={stop}>
        {/* A draft is a proposal, not part of the suite yet — the backend refuses
            to run it, so the row offers acceptance instead and teaches why. */}
        {isDraft ? (
          <>
            {c.validationRunId && (
              <button className="btn" title="See the run that proved it"
                onClick={() => onProof?.(c)}>Proof</button>
            )}
            <button className="btn" onClick={() => onAccept?.(c)}>Accept</button>
          </>
        ) : (
          <button className="btn icon ghost" title="Run now (⌘R)" onClick={onRun} disabled={isProving}>
            <I.play size={12} />
          </button>
        )}
        <button className="btn icon ghost" onClick={() => setMenu(!menu)}><I.more size={14} /></button>
        {menu && <Menu onClose={() => setMenu(false)} style={{ top: 26, right: 0 }} items={[
          ...(isDraft ? [
            { label: 'Accept into the suite', icon: 'check', onClick: () => onAccept?.(c) },
          ] : [
            { label: 'Open latest run', icon: 'runs', hint: '⏎', onClick: onOpen },
            { label: 'Run now', icon: 'play', hint: '⌘R', onClick: onRun },
          ]),
          { label: 'Edit steps', icon: 'settings', onClick: onEdit },
          '-',
          { label: 'Delete test', icon: 'trash', danger: true, onClick: onDelete },
        ]} />}
      </div>
    </div>
  );
}

export function TestsScreen({ cases, suites, stats, onOpen, onNew, onRun, onEdit, onDelete, suiteFilter, onClearSuite, group = true, showToast, onAnalyze, onAcceptDraft, onOpenProof, pendingDelivery, onOpenDelivery }: {
  cases: DesignCase[]; suites: DesignSuite[]; stats: any;
  onOpen: (c: DesignCase) => void; onNew: () => void; onRun: (c: DesignCase) => void;
  onEdit: (c: DesignCase) => void; onDelete?: (c: DesignCase) => void;
  suiteFilter: string | null; onClearSuite: () => void; group?: boolean; showToast?: any;
  /** Opens the analyze dialog — absent in contexts where generation isn't offered. */
  onAnalyze?: () => void;
  onAcceptDraft?: (c: DesignCase) => void;
  onOpenProof?: (c: DesignCase) => void;
  /** The job that most needs the user: awaiting approval, in flight, or delivered. */
  pendingDelivery?: {
    jobId: string; suiteId: string; status: string; count: number; pagesCrawled?: number | null;
  } | null;
  onOpenDelivery?: () => void;
}) {
  const [q, setQ] = uSt('');
  const [filter, setFilter] = uSt('all');
  const [selId, setSelId] = uSt<string | null>(null);
  const [confirmDel, setConfirmDel] = uSt<any>(null);
  const refs = uRt<Record<string, any>>({});

  const list = uM(() => cases.filter((c) => {
    if (suiteFilter && c.suiteId !== suiteFilter) return false;
    if (filter === 'failing' && !(c.status === 'failed' || c.status === 'cancelled')) return false;
    if (filter === 'healed' && c.status !== 'healed') return false;
    if (filter === 'passed' && c.status !== 'passed') return false;
    if (filter === 'drafts' && c.caseStatus !== 'draft' && c.caseStatus !== 'validating') return false;
    if (q && !(`${c.name} ${c.suiteName} ${c.baseUrl} ${c.author}`.toLowerCase().includes(q.toLowerCase()))) return false;
    return true;
  }), [cases, q, filter, suiteFilter]);

  // The Drafts filter appears only when there is something to filter to — a
  // workspace that has never used the writer keeps its original toolbar.
  const draftCount = uM(
    () => cases.filter((c) => c.caseStatus === 'draft' || c.caseStatus === 'validating').length,
    [cases],
  );

  uEt(() => {
    const h = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      // ⌘R runs the selected test — the shortcut the footer hint advertises.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'r') {
        const c = list.find((x) => x.id === selId);
        if (!c) return;
        e.preventDefault();
        onRun(c);
        return;
      }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      const i = list.findIndex((c) => c.id === selId);
      const next = e.key === 'ArrowDown' ? Math.min(i + 1, list.length - 1) : Math.max(i - 1, 0);
      const c = list[i === -1 ? 0 : next];
      if (c) { setSelId(c.id); const el = refs.current[c.id]; if (el) el.focus({ preventScroll: false }); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [list, selId, onRun]);

  const suite = suiteFilter ? suites.find((s) => s.id === suiteFilter) : null;
  const groups = group && !suiteFilter
    ? suites.map((s) => ({ s, items: list.filter((c) => c.suiteId === s.id) })).filter((g) => g.items.length)
    : [{ s: suite, items: list }];
  const green = stats.total ? Math.round((stats.pass + stats.healed) / stats.total * 100) : 0;

  return (
    <>
      <Toolbar title={suite ? suite.name : 'Tests'} sub={suite ? suite.desc : `${cases.length} tests across ${suites.length} suites`}
        back={suite ? onClearSuite : null}>
        <div style={{ position: 'relative', width: 208 }} className="hide-narrow">
          <I.search size={13} style={{ position: 'absolute', left: 9, top: 8.5, color: 'var(--text-3)' }} />
          <input className="field" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search tests"
            style={{ height: 28, paddingLeft: 27, fontSize: 13 }} />
        </div>
        <Seg value={filter} onChange={setFilter} options={[
          { value: 'all', label: 'All' }, { value: 'failing', label: 'Failing' },
          { value: 'healed', label: 'Healed' }, { value: 'passed', label: 'Passed' },
          ...(draftCount ? [{ value: 'drafts', label: `Drafts ${draftCount}` }] : []),
        ]} />
        {onAnalyze && (
          <button className="btn" onClick={onAnalyze} title="Have Kaizen explore your app and propose tests">
            <I.sparkle size={13} />Analyze
          </button>
        )}
        <button className="btn pri" onClick={onNew}><I.plus size={13} />New Test</button>
      </Toolbar>

      <div className="scroll" style={{ flex: 1, padding: '18px 22px 40px' }}>
        {/* The "you were gone when it finished" catch-all: a job that needs the
            user is surfaced where they actually are, not only in the writer. */}
        {pendingDelivery && (
          <button className="card rise" onClick={onOpenDelivery}
            style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left',
              padding: '12px 16px', marginBottom: 14, cursor: 'pointer', border: '.5px solid var(--accent-soft)' }}>
            {pendingDelivery.status === 'running' || pendingDelivery.status === 'queued'
              ? <span className="spinner" style={{ width: 13, height: 13, flex: 'none' }} />
              : <I.sparkle size={14} style={{ color: 'var(--accent)', flex: 'none' }} />}
            <span style={{ flex: 1, fontSize: 12.5 }}>
              {pendingDelivery.status === 'awaiting_plan_approval'
                ? 'A test plan is ready for your approval.'
                : pendingDelivery.status === 'queued'
                  ? 'Kaizen is starting up an analysis.'
                  : pendingDelivery.status === 'running'
                    ? `Kaizen is exploring your app${pendingDelivery.pagesCrawled ? ` — ${pendingDelivery.pagesCrawled} pages so far` : ''}.`
                    : pendingDelivery.count > 0
                      ? `${pendingDelivery.count} proven ${pendingDelivery.count === 1 ? 'test is' : 'tests are'} waiting for review.`
                      : 'Your last analysis proposed nothing — the reasons are in its report.'}
            </span>
            <span className="btn">
              {pendingDelivery.status === 'awaiting_plan_approval' ? 'Review the plan'
                : pendingDelivery.status === 'running' || pendingDelivery.status === 'queued' ? 'View progress'
                  : pendingDelivery.count > 0 ? 'Review delivery' : 'See why'}
            </span>
          </button>
        )}

        {/* Scoped to a single suite: the brief describes ONE app, so it would be
            meaningless over a mixed list. */}
        {suiteFilter && <AppBriefCard suiteId={suiteFilter} onReanalyze={onAnalyze} />}

        <div className="card rise" style={{ display: 'flex', alignItems: 'stretch', marginBottom: 16, overflow: 'hidden', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 18px', borderRight: '.5px solid var(--sep)', flex: '1 1 300px', minWidth: 0 }}>
            <Ring value={green} label={`${green}%`} sub="Green" size={64} />
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 15, fontWeight: 600, letterSpacing: '-.015em' }}>Suite health</div>
              <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 3, lineHeight: 1.4 }}>
                {stats.pass} passed clean, {stats.healed} healed themselves, {stats.fail} need a human.
              </div>
            </div>
          </div>
          <button className={stats.fail ? 'hazard' : undefined} onClick={() => setFilter('failing')} style={{ flex: '1 1 170px', minWidth: 0, border: 'none', background: 'none', textAlign: 'left', cursor: 'pointer', borderRight: '.5px solid var(--sep)', padding: 0 }}>
            <Stat label="Needs a human" icon="x" value={stats.fail} tone="var(--fail)" sub="tap to filter" />
          </button>
          <div style={{ flex: '1 1 170px', minWidth: 0, borderRight: '.5px solid var(--sep)' }}>
            <Stat label="Self-healed" icon="heal" value={stats.healed} tone="var(--heal)" sub="no one fixed a selector" />
          </div>
          <div style={{ flex: '1 1 170px', minWidth: 0 }}>
            <Stat label="From memory" icon="db" value={stats.ran ? `${stats.fromMemory}%` : '—'} sub={stats.ran ? 'of last runs cost 0 tokens' : 'no runs yet'} />
          </div>
        </div>

        {list.length > 0 && (
          <div className="list-h" style={{ background: 'transparent', borderBottom: 'none', padding: '0 14px 5px' }}>
            <span style={{ flex: 1 }}>TEST</span>
            <span className="hide-md" style={{ width: 66, textAlign: 'right' }}>MEMORY</span>
            <span style={{ width: 74, textAlign: 'right' }}>COST · TOK</span>
            <span style={{ width: 82 }}>STATUS</span>
            <span style={{ width: 70, textAlign: 'right' }}>LAST RUN</span>
            <span style={{ width: 56 }} />
          </div>
        )}
        {groups.map(({ s, items }: any, gi: number) => (
          <div key={s ? s.id : 'all'} style={{ marginBottom: 18 }}>
            {group && !suiteFilter && s && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 4px 7px' }}>
                {React.createElement(I[s.icon] || I.suites, { size: 13, style: { color: 'var(--text-3)' } })}
                <span style={{ fontSize: 13, fontWeight: 600 }}>{s.name}</span>
                <span className="num" style={{ fontSize: 11, color: 'var(--text-3)' }}>{items.length}</span>
                {s.desc && <span style={{ fontSize: 12, color: 'var(--text-3)' }}>· {s.desc}</span>}
              </div>
            )}
            <div className="list rise" style={{ animationDelay: `${gi * 40}ms` }}>
              {items.map((c: DesignCase) => (
                <CaseRow key={c.id} c={c} sel={selId === c.id}
                  rowRef={(el: any) => { refs.current[c.id] = el; }}
                  onSelect={() => setSelId(c.id)}
                  onOpen={() => onOpen(c)} onRun={() => onRun(c)}
                  onEdit={() => onEdit(c)}
                  onAccept={onAcceptDraft} onProof={onOpenProof}
                  onDelete={() => setConfirmDel(c)} />
              ))}
            </div>
          </div>
        ))}

        {/* A brand-new workspace leads with the capability, not the chore: this is
            the onboarding moment where Kaizen shows what it is. A filtered-empty
            list keeps the plain message — nothing to sell there. */}
        {!list.length && !cases.length && onAnalyze ? (
          <div className="card" style={{ padding: '48px 20px', textAlign: 'center' }}>
            <I.sparkle size={26} style={{ color: 'var(--accent)' }} />
            <div style={{ fontSize: 16, fontWeight: 600, marginTop: 10 }}>
              Your suite is empty. Kaizen isn&apos;t.
            </div>
            <div style={{ fontSize: 13, color: 'var(--text-2)', marginTop: 8, marginBottom: 18,
              lineHeight: 1.6, maxWidth: 470, marginLeft: 'auto', marginRight: 'auto' }}>
              Point Kaizen at your app. It explores it like a QA engineer on day one, writes a
              test plan for your approval, and proves every test with a real run — before you
              accept a single one.
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
              <button className="btn pri lg" onClick={onAnalyze}><I.sparkle size={13} />Analyze my app</button>
              <button className="btn lg" onClick={onNew}>Write a test yourself</button>
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 16, lineHeight: 1.5 }}>
              Takes a few minutes · read-only exploration · you approve the plan before
              anything is executed
            </div>
          </div>
        ) : !list.length && (
          <div className="card" style={{ padding: '54px 20px', textAlign: 'center' }}>
            <I.tests size={26} style={{ color: 'var(--text-3)' }} />
            <div style={{ fontSize: 15, fontWeight: 600, marginTop: 10 }}>{cases.length ? 'No tests match' : 'No tests yet'}</div>
            <div style={{ fontSize: 13, color: 'var(--text-3)', marginTop: 3, marginBottom: 14 }}>
              {cases.length ? 'Try a different filter, or write a new test in plain English.' : 'Write your first test in plain English.'}
            </div>
            <button className="btn pri lg" onClick={onNew}><I.plus size={13} />New Test</button>
          </div>
        )}

        <div style={{ display: 'flex', gap: 14, padding: '2px 4px', fontSize: 11, color: 'var(--text-3)' }}>
          <span><span className="num">↑↓</span> move</span><span><span className="num">⏎</span> open latest run</span>
          <span><span className="num">⌘R</span> run</span><span><span className="num">⌘N</span> new test</span>
        </div>
      </div>

      {confirmDel && <ConfirmSheet title={`Delete “${confirmDel.name}”?`}
        message="The test, its run history and its learned selectors are removed for everyone in the workspace. This can’t be undone."
        confirmLabel="Delete test"
        onConfirm={() => { onDelete ? onDelete(confirmDel) : showToast && showToast(`Delete isn’t wired yet`, 'info'); }}
        onClose={() => setConfirmDel(null)} />}
    </>
  );
}
