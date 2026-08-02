/* global React, I, fmt, STEPS, SOURCES */
// Line view — a run as a production line. Isometric CSS-3D: the browser session
// is the item on the belt, each step is a machine, cached machines run free and
// the AI machine draws power. A heal is a machine repairing itself mid-shift.

const { useState: uSl, useEffect: uEl, useRef: uRl } = React;

const MACHINE_W = 124;

function Machine({ st, state, active, onClick }) {
  const src = SOURCES[st.source];
  const powered = st.tokens > 0;
  const done = state === 'done';
  const tone = st.heal ? 'var(--heal)' : powered ? 'var(--accent)' : 'var(--pass)';
  return (
    <button className={`mach${active ? ' mach-active' : ''}${done ? ' mach-done' : ''}`} onClick={onClick}
      style={{ '--tone': tone, opacity: state === 'idle' ? .34 : 1 }}>
      <span className="mach-label">
        <span className="num" style={{ fontSize: 11, color: 'var(--text-3)' }}>{String(st.i).padStart(2, '0')}</span>
        <span className="mach-verb">{st.verb}</span>
      </span>
      <span className="mach-plate" />
      <span className="mach-body">
        <span className="mach-face">
          <span className="mach-cap" />
          <span className="mach-ico">{React.createElement(I[st.heal ? 'heal' : powered ? 'sparkle' : 'db'], { size: 16 })}</span>
          <span className="mach-src">{src.short}</span>
          <span className="mach-power"><i style={{ width: powered ? '100%' : '18%' }} /></span>
        </span>
      </span>
      <span className="mach-cost num">{st.tokens ? fmt.n(st.tokens) : 'free'}</span>
      {state === 'run' && <span className="mach-beam" />}
    </button>
  );
}

function LineView({ landed, live, onSelect, sel }) {
  const scroller = uRl(null);
  const total = STEPS.length;
  const at = Math.min(landed, total);

  uEl(() => {
    if (!scroller.current) return;
    const x = Math.max(0, (at - 1) * MACHINE_W - scroller.current.clientWidth / 2 + MACHINE_W);
    scroller.current.scrollTo({ left: x, behavior: 'smooth' });
  }, [at]);

  const tokens = STEPS.slice(0, at).reduce((a, s) => a + s.tokens, 0);
  const free = STEPS.slice(0, at).filter((s) => !s.tokens).length;

  return (
    <div className="card" style={{ overflow: 'hidden' }}>
      <div className="card-h">
        <I.bolt size={13} style={{ color: 'var(--accent)' }} />
        <span className="card-t">Production line</span>
        <span style={{ fontSize: 12, color: 'var(--text-2)' }}>
          The session moves down the belt. Machines that remember run for free; the one that has to think draws power.
        </span>
        <div style={{ flex: 1 }} />
        <span className="badge" style={{ background: 'var(--pass-soft)', color: 'var(--pass)' }}>{free} free</span>
        <span className="badge" style={{ background: 'var(--accent-soft)', color: 'var(--accent-text)' }}>{fmt.n(tokens)} tok drawn</span>
      </div>

      <div className="line-scroll scroll" ref={scroller}>
        <div className="line-scene">
          <div className="line-stage" style={{ width: total * MACHINE_W + 80 }}>
            <div className="belt">
              <div className="belt-run" style={{ animationPlayState: live && at < total ? 'running' : 'paused' }} />
            </div>
            <div className="line-row">
              {STEPS.map((st, i) => (
                <Machine key={st.i} st={st} active={sel === st.i}
                  state={i < at - 1 ? 'done' : i === at - 1 ? (live && at < total ? 'run' : 'done') : 'idle'}
                  onClick={() => st.i <= landed && onSelect(st.i)} />
              ))}
            </div>
            <div className="item" style={{ transform: `translateX(${at * MACHINE_W - MACHINE_W / 2 + 26}px)` }}>
              <span className="item-cube" />
            </div>
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '10px 14px', borderTop: '.5px solid var(--sep)', flexWrap: 'wrap' }}>
        {[['From memory', 'var(--pass)', 'Runs on stored selectors — no model call'],
          ['Drawing power', 'var(--accent)', 'Reads the page with the AI, once'],
          ['Repaired itself', 'var(--heal)', 'Selector broke, machine re-learned it']].map(([l, c, note]) => (
          <span key={l} style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 11.5, color: 'var(--text-2)' }}>
            <span className="dot" style={{ background: c, boxShadow: `0 0 8px -1px ${c}` }} />
            <b style={{ fontWeight: 600, color: 'var(--text)' }}>{l}</b> {note}
          </span>
        ))}
      </div>
    </div>
  );
}

Object.assign(window, { LineView });
