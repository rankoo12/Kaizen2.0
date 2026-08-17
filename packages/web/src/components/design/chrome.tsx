'use client';
/* Ported verbatim from `Kaizen (1)/native/chrome.jsx` — design is the source of truth.
   Shell + shared primitives. window.* globals replaced with module imports. Loosely
   typed on purpose to mirror the design's dynamic patterns. */
/* eslint-disable @typescript-eslint/no-explicit-any */
import * as React from 'react';
import { I } from './icons';
import { NAV, SOURCES, fmt } from './data';
import { CountUp } from './game';

const { useState: uS, useEffect: uE, useRef: uR } = React;

export function Seg({ value, onChange, options, size }: any) {
  return (
    <div className="seg" style={size === 'lg' ? { padding: 3 } : undefined}>
      {options.map((o: any) => {
        const val = o.value ?? o;
        const Ico = o.icon ? I[o.icon] : null;
        return (
          <button key={val} aria-pressed={value === val} onClick={() => onChange(val)}
            style={size === 'lg' ? { height: 26, padding: '0 13px' } : undefined}>
            {Ico && <Ico size={13} />}{o.label ?? o}
          </button>
        );
      })}
    </div>
  );
}

export function Switch({ checked, onChange, disabled, title }: any) {
  // `disabled` rather than an inert onChange: a control the caller cannot use has
  // to say so to a screen reader and to a keyboard, not only to a mouse.
  return <button className="switch" role="switch" aria-checked={checked} disabled={disabled}
    title={title} onClick={() => !disabled && onChange(!checked)}><i /></button>;
}

export function Disclose({ title, children, defaultOpen, accent, badge }: any) {
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

export function Toolbar({ title, sub, back, children, right }: any) {
  return (
    <div className="toolbar">
      {back && <button className="btn icon ghost" onClick={back} title="Back"><I.back size={15} /></button>}
      <div style={{ minWidth: 0, flex: '1 1 auto' }}>
        <div className="toolbar-title" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</div>
        {sub && <div className="toolbar-sub">{sub}</div>}
      </div>
      {children}
      {right}
    </div>
  );
}

export function Lights({ onAction }: any) {
  const [hover, setHover] = uS(false);
  const g: any = { r: 'x', y: 'chevronDown', g: 'frame' };
  return (
    <div className="lights" style={{ padding: '11px 8px 9px 9px' }}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      {['r', 'y', 'g'].map((k) => {
        const Ico = I[g[k]];
        return (
          <button key={k} className={`light ${k}`} tabIndex={-1}
            title={({ r: 'Close', y: 'Minimise', g: 'Fill the screen' } as any)[k]}
            onClick={() => onAction && onAction(k)}
            style={{ display: 'grid', placeItems: 'center', color: 'rgba(0,0,0,.5)' }}>
            {hover && <Ico size={8} />}
          </button>
        );
      })}
    </div>
  );
}

export function MenuBar({ menus, status }: any) {
  const [open, setOpen] = uS<string | null>(null);
  const wrap = uR<HTMLDivElement>(null);
  uE(() => {
    const h = (e: MouseEvent) => { if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(null); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);
  return (
    <div className="menubar on-wallpaper" ref={wrap} style={{ position: 'relative' }}>
      <span className="mb-item brand" style={{ pointerEvents: 'none', gap: 6 }}><I.logo size={11} />Kaizen</span>
      {menus.map((m: any) => (
        <div key={m.label} style={{ position: 'relative' }}>
          <button className="mb-item" aria-expanded={open === m.label}
            onClick={() => setOpen(open === m.label ? null : m.label)}
            onMouseEnter={() => open && setOpen(m.label)}>{m.label}</button>
          {open === m.label && (
            <div className="popover" style={{ top: 22, left: 0, minWidth: 216, transformOrigin: 'top left' }}>
              {m.items.map((it: any, k: number) => it === '-' ? <div className="menu-sep" key={k} /> : (
                <button className="menu-item" key={k} disabled={it.disabled}
                  onClick={() => { setOpen(null); it.onClick && it.onClick(); }}
                  style={it.disabled ? { opacity: .4 } : undefined}>
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

export function Sidebar({ active, onNav, counts, onSettings, onLights, onToggle, suites = [], user, activeJobs = [], onOpenJob }: any) {
  const [suitesOpen, setSuitesOpen] = uS(true);
  /** Suites with a live analysis, so a row can carry a dot without a second scan. */
  const liveSuites = new Set(activeJobs.map((j: any) => j.suiteId));
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
        {NAV.map((n: any) => {
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
              {isTests && suitesOpen && suites.map((s: any) => {
                const SIco = I[s.icon] || I.suites;
                return (
                  <button key={s.id} className="side-item" onClick={() => onNav('tests', s.id)} aria-current={active === s.id}
                    style={{ paddingLeft: 26 }}>
                    <SIco size={14} />
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</span>
                    {liveSuites.has(s.id) && (
                      <span className="live-dot" title="Kaizen is working on this suite" />
                    )}
                    <span className="side-count">{s.count}</span>
                  </button>
                );
              })}
            </React.Fragment>
          );
        })}
      </div>
      <div style={{ flex: 1 }} />
      {/* The QA engineer's activity, always in view. The writer screen tells the
          user they can walk away; this is what they come back to. */}
      {activeJobs.length > 0 && (
        <div className="rise" style={{ margin: '0 8px 8px', padding: '7px 9px', borderRadius: 8, background: 'var(--fill)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5 }}>
            <I.sparkle size={11} style={{ color: 'var(--accent)' }} />
            <span className="label" style={{ fontSize: 10 }}>QA engineer</span>
          </div>
          {activeJobs.map((j: any) => (
            <button key={j.jobId} onClick={() => onOpenJob?.(j.suiteId, j.jobId)}
              style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%', background: 'none',
                border: 'none', padding: '3px 0', cursor: 'pointer', textAlign: 'left', font: 'inherit' }}>
              <span className={j.status === 'awaiting_plan_approval' ? 'live-dot waiting' : 'live-dot'} />
              <span style={{ flex: 1, minWidth: 0, fontSize: 11.5, color: 'var(--text-2)',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {j.suiteName}
              </span>
              <span style={{ fontSize: 10.5, color: j.status === 'awaiting_plan_approval' ? 'var(--accent)' : 'var(--text-3)' }}>
                {j.status === 'awaiting_plan_approval' ? 'your turn'
                  : j.status === 'queued' ? 'queued'
                    : j.pagesCrawled ? `${j.pagesCrawled} pages` : 'exploring'}
              </span>
            </button>
          ))}
        </div>
      )}
      <button className="side-item" onClick={onSettings} aria-current={active === 'settings'}>
        <I.settings size={16} />Settings
      </button>
      <div style={{ height: .5, background: 'var(--sep)', margin: '7px 9px' }} />
      {/* Until the session resolves there is no identity to show. This used to fall back
          to the design's fixture user, so the sidebar briefly claimed to be signed in as
          "Ada Lovelace" — a fake person is never a good loading state. */}
      <button className="side-item" onClick={onSettings} disabled={!user}>
        <span style={{ width: 20, height: 20, borderRadius: 5, background: 'var(--fill-2)', display: 'grid', placeItems: 'center', fontSize: 11, fontWeight: 700, color: 'var(--text-2)', flex: 'none' }}>
          {user?.initials ?? '·'}
        </span>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: user ? undefined : 'var(--text-3)' }}>
          {user?.name ?? 'Signing in…'}
        </span>
      </button>
    </div>
  );
}

export function Menu({ items, onClose, style }: any) {
  const ref = uR<HTMLDivElement>(null);
  uE(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    const t = setTimeout(() => { document.addEventListener('mousedown', h); document.addEventListener('keydown', k); }, 0);
    return () => { clearTimeout(t); document.removeEventListener('mousedown', h); document.removeEventListener('keydown', k); };
  }, [onClose]);
  return (
    <div className="popover" ref={ref} style={{ minWidth: 188, ...style }}>
      {items.map((it: any, k: number) => it === '-' ? <div className="menu-sep" key={k} /> : (
        <button className="menu-item" key={k} onClick={() => { onClose(); it.onClick && it.onClick(); }}
          style={it.danger ? { color: 'var(--fail)' } : undefined}>
          {it.icon && React.createElement(I[it.icon], { size: 13 })}{it.label}
          {it.hint && <span style={{ marginLeft: 'auto', color: 'var(--text-3)', fontSize: 11 }}>{it.hint}</span>}
        </button>
      ))}
    </div>
  );
}

export function Sheet({ title, children, footer, onClose, width }: any) {
  uE(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', k);
    return () => document.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet" style={width ? { width } : undefined}>
        <div style={{ padding: '16px 20px 0', textAlign: 'center' }}>
          <div style={{ fontSize: 15, fontWeight: 600 }}>{title}</div>
        </div>
        <div style={{ padding: '14px 20px 4px' }}>{children}</div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '14px 20px 18px' }}>{footer}</div>
      </div>
    </div>
  );
}

/* dismissLabel exists because "Cancel run" as the confirm action put two buttons reading
   "Cancel" side by side — the dismiss and the destructive one. Callers whose action is
   itself a cancellation pass something unambiguous ("Keep running"). */
export function ConfirmSheet({ title, message, confirmLabel = 'Delete', dismissLabel = 'Cancel', onConfirm, onClose }: any) {
  return (
    <Sheet title={title} onClose={onClose} width={400} footer={<>
      <button className="btn lg" onClick={onClose}>{dismissLabel}</button>
      <button className="btn lg" style={{ background: 'var(--fail)', color: '#fff', borderColor: 'transparent' }}
        onClick={() => { onConfirm(); onClose(); }}>{confirmLabel}</button>
    </>}>
      <div style={{ fontSize: 13, color: 'var(--text-2)', lineHeight: 1.55, textAlign: 'center' }}>{message}</div>
    </Sheet>
  );
}

export function Toast({ toast }: any) {
  if (!toast) return null;
  const tone = ({ success: 'var(--pass)', error: 'var(--fail)', heal: 'var(--heal)', info: 'var(--accent)' } as any)[toast.kind] || 'var(--accent)';
  const Ico = I[toast.icon || (toast.kind === 'heal' ? 'heal' : toast.kind === 'error' ? 'x' : 'check')];
  const body = <><span style={{ color: tone, display: 'grid' }}><Ico size={14} /></span>{toast.message}</>;
  // A toast that announces "your plan is ready" should also be the way to it.
  // Rendered as a button only when it leads somewhere, so a plain notice keeps
  // its non-interactive semantics.
  if (!toast.onClick) return <div className="toast" key={toast.k}>{body}</div>;
  return (
    <button className="toast" key={toast.k} onClick={toast.onClick}
      style={{ cursor: 'pointer', textAlign: 'left', font: 'inherit' }}>
      {body}
    </button>
  );
}

export function Stat({ label, value, unit, sub, tone, icon }: any) {
  const Ico = icon ? I[icon] : null;
  return (
    <div style={{ padding: '13px 15px', minWidth: 0 }}>
      <div className="stat-label" style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 600, color: 'var(--text-3)', lineHeight: 1.25 }}>
        {Ico && <Ico size={12} style={{ flex: 'none' }} />}{label}
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 4, marginTop: 5 }}>
        <span className="num" style={{ fontSize: 21, fontWeight: 600, letterSpacing: '-.02em', color: tone || 'var(--text)' }}>
          <CountUp value={value} />
        </span>
        {unit && <span style={{ fontSize: 12, color: 'var(--text-3)', fontWeight: 500 }}>{unit}</span>}
      </div>
      {sub && <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 2, lineHeight: 1.35 }}>{sub}</div>}
    </div>
  );
}

export function Sparkline({ data, w = 120, h = 30, color = 'var(--accent)', fill = true, strokeWidth = 1.5 }: any) {
  const max = Math.max(...data, 1), min = Math.min(...data);
  const pts = data.map((v: number, i: number) => [i / (data.length - 1) * w, h - 2 - ((v - min) / (max - min || 1)) * (h - 4)]);
  const d = pts.map((p: any, i: number) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
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

export function Ring({ value, size = 62, stroke = 6, color = 'var(--pass)', label, sub }: any) {
  const r = (size - stroke) / 2, c = 2 * Math.PI * r;
  // Start at zero and sweep to the real value on mount, so the arc reads as filling up
  // rather than appearing already full.
  const [v, setV] = uS(0);
  uE(() => { const t = setTimeout(() => setV(value), 60); return () => clearTimeout(t); }, [value]);
  return (
    <div style={{ position: 'relative', width: size, height: size, flex: 'none' }}>
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--fill-2)" strokeWidth={stroke} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={c * (1 - v / 100)}
          style={{ transition: 'stroke-dashoffset 1.1s cubic-bezier(.16,.84,.28,1)' }} />
      </svg>
      <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', textAlign: 'center', lineHeight: 1.1 }}>
        <div>
          <div className="num" style={{ fontSize: size > 50 ? 16 : 12, fontWeight: 600 }}>
            <CountUp value={label} ms={1000} />
          </div>
          {sub && <div style={{ fontSize: 11, color: 'var(--text-2)', fontWeight: 600, letterSpacing: '.02em' }}>{sub}</div>}
        </div>
      </div>
    </div>
  );
}

export function SourceTag({ source, tokens }: any) {
  const s = SOURCES[source];
  return (
    <span className="badge" style={{ background: 'var(--fill)', color: s.color, gap: 5 }}>
      <span className="dot" style={{ width: 5, height: 5, background: s.color }} />{s.short}
      <span style={{ color: 'var(--text-3)', fontFamily: 'var(--font-num)', fontWeight: 500 }}>
        {tokens ? `${fmt.n(tokens)} tok` : '0 tok'}
      </span>
    </span>
  );
}

/* SHOT_TEMPLATES + FauxShot removed: fake browser-chrome graphics used by the design
   to stand in for screenshots. The run screen shows the real captured image, and an
   honest empty state when a step has none, so drawing a convincing fake page would
   only be misleading. Recover from the design folder if a skeleton is ever wanted. */
