'use client';
/* Tests screen — design markup from `Kaizen (1)/native/screen-tests.jsx`, now driven by
   REAL data passed in via props (cases/suites/stats from useDesignData). Fields the API
   does not expose (per-case cache %, step count, CI flag) are omitted rather than faked. */
/* eslint-disable @typescript-eslint/no-explicit-any */
import * as React from 'react';
import { I, StatusBadge } from './icons';
import { Toolbar, Seg, Stat, Ring, Menu, ConfirmSheet } from './chrome';
import { fmt } from './data';
import type { DesignCase, DesignSuite } from './use-design-data';

const { useState: uSt, useMemo: uM, useEffect: uEt, useRef: uRt } = React;

function CaseRow({ c, sel, onSelect, onOpen, onRun, onEdit, onDelete, rowRef }: any) {
  const [menu, setMenu] = uSt(false);
  const stop = (e: any) => e.stopPropagation();
  const cost = c.lastCost == null ? '—' : c.lastCost === 0 ? 'free' : fmt.k(c.lastCost);
  return (
    <div className={`row focus-row${sel ? ' sel' : ''}`} ref={rowRef} tabIndex={0}
      style={{ padding: '11px 14px' }}
      onClick={onSelect} onDoubleClick={onOpen}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onOpen(); } }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="row-t" title={c.name}>{c.name}</div>
        <div className="row-s num">{c.baseUrl.replace(/^https?:\/\//, '')}</div>
      </div>
      <div className="num" style={{ width: 74, flex: 'none', textAlign: 'right', fontSize: 12, fontWeight: 600, color: c.lastCost === 0 || c.lastCost == null ? 'var(--text-2)' : 'var(--text)' }}>
        {cost}
      </div>
      <div style={{ width: 82, flex: 'none' }}><StatusBadge status={c.status} size="sm" /></div>
      <div className="num" style={{ width: 70, flex: 'none', fontSize: 11, color: 'var(--text-2)', textAlign: 'right' }}>{c.lastRun || 'never'}</div>

      <div className="row-actions" style={{ display: 'flex', gap: 4, flex: 'none', position: 'relative' }} onClick={stop} onDoubleClick={stop}>
        <button className="btn icon ghost" title="Run now (⌘R)" onClick={onRun}><I.play size={12} /></button>
        <button className="btn icon ghost" onClick={() => setMenu(!menu)}><I.more size={14} /></button>
        {menu && <Menu onClose={() => setMenu(false)} style={{ top: 26, right: 0 }} items={[
          { label: 'Open latest run', icon: 'runs', hint: '⏎', onClick: onOpen },
          { label: 'Run now', icon: 'play', hint: '⌘R', onClick: onRun },
          { label: 'Edit steps', icon: 'settings', onClick: onEdit },
          '-',
          { label: 'Delete test', icon: 'trash', danger: true, onClick: onDelete },
        ]} />}
      </div>
    </div>
  );
}

export function TestsScreen({ cases, suites, stats, onOpen, onNew, onRun, onEdit, onDelete, suiteFilter, onClearSuite, group = true, showToast }: {
  cases: DesignCase[]; suites: DesignSuite[]; stats: any;
  onOpen: (c: DesignCase) => void; onNew: () => void; onRun: (c: DesignCase) => void;
  onEdit: (c: DesignCase) => void; onDelete?: (c: DesignCase) => void;
  suiteFilter: string | null; onClearSuite: () => void; group?: boolean; showToast?: any;
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
    if (q && !(`${c.name} ${c.suiteName} ${c.baseUrl}`.toLowerCase().includes(q.toLowerCase()))) return false;
    return true;
  }), [cases, q, filter, suiteFilter]);

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
        ]} />
        <button className="btn pri" onClick={onNew}><I.plus size={13} />New Test</button>
      </Toolbar>

      <div className="scroll" style={{ flex: 1, padding: '18px 22px 40px' }}>
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
                  onDelete={() => setConfirmDel(c)} />
              ))}
            </div>
          </div>
        ))}

        {!list.length && (
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
