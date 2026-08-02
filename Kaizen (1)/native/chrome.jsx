/* global React, I, fmt, TENANT, NAV */
// Shell + shared primitives: window chrome, sidebar, toolbar, segmented control,
// switch, sheet, menu, toast, faux evidence screenshots, tiny charts.

const { useState: uS, useEffect: uE, useRef: uR } = React;

function Seg({ value, onChange, options, size }) {
  return (
    <div className="seg" style={size === 'lg' ? { padding: 3 } : null}>
      {options.map((o) => {
        const val = o.value ?? o;
        const Ico = o.icon ? I[o.icon] : null;
        return (
          <button key={val} aria-pressed={value === val} onClick={() => onChange(val)}
            style={size === 'lg' ? { height: 26, padding: '0 13px' } : null}>
            {Ico && <Ico size={13} />}{o.label ?? o}
          </button>
        );
      })}
    </div>
  );
}

function Switch({ checked, onChange }) {
  return <button className="switch" role="switch" aria-checked={checked} onClick={() => onChange(!checked)}><i /></button>;
}

// Progressive disclosure block — collapsed detail inside the inspector
function Disclose({ title, children, defaultOpen, accent, badge }) {
  const [open, setOpen] = uS(!!defaultOpen);
  return (
    <div style={{ borderTop: '.5px solid var(--sep)' }}>
      <button onClick={() => setOpen(!open)} style={{ display: 'flex', alignItems: 'center', gap: 7, width: '100%', padding: '11px 0 10px', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left' }}>
        <span style={{ color: 'var(--text-3)', display: 'grid', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .16s' }}><I.chevron size={11} /></span>
        <span className="label" style={{ color: accent || 'var(--text-2)' }}>{title}</span>
        <div style={{ flex: 1 }} />
        {badge}
      </button>
      {open && <div style={{ paddingBottom: 13 }} className="rise">{children}</div>}
    </div>
  );
}

function Toolbar({ title, sub, back, children, right }) {
  return (
    <div className="toolbar">
      {back && <button className="btn icon ghost" onClick={back} title="Back"><I.back size={15} /></button>}
      <div style={{ minWidth: 0 }}>
        <div className="toolbar-title" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</div>
        {sub && <div className="toolbar-sub">{sub}</div>}
      </div>
      <div style={{ flex: 1 }} />
      {children}
      {right}
    </div>
  );
}

function Lights({ onAction }) {
  const [hover, setHover] = uS(false);
  const g = { r: 'x', y: 'chevronDown', g: 'frame' };
  return (
    <div className="lights" style={{ padding: '11px 8px 9px 9px' }}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      {['r', 'y', 'g'].map((k) => {
        const Ico = I[g[k]];
        return (
          <button key={k} className={`light ${k}`} tabIndex={-1}
            title={{ r: 'Close', y: 'Minimise', g: 'Fill the screen' }[k]}
            onClick={() => onAction && onAction(k)}
            style={{ display: 'grid', placeItems: 'center', color: 'rgba(0,0,0,.5)' }}>
            {hover && <Ico size={8} />}
          </button>
        );
      })}
    </div>
  );
}

// macOS-style menu bar with real shortcuts
function MenuBar({ menus, status }) {
  const [open, setOpen] = uS(null);
  const wrap = uR(null);
  uE(() => {
    const h = (e) => { if (wrap.current && !wrap.current.contains(e.target)) setOpen(null); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);
  return (
    <div className="menubar on-wallpaper" ref={wrap} style={{ position: 'relative' }}>
      <span className="mb-item brand" style={{ pointerEvents: 'none', gap: 6 }}><I.logo size={11} />Kaizen</span>
      {menus.map((m) => (
        <div key={m.label} style={{ position: 'relative' }}>
          <button className="mb-item" aria-expanded={open === m.label}
            onClick={() => setOpen(open === m.label ? null : m.label)}
            onMouseEnter={() => open && setOpen(m.label)}>{m.label}</button>
          {open === m.label && (
            <div className="popover" style={{ top: 22, left: 0, minWidth: 216, transformOrigin: 'top left' }}>
              {m.items.map((it, k) => it === '-' ? <div className="menu-sep" key={k} /> : (
                <button className="menu-item" key={k} disabled={it.disabled}
                  onClick={() => { setOpen(null); it.onClick && it.onClick(); }}
                  style={it.disabled ? { opacity: .4 } : null}>
                  {it.label}
                  <span style={{ marginLeft: 'auto', color: 'var(--text-3)', fontSize: 12 }}>{it.key}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      ))}
      <div style={{ flex: 1 }} />
      {status}
    </div>
  );
}

function Sidebar({ active, onNav, counts, onSettings, onLights, onToggle }) {
  const [suitesOpen, setSuitesOpen] = uS(true);
  return (
    <div className="sidebar">
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <Lights onAction={onLights} />
        <div style={{ flex: 1 }} />
        <button className="btn icon ghost" title="Hide sidebar (⌥⌘S)" onClick={onToggle} style={{ marginTop: 2 }}><I.sidebar size={15} /></button>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '2px 8px 8px' }}>
        <div style={{ width: 22, height: 22, borderRadius: 6, background: 'var(--accent)', color: '#fff', display: 'grid', placeItems: 'center', boxShadow: '0 1px 3px rgba(11,98,244,.4)' }}>
          <I.logo size={13} />
        </div>
        <div style={{ fontSize: 13, fontWeight: 600, letterSpacing: '-.01em' }}>Kaizen</div>
      </div>
      <div className="side-label">Workspace</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        {NAV.map((n) => {
          const Ico = I[n.icon];
          const isTests = n.id === 'tests';
          return (
            <React.Fragment key={n.id}>
              <div style={{ display: 'flex', alignItems: 'center' }}>
                <button className="side-item" aria-current={active === n.id} onClick={() => onNav(n.id)}>
                  <Ico size={16} />{n.label}
                  {counts[n.id] != null && <span className="side-count">{counts[n.id]}</span>}
                </button>
                {isTests && (
                  <button className="btn icon ghost" title={suitesOpen ? 'Hide suites' : 'Show suites'} style={{ width: 20, height: 20, flex: 'none', marginLeft: 2 }}
                    onClick={() => setSuitesOpen(!suitesOpen)}>
                    {suitesOpen ? <I.chevronDown size={11} /> : <I.chevron size={11} />}
                  </button>
                )}
              </div>
              {isTests && suitesOpen && window.SUITES.map((s) => {
                const SIco = I[s.icon];
                return (
                  <button key={s.id} className="side-item" onClick={() => onNav('tests', s.id)} aria-current={active === s.id}
                    style={{ paddingLeft: 26 }}>
                    <SIco size={14} />
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</span>
                    <span className="side-count">{window.BY_SUITE[s.id].length}</span>
                  </button>
                );
              })}
            </React.Fragment>
          );
        })}
      </div>
      <div style={{ flex: 1 }} />
      <button className="side-item" onClick={onSettings} aria-current={active === 'settings'}>
        <I.settings size={16} />Settings
      </button>
      <div style={{ height: .5, background: 'var(--sep)', margin: '7px 9px' }} />
      <button className="side-item" onClick={onSettings}>
        <span style={{ width: 20, height: 20, borderRadius: 5, background: 'var(--fill-2)', display: 'grid', placeItems: 'center', fontSize: 11, fontWeight: 700, color: 'var(--text-2)', flex: 'none' }}>{TENANT.user.initials}</span>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{TENANT.user.name}</span>
      </button>
    </div>
  );
}

function Menu({ items, onClose, style }) {
  const ref = uR(null);
  uE(() => {
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    const k = (e) => { if (e.key === 'Escape') onClose(); };
    const t = setTimeout(() => { document.addEventListener('mousedown', h); document.addEventListener('keydown', k); }, 0);
    return () => { clearTimeout(t); document.removeEventListener('mousedown', h); document.removeEventListener('keydown', k); };
  }, [onClose]);
  return (
    <div className="popover" ref={ref} style={{ minWidth: 188, ...style }}>
      {items.map((it, k) => it === '-' ? <div className="menu-sep" key={k} /> : (
        <button className="menu-item" key={k} onClick={() => { onClose(); it.onClick && it.onClick(); }}
          style={it.danger ? { color: 'var(--fail)' } : null}>
          {it.icon && React.createElement(I[it.icon], { size: 13 })}{it.label}
          {it.hint && <span style={{ marginLeft: 'auto', color: 'var(--text-3)', fontSize: 11 }}>{it.hint}</span>}
        </button>
      ))}
    </div>
  );
}

function Sheet({ title, children, footer, onClose, width }) {
  uE(() => {
    const k = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', k);
    return () => document.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet" style={width ? { width } : null}>
        <div style={{ padding: '16px 20px 0', textAlign: 'center' }}>
          <div style={{ fontSize: 15, fontWeight: 600 }}>{title}</div>
        </div>
        <div style={{ padding: '14px 20px 4px' }}>{children}</div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '14px 20px 18px' }}>{footer}</div>
      </div>
    </div>
  );
}

// Confirmation for destructive actions
function ConfirmSheet({ title, message, confirmLabel = 'Delete', onConfirm, onClose }) {
  return (
    <Sheet title={title} onClose={onClose} width={400} footer={<>
      <button className="btn lg" onClick={onClose}>Cancel</button>
      <button className="btn lg" style={{ background: 'var(--fail)', color: '#fff', borderColor: 'transparent' }}
        onClick={() => { onConfirm(); onClose(); }}>{confirmLabel}</button>
    </>}>
      <div style={{ fontSize: 13, color: 'var(--text-2)', lineHeight: 1.55, textAlign: 'center' }}>{message}</div>
    </Sheet>
  );
}

function Toast({ toast }) {
  if (!toast) return null;
  const tone = { success: 'var(--pass)', error: 'var(--fail)', heal: 'var(--heal)', info: 'var(--accent)' }[toast.kind] || 'var(--accent)';
  const Ico = I[toast.icon || (toast.kind === 'heal' ? 'heal' : toast.kind === 'error' ? 'x' : 'check')];
  return (
    <div className="toast" key={toast.k}>
      <span style={{ color: tone, display: 'grid' }}><Ico size={14} /></span>{toast.message}
    </div>
  );
}

// ── Metric primitives ────────────────────────────────────────────────────────
function Stat({ label, value, unit, sub, tone, icon }) {
  const Ico = icon ? I[icon] : null;
  return (
    <div style={{ padding: '13px 15px', minWidth: 0 }}>
      <div className="stat-label" style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 600, color: 'var(--text-3)', lineHeight: 1.25 }}>
        {Ico && <Ico size={12} style={{ flex: 'none' }} />}{label}
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 4, marginTop: 5 }}>
        <span className="num" style={{ fontSize: 21, fontWeight: 600, letterSpacing: '-.02em', color: tone || 'var(--text)' }}>{value}</span>
        {unit && <span style={{ fontSize: 12, color: 'var(--text-3)', fontWeight: 500 }}>{unit}</span>}
      </div>
      {sub && <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 2, lineHeight: 1.35 }}>{sub}</div>}
    </div>
  );
}

function Sparkline({ data, w = 120, h = 30, color = 'var(--accent)', fill = true, strokeWidth = 1.5 }) {
  const max = Math.max(...data, 1), min = Math.min(...data);
  const pts = data.map((v, i) => [i / (data.length - 1) * w, h - 2 - ((v - min) / (max - min || 1)) * (h - 4)]);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
  const id = `sg${Math.round(w + h + data.length + max)}`;
  return (
    <svg width={w} height={h} style={{ display: 'block', overflow: 'visible' }}>
      {fill && <defs><linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor={color} stopOpacity=".22" /><stop offset="1" stopColor={color} stopOpacity="0" />
      </linearGradient></defs>}
      {fill && <path d={`${d} L${w} ${h} L0 ${h} Z`} fill={`url(#${id})`} />}
      <path d={d} fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Ring({ value, size = 62, stroke = 6, color = 'var(--pass)', label, sub }) {
  const r = (size - stroke) / 2, c = 2 * Math.PI * r;
  return (
    <div style={{ position: 'relative', width: size, height: size, flex: 'none' }}>
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--fill-2)" strokeWidth={stroke} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={c * (1 - value / 100)}
          style={{ transition: 'stroke-dashoffset .8s cubic-bezier(.32,.72,0,1)' }} />
      </svg>
      <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', textAlign: 'center', lineHeight: 1.1 }}>
        <div>
          <div className="num" style={{ fontSize: size > 50 ? 15 : 12, fontWeight: 600 }}>{label}</div>
          {sub && <div style={{ fontSize: 8.5, color: 'var(--text-3)', fontWeight: 600 }}>{sub}</div>}
        </div>
      </div>
    </div>
  );
}

function SourceTag({ source, tokens }) {
  const s = window.SOURCES[source];
  return (
    <span className="badge" style={{ background: 'var(--fill)', color: s.color, gap: 5 }}>
      <span className="dot" style={{ width: 5, height: 5, background: s.color }} />{s.short}
      <span style={{ color: 'var(--text-3)', fontFamily: 'var(--font-num)', fontWeight: 500 }}>
        {tokens ? `${fmt.n(tokens)} tok` : '0 tok'}
      </span>
    </span>
  );
}

// ── Faux browser evidence shot ───────────────────────────────────────────────
const SHOT_TEMPLATES = {
  login: (
    <>
      <div style={{ position: 'absolute', left: '22%', top: '14%', width: '30%', height: '8%', background: '#2b2b31', borderRadius: 3 }} />
      <div style={{ position: 'absolute', left: '22%', top: '30%', width: '20%', height: '4%', background: '#dcdce1', borderRadius: 2 }} />
      <div className="shot-box" style={{ position: 'absolute', left: '22%', top: '38%', width: '56%', height: '12%' }} />
      <div style={{ position: 'absolute', left: '22%', top: '52%', width: '24%', height: '4%', background: '#dcdce1', borderRadius: 2 }} />
      <div className="shot-box" style={{ position: 'absolute', left: '22%', top: '56%', width: '56%', height: '12%' }} />
      <div className="shot-btn" style={{ position: 'absolute', left: '22%', top: '74%', width: '56%', height: '12%' }} />
    </>
  ),
  consent: (
    <>
      <div style={{ position: 'absolute', left: '8%', top: '12%', width: '40%', height: '6%', background: '#e6e6e9', borderRadius: 2 }} />
      <div style={{ position: 'absolute', left: '8%', top: '24%', width: '76%', height: '4%', background: '#eeeef1', borderRadius: 2 }} />
      <div style={{ position: 'absolute', left: '4%', top: '62%', width: '92%', height: '32%', background: '#f4f4f6', border: '1px solid #e2e2e6', borderRadius: 5 }} />
      <div style={{ position: 'absolute', left: '8%', top: '66%', width: '46%', height: '5%', background: '#dcdce1', borderRadius: 2 }} />
      <div className="shot-btn" style={{ position: 'absolute', left: '54%', top: '72%', width: '32%', height: '15%' }} />
    </>
  ),
  dash: (
    <>
      <div style={{ position: 'absolute', left: 0, top: 0, width: '100%', height: '14%', background: '#f4f4f6', borderBottom: '1px solid #e6e6e9' }} />
      <div style={{ position: 'absolute', left: '4%', top: '4%', width: '18%', height: '6%', background: '#2b2b31', borderRadius: 2 }} />
      <div style={{ position: 'absolute', left: '80%', top: '4%', width: '14%', height: '6%', background: '#dcdce1', borderRadius: 99 }} />
      <div style={{ position: 'absolute', left: '8%', top: '24%', width: '30%', height: '6%', background: '#e6e6e9', borderRadius: 2 }} />
      {[38, 52, 66, 80].map((y) => (
        <div key={y} style={{ position: 'absolute', left: '8%', top: `${y}%`, width: '40%', height: '11%', background: '#f4f4f6', border: '1px solid #e6e6e9', borderRadius: 4 }} />
      ))}
      <div style={{ position: 'absolute', left: '54%', top: '38%', width: '38%', height: '53%', background: '#f9f9fb', border: '1px solid #e6e6e9', borderRadius: 4 }} />
    </>
  ),
  project: (
    <>
      <div style={{ position: 'absolute', left: 0, top: 0, width: '100%', height: '14%', background: '#f4f4f6', borderBottom: '1px solid #e6e6e9' }} />
      <div style={{ position: 'absolute', left: '74%', top: '8%', width: '20%', height: '10%', background: '#e9e9ed', borderRadius: 99 }} />
      <div style={{ position: 'absolute', left: '8%', top: '22%', width: '46%', height: '12%', background: '#2b2b31', borderRadius: 3 }} />
      <div style={{ position: 'absolute', left: '8%', top: '40%', width: '26%', height: '5%', background: '#dcdce1', borderRadius: 2 }} />
      <div style={{ position: 'absolute', left: '8%', top: '52%', width: '62%', height: '22%', background: '#f7f7f9', border: '1px solid #e6e6e9', borderRadius: 4 }} />
      <div style={{ position: 'absolute', left: '11%', top: '58%', width: '40%', height: '5%', background: '#e2e2e6', borderRadius: 2 }} />
    </>
  ),
};

function FauxShot({ shot = 'login', hl, miss, height = 132, caption, url, onZoom, scale = 1 }) {
  return (
    <div>
      <div className={`shot${onZoom ? ' zoomable' : ''}`} style={{ height }} onClick={onZoom}>
        <div className="shot-bar" style={{ height: 16 * scale }}>
          <b /><b /><b />
          <div style={{ marginLeft: 5, flex: 1, height: 8, borderRadius: 99, background: '#f7f7f9', border: '.5px solid #e0e0e4', fontSize: 5.5, color: '#9a9aa2', display: 'flex', alignItems: 'center', paddingLeft: 4, fontFamily: 'var(--font-num)' }}>{url || 'app.acme.io'}</div>
        </div>
        <div style={{ position: 'relative', height: `calc(100% - ${16 * scale}px)`, background: '#fff', overflow: 'hidden' }}>
          {SHOT_TEMPLATES[shot] || SHOT_TEMPLATES.login}
          {hl && <div className={`highlight${miss ? ' miss' : ''}`}
            style={{ left: `${hl.x}%`, top: `${hl.y}%`, width: `${hl.w}%`, height: `${hl.h}%` }} />}
        </div>
      </div>
      {caption && <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 5, fontWeight: 600, letterSpacing: '.01em' }}>{caption}</div>}
    </div>
  );
}

Object.assign(window, { Seg, Switch, Toolbar, Sidebar, Lights, MenuBar, Menu, Sheet, ConfirmSheet, Toast, Stat, Sparkline, Ring, SourceTag, FauxShot, Disclose });
