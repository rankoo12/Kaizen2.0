/* global React, I, fmt, BRAIN, COST_CURVE, Toolbar, Seg, Stat, Sparkline, Ring */

const { useState: uSb, useMemo: uMb } = React;

function ConfBar({ v }) {
  const c = v >= .9 ? 'var(--pass)' : v >= .75 ? 'var(--warn)' : 'var(--fail)';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
      <div className="meter" style={{ width: 46 }}><i style={{ width: `${v * 100}%`, background: c }} /></div>
      <span className="num" style={{ fontSize: 11, color: c, fontWeight: 600 }}>{v ? v.toFixed(2) : '—'}</span>
    </div>
  );
}

function BrainRow({ b, open, onToggle, onAct }) {
  return (
    <>
      <div className="row" onClick={onToggle} style={{ background: open ? 'var(--fill)' : undefined }}>
        <span style={{ width: 15, flex: 'none', display: 'grid', color: 'var(--text-3)' }}>
          {open ? <I.chevronDown size={12} /> : <I.chevron size={12} />}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="row-t" title={b.intent} style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            {b.intent}
            {b.pinned && <I.pin size={11} style={{ color: 'var(--pass)' }} />}
            {b.blocked && <span className="badge" style={{ background: 'var(--fail-soft)', color: 'var(--fail)' }}>BLOCKED</span>}
            {b.relearned && <span className="badge" style={{ background: 'var(--heal-soft)', color: 'var(--heal)' }}>RE-LEARNED</span>}
            {b.shaky && <span className="badge" style={{ background: 'var(--warn-soft)', color: 'var(--warn)' }}>NEEDS REVIEW</span>}
          </div>
          <div className="row-s num" title={b.selector} style={{ marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.selector}</div>
        </div>
        <span className="num hide-md" style={{ width: 140, flex: 'none', fontSize: 11, color: 'var(--text-3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.site}</span>
        <span style={{ width: 96, flex: 'none' }}>
          <span className="badge" style={{ background: b.scope === 'global' ? 'var(--accent-soft)' : 'var(--fill)', color: b.scope === 'global' ? 'var(--accent-text)' : 'var(--text-2)' }}>
            {b.scope === 'global' ? <I.cloud size={9} /> : <I.db size={9} />}{b.scope === 'global' ? 'GLOBAL' : 'WORKSPACE'}
          </span>
        </span>
        <span style={{ width: 104, flex: 'none' }}><ConfBar v={b.conf} /></span>
        <span className="num" style={{ width: 78, flex: 'none', textAlign: 'right', fontSize: 12 }}>{fmt.n(b.uses)}</span>
        <span className="num hide-lg" style={{ width: 66, flex: 'none', textAlign: 'right', fontSize: 11, color: 'var(--text-3)' }}>{b.last}</span>
      </div>
      {open && (
        <div style={{ padding: '13px 16px 15px 42px', background: 'var(--content-2)', borderTop: '.5px solid var(--sep)', display: 'flex', gap: 22, alignItems: 'flex-start' }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="label">Selector Kaizen learned</div>
            <div className="num" style={{ fontSize: 12, background: 'var(--fill)', padding: '8px 10px', borderRadius: 7, marginTop: 5, wordBreak: 'break-all' }}>{b.selector}</div>
            <div style={{ display: 'flex', gap: 20, marginTop: 13 }}>
              <div><div className="label">Outcomes</div><div className="num" style={{ fontSize: 13, marginTop: 3 }}>{fmt.n(b.ok)} good · {fmt.n(b.uses - b.ok)} bad</div></div>
              <div><div className="label">Success rate</div><div className="num" style={{ fontSize: 13, marginTop: 3, color: b.uses && b.ok / b.uses > .95 ? 'var(--pass)' : 'var(--warn)' }}>{b.uses ? fmt.pct(b.ok / b.uses * 100) : '—'}</div></div>
              <div><div className="label">Scope</div><div style={{ fontSize: 13, marginTop: 3 }}>{b.scope === 'global' ? 'Shared with every workspace' : 'Private to Acme Cloud'}</div></div>
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 'none', width: 186 }}>
            <button className="btn" onClick={() => onAct(b, 'pin')} style={b.pinned ? { background: 'var(--pass)', color: '#fff', borderColor: 'transparent' } : null}>
              <I.pin size={12} />{b.pinned ? 'Pinned — always reuse' : 'Pin this element'}
            </button>
            <button className="btn danger" onClick={() => onAct(b, 'block')}><I.block size={12} />Block this pattern</button>
            {b.scope !== 'global' && b.conf > .95 && <button className="btn" onClick={() => onAct(b, 'promote')}><I.cloud size={12} />Promote to global brain</button>}
          </div>
        </div>
      )}
    </>
  );
}

function BrainScreen({ showToast }) {
  const [scope, setScope] = uSb('all');
  const [q, setQ] = uSb('');
  const [open, setOpen] = uSb(null);
  const [pins, setPins] = uSb({});
  const [confirmBlock, setConfirmBlock] = uSb(null);

  const rows = uMb(() => BRAIN.map((b) => ({ ...b, pinned: pins[b.selector] ?? b.pinned })).filter((b) => {
    if (scope === 'tenant' && b.scope !== 'tenant') return false;
    if (scope === 'global' && b.scope !== 'global') return false;
    if (scope === 'review' && !(b.shaky || b.blocked)) return false;
    if (q && !`${b.intent} ${b.selector} ${b.site}`.toLowerCase().includes(q.toLowerCase())) return false;
    return true;
  }), [scope, q, pins]);

  const tokensSaved = BRAIN.reduce((a, b) => a + b.uses * 1750, 0);
  const avgConf = BRAIN.filter((b) => !b.blocked).reduce((a, b) => a + b.conf, 0) / BRAIN.filter((b) => !b.blocked).length;
  const hit = COST_CURVE[COST_CURVE.length - 1].cacheHit;

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
        <div className="card rise" style={{ display: 'flex', alignItems: 'center', marginBottom: 16, overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 13, padding: '13px 18px', borderRight: '.5px solid var(--sep)' }}>
            <Ring value={hit} label={`${hit}%`} sub="Cached" color="var(--cache)" size={64} />
            <div style={{ width: 196 }}>
              <div style={{ fontSize: 15, fontWeight: 600, letterSpacing: '-.015em' }}>{hit}% of steps resolve from memory</div>
              <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 2, lineHeight: 1.45 }}>
                Up from {COST_CURVE[0].cacheHit}% a month ago. The rest still need one AI call.
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', flex: 1, minWidth: 0 }}>
            <div style={{ flex: '1 1 148px', minWidth: 0, borderRight: '.5px solid var(--sep)' }}><Stat label="Learned elements" icon="brain" value={BRAIN.length} sub={`${BRAIN.filter((b) => b.scope === 'global').length} shared globally`} /></div>
            <div style={{ flex: '1 1 148px', minWidth: 0, borderRight: '.5px solid var(--sep)' }}><Stat label="Avg confidence" icon="target" value={avgConf.toFixed(2)} sub="across active entries" /></div>
            <div style={{ flex: '1 1 148px', minWidth: 0 }}><Stat label="Tokens not spent" icon="sparkle" value={fmt.k(tokensSaved)} sub="it remembered instead" /></div>
          </div>
        </div>

        <div className="list">
          <div className="list-h">
            <span style={{ width: 15 }} /><span style={{ flex: 1 }}>WHAT IT MEANS · SELECTOR</span>
            <span className="hide-md" style={{ width: 140 }}>SITE</span><span style={{ width: 96 }}>SCOPE</span>
            <span style={{ width: 104 }}>CONFIDENCE</span><span style={{ width: 78, textAlign: 'right' }}>USES</span>
            <span className="hide-lg" style={{ width: 66, textAlign: 'right' }}>LAST</span>
          </div>
          {rows.map((b) => (
            <BrainRow key={b.selector} b={b} open={open === b.selector}
              onToggle={() => setOpen(open === b.selector ? null : b.selector)}
              onAct={(x, kind) => {
                if (kind === 'pin') { setPins({ ...pins, [x.selector]: !x.pinned }); showToast(x.pinned ? 'Unpinned' : 'Pinned — this element is always reused', 'success'); }
                if (kind === 'block') setConfirmBlock(x);
                if (kind === 'promote') showToast('Queued for verification, then shared globally', 'info');
              }} />
          ))}
        </div>

        <div style={{ display: 'flex', gap: 9, alignItems: 'flex-start', marginTop: 14, padding: '0 4px' }}>
          <I.info size={13} style={{ color: 'var(--text-3)', marginTop: 2, flex: 'none' }} />
          <div style={{ fontSize: 12, color: 'var(--text-3)', lineHeight: 1.55, maxWidth: 660 }}>
            Kaizen resolves cheapest-first: known patterns, then this workspace’s cache, then similarity search over past
            resolutions, then the global brain of verified selectors, and only then the AI. Every success is written back here.
          </div>
        </div>
      </div>

      {confirmBlock && <window.ConfirmSheet title={`Block “${confirmBlock.intent}”?`}
        message={`Kaizen will never use ${confirmBlock.selector} again, even if it matches. Steps that relied on it will re-resolve from scratch on the next run.`}
        confirmLabel="Block pattern"
        onConfirm={() => showToast('Pattern blocked — never used again', 'error')}
        onClose={() => setConfirmBlock(null)} />}
    </>
  );
}

Object.assign(window, { BrainScreen });
