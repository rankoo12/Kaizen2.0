/* global React, I, fmt, SOURCES, STEPS, RUN, HISTORY, FOCUS_CASE, StatusBadge, StatusDot, Seg, Toolbar, Stat, Sparkline, FauxShot, SourceTag, Menu */

const { useState: uSr, useEffect: uEr, useRef: uRr } = React;

function StepPill({ verb }) {
  return <span className="mono-chip" style={{ minWidth: 54, justifyContent: 'center', textAlign: 'center', display: 'inline-block', fontSize: 11, fontWeight: 700, letterSpacing: '.04em' }}>{verb.toUpperCase()}</span>;
}

function StepRow({ st, sel, onSelect, landed, verdict }) {
  const s = window.STATUS[st.status];
  return (
    <div className={`row focus-row${sel ? ' sel' : ''}${landed && st.heal ? ' heal-row' : ''}`} onClick={onSelect} tabIndex={landed ? 0 : -1}
      onKeyDown={(e) => { if (e.key === 'Enter') onSelect(); }}
      style={{ alignItems: 'flex-start', padding: '9px 13px', opacity: landed ? 1 : .32, animation: landed && !st.heal ? 'rise .3s cubic-bezier(.32,.72,0,1) both' : undefined }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, paddingTop: 2, flex: 'none' }}>
        {landed && st.status !== 'pending'
          ? <span style={{ color: s.c, display: 'grid' }}>{React.createElement(I[s.icon], { size: 13 })}</span>
          : <span className="spinner" style={{ width: 12, height: 12 }} />}
        <span className="num" style={{ fontSize: 11, color: 'var(--text-3)' }}>{String(st.i).padStart(2, '0')}</span>
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', gap: 7, alignItems: 'center', flexWrap: 'wrap' }}>
          <StepPill verb={st.verb} />
          <span style={{ fontSize: 13, color: 'var(--text)', letterSpacing: '-.005em' }}>{st.text}</span>
        </div>
        {landed && (
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 5, flexWrap: 'wrap' }}>
            <SourceTag source={st.source} tokens={st.tokens} />
            <span className="num" style={{ fontSize: 11, color: 'var(--text-3)' }}>{fmt.ms(st.ms)}</span>
            {st.heal && <span className="badge" style={{ background: 'var(--heal-soft)', color: 'var(--heal)' }}><I.heal size={9} />Self-healed</span>}
            {st.captured && <span className="badge" style={{ background: 'var(--accent-soft)', color: 'var(--accent-text)' }}>{'{{'}{st.captured.key}{'}}'} = {st.captured.value}</span>}
            {verdict === 'good' && <span className="badge" style={{ background: 'var(--pass-soft)', color: 'var(--pass)' }}><I.pin size={9} />Pinned</span>}
            {verdict === 'wrong' && <span className="badge" style={{ background: 'var(--fail-soft)', color: 'var(--fail)' }}><I.block size={9} />Blocked</span>}
          </div>
        )}
        {landed && st.heal && (
          <div className="num" style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 6, fontSize: 11, minWidth: 0 }}>
            <span className="heal-old" style={{ color: 'var(--text-3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{st.heal.was}</span>
            <span className="heal-arrow" style={{ color: 'var(--heal)', display: 'grid', flex: 'none' }}><I.chevron size={10} /></span>
            <span className="heal-new" style={{ color: 'var(--heal)', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{st.selector}</span>
          </div>
        )}
      </div>
      {sel && <I.chevron size={12} style={{ color: 'var(--accent)', flex: 'none', marginTop: 3 }} />}
    </div>
  );
}

function Evidence({ st }) {
  const [view, setView] = uSr('after');
  const [zoom, setZoom] = uSr(false);
  uEr(() => {
    if (!zoom) return;
    const k = (e) => { if (e.key === 'Escape') setZoom(false); };
    document.addEventListener('keydown', k);
    return () => document.removeEventListener('keydown', k);
  }, [zoom]);
  const after = view === 'after';
  const url = st.shot === 'consent' ? 'app.acme.io/login' : undefined;
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span className="label">Evidence</span>
        <div style={{ flex: 1 }} />
        <Seg value={view} onChange={setView} options={[{ value: 'before', label: 'Before' }, { value: 'after', label: 'After' }]} />
      </div>
      <div key={view} className="rise">
        <FauxShot shot={st.shot} hl={after ? st.hl : null} miss={after && st.status === 'failed'}
          height={188} url={url} onZoom={() => setZoom(true)} />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 7, fontSize: 11, color: 'var(--text-3)' }}>
        <I.search size={11} />
        {after
          ? (st.hl ? 'The element Kaizen acted on, outlined. Click to enlarge.' : 'Page state after the step. Click to enlarge.')
          : 'Page state before the step ran. Click to enlarge.'}
      </div>
      {zoom && ReactDOM.createPortal((
        <div className="zoom-scrim" onClick={() => setZoom(false)}>
          <div style={{ width: '100%', maxWidth: 720 }} onClick={(e) => e.stopPropagation()}>
            <FauxShot shot={st.shot} hl={after ? st.hl : null} miss={after && st.status === 'failed'} height={430} url={url} scale={1.6} />
            <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginTop: 11, background: 'var(--overlay)', backdropFilter: 'blur(24px)', padding: '8px 10px', borderRadius: 10 }}>
              <Seg value={view} onChange={setView} options={[{ value: 'before', label: 'Before' }, { value: 'after', label: 'After' }]} />
              <span className="num" style={{ fontSize: 12, color: 'var(--text-2)' }}>step {String(st.i).padStart(2, '0')} · {st.selector}</span>
              <div style={{ flex: 1 }} />
              <button className="btn" onClick={() => setZoom(false)}>Done</button>
            </div>
          </div>
        </div>
      ), document.body)}
    </div>
  );
}

function Inspector({ st, verdict, onVerdict }) {
  if (!st) return null;
  const src = SOURCES[st.source];
  return (
    <div className="scroll slide-in inspector" key={st.i} style={{ flex: 'none', borderLeft: '.5px solid var(--sep)', background: 'var(--content)', padding: '15px 16px 40px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <StepPill verb={st.verb} />
        <span className="num" style={{ fontSize: 11, color: 'var(--text-3)' }}>Step {String(st.i).padStart(2, '0')}</span>
        <div style={{ flex: 1 }} />
        <StatusBadge status={st.status} />
      </div>
      <div style={{ fontSize: 15, fontWeight: 600, marginTop: 9, letterSpacing: '-.014em', lineHeight: 1.35 }}>{st.text}</div>

      <div style={{ marginTop: 16 }}><Evidence st={st} /></div>

      {/* the question that matters first */}
      <div style={{ marginTop: 18, padding: 13, borderRadius: 10, background: 'var(--fill)' }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>Was this the right element?</div>
        <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 3, lineHeight: 1.45 }}>
          Pinning always reuses it; blocking retires the pattern for good.
        </div>
        <div style={{ display: 'flex', gap: 7, marginTop: 10 }}>
          <button className="btn" style={{ flex: 1, ...(verdict === 'good' ? { background: 'var(--pass)', color: '#fff', borderColor: 'transparent' } : null) }}
            onClick={() => onVerdict(verdict === 'good' ? null : 'good')}>
            <I.pin size={12} />Yes — pin it
          </button>
          <button className="btn danger" style={{ flex: 1, ...(verdict === 'wrong' ? { background: 'var(--fail)', color: '#fff', borderColor: 'transparent' } : null) }}
            onClick={() => onVerdict(verdict === 'wrong' ? null : 'wrong')}>
            <I.block size={12} />No — block it
          </button>
        </div>
      </div>

      <div style={{ marginTop: 16 }}>
        {st.heal && (
          <Disclose title="What broke, how it recovered" defaultOpen accent="var(--heal)"
            badge={<span className="num" style={{ fontSize: 11, fontWeight: 700, color: 'var(--heal)' }}>{st.heal.errorClass}</span>}>
            <div style={{ fontSize: 13, lineHeight: 1.5 }}>{st.heal.why}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '10px 0', fontSize: 11 }}>
              <span className="num" style={{ textDecoration: 'line-through', color: 'var(--text-3)', wordBreak: 'break-all' }}>{st.heal.was}</span>
              <I.chevron size={11} style={{ color: 'var(--heal)', flex: 'none' }} />
              <span className="num" style={{ color: 'var(--heal)', fontWeight: 600, wordBreak: 'break-all' }}>{st.selector}</span>
            </div>
            <div style={{ fontSize: 13, color: 'var(--text-2)', lineHeight: 1.5 }}>{st.heal.how}</div>
          </Disclose>
        )}

        <Disclose title="How it was resolved"
          badge={<span className="num" style={{ fontSize: 11, color: st.tokens ? 'var(--warn)' : 'var(--text-2)', fontWeight: 600 }}>
            {src.label} · {st.tokens ? `${fmt.n(st.tokens)} tok` : '0 tok'}</span>}>
          <div style={{ fontSize: 13, color: 'var(--text-2)', lineHeight: 1.5 }}>{src.note}</div>
          <div className="label" style={{ marginTop: 11, marginBottom: 4 }}>Selector used</div>
          <div className="num" style={{ fontSize: 12, background: 'var(--fill)', padding: '8px 10px', borderRadius: 7, wordBreak: 'break-all', lineHeight: 1.5 }}>{st.selector}</div>
          {st.frame && <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 6 }}>Inside frame <span className="num">{st.frame}</span></div>}
          <div style={{ display: 'flex', marginTop: 11, border: '.5px solid var(--sep)', borderRadius: 8, overflow: 'hidden' }}>
            {[['Confidence', `${Math.round(st.conf * 100)}%`], ['Duration', fmt.ms(st.ms)], ['Retries', st.heal ? '1' : '0']].map(([l, v], k) => (
              <div key={l} style={{ flex: 1, padding: '8px 11px', borderRight: k < 2 ? '.5px solid var(--sep)' : 'none' }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-3)' }}>{l}</div>
                <div className="num" style={{ fontSize: 13, fontWeight: 600, marginTop: 1 }}>{v}</div>
              </div>
            ))}
          </div>
        </Disclose>

        {st.assertion && (
          <Disclose title="Assertion" badge={<span className="num" style={{ fontSize: 11, color: 'var(--pass)' }}>met</span>}>
            <div className="num" style={{ fontSize: 12, background: 'var(--pass-soft)', color: 'var(--pass)', padding: '9px 11px', borderRadius: 8, display: 'flex', alignItems: 'center', gap: 7 }}>
              <I.check size={12} />{st.assertion}
            </div>
          </Disclose>
        )}

        {st.captured && (
          <Disclose title="Captured for later steps" badge={<span className="num" style={{ fontSize: 11, color: 'var(--accent-text)' }}>{'{{'}{st.captured.key}{'}}'}</span>}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--fill)', padding: '9px 11px', borderRadius: 8 }}>
              <span className="num" style={{ fontSize: 12, color: 'var(--accent-text)' }}>{'{{'}{st.captured.key}{'}}'}</span>
              <span style={{ color: 'var(--text-3)' }}>=</span>
              <span style={{ fontSize: 13, fontWeight: 500 }}>{st.captured.value}</span>
            </div>
          </Disclose>
        )}
      </div>
    </div>
  );
}

function ActivityFeed({ steps, landed }) {
  const events = [];
  steps.slice(0, landed).forEach((st) => {
    events.push({ t: st.i, kind: 'resolve', text: `Resolving “${st.text}”`, sub: SOURCES[st.source].label });
    if (st.heal) events.push({ t: st.i, kind: 'heal', text: `${st.heal.errorClass} — healing`, sub: st.heal.how });
    events.push({ t: st.i, kind: st.status, text: `${st.verb} ${st.status}`, sub: `${fmt.ms(st.ms)} · ${st.tokens ? `${fmt.n(st.tokens)} tokens` : 'no tokens'}` });
  });
  return (
    <div className="list" style={{ margin: '0 0 16px' }}>
      {events.map((e, k) => {
        const color = e.kind === 'heal' ? 'var(--heal)' : e.kind === 'resolve' ? 'var(--text-3)' : (window.STATUS[e.kind] || window.STATUS.pending).c;
        return (
          <div className="row" key={k} style={{ cursor: 'default', padding: '7px 13px', alignItems: 'flex-start' }}>
            <span className="num" style={{ fontSize: 11, color: 'var(--text-3)', width: 22, flex: 'none', paddingTop: 2 }}>{String(e.t).padStart(2, '0')}</span>
            <span className="dot" style={{ background: color, marginTop: 6 }} />
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 13 }}>{e.text}</div>
              <div style={{ fontSize: 11, color: 'var(--text-3)' }}>{e.sub}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function HistoryTab({ onOpenCompare }) {
  return (
    <>
      <div className="card" style={{ marginBottom: 14, padding: '14px 16px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between' }}>
          <div>
            <div className="card-t">Cost per run</div>
            <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 2 }}>
              This test cost {fmt.n(HISTORY[0].tokens)} tokens the first time and {fmt.n(HISTORY[HISTORY.length - 1].tokens)} last run.
            </div>
          </div>
          <span className="badge" style={{ background: 'var(--pass-soft)', color: 'var(--pass)' }}>
            <I.arrowDown size={9} />{Math.round((1 - HISTORY[HISTORY.length - 1].tokens / HISTORY[0].tokens) * 100)}% CHEAPER
          </span>
        </div>
        <div style={{ marginTop: 12, overflow: 'hidden' }}>
          <Sparkline data={HISTORY.map((h) => h.tokens)} w={720} h={64} color="var(--cache)" />
        </div>
      </div>
      <div className="list">
        <div className="list-h"><span style={{ width: 8 }} /><span style={{ flex: 1 }}>RUN</span><span className="hide-md" style={{ width: 90 }}>STATUS</span><span className="hide-lg" style={{ width: 80, textAlign: 'right' }}>DURATION</span><span style={{ width: 80, textAlign: 'right' }}>TOKENS</span><span style={{ width: 100, textAlign: 'right' }}>WHEN</span><span style={{ width: 30 }} /></div>
        {[...HISTORY].reverse().map((h, i) => (
          <div className="row" key={h.id} onClick={() => i === 0 || onOpenCompare()}>
            <StatusDot status={h.status} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="row-t num">#{h.n}</div>
              <div className="row-s">{h.trigger} · {h.branch}</div>
            </div>
            <span className="hide-md" style={{ width: 90 }}><StatusBadge status={h.status} size="sm" /></span>
            <span className="num hide-lg" style={{ width: 80, textAlign: 'right', fontSize: 12 }}>{fmt.ms(h.ms)}</span>
            <span className="num" style={{ width: 80, textAlign: 'right', fontSize: 12, color: h.tokens === 0 ? 'var(--cache)' : 'var(--text)' }}>{h.tokens === 0 ? 'free' : fmt.n(h.tokens)}</span>
            <span className="num" style={{ width: 100, textAlign: 'right', fontSize: 12, color: 'var(--text-2)' }}>{h.when}</span>
            <span style={{ width: 30, display: 'grid', placeItems: 'center' }}><I.chevron size={12} style={{ color: 'var(--text-3)' }} /></span>
          </div>
        ))}
      </div>
    </>
  );
}

function RunScreen({ onBack, showToast, liveDefault }) {
  const [tab, setTab] = uSr('steps');
  const [sel, setSel] = uSr(4);
  const [live, setLive] = uSr(!!liveDefault);
  const [landed, setLanded] = uSr(liveDefault ? 0 : STEPS.length);
  const [verdicts, setVerdicts] = uSr({});
  const [menu, setMenu] = uSr(false);
  const healed = uRr(false);

  uEr(() => {
    if (!live || landed >= STEPS.length) { if (live && landed >= STEPS.length) setLive(false); return; }
    const st = STEPS[landed];
    const id = setTimeout(() => {
      setLanded(landed + 1);
      setSel(st.i);
      if (st.heal && !healed.current) { healed.current = true; }
    }, landed === 0 ? 500 : 620 + Math.min(st.ms, 1400) / 3);
    return () => clearTimeout(id);
  }, [live, landed]);

  const restart = () => { healed.current = false; setLanded(0); setSel(null); setLive(true); setTab('steps'); };
  const shown = STEPS.slice(0, Math.max(landed, 0));
  const done = landed >= STEPS.length;
  const tokens = shown.reduce((a, s) => a + s.tokens, 0);
  const ms = shown.reduce((a, s) => a + s.ms, 0);
  const cacheSteps = shown.filter((s) => s.tokens === 0).length;
  const status = !done ? 'running' : shown.some((s) => s.status === 'failed') ? 'failed' : shown.some((s) => s.heal) ? 'healed' : 'passed';
  const selStep = STEPS.find((s) => s.i === sel && s.i <= landed);

  return (
    <>
      <Toolbar back={onBack} title={FOCUS_CASE.name} sub={<span className="num">#{RUN.n} · {RUN.env.replace('https://', '')} · {RUN.trigger}</span>}>
        <Seg value={tab} onChange={setTab} options={[
          { value: 'steps', label: 'Steps' }, { value: 'activity', label: 'Activity' }, { value: 'history', label: 'History' },
        ]} />
        <button className="btn" onClick={restart}><I.play size={12} />Re-run</button>
        <div style={{ position: 'relative' }}>
          <button className="btn icon" onClick={() => setMenu(!menu)}><I.more size={14} /></button>
          {menu && <Menu onClose={() => setMenu(false)} style={{ top: 30, right: 0 }} items={[
            { label: live ? 'Pause live replay' : 'Watch live replay', icon: live ? 'pause' : 'play', onClick: () => (done ? restart() : setLive(!live)) },
            { label: 'Compare with previous run', icon: 'target' },
            { label: 'Copy run link', icon: 'copy' },
            '-',
            { label: 'Download evidence bundle', icon: 'arrowDown' },
            { label: 'Cancel run', icon: 'block', danger: true },
          ]} />}
        </div>
      </Toolbar>

      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <div className="scroll" style={{ flex: 1, padding: '16px 20px 40px', minWidth: 0 }}>
          {/* run summary */}
          <div className="card" style={{ display: 'flex', alignItems: 'center', marginBottom: 14, overflow: 'hidden' }}>
            <div style={{ padding: '13px 17px', display: 'flex', alignItems: 'center', gap: 12, borderRight: '.5px solid var(--sep)', minWidth: 0, flex: '1 1 210px' }}>
              {!done
                ? <span className="spinner" style={{ width: 22, height: 22, borderWidth: 2.4 }} />
                : <span style={{ width: 26, height: 26, borderRadius: '50%', background: window.STATUS[status].s, color: window.STATUS[status].c, display: 'grid', placeItems: 'center', flex: 'none' }}>
                    {React.createElement(I[window.STATUS[status].icon], { size: 14 })}
                  </span>}
              <div>
                <div style={{ fontSize: 15, fontWeight: 600, letterSpacing: '-.01em' }}>
                  {!done ? `Running step ${Math.min(landed + 1, STEPS.length)} of ${STEPS.length}` : status === 'healed' ? 'Passed, self-healed' : window.STATUS[status].label}
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 1 }}>
                  {done ? `${STEPS.length} steps · started ${RUN.startedAt}` : 'Polling every 2s'}
                </div>
              </div>
            </div>
            <div style={{ display: 'flex', flex: '1 1 auto', minWidth: 0 }}>
              <div style={{ flex: '1 1 148px', minWidth: 0, borderRight: '.5px solid var(--sep)' }}><Stat label="Duration" value={fmt.ms(ms)} sub={done ? `${fmt.ms(RUN.prevMs - ms)} faster than last` : 'elapsed'} /></div>
              <div style={{ flex: '1 1 148px', minWidth: 0, borderRight: '.5px solid var(--sep)' }}><Stat label="Tokens spent" value={fmt.n(tokens)} tone={tokens ? 'var(--warn)' : 'var(--cache)'} sub={`was ${fmt.n(RUN.prevTokens)} last run`} /></div>
              <div className="hide-md" style={{ flex: 1, borderRight: '.5px solid var(--sep)' }}><Stat label="From memory" value={`${cacheSteps}/${Math.max(shown.length, 1)}`} tone="var(--cache)" sub="steps needed no AI" /></div>
              <div className="hide-lg" style={{ flex: 'none', width: 150, padding: '13px 15px' }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-3)' }}>Progress</div>
                <div className="meter" style={{ marginTop: 9 }}><i style={{ width: `${landed / STEPS.length * 100}%`, background: window.STATUS[status].c }} /></div>
                <div className="num" style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 6 }}>{landed}/{STEPS.length} steps</div>
              </div>
            </div>
          </div>

          {status === 'healed' && done && (
            <div className="card rise" style={{ display: 'flex', gap: 11, alignItems: 'flex-start', padding: '12px 15px', marginBottom: 14, background: 'var(--heal-soft)', boxShadow: 'none' }}>
              <I.heal size={15} style={{ color: 'var(--heal)', marginTop: 1, flex: 'none' }} />
              <div>
                <div style={{ fontSize: 13, fontWeight: 600 }}>One step healed itself, so nobody has to fix this test</div>
                <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 3, lineHeight: 1.5 }}>
                  The password field lost its id in the new markup. Kaizen re-found it, re-learned the selector, and the run passed. Next run resolves it from memory for free.
                </div>
              </div>
              <button className="btn" style={{ flex: 'none', marginLeft: 'auto' }} onClick={() => { setTab('steps'); setSel(4); }}>See the step</button>
            </div>
          )}

          {tab === 'steps' && (
            <div className="list">
              <div className="list-h"><span style={{ flex: 1 }}>STEPS · IN ORDER, STOPS ON FIRST UNHEALED FAILURE</span><span>{landed}/{STEPS.length}</span></div>
              {STEPS.map((st) => (
                <StepRow key={st.i} st={st} sel={sel === st.i} landed={st.i <= landed}
                  verdict={verdicts[st.i]} onSelect={() => st.i <= landed && setSel(st.i)} />
              ))}
            </div>
          )}
          {tab === 'activity' && <ActivityFeed steps={STEPS} landed={landed} />}
          {tab === 'history' && <HistoryTab onOpenCompare={() => showToast('Comparison view — coming from the run diff endpoint', 'info')} />}
        </div>

        {tab !== 'history' && selStep && (
          <Inspector st={selStep} verdict={verdicts[selStep.i]}
            onVerdict={(v) => {
              setVerdicts({ ...verdicts, [selStep.i]: v });
              if (v) showToast(v === 'good' ? 'Element pinned — always reused for this step' : 'Pattern blocked — the brain will never use it again', v === 'good' ? 'success' : 'error');
            }} />
        )}
      </div>
    </>
  );
}

Object.assign(window, { RunScreen });
