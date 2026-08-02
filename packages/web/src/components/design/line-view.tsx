'use client';
/* Production line — ported from `Kaizen (2)/native/line-view.jsx`.

   A run as a production line. Isometric CSS-3D: the browser session is the item on the
   belt, each step is a machine, machines that remember run free and the machine that has
   to think draws power. A heal is a machine repairing itself mid-shift.

   The design read a global STEPS fixture; this takes the run screen's real rows, so every
   machine's source tag, cost and heal state is what actually happened. */
/* eslint-disable @typescript-eslint/no-explicit-any */
import * as React from 'react';
import { I } from './icons';
import { fmt, SOURCES } from './data';

const { useEffect, useRef } = React;

const MACHINE_W = 124;

export type LineStep = {
  i: number;
  verb: string;
  /** Design source key (pattern/cache/vector/global/llm), or null when nothing resolved. */
  source: string | null;
  tokens: number;
  healed: boolean;
  failed: boolean;
  landed: boolean;
};

function Machine({ st, state, active, onClick }: { st: LineStep; state: string; active: boolean; onClick: () => void }) {
  const src = st.source ? SOURCES[st.source] : null;
  const powered = st.tokens > 0;
  /* A failed step is the one thing on this belt you must not miss, so it outranks every
     other state: red, thrown askew, and the line stops there. */
  const tone = st.failed ? 'var(--fail)' : st.healed ? 'var(--heal)' : powered ? 'var(--accent)' : 'var(--pass)';
  const Ico = I[st.failed ? 'x' : st.healed ? 'heal' : powered ? 'sparkle' : 'db'];
  return (
    <button className={`mach${active ? ' mach-active' : ''}${state === 'done' ? ' mach-done' : ''}${st.failed ? ' mach-broken' : ''}`} onClick={onClick}
      title={src ? src.label : undefined}
      style={{ ['--tone' as any]: tone, opacity: state === 'idle' ? .34 : 1 }}>
      <span className="mach-label">
        <span className="num" style={{ fontSize: 11, color: 'var(--text-3)' }}>{String(st.i).padStart(2, '0')}</span>
        <span className="mach-verb">{st.verb}</span>
      </span>
      <span className="mach-plate" />
      <span className="mach-body">
        <span className="mach-face">
          <span className="mach-cap" />
          <span className="mach-ico"><Ico size={16} /></span>
          <span className="mach-src">{src ? src.short : '—'}</span>
          <span className="mach-power"><i style={{ width: powered ? '100%' : '18%' }} /></span>
        </span>
      </span>
      <span className="mach-cost num" style={st.failed ? { color: 'var(--fail)', fontWeight: 600 } : undefined}>
        {st.failed ? 'failed' : st.tokens ? fmt.n(st.tokens) : 'free'}
      </span>
      {state === 'run' && <span className="mach-beam" />}
    </button>
  );
}

export function LineView({ steps, live, sel, onSelect }: {
  steps: LineStep[]; live: boolean; sel: number | null; onSelect: (i: number) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const total = steps.length;
  const at = Math.min(steps.filter((s) => s.landed).length, total);

  // Keep the item on the belt centred as it advances.
  useEffect(() => {
    if (!scroller.current) return;
    const x = Math.max(0, (at - 1) * MACHINE_W - scroller.current.clientWidth / 2 + MACHINE_W);
    scroller.current.scrollTo({ left: x, behavior: 'smooth' });
  }, [at]);

  const landedSteps = steps.filter((s) => s.landed);
  const tokens = landedSteps.reduce((a, s) => a + s.tokens, 0);
  const free = landedSteps.filter((s) => !s.tokens && s.source).length;

  return (
    <div className="card" style={{ overflow: 'hidden' }}>
      <div className="card-h">
        <I.bolt size={13} style={{ color: 'var(--accent)' }} />
        <span className="card-t">Production line</span>
        <span className="hide-md" style={{ fontSize: 12, color: 'var(--text-2)' }}>
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
              {steps.map((st, i) => (
                <Machine key={st.i} st={st} active={sel === st.i}
                  state={i < at - 1 ? 'done' : i === at - 1 ? (live && at < total ? 'run' : 'done') : 'idle'}
                  onClick={() => st.landed && onSelect(st.i)} />
              ))}
            </div>
            <div className="item" style={{ transform: `translateX(${at * MACHINE_W - MACHINE_W / 2 + 26}px)` }}>
              <span className="item-cube" />
            </div>
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '10px 14px', borderTop: '.5px solid var(--sep)', flexWrap: 'wrap' }}>
        {([['From memory', 'var(--pass)', 'Runs on stored selectors — no model call'],
          ['Drawing power', 'var(--accent)', 'Reads the page with the AI, once'],
          ['Repaired itself', 'var(--heal)', 'Selector broke, machine re-learned it'],
          ['Broke down', 'var(--fail)', 'The step failed — the line stops here']] as const).map(([l, c, note]) => (
          <span key={l} style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 11.5, color: 'var(--text-2)' }}>
            <span className="dot" style={{ background: c, boxShadow: `0 0 8px -1px ${c}` }} />
            <b style={{ fontWeight: 600, color: 'var(--text)' }}>{l}</b> {note}
          </span>
        ))}
      </div>
    </div>
  );
}
