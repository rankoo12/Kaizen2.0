/* global React, Icon, StatusDot, SUITES, ALL_CASES, CASES_BY_SUITE */

const { useState: useStateTests, useMemo: useMemoTests } = React;

function TestsDashboard({ onOpenTest, onNew, density = 'compact', viewMode: vmProp = 'grid' }) {
  const [view, setView] = useStateTests(vmProp);
  React.useEffect(() => setView(vmProp), [vmProp]);

  const [filter, setFilter] = useStateTests('all'); // all/failed/healed/passed
  const [search, setSearch] = useStateTests('');
  const [selected, setSelected] = useStateTests(new Set());
  const [hoverId, setHoverId] = useStateTests(null);
  const [running, setRunning] = useStateTests(new Set());

  const summary = useMemoTests(() => {
    const pass = ALL_CASES.filter((c) => c.status === 'passed').length;
    const fail = ALL_CASES.filter((c) => c.status === 'failed').length;
    const heal = ALL_CASES.filter((c) => c.status === 'healed').length;
    const total = ALL_CASES.length;
    return { pass, fail, heal, total, passPct: Math.round((pass / total) * 100) };
  }, []);

  const toggle = (id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const filtered = useMemoTests(() => {
    return ALL_CASES.filter((c) => {
      if (filter !== 'all' && c.status !== filter) return false;
      if (search && !c.name.toLowerCase().includes(search.toLowerCase()) && !c.id.includes(search)) return false;
      return true;
    });
  }, [filter, search]);

  const runSelected = () => {
    const ids = Array.from(selected);
    setRunning(new Set(ids));
    setSelected(new Set());
    setTimeout(() => setRunning(new Set()), 3000);
  };

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* page header */}
      <div style={{ padding: '20px 28px 16px', borderBottom: '1px solid var(--border-subtle)' }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 24, marginBottom: 18 }}>
          <div>
            <div className="eyebrow" style={{ marginBottom: 6 }}>40 tests · 5 suites · last sweep 4m ago</div>
            <h1 className="font-display" style={{ fontSize: 28, fontWeight: 600, letterSpacing: '-0.02em', color: 'var(--text-hi)', margin: 0, marginBottom: 4 }}>
              Tests
            </h1>
            <div style={{ fontSize: 13, color: 'var(--text-mid)' }}>
              Plain-English specs that drive a real browser. Healing on.
            </div>
          </div>

          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn" style={{ gap: 6 }}>
              <Icon name="rotate" size={13} /> Sync from main
            </button>
            <button onClick={onNew} className="btn btn-primary">
              <Icon name="plus" size={13} /> New test
            </button>
          </div>
        </div>

        <SummaryStrip summary={summary} />
      </div>

      {/* controls bar */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '10px 28px', borderBottom: '1px solid var(--border-subtle)',
        background: 'var(--app-bg)',
      }}>
        <div style={{
          position: 'relative', display: 'flex', alignItems: 'center',
          background: 'var(--surface)', border: '1px solid var(--border-subtle)',
          borderRadius: 8, padding: '0 10px', minWidth: 280,
        }}>
          <Icon name="search" size={13} style={{ color: 'var(--text-low)' }} />
          <input
            value={search} onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter by name, id, suite…"
            style={{
              border: 'none', outline: 'none', background: 'transparent',
              padding: '8px 10px', flex: 1, color: 'var(--text)', fontSize: 13,
            }}
          />
          <kbd style={{ fontSize: 10, fontFamily: 'JetBrains Mono, monospace', color: 'var(--text-faint)' }}>/</kbd>
        </div>

        <div className="seg" style={{
          display: 'flex', background: 'var(--surface)', border: '1px solid var(--border-subtle)',
          borderRadius: 8, padding: 2,
        }}>
          {[
            { id: 'all', label: 'All', dot: null, count: summary.total },
            { id: 'failed', label: 'Failed', dot: 'failed', count: summary.fail },
            { id: 'healed', label: 'Healed', dot: 'healed', count: summary.heal },
            { id: 'passed', label: 'Passed', dot: 'passed', count: summary.pass },
          ].map((f) => (
            <button key={f.id} onClick={() => setFilter(f.id)} style={{
              border: 'none', padding: '5px 10px', borderRadius: 6, fontSize: 12,
              background: filter === f.id ? 'var(--surface-elevated)' : 'transparent',
              color: filter === f.id ? 'var(--text-hi)' : 'var(--text-mid)',
              display: 'flex', alignItems: 'center', gap: 6, fontWeight: 500,
              boxShadow: filter === f.id ? 'inset 0 0 0 1px var(--border-strong)' : 'none',
            }}>
              {f.dot && <StatusDot status={f.dot} size={6} />}
              {f.label}
              <span className="font-mono tabular" style={{ fontSize: 10, color: 'var(--text-low)' }}>{f.count}</span>
            </button>
          ))}
        </div>

        <button className="btn btn-ghost btn-sm" style={{ gap: 6 }}>
          <Icon name="filter" size={12} /> Branch: <span className="font-mono" style={{ color: 'var(--text-hi)' }}>main</span>
          <Icon name="chevronDown" size={11} />
        </button>

        <div style={{ flex: 1 }} />

        <div className="seg" style={{
          display: 'flex', background: 'var(--surface)', border: '1px solid var(--border-subtle)',
          borderRadius: 8, padding: 2,
        }}>
          {[{ id: 'grid', icon: 'grid' }, { id: 'list', icon: 'list' }].map((v) => (
            <button key={v.id} onClick={() => setView(v.id)} style={{
              border: 'none', padding: '5px 10px', borderRadius: 6,
              background: view === v.id ? 'var(--surface-elevated)' : 'transparent',
              color: view === v.id ? 'var(--brand-primary)' : 'var(--text-mid)',
              display: 'grid', placeItems: 'center', cursor: 'pointer',
              boxShadow: view === v.id ? 'inset 0 0 0 1px var(--border-strong)' : 'none',
            }}>
              <Icon name={v.icon} size={13} />
            </button>
          ))}
        </div>

        <button className="btn btn-ghost btn-sm" style={{ gap: 6 }}>
          <Icon name="diff" size={12} /> Compare
        </button>
      </div>

      {/* main scroll area */}
      <div style={{ flex: 1, overflow: 'auto', padding: '20px 28px 80px' }}>
        {view === 'grid' ? (
          <GridView
            filtered={filtered} onToggle={toggle} selected={selected} running={running}
            onOpen={onOpenTest} hoverId={hoverId} onHover={setHoverId} density={density}
          />
        ) : (
          <ListView filtered={filtered} onToggle={toggle} selected={selected} running={running} onOpen={onOpenTest} />
        )}
      </div>

      {/* selection action bar */}
      {selected.size > 0 && (
        <div className="animate-modal-pop" style={{
          position: 'absolute', bottom: 24, left: '50%', transform: 'translateX(-50%)',
          background: 'rgba(20, 14, 26, 0.92)', backdropFilter: 'blur(20px)',
          border: '1px solid var(--border-strong)', borderRadius: 12,
          padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 12,
          boxShadow: '0 12px 36px rgba(0,0,0,0.5)', zIndex: 50,
        }}>
          <div style={{
            width: 28, height: 28, borderRadius: 8, background: 'var(--brand-primary)',
            display: 'grid', placeItems: 'center', color: '#1a0e05', fontWeight: 700, fontSize: 12,
            boxShadow: '0 0 12px var(--brand-primary-glow)',
          }} className="font-mono tabular">{selected.size}</div>
          <span style={{ fontSize: 12, color: 'var(--text-hi)', fontWeight: 500 }}>
            {selected.size} test{selected.size === 1 ? '' : 's'} selected
          </span>
          <span style={{ width: 1, height: 16, background: 'var(--border-subtle)' }} />
          <button onClick={() => setSelected(new Set())} className="btn btn-ghost btn-sm">Clear</button>
          <button className="btn btn-sm">
            <Icon name="archive" size={12} /> Archive
          </button>
          <button onClick={runSelected} className="btn btn-primary btn-sm">
            <Icon name="play" size={11} /> Run {selected.size}
          </button>
        </div>
      )}
    </div>
  );
}

function SummaryStrip({ summary }) {
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: 'auto 1fr 1fr 1fr 1fr',
      gap: 0,
      background: 'var(--surface)',
      border: '1px solid var(--border-subtle)',
      borderRadius: 12, overflow: 'hidden',
    }}>
      {/* Big pass rate */}
      <div style={{ padding: '14px 18px', display: 'flex', alignItems: 'center', gap: 14, borderRight: '1px solid var(--border-subtle)', minWidth: 220 }}>
        <PassRing pct={summary.passPct} />
        <div>
          <div className="eyebrow" style={{ fontSize: 9, marginBottom: 2 }}>pass rate · 24h</div>
          <div className="font-display tabular" style={{ fontSize: 26, fontWeight: 600, color: 'var(--text-hi)', lineHeight: 1 }}>
            {summary.passPct}<span style={{ fontSize: 14, color: 'var(--text-low)', fontWeight: 400 }}>%</span>
          </div>
        </div>
      </div>

      <SummaryCell label="Passing" value={summary.pass} status="passed" trend="+3" />
      <SummaryCell label="Failing" value={summary.fail} status="failed" trend="−1" />
      <SummaryCell label="Self-healed" value={summary.heal} status="healed" trend="+2" />
      <SummaryCell label="Median run" value="6.4s" status="info" trend="−0.3s" mono />
    </div>
  );
}

function SummaryCell({ label, value, status, trend, mono = false }) {
  const trendDown = trend && trend.startsWith('−');
  return (
    <div style={{ padding: '14px 18px', borderRight: '1px solid var(--border-subtle)', display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {status !== 'info' && <StatusDot status={status} size={5} />}
        <span className="eyebrow" style={{ fontSize: 9 }}>{label}</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span className={`tabular ${mono ? 'font-mono' : 'font-display'}`} style={{ fontSize: 22, fontWeight: 600, color: 'var(--text-hi)' }}>
          {value}
        </span>
        {trend && (
          <span className="font-mono tabular" style={{ fontSize: 11, color: trendDown && status === 'failed' ? 'var(--success)' : trendDown ? 'var(--success)' : 'var(--brand-primary)' }}>
            {trend}
          </span>
        )}
      </div>
    </div>
  );
}

function PassRing({ pct }) {
  const r = 22;
  const c = 2 * Math.PI * r;
  const off = c * (1 - pct / 100);
  return (
    <svg width="56" height="56" viewBox="0 0 56 56">
      <circle cx="28" cy="28" r={r} fill="none" stroke="var(--border-strong)" strokeWidth="3" />
      <circle cx="28" cy="28" r={r} fill="none" stroke="var(--success)" strokeWidth="3"
        strokeLinecap="round"
        strokeDasharray={c} strokeDashoffset={off}
        transform="rotate(-90 28 28)"
        style={{ filter: 'drop-shadow(0 0 4px var(--success-glow))', transition: 'stroke-dashoffset 0.6s' }}
      />
    </svg>
  );
}

// ─── Grid view ───────────────────────────────────────────────────────────────
function GridView({ filtered, onToggle, selected, running, onOpen, hoverId, onHover, density }) {
  const cellSize = density === 'comfortable' ? 28 : 22;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 28, position: 'relative' }}>
      {SUITES.map((suite) => {
        const suiteCases = filtered.filter((c) => c.suiteId === suite.id);
        if (!suiteCases.length) return null;
        const passCount = suiteCases.filter((c) => c.status === 'passed').length;
        return (
          <div key={suite.id}>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10,
              padding: '0 2px',
            }}>
              <div style={{
                display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer',
                color: 'var(--text-hi)',
              }}>
                <Icon name="chevronDown" size={11} style={{ color: 'var(--text-low)' }} />
                <span style={{ fontSize: 13, fontWeight: 500 }}>{suite.name}</span>
              </div>
              <span className="eyebrow">{suiteCases.length} tests</span>
              <span className="eyebrow" style={{ color: 'var(--success)' }}>
                {Math.round((passCount / suiteCases.length) * 100)}% pass
              </span>
              <div style={{ flex: 1 }} />
              <button className="btn btn-ghost btn-xs">
                Run suite
              </button>
            </div>

            <div style={{
              display: 'grid',
              gridTemplateColumns: `repeat(auto-fill, minmax(${cellSize + 4}px, ${cellSize + 4}px))`,
              gap: 4, padding: '10px 12px',
              background: 'var(--surface)', border: '1px solid var(--border-subtle)',
              borderRadius: 12, position: 'relative',
            }}>
              {suiteCases.map((tc) => (
                <TestCell
                  key={tc.id} tc={tc} size={cellSize}
                  selected={selected.has(tc.id)}
                  running={running.has(tc.id)}
                  onClick={() => onToggle(tc.id)}
                  onDoubleClick={() => onOpen(tc.id)}
                  onMouseEnter={() => onHover(tc.id)}
                  onMouseLeave={() => onHover(null)}
                />
              ))}
            </div>

            {hoverId && suiteCases.find((c) => c.id === hoverId) && (
              <TestHoverCard tc={suiteCases.find((c) => c.id === hoverId)} />
            )}
          </div>
        );
      })}
    </div>
  );
}

function TestCell({ tc, size, selected, running, onClick, onDoubleClick, onMouseEnter, onMouseLeave }) {
  const colors = {
    passed: { bg: 'rgba(34, 197, 94, 0.08)', border: 'rgba(34, 197, 94, 0.18)', fg: 'var(--success)' },
    failed: { bg: 'rgba(239, 68, 68, 0.10)', border: 'rgba(239, 68, 68, 0.30)', fg: 'var(--danger)' },
    healed: { bg: 'rgba(219, 135, 175, 0.10)', border: 'rgba(219, 135, 175, 0.25)', fg: 'var(--brand-accent)' },
    pending: { bg: 'var(--surface-sunken)', border: 'var(--border-subtle)', fg: 'var(--text-low)' },
  };
  const c = colors[tc.status] || colors.pending;

  return (
    <div
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      title={tc.name}
      style={{
        width: size, height: size, borderRadius: 4,
        background: c.bg, border: `1px solid ${selected ? 'var(--brand-primary)' : c.border}`,
        display: 'grid', placeItems: 'center',
        cursor: 'pointer', transition: 'transform 0.15s, box-shadow 0.15s',
        boxShadow: selected ? '0 0 0 1px var(--brand-primary), 0 0 12px var(--brand-primary-glow)' : 'none',
        transform: selected ? 'scale(1.08)' : 'scale(1)',
        position: 'relative',
      }}
      onMouseOver={(e) => { e.currentTarget.style.transform = 'scale(1.12)'; e.currentTarget.style.zIndex = 20; }}
      onMouseOut={(e) => { e.currentTarget.style.transform = selected ? 'scale(1.08)' : 'scale(1)'; e.currentTarget.style.zIndex = 'auto'; }}
    >
      {running ? (
        <div style={{
          width: 6, height: 6, borderRadius: '50%', background: 'var(--brand-primary)',
          boxShadow: '0 0 8px var(--brand-primary-glow)', animation: 'orbit 0.8s linear infinite',
        }} />
      ) : (
        <span className="font-mono tabular" style={{ fontSize: 9, color: c.fg, fontWeight: 600 }}>
          {tc.id.slice(-2)}
        </span>
      )}
      {tc.flaky && (
        <span style={{
          position: 'absolute', top: -2, right: -2,
          width: 6, height: 6, borderRadius: '50%', background: 'var(--warning)',
          boxShadow: '0 0 4px var(--warning)',
        }} />
      )}
    </div>
  );
}

function TestHoverCard({ tc }) {
  return (
    <div className="animate-modal-pop" style={{
      position: 'absolute', top: 50, right: 12, zIndex: 30,
      width: 320,
      background: 'rgba(20, 14, 26, 0.95)', backdropFilter: 'blur(20px)',
      border: '1px solid var(--border-strong)', borderRadius: 12,
      padding: 16, boxShadow: '0 12px 32px rgba(0,0,0,0.5)',
      pointerEvents: 'none',
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 10 }}>
        <div style={{ flex: 1, paddingRight: 8 }}>
          <div className="eyebrow" style={{ fontSize: 9, marginBottom: 4 }}>#{tc.id.slice(-6)}</div>
          <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-hi)', lineHeight: 1.3 }}>{tc.name}</div>
        </div>
        <span className={`chip chip-${tc.status}`}>
          <span className="chip-dot" style={{ background: 'currentColor' }} />{tc.status}
        </span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 10 }}>
        <Mini label="duration" value={`${(tc.durationMs / 1000).toFixed(1)}s`} />
        <Mini label="tokens" value={tc.tokens.toLocaleString()} />
      </div>

      <div className="eyebrow" style={{ fontSize: 9, marginBottom: 6 }}>last 12 runs</div>
      <div style={{ display: 'flex', gap: 2, height: 18, alignItems: 'flex-end' }}>
        {tc.history.map((h, i) => (
          <div key={i} style={{
            flex: 1, height: '100%', borderRadius: 1,
            background: h === 'passed' ? 'var(--success)' : h === 'failed' ? 'var(--danger)' : 'var(--brand-accent)',
            opacity: 0.4 + (i / tc.history.length) * 0.6,
          }} />
        ))}
      </div>

      <div style={{
        marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--border-subtle)',
        display: 'flex', justifyContent: 'space-between', fontSize: 11,
      }}>
        <span style={{ color: 'var(--text-low)' }}>{tc.completedAgo}m ago</span>
        <span className="font-mono" style={{ color: 'var(--text-mid)' }}>{tc.suiteName.split(' ')[0].toLowerCase()}</span>
      </div>
    </div>
  );
}

function Mini({ label, value }) {
  return (
    <div style={{
      padding: 8, borderRadius: 6,
      background: 'var(--surface-sunken)', border: '1px solid var(--border-subtle)',
    }}>
      <div className="eyebrow" style={{ fontSize: 8, marginBottom: 2 }}>{label}</div>
      <div className="font-mono tabular" style={{ fontSize: 13, color: 'var(--text-hi)', fontWeight: 500 }}>{value}</div>
    </div>
  );
}

// ─── List view ───────────────────────────────────────────────────────────────
function ListView({ filtered, onToggle, selected, running, onOpen }) {
  return (
    <div style={{
      background: 'var(--surface)', border: '1px solid var(--border-subtle)',
      borderRadius: 12, overflow: 'hidden',
    }}>
      <div style={{
        display: 'grid', gridTemplateColumns: '32px 60px 1fr 200px 100px 80px 80px 60px',
        gap: 12, padding: '10px 16px',
        borderBottom: '1px solid var(--border-subtle)',
        background: 'var(--surface-sunken)',
      }}>
        {['', 'id', 'description', 'suite', 'duration', 'tokens', 'last 12', 'when'].map((h) => (
          <div key={h} className="eyebrow" style={{ fontSize: 9 }}>{h}</div>
        ))}
      </div>
      {filtered.map((tc) => (
        <div key={tc.id}
          onClick={() => onToggle(tc.id)}
          onDoubleClick={() => onOpen(tc.id)}
          style={{
            display: 'grid', gridTemplateColumns: '32px 60px 1fr 200px 100px 80px 80px 60px',
            gap: 12, padding: '10px 16px',
            borderBottom: '1px solid var(--border-subtle)',
            alignItems: 'center', cursor: 'pointer', fontSize: 12,
            background: selected.has(tc.id) ? 'rgba(213, 96, 28, 0.05)' : 'transparent',
            transition: 'background 0.1s',
          }}
          onMouseEnter={(e) => { if (!selected.has(tc.id)) e.currentTarget.style.background = 'var(--surface-elevated)'; }}
          onMouseLeave={(e) => { if (!selected.has(tc.id)) e.currentTarget.style.background = 'transparent'; }}
        >
          <div>
            {running.has(tc.id) ? (
              <Icon name="loader" size={12} style={{ animation: 'orbit 0.8s linear infinite', color: 'var(--brand-primary)' }} />
            ) : (
              <StatusDot status={tc.status} size={8} />
            )}
          </div>
          <div className="font-mono tabular" style={{ color: 'var(--text-low)', fontSize: 11 }}>#{tc.id.slice(-4)}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ color: 'var(--text-hi)', fontWeight: 500 }}>{tc.name}</span>
            {tc.flaky && (
              <span className="chip" style={{ fontSize: 9, padding: '1px 5px', color: 'var(--warning)', borderColor: 'rgba(245,158,11,0.3)' }}>flaky</span>
            )}
            {tc.status === 'healed' && (
              <span className="chip chip-healed" style={{ fontSize: 9, padding: '1px 5px' }}>healed</span>
            )}
          </div>
          <div style={{ color: 'var(--text-mid)' }}>{tc.suiteName}</div>
          <div className="font-mono tabular" style={{ color: 'var(--text)' }}>{(tc.durationMs / 1000).toFixed(1)}s</div>
          <div className="font-mono tabular" style={{ color: 'var(--text-mid)' }}>{tc.tokens.toLocaleString()}</div>
          <div style={{ display: 'flex', gap: 1, height: 14, alignItems: 'flex-end' }}>
            {tc.history.slice(-12).map((h, i) => (
              <div key={i} style={{
                flex: 1, height: '100%',
                background: h === 'passed' ? 'var(--success)' : h === 'failed' ? 'var(--danger)' : 'var(--brand-accent)',
                opacity: 0.5 + (i / 12) * 0.5,
              }} />
            ))}
          </div>
          <div style={{ color: 'var(--text-low)', fontSize: 11 }}>{tc.completedAgo}m</div>
        </div>
      ))}
    </div>
  );
}

window.TestsDashboard = TestsDashboard;
