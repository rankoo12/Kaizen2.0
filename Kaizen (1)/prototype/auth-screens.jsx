/* global React, Icon, Logo */

const { useState: useStateAuth } = React;

function AuthShell({ children }) {
  return (
    <div style={{
      minHeight: '100vh', height: '100vh', width: '100%',
      display: 'grid', gridTemplateColumns: '1fr 1fr',
      position: 'relative', overflow: 'hidden'
    }}>
      {/* left — brand panel with neural visual */}
      <div style={{
        position: 'relative', overflow: 'hidden',
        background: 'linear-gradient(180deg, var(--app-bg-deep) 0%, var(--welcome-bg) 100%)',
        display: 'flex', flexDirection: 'column', padding: 48
      }}>
        <div className="starfield" />
        <Logo size="lg" />

        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', position: 'relative', zIndex: 2, gap: 28 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div className="glow-cube" />
            <span className="eyebrow">
</span>
          </div>
          <h1 className="font-display" style={{ fontSize: 56, lineHeight: 1.0, letterSpacing: '-0.035em',
              color: 'var(--text-hi)', fontWeight: 600, margin: 0,
              textWrap: 'balance'
            }}>
            Tests written in your language.<br />
            <span style={{ color: 'var(--brand-primary)' }}>Compiled, run, healed.</span>
          </h1>
          <p style={{ fontSize: 15, color: 'var(--text-mid)', maxWidth: 480, lineHeight: 1.55, margin: 0 }}>
            Kaizen reads plain-English steps, drives a real browser through Playwright, and quietly self-heals when selectors drift. The observatory is open.
          </p>
          <BrandStats />
        </div>

        <div style={{ display: 'flex', gap: 24, fontSize: 11, color: 'var(--text-low)', position: 'relative', zIndex: 2 }}>
          <span>SOC 2 Type II</span>
          <span style={{ width: 1, background: 'var(--border-subtle)' }} />
          <span>Self-hosted available</span>
          <span style={{ width: 1, background: 'var(--border-subtle)' }} />
          <span className="font-mono">build 2026.04</span>
        </div>
      </div>

      {/* right — form */}
      <div style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        padding: 48, position: 'relative'
      }}>
        {children}
      </div>
    </div>);

}

function BrandStats() {
  const stats = [
  { label: 'Tests run last week', value: '4.2M', spark: [3, 4, 4, 5, 5, 6, 7] },
  { label: 'Median heal latency', value: '180ms', spark: [5, 5, 4, 4, 3, 3, 3] },
  { label: 'Selectors auto-recovered', value: '94.3%', spark: [4, 5, 5, 5, 6, 7, 7] }];

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14, maxWidth: 540, marginTop: 8 }}>
      {stats.map((s, i) =>
      <div key={i} style={{
        padding: '14px 16px', background: 'rgba(20, 14, 26, 0.4)',
        border: '1px solid var(--border-subtle)', borderRadius: 10, backdropFilter: 'blur(8px)'
      }}>
          <div className="eyebrow" style={{ fontSize: 9, marginBottom: 8 }}>{s.label}</div>
          <div className="font-display tabular" style={{ fontSize: 24, color: 'var(--text-hi)', fontWeight: 600 }}>{s.value}</div>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 14, marginTop: 6 }}>
            {s.spark.map((v, j) =>
          <div key={j} style={{
            width: 3, height: `${v * 12}%`,
            background: 'var(--brand-primary)', opacity: 0.4 + j * 0.08,
            borderRadius: 1
          }} />
          )}
          </div>
        </div>
      )}
    </div>);

}

function LoginScreen({ onSubmit, onSwitch }) {
  const [email, setEmail] = useStateAuth('ada@acme.io');
  const [password, setPassword] = useStateAuth('•••••••••••');
  const [loading, setLoading] = useStateAuth(false);

  const submit = (e) => {
    e.preventDefault();
    setLoading(true);
    setTimeout(() => {setLoading(false);onSubmit();}, 700);
  };

  return (
    <AuthShell>
      <div style={{ width: '100%', maxWidth: 380, display: 'flex', flexDirection: 'column', gap: 24 }}>
        <div>
          <div className="eyebrow" style={{ marginBottom: 12 }}>access</div>
          <h2 className="font-display" style={{ fontSize: 32, fontWeight: 600, letterSpacing: '-0.02em', color: 'var(--text-hi)', margin: 0, marginBottom: 8 }}>
            Welcome back
          </h2>
          <p style={{ fontSize: 13, color: 'var(--text-mid)', margin: 0 }}>
            Sign in to your workspace. New here? <a href="#" style={{ color: 'var(--brand-primary)', textDecoration: 'none' }}>Create an account</a>
          </p>
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn" style={{ flex: 1, justifyContent: 'center' }}>
            <Icon name="google" size={14} /> Google
          </button>
          <button className="btn" style={{ flex: 1, justifyContent: 'center' }}>
            <Icon name="github" size={14} /> GitHub
          </button>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ flex: 1, height: 1, background: 'var(--border-subtle)' }} />
          <span className="eyebrow" style={{ fontSize: 9 }}>or with email</span>
          <div style={{ flex: 1, height: 1, background: 'var(--border-subtle)' }} />
        </div>

        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Field label="Email" value={email} onChange={setEmail} type="email" />
          <Field label="Password" value={password} onChange={setPassword} type="password" rightAction={
          <a href="#" style={{ fontSize: 11, color: 'var(--text-mid)', textDecoration: 'none' }}>Forgot?</a>
          } />
          <button type="submit" className="btn btn-primary" style={{ justifyContent: 'center', padding: '11px 14px', marginTop: 4 }}>
            {loading ? <Icon name="loader" size={14} className="animate-spin" style={{ animation: 'orbit 0.8s linear infinite' }} /> : <Icon name="arrowRight" size={14} />}
            Sign in
          </button>
        </form>

        <div style={{
          padding: '12px 14px', background: 'var(--surface)', border: '1px solid var(--border-subtle)',
          borderRadius: 10, display: 'flex', gap: 10, alignItems: 'flex-start'
        }}>
          <Icon name="shield" size={14} style={{ color: 'var(--brand-accent)', marginTop: 2, flexShrink: 0 }} />
          <div style={{ fontSize: 11, color: 'var(--text-mid)', lineHeight: 1.5 }}>
            Sessions are scoped per workspace. Two-factor is required for admin roles.
          </div>
        </div>

        <div style={{ textAlign: 'center', fontSize: 12, color: 'var(--text-mid)' }}>
          New to Kaizen?{' '}
          <a href="#" onClick={(e) => {e.preventDefault();onSwitch && onSwitch('signup');}}
          style={{ color: 'var(--brand-accent)', textDecoration: 'none', fontWeight: 500 }}>
            Create a workspace →
          </a>
        </div>
      </div>
    </AuthShell>);

}

function SignupScreen({ onSubmit, onSwitch }) {
  const [step, setStep] = useStateAuth(1);
  const [name, setName] = useStateAuth('');
  const [email, setEmail] = useStateAuth('');
  const [workspace, setWorkspace] = useStateAuth('acme');

  return (
    <AuthShell>
      <div style={{ width: '100%', maxWidth: 380, display: 'flex', flexDirection: 'column', gap: 24 }}>
        <div>
          <div className="eyebrow" style={{ marginBottom: 12 }}>onboarding · step {step} of 2</div>
          <h2 className="font-display" style={{ fontSize: 32, fontWeight: 600, letterSpacing: '-0.02em', color: 'var(--text-hi)', margin: 0, marginBottom: 8 }}>
            {step === 1 ? 'Create your account' : 'Name your workspace'}
          </h2>
          <p style={{ fontSize: 13, color: 'var(--text-mid)', margin: 0 }}>
            {step === 1 ?
            'Start with 200 free runs. No card required.' :
            'This is the URL teammates will use to find you.'}
          </p>
        </div>

        {/* step indicator */}
        <div style={{ display: 'flex', gap: 4 }}>
          {[1, 2].map((n) =>
          <div key={n} style={{
            flex: 1, height: 3, borderRadius: 2,
            background: n <= step ? 'var(--brand-primary)' : 'var(--border-subtle)',
            boxShadow: n <= step ? '0 0 8px var(--brand-primary-glow)' : 'none',
            transition: 'all 0.3s'
          }} />
          )}
        </div>

        {step === 1 ?
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn" style={{ flex: 1, justifyContent: 'center' }}>
                <Icon name="google" size={14} /> Sign up with Google
              </button>
              <button className="btn" style={{ flex: 1, justifyContent: 'center' }}>
                <Icon name="github" size={14} /> GitHub
              </button>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ flex: 1, height: 1, background: 'var(--border-subtle)' }} />
              <span className="eyebrow" style={{ fontSize: 9 }}>or</span>
              <div style={{ flex: 1, height: 1, background: 'var(--border-subtle)' }} />
            </div>
            <Field label="Full name" value={name} onChange={setName} placeholder="Ada Lovelace" />
            <Field label="Work email" value={email} onChange={setEmail} type="email" placeholder="ada@yourco.com" />
            <button onClick={() => setStep(2)} className="btn btn-primary" style={{ justifyContent: 'center', padding: '11px 14px', marginTop: 4 }}>
              Continue <Icon name="arrowRight" size={14} />
            </button>
          </div> :

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                <label style={{ fontSize: 11, color: 'var(--text-mid)', fontWeight: 500 }}>Workspace URL</label>
              </div>
              <div style={{
              display: 'flex', alignItems: 'center',
              background: 'var(--input-bg)', border: '1px solid var(--border-strong)',
              borderRadius: 10, overflow: 'hidden'
            }}>
                <input
                className="input"
                style={{ border: 'none', background: 'transparent', padding: '10px 0 10px 12px', flex: 1 }}
                value={workspace} onChange={(e) => setWorkspace(e.target.value)} />
              
                <span style={{ padding: '10px 12px', color: 'var(--text-low)', fontSize: 13, borderLeft: '1px solid var(--border-subtle)' }} className="font-mono">
                  .kaizen.app
                </span>
              </div>
            </div>

            <div style={{
            padding: 14, background: 'var(--surface)', border: '1px solid var(--border-subtle)',
            borderRadius: 10, display: 'flex', flexDirection: 'column', gap: 10
          }}>
              <div className="eyebrow">starter pack</div>
              <Stat label="Free runs / month" value="200" />
              <Stat label="Workers" value="2 concurrent" />
              <Stat label="Self-heal events" value="unlimited" />
              <Stat label="Retention" value="30 days" />
            </div>

            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => setStep(1)} className="btn" style={{ flex: 0 }}>
                <Icon name="arrowLeft" size={14} /> Back
              </button>
              <button onClick={onSubmit} className="btn btn-primary" style={{ flex: 1, justifyContent: 'center', padding: '11px 14px' }}>
                Create workspace <Icon name="arrowRight" size={14} />
              </button>
            </div>
          </div>
        }

        <div style={{ textAlign: 'center', fontSize: 12, color: 'var(--text-mid)' }}>
          Already have an account?{' '}
          <a href="#" onClick={(e) => {e.preventDefault();onSwitch && onSwitch('login');}}
          style={{ color: 'var(--brand-accent)', textDecoration: 'none', fontWeight: 500 }}>
            Sign in →
          </a>
        </div>
      </div>
    </AuthShell>);

}

function Field({ label, value, onChange, type = 'text', placeholder, rightAction }) {
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
        <label style={{ fontSize: 11, color: 'var(--text-mid)', fontWeight: 500 }}>{label}</label>
        {rightAction}
      </div>
      <input
        type={type}
        className="input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder} />
      
    </div>);

}

function Stat({ label, value }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12 }}>
      <span style={{ color: 'var(--text-mid)' }}>{label}</span>
      <span className="font-mono tabular" style={{ color: 'var(--text-hi)', fontWeight: 500 }}>{value}</span>
    </div>);

}

function AuthScreen({ mode, onSwitch, onSubmit }) {
  if (mode === 'signup') return <SignupScreen onSwitch={onSwitch} onSubmit={onSubmit} />;
  return <LoginScreen onSwitch={onSwitch} onSubmit={onSubmit} />;
}

window.LoginScreen = LoginScreen;
window.SignupScreen = SignupScreen;
window.AuthScreen = AuthScreen;