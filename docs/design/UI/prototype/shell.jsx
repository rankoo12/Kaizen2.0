/* global React, Icon, NAV_ITEMS, NAV_FOOTER */

const { useState, useEffect, useRef } = React;

// ─── Logo ────────────────────────────────────────────────────────────────────
function Logo({ size = 'md', collapsed = false }) {
  return (
    <div className="kz-logo" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <div className="kz-logo-mark" style={{
        position: 'relative',
        width: size === 'lg' ? 28 : 22,
        height: size === 'lg' ? 28 : 22,
        display: 'grid',
        placeItems: 'center',
      }}>
        <div style={{
          position: 'absolute', inset: 0,
          background: 'var(--brand-primary)',
          borderRadius: 4,
          boxShadow: '0 0 14px var(--brand-primary-glow)',
          transform: 'rotate(45deg)',
        }} />
        <div style={{
          position: 'absolute', inset: 4,
          background: 'var(--app-bg)',
          borderRadius: 2,
          transform: 'rotate(45deg)',
        }} />
        <div style={{
          position: 'absolute',
          width: 6, height: 6,
          background: 'var(--brand-accent)',
          borderRadius: '50%',
          boxShadow: '0 0 10px var(--brand-accent-glow)',
        }} />
      </div>
      {!collapsed && (
        <div className="font-accent" style={{ fontWeight: 700, fontSize: size === 'lg' ? 19 : 15, letterSpacing: '-0.01em', color: 'var(--text-hi)' }}>
          kaizen
        </div>
      )}
    </div>
  );
}

// ─── Side rail ───────────────────────────────────────────────────────────────
function SideRail({ active, onNavigate }) {
  return (
    <aside style={{
      width: 232,
      flexShrink: 0,
      background: 'linear-gradient(180deg, var(--app-bg-deep) 0%, var(--app-bg) 100%)',
      borderRight: '1px solid var(--border-subtle)',
      display: 'flex',
      flexDirection: 'column',
      padding: '20px 14px 14px',
      gap: 24,
      position: 'relative',
      zIndex: 5,
    }}>
      {/* logo + workspace */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: '4px 6px 0' }}>
        <Logo size="lg" />
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '7px 10px',
          background: 'var(--surface)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 8,
          fontSize: 12,
        }}>
          <div style={{
            width: 18, height: 18, borderRadius: 4,
            background: 'linear-gradient(135deg, var(--brand-accent) 0%, var(--brand-primary) 100%)',
            display: 'grid', placeItems: 'center', fontSize: 9, fontWeight: 700, color: '#1a0e05',
          }}>A</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ color: 'var(--text-hi)', fontWeight: 500, fontSize: 12, lineHeight: 1.2 }}>Acme</div>
            <div className="eyebrow" style={{ fontSize: 9 }}>workspace</div>
          </div>
          <Icon name="chevronDown" size={12} style={{ color: 'var(--text-low)' }} />
        </div>
      </div>

      {/* primary nav */}
      <nav style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <div className="eyebrow" style={{ padding: '0 8px 8px' }}>workflow</div>
        {NAV_ITEMS.map((item) => (
          <NavLink key={item.id} item={item} active={active === item.id} onNavigate={onNavigate} />
        ))}
      </nav>

      {/* recent runs strip */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div className="eyebrow" style={{ padding: '0 8px' }}>recent runs</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 1, padding: '4px 4px 0' }}>
          {[
            { n: 247, status: 'passed', label: 'main · auth' },
            { n: 246, status: 'failed', label: 'feature/checkout' },
            { n: 245, status: 'healed', label: 'main · profile' },
            { n: 244, status: 'passed', label: 'main · search' },
          ].map((r) => (
            <div key={r.n} style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '6px 8px', borderRadius: 6, fontSize: 11,
              cursor: 'pointer', transition: 'background 0.15s',
            }} onClick={() => onNavigate('test-detail')}>
              <StatusDot status={r.status} />
              <span className="font-mono tabular" style={{ color: 'var(--text-mid)' }}>#{r.n}</span>
              <span style={{ color: 'var(--text-low)', fontSize: 11, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.label}</span>
            </div>
          ))}
        </div>
      </div>

      <div style={{ flex: 1 }} />

      {/* run state widget */}
      <div style={{
        background: 'var(--surface)', border: '1px solid var(--border-subtle)',
        borderRadius: 10, padding: 12, display: 'flex', flexDirection: 'column', gap: 8,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div className="eyebrow">engine</div>
          <div className="chip chip-passed" style={{ padding: '2px 6px' }}>
            <span className="chip-dot" style={{ background: 'currentColor' }} />ready
          </div>
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-mid)', lineHeight: 1.4 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span>Workers</span>
            <span className="font-mono tabular" style={{ color: 'var(--text-hi)' }}>4 / 8</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span>Queue</span>
            <span className="font-mono tabular" style={{ color: 'var(--text-hi)' }}>0</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span>Region</span>
            <span className="font-mono" style={{ color: 'var(--text-mid)' }}>us-east</span>
          </div>
        </div>
      </div>

      {/* footer nav */}
      <nav style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {NAV_FOOTER.map((item) => (
          <NavLink key={item.id} item={item} active={active === item.id} onNavigate={onNavigate} />
        ))}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '8px 10px', borderRadius: 8, marginTop: 4,
          background: 'var(--surface)', border: '1px solid var(--border-subtle)',
        }}>
          <div style={{
            width: 22, height: 22, borderRadius: '50%',
            background: 'linear-gradient(135deg, var(--brand-primary) 0%, var(--brand-accent) 100%)',
            display: 'grid', placeItems: 'center', fontSize: 10, fontWeight: 700, color: '#1a0e05',
          }}>AL</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12, color: 'var(--text-hi)', lineHeight: 1.2 }}>Ada Lovelace</div>
            <div className="eyebrow" style={{ fontSize: 9 }}>admin</div>
          </div>
        </div>
      </nav>
    </aside>
  );
}

function NavLink({ item, active, onNavigate }) {
  return (
    <button onClick={() => onNavigate(item.id)} className="nav-link" style={{
      display: 'flex', alignItems: 'center', gap: 10,
      padding: '8px 10px', border: 'none',
      background: active ? 'var(--surface-elevated)' : 'transparent',
      color: active ? 'var(--text-hi)' : 'var(--text-mid)',
      borderRadius: 8, width: '100%', textAlign: 'left',
      fontSize: 13, fontWeight: 500, position: 'relative',
      transition: 'background 0.15s, color 0.15s',
    }}
      onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = 'var(--surface)'; e.currentTarget.style.color = 'var(--text-hi)'; }}
      onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = active ? 'var(--text-hi)' : 'var(--text-mid)'; }}
    >
      {active && (
        <span style={{
          position: 'absolute', left: -14, top: 6, bottom: 6, width: 2,
          background: 'var(--brand-primary)', borderRadius: 2,
          boxShadow: '0 0 8px var(--brand-primary-glow)',
        }} />
      )}
      <Icon name={item.icon} size={15} style={{ color: active ? 'var(--brand-primary)' : 'inherit' }} />
      <span style={{ flex: 1 }}>{item.label}</span>
      {item.id === 'tests' && (
        <span className="font-mono tabular" style={{ fontSize: 10, color: 'var(--text-low)' }}>40</span>
      )}
    </button>
  );
}

// ─── Status dot ──────────────────────────────────────────────────────────────
function StatusDot({ status, size = 6 }) {
  const map = {
    passed: 'var(--success)',
    failed: 'var(--danger)',
    healed: 'var(--brand-accent)',
    pending: 'var(--text-low)',
    running: 'var(--brand-primary)',
    queued: 'var(--warning)',
  };
  const c = map[status] || 'var(--text-low)';
  return <span style={{ width: size, height: size, borderRadius: '50%', background: c, boxShadow: `0 0 ${size + 2}px ${c}`, flexShrink: 0, display: 'inline-block' }} />;
}

// ─── Top bar ─────────────────────────────────────────────────────────────────
function TopBar({ crumbs = [], children, kbar }) {
  return (
    <header style={{
      display: 'flex', alignItems: 'center', gap: 16,
      padding: '12px 24px',
      borderBottom: '1px solid var(--border-subtle)',
      background: 'rgba(15, 11, 18, 0.55)',
      backdropFilter: 'blur(14px)',
      WebkitBackdropFilter: 'blur(14px)',
      position: 'relative', zIndex: 4,
      minHeight: 56,
    }}>
      <Breadcrumbs crumbs={crumbs} />
      <div style={{ flex: 1 }} />
      {kbar !== false && <KbarHint />}
      {children}
      <div style={{ display: 'flex', gap: 4 }}>
        <IconButton icon="bell" />
        <IconButton icon="sparkle" />
      </div>
    </header>
  );
}

function Breadcrumbs({ crumbs }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
      {crumbs.map((c, i) => (
        <React.Fragment key={i}>
          {i > 0 && <Icon name="chevronRight" size={12} style={{ color: 'var(--text-faint)' }} />}
          <span style={{
            color: i === crumbs.length - 1 ? 'var(--text-hi)' : 'var(--text-mid)',
            fontWeight: i === crumbs.length - 1 ? 500 : 400,
            fontFamily: c.mono ? "'JetBrains Mono', monospace" : 'inherit',
            fontSize: c.mono ? 12 : 13,
          }}>{c.label}</span>
        </React.Fragment>
      ))}
    </div>
  );
}

function KbarHint() {
  return (
    <button className="btn btn-ghost" style={{
      padding: '6px 10px', fontSize: 12, color: 'var(--text-mid)',
      background: 'var(--surface)', border: '1px solid var(--border-subtle)',
      gap: 18, minWidth: 240, justifyContent: 'space-between',
    }}>
      <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <Icon name="search" size={12} />
        <span>Search tests, runs, suites…</span>
      </span>
      <kbd style={{
        fontSize: 10, fontFamily: 'JetBrains Mono, monospace',
        padding: '1px 5px', borderRadius: 4,
        background: 'var(--app-bg-deep)', border: '1px solid var(--border-subtle)',
        color: 'var(--text-low)',
      }}>⌘K</kbd>
    </button>
  );
}

function IconButton({ icon, onClick, active = false, title }) {
  return (
    <button onClick={onClick} title={title} className="btn btn-ghost" style={{
      width: 32, height: 32, padding: 0, justifyContent: 'center',
      color: active ? 'var(--brand-primary)' : 'var(--text-mid)',
      background: active ? 'var(--surface-elevated)' : 'transparent',
    }}>
      <Icon name={icon} size={15} />
    </button>
  );
}

// ─── Floating music player ───────────────────────────────────────────────────
function MusicPlayer() {
  const [open, setOpen] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(34);

  useEffect(() => {
    if (!playing) return;
    const t = setInterval(() => setProgress((p) => (p + 0.4) % 100), 200);
    return () => clearInterval(t);
  }, [playing]);

  return (
    <div style={{
      position: 'fixed', bottom: 16, right: 16, zIndex: 60,
      display: 'flex', alignItems: 'center',
      background: 'rgba(20, 14, 26, 0.85)',
      backdropFilter: 'blur(20px)',
      WebkitBackdropFilter: 'blur(20px)',
      border: '1px solid var(--border-subtle)',
      borderRadius: 999, padding: 4,
      boxShadow: '0 12px 32px rgba(0,0,0,0.4)',
      transition: 'width 0.25s ease',
    }}>
      <button onClick={() => setPlaying(!playing)} style={{
        width: 36, height: 36, borderRadius: '50%', border: 'none',
        background: playing ? 'var(--brand-primary)' : 'var(--surface-elevated)',
        color: playing ? '#1a0e05' : 'var(--text-mid)',
        display: 'grid', placeItems: 'center', cursor: 'pointer',
        boxShadow: playing ? '0 0 16px var(--brand-primary-glow)' : 'none',
        transition: 'all 0.2s',
      }}>
        <Icon name={playing ? 'pause' : 'play'} size={14} />
      </button>
      {open && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0 12px 0 10px', minWidth: 220 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3, flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 11, color: 'var(--text-hi)', fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              Observatory · Slow Lane
            </div>
            <div style={{ height: 2, background: 'var(--border-subtle)', borderRadius: 2, overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${progress}%`, background: 'var(--brand-accent)', boxShadow: '0 0 6px var(--brand-accent-glow)' }} />
            </div>
            <div className="eyebrow tabular" style={{ fontSize: 9 }}>
              {Math.floor(progress * 0.038)}:{String(Math.floor((progress * 2.4) % 60)).padStart(2, '0')} · ambient
            </div>
          </div>
          <button onClick={() => setOpen(false)} style={{
            border: 'none', background: 'transparent', color: 'var(--text-low)', cursor: 'pointer',
            display: 'grid', placeItems: 'center', padding: 4,
          }}>
            <Icon name="x" size={12} />
          </button>
        </div>
      )}
      {!open && (
        <button onClick={() => setOpen(true)} style={{
          width: 36, height: 36, border: 'none', background: 'transparent',
          color: 'var(--text-low)', cursor: 'pointer', display: 'grid', placeItems: 'center',
        }}>
          <Icon name="music" size={13} />
        </button>
      )}
    </div>
  );
}

// ─── Toast ───────────────────────────────────────────────────────────────────
function Toast({ message, kind = 'info' }) {
  if (!message) return null;
  const colors = {
    info: { fg: 'var(--brand-primary)', bg: 'var(--surface-elevated)' },
    success: { fg: 'var(--success)', bg: 'var(--surface-elevated)' },
    danger: { fg: 'var(--danger)', bg: 'var(--surface-elevated)' },
  };
  const c = colors[kind] || colors.info;
  return (
    <div className="animate-toast-drop" style={{
      position: 'fixed', top: 76, left: '50%', zIndex: 200,
      background: c.bg, border: `1px solid ${c.fg}`,
      borderRadius: 999, padding: '8px 16px',
      display: 'flex', alignItems: 'center', gap: 10,
      fontSize: 12, fontWeight: 500, color: 'var(--text-hi)',
      boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
    }}>
      <StatusDot status={kind === 'success' ? 'passed' : kind === 'danger' ? 'failed' : 'running'} />
      {message}
    </div>
  );
}

window.Logo = Logo;
window.SideRail = SideRail;
window.StatusDot = StatusDot;
window.TopBar = TopBar;
window.IconButton = IconButton;
window.MusicPlayer = MusicPlayer;
window.Toast = Toast;
