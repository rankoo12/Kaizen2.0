/* global React, I, fmt */
// Game layer — Satisfactory's satisfaction: numbers that climb, tiers you unlock,
// and a completion panel that tallies what the automation just saved you.

const { useState: uSg, useEffect: uEg, useRef: uRg } = React;

const REDUCED = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Counts a formatted value up to itself: "1,284" · "2.7k" · "91%" · "9.07s"
function CountUp({ value, ms = 780 }) {
  const str = String(value);
  const m = str.match(/^(-?[\d,]*\.?\d+)(.*)$/);
  const target = m ? parseFloat(m[1].replace(/,/g, '')) : null;
  const suffix = m ? m[2] : '';
  const decimals = m && m[1].includes('.') ? m[1].split('.')[1].length : 0;
  const grouped = m ? m[1].includes(',') : false;
  const [n, setN] = uSg(target);
  const from = uRg(0);

  uEg(() => {
    if (target === null || REDUCED()) { setN(target); return; }
    const start = performance.now(), a = from.current, b = target;
    if (a === b) { setN(b); return; }
    let raf;
    const tick = (t) => {
      const p = Math.min(1, (t - start) / ms);
      const e = 1 - Math.pow(1 - p, 4);
      setN(a + (b - a) * e);
      if (p < 1) raf = requestAnimationFrame(tick); else from.current = b;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);

  if (target === null) return <>{str}</>;
  const out = n.toFixed(decimals);
  return <>{(grouped ? Number(out).toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) : out) + suffix}</>;
}

// ── Automation tier: the workspace levels up as Kaizen learns ────────────────
const TIERS = [
  { n: 1, name: 'Manual', at: 0, note: 'Every step still asks the AI.' },
  { n: 2, name: 'Assisted', at: 40, note: 'Common elements come from memory.' },
  { n: 3, name: 'Recalling', at: 60, note: 'Most steps resolve without a model call.' },
  { n: 4, name: 'Self-healing', at: 75, note: 'Broken selectors repair themselves.' },
  { n: 5, name: 'Automated', at: 90, note: 'Runs are effectively free.' },
];

function tierFor(pct) {
  let cur = TIERS[0];
  for (const t of TIERS) if (pct >= t.at) cur = t;
  const next = TIERS.find((t) => t.at > cur.at);
  const span = next ? next.at - cur.at : 1;
  return { cur, next, progress: next ? Math.min(1, (pct - cur.at) / span) : 1 };
}

function TierMeter({ pct, compact }) {
  const { cur, next, progress } = tierFor(pct);
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <span className="tier-chip">Tier {cur.n}</span>
        <span style={{ fontSize: 13, fontWeight: 600, letterSpacing: '-.01em' }}>{cur.name}</span>
      </div>
      {!compact && <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 3, lineHeight: 1.4 }}>{cur.note}</div>}
      <div className="meter" style={{ marginTop: 8, height: 7 }}>
        <i style={{ width: `${progress * 100}%`, background: 'var(--accent)' }} />
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 5 }}>
        {next
          ? <>Tier {next.n} · {next.name} at <span className="num">{next.at}%</span> resolved from memory</>
          : <>Fully automated — nothing left to unlock</>}
      </div>
    </div>
  );
}

// ── Run complete: the payoff panel ──────────────────────────────────────────
function RunCompleteHUD({ status, steps, cacheSteps, tokens, prevTokens, ms, prevMs, learned, onClose }) {
  uEg(() => {
    const t = setTimeout(onClose, 6200);
    const k = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', k);
    return () => { clearTimeout(t); document.removeEventListener('keydown', k); };
  }, [onClose]);

  const saved = Math.max(0, prevTokens - tokens);
  const faster = Math.max(0, prevMs - ms);
  const tone = status === 'failed' ? 'var(--fail)' : status === 'healed' ? 'var(--heal)' : 'var(--pass)';
  const rows = [
    ['Steps completed', `${steps}/${steps}`, null],
    ['Resolved from memory', `${cacheSteps}/${steps}`, 'var(--heal)'],
    ['Tokens spent', fmt.n(tokens), tokens ? 'var(--accent-text)' : 'var(--pass)'],
    ['Tokens saved vs. last run', fmt.n(saved), 'var(--pass)'],
    ['Time saved vs. last run', fmt.ms(faster), 'var(--pass)'],
    ['Selectors learned', `+${learned}`, 'var(--heal)'],
  ];

  return (
    <div className="hud" onClick={onClose}>
      <div className="hud-panel" onClick={(e) => e.stopPropagation()}>
        <div className="hud-head" style={{ background: tone }}>
          <span style={{ display: 'grid' }}>{React.createElement(I[status === 'failed' ? 'x' : status === 'healed' ? 'heal' : 'check'], { size: 15 })}</span>
          {status === 'failed' ? 'Run failed' : status === 'healed' ? 'Run complete — self-healed' : 'Run complete'}
        </div>
        <div style={{ padding: '4px 0' }}>
          {rows.map(([l, v, c], i) => (
            <div className="hud-row" key={l} style={{ animationDelay: `${180 + i * 90}ms` }}>
              <span style={{ fontSize: 12.5, color: 'var(--text-2)' }}>{l}</span>
              <span className="num" style={{ fontSize: 14, fontWeight: 600, color: c || 'var(--text)' }}>
                <CountUp value={v} ms={620} />
              </span>
            </div>
          ))}
        </div>
        <div className="hud-foot">
          <span style={{ fontSize: 11.5, color: 'var(--text-3)' }}>Next run resolves {cacheSteps + (status === 'healed' ? 1 : 0)} of {steps} steps for free</span>
          <button className="btn" onClick={onClose}>Dismiss</button>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { CountUp, TierMeter, tierFor, TIERS, RunCompleteHUD });
