'use client';
/* Game layer — ported from `Kaizen (2)/native/game.jsx`.

   Satisfactory's satisfaction: numbers that climb, and a completion panel that tallies
   what the automation just saved you. The design's automation-tier system (Tier 1..5)
   was deliberately left out.

   Every number the HUD shows comes from the run that just finished and the one before
   it — nothing here is estimated. */
/* eslint-disable @typescript-eslint/no-explicit-any */
import * as React from 'react';
import { I } from './icons';
import { fmt } from './data';

const { useState, useEffect, useRef } = React;

const reducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false;

/** Counts a formatted value up to itself: "1,284" · "2.7k" · "91%" · "9.07s".
 *  Non-numeric values (like "—") pass straight through. */
export function CountUp({ value, ms = 780 }: { value: any; ms?: number }) {
  const str = String(value);
  const m = str.match(/^(-?[\d,]*\.?\d+)(.*)$/);
  const target = m ? parseFloat(m[1].replace(/,/g, '')) : null;
  const suffix = m ? m[2] : '';
  const decimals = m && m[1].includes('.') ? m[1].split('.')[1].length : 0;
  const grouped = m ? m[1].includes(',') : false;
  const [n, setN] = useState<number | null>(target);
  const from = useRef(0);

  useEffect(() => {
    if (target === null || reducedMotion()) { setN(target); return; }
    const start = performance.now();
    const a = from.current;
    const b = target;
    if (a === b) { setN(b); return; }
    let raf = 0;
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / ms);
      const e = 1 - Math.pow(1 - p, 4);
      setN(a + (b - a) * e);
      if (p < 1) raf = requestAnimationFrame(tick);
      else from.current = b;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);

  if (target === null || n === null) return <>{str}</>;
  const out = n.toFixed(decimals);
  return <>{(grouped
    ? Number(out).toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
    : out) + suffix}</>;
}

export type RunPayoff = {
  status: string;
  steps: number;
  /** Steps that resolved without a model call. */
  cacheSteps: number;
  tokens: number;
  /** Previous run's totals — null when this is the first run of the test. */
  prevTokens: number | null;
  ms: number;
  prevMs: number | null;
  /** Selectors this run added to memory: AI resolutions plus successful heals. */
  learned: number;
};

/** The payoff panel after a live run. Rows with no honest source are omitted rather
 *  than shown as zero — a first run has nothing to compare against. */
export function RunCompleteHUD({ payoff, onClose }: { payoff: RunPayoff; onClose: () => void }) {
  const { status, steps, cacheSteps, tokens, prevTokens, ms, prevMs, learned } = payoff;

  useEffect(() => {
    const t = setTimeout(onClose, 6200);
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', k);
    return () => { clearTimeout(t); document.removeEventListener('keydown', k); };
  }, [onClose]);

  const tone = status === 'failed' ? 'var(--fail)' : status === 'healed' ? 'var(--heal)' : 'var(--pass)';
  const rows: Array<[string, string, string | null]> = [
    ['Steps completed', `${steps}/${steps}`, null],
    ['Resolved from memory', `${cacheSteps}/${steps}`, 'var(--heal)'],
    ['Tokens spent', fmt.n(tokens), tokens ? 'var(--accent-text)' : 'var(--pass)'],
  ];
  if (prevTokens != null) rows.push(['Tokens saved vs. last run', fmt.n(Math.max(0, prevTokens - tokens)), 'var(--pass)']);
  if (prevMs != null) rows.push(['Time saved vs. last run', fmt.ms(Math.max(0, prevMs - ms)), 'var(--pass)']);
  if (learned > 0) rows.push(['Selectors learned', `+${learned}`, 'var(--heal)']);

  const Ico = I[status === 'failed' ? 'x' : status === 'healed' ? 'heal' : 'check'];
  const freeNext = cacheSteps + learned;

  return (
    <div className="hud" onClick={onClose}>
      <div className="hud-panel" onClick={(e) => e.stopPropagation()} role="status">
        <div className="hud-head" style={{ background: tone }}>
          <span style={{ display: 'grid' }}><Ico size={15} /></span>
          {status === 'failed' ? 'Run failed' : status === 'healed' ? 'Run complete — self-healed' : 'Run complete'}
        </div>
        <div style={{ padding: '4px 0' }}>
          {rows.map(([label, value, colour], i) => (
            <div className="hud-row" key={label} style={{ animationDelay: `${180 + i * 90}ms` }}>
              <span style={{ fontSize: 12.5, color: 'var(--text-2)' }}>{label}</span>
              <span className="num" style={{ fontSize: 14, fontWeight: 600, color: colour || 'var(--text)' }}>
                <CountUp value={value} ms={620} />
              </span>
            </div>
          ))}
        </div>
        <div className="hud-foot">
          <span style={{ fontSize: 11.5, color: 'var(--text-3)' }}>
            {steps > 0 && `Next run resolves ${Math.min(freeNext, steps)} of ${steps} steps for free`}
          </span>
          <button className="btn" onClick={onClose}>Dismiss</button>
        </div>
      </div>
    </div>
  );
}
