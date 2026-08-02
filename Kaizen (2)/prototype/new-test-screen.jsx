/* global React, Icon, StatusDot, FOCUS_CASE, FOCUS_STEPS, FOCUS_RUNS */

const { useState: useStateNew } = React;

// ─── /tests/new ──────────────────────────────────────────────────────────────
function NewTestScreen({ onBack, onCreate }) {
  const [name, setName] = useStateNew('Sign in with valid creds');
  const [url, setUrl] = useStateNew('https://app.acme.io/login');
  const [suite, setSuite] = useStateNew('s-auth');
  const [steps, setSteps] = useStateNew([
    'Navigate to https://app.acme.io/login',
    'Type "ada@example.com" into the email field',
    'Type the saved password into the password field',
    'Click the "Sign in" button',
    'Wait for dashboard to load',
    'Verify the user menu shows "Ada Lovelace"',
  ]);

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ padding: '20px 28px 16px', borderBottom: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', gap: 14 }}>
        <button onClick={onBack} className="btn btn-ghost btn-sm">
          <Icon name="arrowLeft" size={13} /> Back
        </button>
        <div style={{ flex: 1 }}>
          <div className="eyebrow" style={{ marginBottom: 4 }}>compose · plain english</div>
          <h1 className="font-display" style={{ fontSize: 22, fontWeight: 600, letterSpacing: '-0.02em', color: 'var(--text-hi)', margin: 0 }}>
            New test
          </h1>
        </div>
        <button className="btn btn-sm">Save draft</button>
        <button onClick={onCreate} className="btn btn-primary btn-sm">
          <Icon name="play" size={11} /> Compile & run
        </button>
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: '24px 28px 80px', display: 'grid', gridTemplateColumns: '1fr 360px', gap: 24, maxWidth: 1320, margin: '0 auto', width: '100%' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {/* Name + meta */}
          <div className="surface" style={{ padding: 18 }}>
            <input value={name} onChange={(e) => setName(e.target.value)}
              className="font-display"
              style={{
                width: '100%', border: 'none', outline: 'none',
                background: 'transparent', fontSize: 24, fontWeight: 600,
                letterSpacing: '-0.02em', color: 'var(--text-hi)', padding: 0,
              }}
            />
            <div style={{ display: 'flex', gap: 18, marginTop: 12, fontSize: 12, alignItems: 'center', flexWrap: 'wrap' }}>
              <FieldRow label="Target" icon="globe">
                <input value={url} onChange={(e) => setUrl(e.target.value)} className="font-mono"
                  style={{ border: 'none', outline: 'none', background: 'transparent', color: 'var(--text)', fontSize: 12, minWidth: 320 }}
                />
              </FieldRow>
              <FieldRow label="Suite" icon="layers">
                <select value={suite} onChange={(e) => setSuite(e.target.value)}
                  style={{ border: 'none', outline: 'none', background: 'transparent', color: 'var(--text)', fontSize: 12 }}>
                  <option value="s-auth">Authentication & Identity</option>
                  <option value="s-checkout">Checkout & Payments</option>
                  <option value="s-discovery">Search & Discovery</option>
                </select>
              </FieldRow>
              <FieldRow label="Browser" icon="cpu">
                <span style={{ fontSize: 12, color: 'var(--text)' }}>Chromium</span>
              </FieldRow>
            </div>
          </div>

          {/* Steps composer */}
          <div className="surface" style={{ overflow: 'hidden' }}>
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '12px 16px', borderBottom: '1px solid var(--border-subtle)',
              background: 'var(--surface-sunken)',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span className="eyebrow">spec</span>
                <span style={{ fontSize: 11, color: 'var(--text-mid)' }}>Plain English. The compiler infers selectors, intent, and waits.</span>
              </div>
              <div style={{ display: 'flex', gap: 4 }}>
                <button className="btn btn-ghost btn-xs"><Icon name="sparkle" size={11} /> Suggest</button>
                <button className="btn btn-ghost btn-xs"><Icon name="copy" size={11} /> Import</button>
              </div>
            </div>

            <div style={{ padding: '6px 0' }}>
              {steps.map((s, i) => (
                <StepEditor key={i} idx={i} value={s}
                  onChange={(v) => setSteps((prev) => prev.map((p, j) => j === i ? v : p))}
                  onDelete={() => setSteps((prev) => prev.filter((_, j) => j !== i))}
                  showCompiler={i < 2}
                />
              ))}

              <button onClick={() => setSteps([...steps, ''])}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '10px 16px 12px 60px', width: '100%', textAlign: 'left',
                  border: 'none', background: 'transparent', color: 'var(--text-mid)',
                  fontSize: 12, cursor: 'pointer',
                }}>
                <Icon name="plus" size={12} />
                Add step <span className="eyebrow" style={{ marginLeft: 'auto', paddingRight: 12 }}>↵ enter</span>
              </button>
            </div>
          </div>

          {/* Live preview viewport */}
          <div className="surface" style={{ overflow: 'hidden' }}>
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '10px 14px', borderBottom: '1px solid var(--border-subtle)',
              background: 'var(--surface-sunken)',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ display: 'flex', gap: 4 }}>
                  <BrowserDot /><BrowserDot /><BrowserDot />
                </div>
                <span className="font-mono" style={{ fontSize: 11, color: 'var(--text-mid)' }}>
                  {url}
                </span>
              </div>
              <span className="eyebrow">dry run · 0.4s</span>
            </div>
            <div style={{
              height: 280, background: 'var(--app-bg-deep)',
              backgroundImage: 'repeating-linear-gradient(45deg, var(--border-subtle) 0 1px, transparent 1px 14px)',
              display: 'grid', placeItems: 'center', position: 'relative',
            }}>
              <div style={{ textAlign: 'center', color: 'var(--text-mid)' }}>
                <Icon name="eye" size={20} style={{ color: 'var(--text-low)' }} />
                <div className="eyebrow" style={{ marginTop: 8 }}>browser preview</div>
                <div style={{ fontSize: 11, marginTop: 4 }}>Compiles & previews target page on first run</div>
              </div>
            </div>
          </div>
        </div>

        {/* Right: compiler insight + targeting */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <CompilerCard />
          <ConfigCard />
          <CostCard />
        </div>
      </div>
    </div>
  );
}

function FieldRow({ label, icon, children }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <Icon name={icon} size={11} style={{ color: 'var(--text-low)' }} />
      <span className="eyebrow" style={{ fontSize: 9 }}>{label}</span>
      {children}
    </div>
  );
}

function StepEditor({ idx, value, onChange, onDelete, showCompiler }) {
  const [focus, setFocus] = useStateNew(false);
  // Detect intent from the text
  const intent = detectIntent(value);

  return (
    <div style={{
      display: 'grid', gridTemplateColumns: '40px 1fr', gap: 0,
      padding: '6px 0', borderTop: idx > 0 ? '1px solid var(--border-subtle)' : 'none',
      background: focus ? 'rgba(213, 96, 28, 0.025)' : 'transparent',
      transition: 'background 0.15s',
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: 12 }}>
        <span className="font-mono tabular" style={{ fontSize: 10, color: 'var(--text-low)' }}>
          {String(idx + 1).padStart(2, '0')}
        </span>
      </div>
      <div style={{ paddingRight: 16, paddingTop: 6, paddingBottom: 6 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="chip" style={{
            fontSize: 9, padding: '2px 6px',
            color: intent.color, borderColor: intent.border, background: intent.bg,
          }}>
            <Icon name={intent.icon} size={9} /> {intent.label}
          </span>
          <input value={value}
            onChange={(e) => onChange(e.target.value)}
            onFocus={() => setFocus(true)} onBlur={() => setFocus(false)}
            placeholder="Describe the action…"
            style={{
              flex: 1, border: 'none', outline: 'none', background: 'transparent',
              color: 'var(--text)', fontSize: 13, padding: '4px 0',
            }}
          />
          <button onClick={onDelete} className="btn btn-ghost btn-xs" style={{ opacity: 0.6 }}>
            <Icon name="trash" size={11} />
          </button>
        </div>
        {focus && showCompiler && (
          <div className="animate-modal-pop" style={{
            marginTop: 8, padding: '8px 10px', background: 'var(--surface-sunken)',
            border: '1px solid var(--border-accent)', borderRadius: 6,
            fontSize: 11, color: 'var(--text-mid)',
            display: 'flex', alignItems: 'center', gap: 8,
          }}>
            <Icon name="sparkle" size={11} style={{ color: 'var(--brand-primary)' }} />
            <span>Compiler resolved to:</span>
            <code className="font-mono" style={{ color: 'var(--brand-primary)', fontSize: 11 }}>
              {intent.kind === 'TYPE' ? 'input[type="email"]' : intent.kind === 'CLICK' ? 'button:has-text("Sign in")' : intent.kind === 'NAV' ? '→ navigate' : 'getByText'}
            </code>
            <span style={{ marginLeft: 'auto', color: 'var(--text-low)', fontSize: 10 }}>180ms</span>
          </div>
        )}
      </div>
    </div>
  );
}

function detectIntent(text) {
  const t = text.toLowerCase();
  if (t.startsWith('navig') || t.includes('go to') || t.includes('open ')) {
    return { kind: 'NAV', label: 'NAV', icon: 'navigation', color: 'var(--brand-accent)', border: 'rgba(219,135,175,0.3)', bg: 'rgba(219,135,175,0.08)' };
  }
  if (t.startsWith('type') || t.startsWith('enter ') || t.startsWith('fill')) {
    return { kind: 'TYPE', label: 'TYPE', icon: 'type', color: 'var(--brand-primary)', border: 'rgba(213,96,28,0.3)', bg: 'rgba(213,96,28,0.08)' };
  }
  if (t.startsWith('click') || t.startsWith('press') || t.startsWith('tap')) {
    return { kind: 'CLICK', label: 'CLICK', icon: 'mouse', color: 'var(--brand-primary)', border: 'rgba(213,96,28,0.3)', bg: 'rgba(213,96,28,0.08)' };
  }
  if (t.startsWith('verify') || t.startsWith('expect') || t.startsWith('check') || t.startsWith('assert')) {
    return { kind: 'ASSERT', label: 'ASSERT', icon: 'check', color: 'var(--success)', border: 'rgba(34,197,94,0.3)', bg: 'rgba(34,197,94,0.08)' };
  }
  if (t.startsWith('wait')) {
    return { kind: 'WAIT', label: 'WAIT', icon: 'history', color: 'var(--warning)', border: 'rgba(245,158,11,0.3)', bg: 'rgba(245,158,11,0.08)' };
  }
  return { kind: 'STEP', label: 'STEP', icon: 'cpu', color: 'var(--text-mid)', border: 'var(--border-subtle)', bg: 'var(--surface-sunken)' };
}

function BrowserDot() {
  return <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--border-strong)' }} />;
}

function CompilerCard() {
  return (
    <div className="surface" style={{ padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <Icon name="cpu" size={13} style={{ color: 'var(--brand-primary)' }} />
        <span className="eyebrow">compiler</span>
        <div style={{ flex: 1 }} />
        <span className="chip chip-passed" style={{ padding: '2px 6px', fontSize: 9 }}>
          <span className="chip-dot" style={{ background: 'currentColor' }} /> ready
        </span>
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-mid)', lineHeight: 1.5, marginBottom: 12 }}>
        6 steps recognized · 6 selectors resolved on first attempt · 0 ambiguous matches.
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <Mini2 label="LLM tokens" value="1,482" />
        <Mini2 label="Compile time" value="610ms" />
      </div>
    </div>
  );
}

function ConfigCard() {
  return (
    <div className="surface" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="eyebrow">configuration</div>
      <Toggle label="Self-heal selectors" desc="Recover when DOM drifts" on />
      <Toggle label="Capture screenshots" desc="On every step" on />
      <Toggle label="Record video" desc="Trace.zip download" />
      <Toggle label="Run on save" desc="Trigger on every commit" on />
    </div>
  );
}

function Toggle({ label, desc, on = false }) {
  const [v, setV] = useStateNew(on);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <button onClick={() => setV(!v)} style={{
        width: 28, height: 16, borderRadius: 999, border: 'none',
        background: v ? 'var(--brand-primary)' : 'var(--border-strong)',
        position: 'relative', cursor: 'pointer',
        boxShadow: v ? 'inset 0 0 0 1px var(--brand-primary), 0 0 8px var(--brand-primary-glow)' : 'none',
        transition: 'all 0.2s',
      }}>
        <span style={{
          position: 'absolute', top: 2, left: v ? 14 : 2,
          width: 12, height: 12, borderRadius: '50%',
          background: v ? '#1a0e05' : 'var(--text-mid)',
          transition: 'left 0.2s',
        }} />
      </button>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 12, color: 'var(--text-hi)', fontWeight: 500 }}>{label}</div>
        <div style={{ fontSize: 11, color: 'var(--text-low)' }}>{desc}</div>
      </div>
    </div>
  );
}

function CostCard() {
  return (
    <div className="surface" style={{ padding: 16 }}>
      <div className="eyebrow" style={{ marginBottom: 8 }}>est. cost per run</div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span className="font-display tabular" style={{ fontSize: 24, fontWeight: 600, color: 'var(--text-hi)' }}>$0.014</span>
        <span style={{ fontSize: 11, color: 'var(--text-low)' }}>/ run</span>
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-mid)', marginTop: 4 }}>
        ~7s avg · 1.5K LLM tokens · Chromium worker
      </div>
    </div>
  );
}

function Mini2({ label, value }) {
  return (
    <div style={{ padding: 8, borderRadius: 6, background: 'var(--surface-sunken)' }}>
      <div className="eyebrow" style={{ fontSize: 9, marginBottom: 2 }}>{label}</div>
      <div className="font-mono tabular" style={{ fontSize: 13, color: 'var(--text-hi)', fontWeight: 500 }}>{value}</div>
    </div>
  );
}

window.NewTestScreen = NewTestScreen;
