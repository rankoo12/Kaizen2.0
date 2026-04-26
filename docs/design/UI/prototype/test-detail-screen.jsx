/* global React, Icon, StatusDot, FOCUS_CASE, FOCUS_STEPS, FOCUS_RUNS */

const { useState: useStateDet } = React;

function TestDetailScreen({ caseId, onBack, vizMode = 'timeline' }) {
  const tc = (window.ALL_CASES || []).find((c) => c.id === caseId) || FOCUS_CASE;
  const [activeRun, setActiveRun] = useStateDet(FOCUS_RUNS[0].id);
  const [activeStep, setActiveStep] = useStateDet('st6');
  const [viz, setViz] = useStateDet(vizMode);
  React.useEffect(() => setViz(vizMode), [vizMode]);

  const run = FOCUS_RUNS.find((r) => r.id === activeRun);
  const stepRuns = computeStepRuns(FOCUS_STEPS);
  const totalDur = stepRuns.reduce((s, r) => s + r.dur, 0);

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ padding: '20px 28px 16px', borderBottom: '1px solid var(--border-subtle)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
          <button onClick={onBack} className="btn btn-ghost btn-sm">
            <Icon name="arrowLeft" size={13} />
          </button>
          <span className="eyebrow">{tc.suiteName}</span>
          <Icon name="chevronRight" size={11} style={{ color: 'var(--text-faint)' }} />
          <span className="font-mono" style={{ fontSize: 11, color: 'var(--text-low)' }}>#{tc.id.slice(-6)}</span>
          <div style={{ flex: 1 }} />
          <span className="chip" style={{ fontSize: 9, padding: '2px 6px' }}>
            <Icon name="branch" size={9} /> main
          </span>
          <span style={{ fontSize: 11, color: 'var(--text-low)' }}>updated 12m ago</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 24 }}>
          <h1 className="font-display" style={{ fontSize: 28, fontWeight: 600, letterSpacing: '-0.02em', color: 'var(--text-hi)', margin: 0 }}>
            {tc.name}
          </h1>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-sm"><Icon name="copy" size={12} /> Duplicate</button>
            <button className="btn btn-sm"><Icon name="diff" size={12} /> Compare runs</button>
            <button className="btn btn-primary btn-sm">
              <Icon name="play" size={11} /> Run again
            </button>
          </div>
        </div>
      </div>

      <RunSummaryStrip run={run} />

      <div style={{ flex: 1, display: 'grid', gridTemplateColumns: '220px 1fr 380px', overflow: 'hidden' }}>
        <RunHistoryRail runs={FOCUS_RUNS} active={activeRun} onSelect={setActiveRun} />

        <div style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden', borderRight: '1px solid var(--border-subtle)' }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '10px 20px', borderBottom: '1px solid var(--border-subtle)',
            background: 'var(--app-bg)',
          }}>
            <span className="eyebrow">execution</span>
            <div style={{ flex: 1 }} />
            <div className="seg" style={{
              display: 'flex', background: 'var(--surface)', border: '1px solid var(--border-subtle)',
              borderRadius: 8, padding: 2,
            }}>
              {[
                { id: 'timeline', label: 'Timeline', icon: 'list' },
                { id: 'gantt', label: 'Gantt', icon: 'signal' },
                { id: 'logs', label: 'Logs', icon: 'cpu' },
              ].map((v) => (
                <button key={v.id} onClick={() => setViz(v.id)} style={{
                  border: 'none', padding: '4px 10px', borderRadius: 6,
                  background: viz === v.id ? 'var(--surface-elevated)' : 'transparent',
                  color: viz === v.id ? 'var(--text-hi)' : 'var(--text-mid)',
                  fontSize: 11, fontWeight: 500, display: 'flex', alignItems: 'center', gap: 5,
                }}>
                  <Icon name={v.icon} size={11} /> {v.label}
                </button>
              ))}
            </div>
          </div>

          <GanttStrip stepRuns={stepRuns} totalDur={totalDur} active={activeStep} onSelect={setActiveStep} />

          <div style={{ flex: 1, overflow: 'auto', padding: '14px 20px 60px' }}>
            {viz === 'timeline' && <StepTimeline steps={FOCUS_STEPS} stepRuns={stepRuns} active={activeStep} onSelect={setActiveStep} />}
            {viz === 'gantt' && <GanttDetail stepRuns={stepRuns} active={activeStep} onSelect={setActiveStep} />}
            {viz === 'logs' && <LogsView steps={FOCUS_STEPS} />}
          </div>
        </div>

        <StepInspector step={FOCUS_STEPS.find((s) => s.id === activeStep) || FOCUS_STEPS[0]} />
      </div>
    </div>
  );
}

function computeStepRuns(steps) {
  let cursor = 0;
  return steps.map((s) => {
    const start = cursor;
    cursor += s.dur || 200;
    return { ...s, start, dur: s.dur || 200 };
  });
}

function RunSummaryStrip({ run }) {
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: 'auto 1fr 1fr 1fr 1fr 1fr',
      borderBottom: '1px solid var(--border-subtle)',
      background: 'var(--surface-sunken)',
    }}>
      <div style={{ padding: '14px 20px', display: 'flex', alignItems: 'center', gap: 12, borderRight: '1px solid var(--border-subtle)', minWidth: 200 }}>
        <div style={{
          width: 10, height: 10, borderRadius: '50%',
          background: run.status === 'passed' ? 'var(--success)' : run.status === 'failed' ? 'var(--danger)' : 'var(--brand-accent)',
          boxShadow: `0 0 14px ${run.status === 'passed' ? 'var(--success-glow)' : run.status === 'failed' ? 'var(--danger-glow)' : 'var(--brand-accent-glow)'}`,
        }} />
        <div>
          <div className="eyebrow" style={{ fontSize: 9, marginBottom: 2 }}>run #{run.n}</div>
          <div className="font-display tabular" style={{
            fontSize: 18, fontWeight: 600,
            color: run.status === 'passed' ? 'var(--success)' : run.status === 'failed' ? 'var(--danger)' : 'var(--brand-accent)',
            textTransform: 'capitalize', lineHeight: 1,
          }}>{run.status}</div>
        </div>
      </div>
      <RunCell label="Duration" value={`${(run.durationMs / 1000).toFixed(1)}s`} />
      <RunCell label="Steps" value="6 / 7" />
      <RunCell label="Self-heals" value="1" accent />
      <RunCell label="Tokens" value={run.tokens.toLocaleString()} />
      <RunCell label="When" value={run.when} />
    </div>
  );
}

function RunCell({ label, value, accent = false }) {
  return (
    <div style={{ padding: '14px 20px', borderRight: '1px solid var(--border-subtle)' }}>
      <div className="eyebrow" style={{ fontSize: 9, marginBottom: 4 }}>{label}</div>
      <div className="font-mono tabular" style={{ fontSize: 16, fontWeight: 500, color: accent ? 'var(--brand-accent)' : 'var(--text-hi)' }}>{value}</div>
    </div>
  );
}

function RunHistoryRail({ runs, active, onSelect }) {
  return (
    <div style={{ borderRight: '1px solid var(--border-subtle)', overflow: 'auto', background: 'var(--app-bg)' }}>
      <div style={{ padding: '12px 16px 8px' }}>
        <div className="eyebrow">history · {runs.length}</div>
      </div>
      {runs.map((r) => {
        const isActive = r.id === active;
        return (
          <button key={r.id} onClick={() => onSelect(r.id)} style={{
            display: 'flex', alignItems: 'center', gap: 10, width: '100%',
            padding: '8px 16px', border: 'none', textAlign: 'left',
            background: isActive ? 'var(--surface-elevated)' : 'transparent',
            borderLeft: isActive ? '2px solid var(--brand-primary)' : '2px solid transparent',
            cursor: 'pointer',
          }}>
            <StatusDot status={r.status} size={6} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                <span className="font-mono tabular" style={{ fontSize: 11, color: 'var(--text-hi)', fontWeight: 500 }}>#{r.n}</span>
                <span style={{ fontSize: 11, color: 'var(--text-mid)' }}>{r.when}</span>
              </div>
              <div className="font-mono" style={{ fontSize: 10, color: 'var(--text-low)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {r.branch} · {(r.durationMs / 1000).toFixed(1)}s
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}

function GanttStrip({ stepRuns, totalDur, active, onSelect }) {
  return (
    <div style={{ padding: '14px 20px 14px', borderBottom: '1px solid var(--border-subtle)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
        <div className="eyebrow">timeline · {(totalDur / 1000).toFixed(1)}s total</div>
        <div className="eyebrow font-mono">0ms ─── {totalDur}ms</div>
      </div>
      <div style={{ position: 'relative', height: 26, background: 'var(--surface-sunken)', borderRadius: 6, border: '1px solid var(--border-subtle)', overflow: 'hidden' }}>
        {[0.25, 0.5, 0.75].map((t, i) => (
          <div key={i} style={{
            position: 'absolute', left: `${t * 100}%`, top: 0, bottom: 0,
            width: 1, background: 'var(--border-subtle)',
          }} />
        ))}
        {stepRuns.map((s) => {
          const left = (s.start / totalDur) * 100;
          const width = (s.dur / totalDur) * 100;
          const isActive = s.id === active;
          const c = s.status === 'passed' ? 'var(--success)' : s.status === 'failed' ? 'var(--danger)' : s.status === 'pending' ? 'var(--text-faint)' : 'var(--brand-accent)';
          return (
            <div key={s.id} onClick={() => onSelect(s.id)} title={s.text}
              style={{
                position: 'absolute', left: `${left}%`, width: `${width}%`,
                top: 4, bottom: 4, borderRadius: 3,
                background: c, opacity: isActive ? 1 : 0.7,
                cursor: 'pointer',
                boxShadow: isActive ? `0 0 0 2px var(--app-bg-deep), 0 0 0 3px ${c}` : 'none',
                transition: 'opacity 0.15s',
              }}>
              {s.healed && (
                <div className="animate-heal-pulse" style={{
                  position: 'absolute', top: -1, right: -1, width: 6, height: 6, borderRadius: '50%',
                  background: 'var(--brand-accent)', boxShadow: '0 0 8px var(--brand-accent-glow)',
                }} />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function StepTimeline({ steps, stepRuns, active, onSelect }) {
  return (
    <div style={{ position: 'relative' }}>
      <div style={{
        position: 'absolute', left: 19, top: 8, bottom: 8, width: 1,
        background: 'var(--border-subtle)',
      }} />

      {steps.map((s, i) => {
        const isActive = s.id === active;
        return (
          <div key={s.id} onClick={() => onSelect(s.id)} style={{
            display: 'grid', gridTemplateColumns: '40px 1fr', gap: 12,
            padding: '10px 4px', cursor: 'pointer', position: 'relative',
            background: isActive ? 'var(--surface-elevated)' : 'transparent',
            borderRadius: 8, marginBottom: 4,
          }}>
            <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 4 }}>
              <StepNode status={s.status} healed={s.healed} />
            </div>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <span className="font-mono tabular" style={{ fontSize: 10, color: 'var(--text-low)' }}>
                  step {String(i + 1).padStart(2, '0')}
                </span>
                <StepKindChip kind={s.kind} />
                {s.healed && (
                  <span className="chip chip-healed" style={{ fontSize: 9, padding: '2px 6px' }}>
                    <Icon name="branchHeal" size={9} /> self-healed
                  </span>
                )}
                <div style={{ flex: 1 }} />
                <span className="font-mono tabular" style={{ fontSize: 11, color: 'var(--text-mid)' }}>
                  {s.dur}ms
                </span>
                {s.tokens > 0 && (
                  <span className="font-mono tabular" style={{ fontSize: 10, color: 'var(--text-low)' }}>
                    <Icon name="zap" size={9} style={{ display: 'inline', verticalAlign: '-1px' }} /> {s.tokens}
                  </span>
                )}
              </div>
              <div style={{ fontSize: 13, color: 'var(--text-hi)', fontWeight: 400, lineHeight: 1.4 }}>
                {s.text}
              </div>
              {s.healed && (
                <div style={{
                  marginTop: 6, padding: '6px 10px', background: 'rgba(219, 135, 175, 0.06)',
                  border: '1px solid rgba(219, 135, 175, 0.2)', borderRadius: 6,
                  fontSize: 11, color: 'var(--brand-accent)', display: 'flex', gap: 8, alignItems: 'center',
                }}>
                  <Icon name="branchHeal" size={11} />
                  <span className="font-mono" style={{ fontSize: 10, color: 'var(--text-mid)' }}>{s.healInfo}</span>
                </div>
              )}
              {s.error && (
                <div style={{
                  marginTop: 6, padding: '6px 10px', background: 'rgba(239, 68, 68, 0.06)',
                  border: '1px solid rgba(239, 68, 68, 0.2)', borderRadius: 6,
                  fontSize: 11, color: 'var(--danger)', display: 'flex', gap: 8, alignItems: 'center',
                }}>
                  <Icon name="alert" size={11} />
                  <span className="font-mono" style={{ fontSize: 10 }}>{s.error}</span>
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function StepNode({ status, healed }) {
  const c = status === 'passed' ? 'var(--success)' : status === 'failed' ? 'var(--danger)' : status === 'pending' ? 'var(--text-faint)' : 'var(--brand-accent)';
  return (
    <div style={{
      width: 14, height: 14, borderRadius: '50%',
      background: status === 'pending' ? 'transparent' : c,
      border: status === 'pending' ? '1px dashed var(--text-faint)' : `2px solid var(--app-bg)`,
      boxShadow: status === 'pending' ? 'none' : `0 0 0 2px ${c}, 0 0 12px ${c}`,
      position: 'relative',
    }}>
      {healed && (
        <span className="animate-heal-pulse" style={{
          position: 'absolute', inset: -4, borderRadius: '50%',
        }} />
      )}
    </div>
  );
}

function StepKindChip({ kind }) {
  const map = {
    NAV: { c: 'var(--brand-accent)', icon: 'navigation' },
    TYPE: { c: 'var(--brand-primary)', icon: 'type' },
    CLICK: { c: 'var(--brand-primary)', icon: 'mouse' },
    ASSERT: { c: 'var(--success)', icon: 'check' },
    WAIT: { c: 'var(--warning)', icon: 'history' },
  };
  const m = map[kind] || { c: 'var(--text-mid)', icon: 'cpu' };
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: '1px 6px', borderRadius: 4, fontSize: 9,
      fontFamily: 'JetBrains Mono, monospace',
      letterSpacing: '0.1em', fontWeight: 600,
      color: m.c, background: 'var(--surface-sunken)',
      border: '1px solid var(--border-subtle)',
    }}>
      <Icon name={m.icon} size={9} /> {kind}
    </span>
  );
}

function GanttDetail({ stepRuns, active, onSelect }) {
  const totalDur = stepRuns.reduce((s, r) => s + r.dur, 0);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {stepRuns.map((s, i) => {
        const left = (s.start / totalDur) * 100;
        const width = (s.dur / totalDur) * 100;
        const isActive = s.id === active;
        const c = s.status === 'passed' ? 'var(--success)' : s.status === 'failed' ? 'var(--danger)' : s.status === 'pending' ? 'var(--text-faint)' : 'var(--brand-accent)';
        return (
          <div key={s.id} onClick={() => onSelect(s.id)} style={{
            display: 'grid', gridTemplateColumns: '32px 200px 1fr 60px', gap: 8,
            alignItems: 'center', padding: '6px 6px', cursor: 'pointer',
            background: isActive ? 'var(--surface-elevated)' : 'transparent',
            borderRadius: 6,
          }}>
            <span className="font-mono tabular" style={{ fontSize: 10, color: 'var(--text-low)', textAlign: 'right' }}>
              {String(i + 1).padStart(2, '0')}
            </span>
            <div style={{ fontSize: 12, color: 'var(--text-hi)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {s.text}
            </div>
            <div style={{ position: 'relative', height: 14, background: 'var(--surface-sunken)', borderRadius: 3 }}>
              <div style={{
                position: 'absolute', left: `${left}%`, width: `${width}%`,
                top: 1, bottom: 1, background: c, borderRadius: 2,
                boxShadow: isActive ? `0 0 8px ${c}` : 'none',
              }} />
            </div>
            <span className="font-mono tabular" style={{ fontSize: 11, color: 'var(--text-mid)', textAlign: 'right' }}>
              {s.dur}ms
            </span>
          </div>
        );
      })}
    </div>
  );
}

function LogsView({ steps }) {
  return (
    <div className="font-mono" style={{
      background: 'var(--app-bg-deep)', border: '1px solid var(--border-subtle)',
      borderRadius: 8, padding: 16, fontSize: 11, lineHeight: 1.7, color: 'var(--text-mid)',
    }}>
      {steps.map((s, i) => {
        const t = (i * 312 + 14).toString().padStart(5, '0');
        const c = s.status === 'passed' ? 'var(--success)' : s.status === 'failed' ? 'var(--danger)' : s.status === 'pending' ? 'var(--text-low)' : 'var(--brand-accent)';
        return (
          <div key={s.id} style={{ marginBottom: 6 }}>
            <span style={{ color: 'var(--text-faint)' }}>[{t}ms]</span>{' '}
            <span style={{ color: c, fontWeight: 600 }}>{s.kind.padEnd(7)}</span>{' '}
            <span style={{ color: 'var(--text)' }}>{s.text}</span>
            {s.healed && (
              <div style={{ paddingLeft: 80, color: 'var(--brand-accent)', marginTop: 2 }}>
                ↳ heal: {s.healInfo}
              </div>
            )}
            {s.error && (
              <div style={{ paddingLeft: 80, color: 'var(--danger)', marginTop: 2 }}>
                ↳ ERROR: {s.error}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function StepInspector({ step }) {
  return (
    <div style={{ overflow: 'auto', padding: '20px 22px 60px', background: 'var(--app-bg)' }}>
      <div className="eyebrow" style={{ marginBottom: 8 }}>step inspector</div>
      <div style={{ fontSize: 14, color: 'var(--text-hi)', fontWeight: 500, marginBottom: 4, lineHeight: 1.4 }}>
        {step.text}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
        <StepKindChip kind={step.kind} />
        <span className={`chip chip-${step.status === 'passed' ? 'passed' : step.status === 'failed' ? 'failed' : step.status === 'pending' ? '' : 'healed'}`}>
          <span className="chip-dot" style={{ background: 'currentColor' }} />{step.status}
        </span>
      </div>

      <div className="eyebrow" style={{ marginBottom: 8 }}>screenshot</div>
      <div style={{
        border: '1px solid var(--border-subtle)', borderRadius: 8, overflow: 'hidden',
        background: 'var(--app-bg-deep)', position: 'relative',
        marginBottom: 16,
      }}>
        <div style={{
          aspectRatio: '16 / 10',
          backgroundImage: 'repeating-linear-gradient(135deg, var(--border-subtle) 0 1px, transparent 1px 12px)',
          position: 'relative',
        }}>
          <div style={{ position: 'absolute', inset: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ height: 24, background: 'var(--surface-elevated)', borderRadius: 4, width: '60%' }} />
            <div style={{ height: 8, background: 'var(--surface)', borderRadius: 4, width: '90%' }} />
            <div style={{ height: 8, background: 'var(--surface)', borderRadius: 4, width: '75%' }} />
            <div style={{ flex: 1 }} />
            {step.kind === 'TYPE' && (
              <div style={{ height: 32, background: 'var(--surface-elevated)', border: '1px solid var(--brand-primary)', borderRadius: 6, padding: '6px 10px', boxShadow: '0 0 12px var(--brand-primary-glow)' }}>
                <div style={{ height: 6, width: '50%', background: 'var(--brand-primary)', opacity: 0.5 }} />
              </div>
            )}
            {step.kind === 'ASSERT' && (
              <div style={{ height: 32, background: 'rgba(239,68,68,0.1)', border: '1px solid var(--danger)', borderRadius: 6, padding: '6px 10px', boxShadow: '0 0 12px var(--danger-glow)' }}>
                <div className="font-mono" style={{ fontSize: 10, color: 'var(--danger)' }}>ADA L.</div>
              </div>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 10px', borderTop: '1px solid var(--border-subtle)' }}>
          <span className="eyebrow font-mono" style={{ fontSize: 9 }}>frame · {step.id}</span>
          <button className="btn btn-ghost btn-xs"><Icon name="external" size={11} /></button>
        </div>
      </div>

      {step.healed && (
        <>
          <div className="eyebrow" style={{ marginBottom: 8, color: 'var(--brand-accent)' }}>self-heal trace</div>
          <div style={{
            padding: 12, borderRadius: 8,
            background: 'rgba(219, 135, 175, 0.04)',
            border: '1px solid rgba(219, 135, 175, 0.20)',
            marginBottom: 16,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <Icon name="branchHeal" size={14} style={{ color: 'var(--brand-accent)' }} />
              <span style={{ fontSize: 12, color: 'var(--brand-accent)', fontWeight: 500 }}>Selector recovered in 180ms</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 11 }}>
              <div style={{ display: 'flex', gap: 8 }}>
                <span className="eyebrow" style={{ width: 50, fontSize: 9 }}>old</span>
                <code className="font-mono" style={{ color: 'var(--text-low)', textDecoration: 'line-through' }}>input[name=password]</code>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <span className="eyebrow" style={{ width: 50, fontSize: 9, color: 'var(--brand-accent)' }}>new</span>
                <code className="font-mono" style={{ color: 'var(--brand-accent)' }}>input[type=password]</code>
              </div>
            </div>
          </div>
        </>
      )}

      {step.error && (
        <>
          <div className="eyebrow" style={{ marginBottom: 8, color: 'var(--danger)' }}>failure trace</div>
          <div style={{
            padding: 12, borderRadius: 8,
            background: 'rgba(239, 68, 68, 0.04)',
            border: '1px solid rgba(239, 68, 68, 0.30)',
            marginBottom: 16,
          }}>
            <div style={{ fontSize: 12, color: 'var(--danger)', marginBottom: 6, fontWeight: 500 }}>Assertion failed</div>
            <div className="font-mono" style={{ fontSize: 11, color: 'var(--text)', lineHeight: 1.6 }}>
              {step.error}
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <button className="btn btn-xs" style={{ flex: 1, justifyContent: 'center' }}>
                <Icon name="copy" size={10} /> Copy trace
              </button>
              <button className="btn btn-xs" style={{ flex: 1, justifyContent: 'center', color: 'var(--brand-accent)', borderColor: 'rgba(219,135,175,0.3)' }}>
                <Icon name="sparkle" size={10} /> Update assertion
              </button>
            </div>
          </div>
        </>
      )}

      <div className="eyebrow" style={{ marginBottom: 8 }}>resolution</div>
      <div style={{
        padding: 10, borderRadius: 6,
        background: 'var(--surface-sunken)', border: '1px solid var(--border-subtle)',
        marginBottom: 16,
      }}>
        <div className="font-mono" style={{ fontSize: 10, color: 'var(--text-mid)', wordBreak: 'break-all' }}>
          {step.kind === 'TYPE' ? 'page.locator("input[type=password]").fill(***)' :
           step.kind === 'CLICK' ? 'page.getByRole("button", { name: "Sign in" }).click()' :
           step.kind === 'NAV' ? 'page.goto("https://app.acme.io/login")' :
           step.kind === 'WAIT' ? 'page.waitForLoadState("networkidle")' :
           'expect(page.getByRole("menuitem")).toHaveText("Ada Lovelace")'}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <button className="btn btn-xs" style={{ justifyContent: 'center', color: 'var(--success)', borderColor: 'rgba(34,197,94,0.3)' }}>
          <Icon name="check" size={11} /> Mark pass
        </button>
        <button className="btn btn-xs" style={{ justifyContent: 'center', color: 'var(--danger)', borderColor: 'rgba(239,68,68,0.3)' }}>
          <Icon name="x" size={11} /> Mark fail
        </button>
      </div>
    </div>
  );
}

window.TestDetailScreen = TestDetailScreen;
