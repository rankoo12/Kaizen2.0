/* global React, I, fmt, CASES, SUITES, TENANT, StatusBadge, Seg, Toolbar, Stat, Sparkline, Ring, Menu */

const { useState: uSt, useMemo: uM, useEffect: uEt, useRef: uRt } = React;

function costSeries(c) {
  return Array.from({ length: 10 }, (_, i) => Math.round(c.firstCost * Math.pow(c.lastCost / (c.firstCost || 1) || 0.2, i / 9)));
}

function CaseRow({ c, sel, onSelect, onOpen, onRun, onDelete, density, rowRef }) {
  const [menu, setMenu] = uSt(false);
  const comfy = density === 'comfortable';
  const stop = (e) => e.stopPropagation();
  return (
    <div className={`row focus-row${sel ? ' sel' : ''}`} ref={rowRef} tabIndex={0}
      style={{ padding: comfy ? '11px 14px' : '8px 14px' }}
      onClick={onSelect} onDoubleClick={onOpen}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onOpen(); } }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="row-t" title={c.name}>{c.name}</div>
        <div className="row-s num" style={{ display: 'flex', gap: 7, alignItems: 'center' }}>
          {c.baseUrl.replace('https://', '')} · {c.steps} steps
          {c.ci && <span className="badge caps" style={{ background: 'var(--fill)', color: 'var(--text-3)', height: 16, fontSize: 11 }}>CI</span>}
        </div>
      </div>

      {comfy && (
        <div className="hide-md" style={{ width: 120, flex: 'none' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <div className="meter" style={{ flex: 1 }}><i style={{ width: `${c.cacheHit}%`, background: 'var(--cache)' }} /></div>
            <span className="num" style={{ fontSize: 11, color: 'var(--text-3)' }}>{c.cacheHit}%</span>
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>from memory</div>
        </div>
      )}

      <div className="num" style={{ width: 74, flex: 'none', textAlign: 'right', fontSize: 12, fontWeight: 600, color: c.lastCost === 0 ? 'var(--text-2)' : 'var(--text)' }}>
        {c.lastCost === 0 ? 'free' : fmt.k(c.lastCost)}
      </div>
      <div style={{ width: 82, flex: 'none' }}><StatusBadge status={c.status} size="sm" /></div>
      <div className="num" style={{ width: 62, flex: 'none', fontSize: 11, color: 'var(--text-2)', textAlign: 'right' }}>{c.lastRun}</div>

      <div className="row-actions" style={{ display: 'flex', gap: 4, flex: 'none', position: 'relative' }} onClick={stop} onDoubleClick={stop}>
        <button className="btn icon ghost" title="Run now (⌘R)" onClick={onRun}><I.play size={12} /></button>
        <button className="btn icon ghost" onClick={() => setMenu(!menu)}><I.more size={14} /></button>
        {menu && <Menu onClose={() => setMenu(false)} style={{ top: 26, right: 0 }} items={[
          { label: 'Open latest run', icon: 'runs', hint: '⏎', onClick: onOpen },
          { label: 'Run now', icon: 'play', hint: '⌘R', onClick: onRun },
          { label: 'Compare last two runs', icon: 'target' },
          '-',
          { label: 'What it has learned', icon: 'brain' },
          { label: 'Duplicate', icon: 'copy' },
          '-',
          { label: 'Delete test', icon: 'trash', danger: true, onClick: onDelete },
        ]} />}
      </div>
    </div>
  );
}

function TestsScreen({ onOpen, onNew, onRun, suiteFilter, onClearSuite, density, group, showToast }) {
  const [q, setQ] = uSt('');
  const [filter, setFilter] = uSt('all');
  const [selId, setSelId] = uSt(null);
  const [confirmDel, setConfirmDel] = uSt(null);
  const refs = uRt({});

  const list = uM(() => CASES.filter((c) => {
    if (suiteFilter && c.suiteId !== suiteFilter) return false;
    if (filter === 'failing' && c.status !== 'failed') return false;
    if (filter === 'healed' && c.status !== 'healed') return false;
    if (filter === 'ci' && !c.ci) return false;
    if (q && !(`${c.name} ${c.suiteName} ${c.baseUrl}`.toLowerCase().includes(q.toLowerCase()))) return false;
    return true;
  }), [q, filter, suiteFilter]);

  // one interaction rule: ↑↓ moves the selection, ⏎ opens
  uEt(() => {
    const h = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      const i = list.findIndex((c) => c.id === selId);
      const next = e.key === 'ArrowDown' ? Math.min(i + 1, list.length - 1) : Math.max(i - 1, 0);
      const c = list[i === -1 ? 0 : next];
      if (c) { setSelId(c.id); const el = refs.current[c.id]; if (el) el.focus({ preventScroll: false }); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [list, selId]);

  const stats = uM(() => {
    const pass = CASES.filter((c) => c.status === 'passed').length;
    const healed = CASES.filter((c) => c.status === 'healed').length;
    const fail = CASES.filter((c) => c.status === 'failed').length;
    const avgCache = Math.round(CASES.reduce((a, c) => a + c.cacheHit, 0) / CASES.length);
    return { pass, healed, fail, avgCache, total: CASES.length };
  }, []);

  const suite = suiteFilter ? SUITES.find((s) => s.id === suiteFilter) : null;
  const groups = group && !suiteFilter
    ? SUITES.map((s) => ({ s, items: list.filter((c) => c.suiteId === s.id) })).filter((g) => g.items.length)
    : [{ s: suite, items: list }];

  return (
    <>
      <Toolbar title={suite ? suite.name : 'Tests'} sub={suite ? suite.desc : `${CASES.length} tests across ${SUITES.length} suites · ${TENANT.name}`}
        back={suite ? onClearSuite : null}>
        <div style={{ position: 'relative', width: 208 }} className="hide-narrow">
          <I.search size={13} style={{ position: 'absolute', left: 9, top: 8.5, color: 'var(--text-3)' }} />
          <input className="field" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search tests"
            style={{ height: 28, paddingLeft: 27, fontSize: 13 }} />
        </div>
        <Seg value={filter} onChange={setFilter} options={[
          { value: 'all', label: 'All' }, { value: 'failing', label: 'Failing' },
          { value: 'healed', label: 'Healed' }, { value: 'ci', label: 'CI' },
        ]} />
        <button className="btn pri" onClick={onNew}><I.plus size={13} />New Test</button>
      </Toolbar>

      <div className="scroll" style={{ flex: 1, padding: '18px 22px 40px' }}>
        {/* this screen leads with health — cost lives in Usage */}
        <div className="card rise" style={{ display: 'flex', alignItems: 'stretch', marginBottom: 16, overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 18px', borderRight: '.5px solid var(--sep)', flex: '1 1 300px', minWidth: 0 }}>
            <Ring value={(stats.pass + stats.healed) / stats.total * 100} label={`${Math.round((stats.pass + stats.healed) / stats.total * 100)}%`} sub="Green" size={64} />
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 15, fontWeight: 600, letterSpacing: '-.015em' }}>Suite health</div>
              <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 3, lineHeight: 1.4 }}>
                {stats.pass} passed clean, {stats.healed} healed themselves, {stats.fail} need a human.
              </div>
            </div>
          </div>
          <div style={{ flex: '1 1 230px', minWidth: 0, padding: '14px 16px', borderRight: '.5px solid var(--sep)' }}>
            <window.TierMeter pct={stats.avgCache} />
          </div>
          <button className={stats.fail ? 'hazard' : undefined} onClick={() => setFilter('failing')} style={{ flex: '1 1 170px', minWidth: 0, border: 'none', background: 'none', textAlign: 'left', cursor: 'pointer', borderRight: '.5px solid var(--sep)', padding: 0 }}>
            <Stat label="Needs a human" icon="x" value={stats.fail} tone="var(--fail)" sub="tap to filter" />
          </button>
          <div style={{ flex: '1 1 170px', minWidth: 0, borderRight: '.5px solid var(--sep)' }}>
            <Stat label="Self-healed" icon="heal" value={stats.healed} tone="var(--heal)" sub="no one fixed a selector" />
          </div>
          <div className="hide-md" style={{ flex: '1 1 170px', minWidth: 0 }}>
            <Stat label="From memory" icon="db" value={`${stats.avgCache}%`} sub="of steps, averaged" />
          </div>
        </div>

        {list.length > 0 && (
          <div className="list-h" style={{ background: 'transparent', borderBottom: 'none', padding: '0 14px 5px' }}>
            <span style={{ flex: 1 }}>TEST</span>
            {density === 'comfortable' && <span className="hide-md" style={{ width: 120 }}>CACHE</span>}
            <span style={{ width: 74, textAlign: 'right' }}>COST · TOK</span>
            <span style={{ width: 82 }}>STATUS</span>
            <span style={{ width: 62, textAlign: 'right' }}>LAST RUN</span>
            <span style={{ width: 56 }} />
          </div>
        )}
        {groups.map(({ s, items }, gi) => (
          <div key={s ? s.id : 'all'} style={{ marginBottom: 18 }}>
            {group && !suiteFilter && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 4px 7px' }}>
                {React.createElement(I[s.icon], { size: 13, style: { color: 'var(--text-3)' } })}
                <span style={{ fontSize: 13, fontWeight: 600 }}>{s.name}</span>
                <span className="num" style={{ fontSize: 11, color: 'var(--text-3)' }}>{items.length}</span>
                <span style={{ fontSize: 12, color: 'var(--text-3)' }}>· {s.desc}</span>
              </div>
            )}
            <div className="list rise" style={{ animationDelay: `${gi * 40}ms` }}>
              {items.map((c) => (
                <CaseRow key={c.id} c={c} density={density} sel={selId === c.id}
                  rowRef={(el) => { refs.current[c.id] = el; }}
                  onSelect={() => setSelId(c.id)}
                  onOpen={() => onOpen(c)} onRun={() => onRun(c)}
                  onDelete={() => setConfirmDel(c)} />
              ))}
            </div>
          </div>
        ))}

        {!list.length && (
          <div className="card" style={{ padding: '54px 20px', textAlign: 'center' }}>
            <I.tests size={26} style={{ color: 'var(--text-3)' }} />
            <div style={{ fontSize: 15, fontWeight: 600, marginTop: 10 }}>No tests match</div>
            <div style={{ fontSize: 13, color: 'var(--text-3)', marginTop: 3, marginBottom: 14 }}>
              Try a different filter, or write a new test in plain English.
            </div>
            <button className="btn pri lg" onClick={onNew}><I.plus size={13} />New Test</button>
          </div>
        )}

        <div style={{ display: 'flex', gap: 14, padding: '2px 4px', fontSize: 11, color: 'var(--text-3)' }}>
          <span><span className="num">↑↓</span> move</span><span><span className="num">⏎</span> open latest run</span>
          <span><span className="num">⌘R</span> run</span><span><span className="num">⌘N</span> new test</span>
        </div>
      </div>

      {confirmDel && <window.ConfirmSheet title={`Delete “${confirmDel.name}”?`}
        message="The test, its run history and its learned selectors are removed for everyone in the workspace. This can’t be undone."
        confirmLabel="Delete test"
        onConfirm={() => showToast && showToast(`Deleted “${confirmDel.name}”`, 'error')}
        onClose={() => setConfirmDel(null)} />}
    </>
  );
}

Object.assign(window, { TestsScreen, costSeries });
