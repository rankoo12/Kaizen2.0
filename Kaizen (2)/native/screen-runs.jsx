/* global React, I, fmt, RUNS_FEED, Toolbar, Seg, StatusBadge, StatusDot, Stat */

const { useState: uSf } = React;

function RunsScreen({ onOpen }) {
  const [f, setF] = uSf('all');
  const list = RUNS_FEED.filter((r) => f === 'all' || (f === 'active' ? r.status === 'running' || r.status === 'queued' : r.status === f));
  const active = RUNS_FEED.filter((r) => r.status === 'running' || r.status === 'queued').length;

  return (
    <>
      <Toolbar title="Runs" sub="Every execution in this workspace, newest first">
        <span className="pill" style={{ background: 'var(--accent-soft)', color: 'var(--accent-text)' }}>
          <span className="dot pulse" style={{ background: 'var(--accent)', width: 6, height: 6 }} />{active} active
        </span>
        <Seg value={f} onChange={setF} options={[
          { value: 'all', label: 'All' }, { value: 'active', label: 'Active' },
          { value: 'failed', label: 'Failed' }, { value: 'healed', label: 'Healed' },
        ]} />
      </Toolbar>
      <div className="scroll" style={{ flex: 1, padding: '18px 22px 40px' }}>
        <div className="card rise" style={{ display: 'flex', marginBottom: 16, overflow: 'hidden' }}>
          {[
            ['RUNS TODAY', RUNS_FEED.length, null, null],
            ['PASSED CLEAN', RUNS_FEED.filter((r) => r.status === 'passed').length, 'var(--pass)', 'no healing needed'],
            ['SELF-HEALED', RUNS_FEED.filter((r) => r.status === 'healed').length, 'var(--heal)', 'passed anyway'],
            ['FAILED', RUNS_FEED.filter((r) => r.status === 'failed').length, 'var(--fail)', 'need a look'],
            ['TOKENS TODAY', fmt.k(RUNS_FEED.reduce((a, r) => a + r.tokens, 0)), 'var(--cache)', 'across all runs'],
          ].map(([l, v, tone, sub], i, arr) => (
            <div key={l} className={i === 0 ? 'hide-md' : undefined} style={{ flex: '1 1 148px', minWidth: 0, borderRight: i < arr.length - 1 ? '.5px solid var(--sep)' : 'none' }}>
              <Stat label={l} value={v} tone={tone} sub={sub} />
            </div>
          ))}
        </div>

        <div className="list">
          <div className="list-h">
            <span style={{ flex: 1 }}>TEST</span><span style={{ width: 84 }}>STATUS</span>
            <span className="hide-lg" style={{ width: 80, textAlign: 'right' }}>DURATION</span><span style={{ width: 80, textAlign: 'right' }}>TOKENS</span>
            <span className="hide-md" style={{ width: 78 }}>TRIGGER</span><span style={{ width: 70, textAlign: 'right' }}>WHEN</span><span style={{ width: 22 }} />
          </div>
          {list.map((r) => (
            <div className="row" key={r.id} onClick={() => onOpen(r)}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="row-t" style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                  <span title={r.name} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</span>
                  <span className="num" style={{ fontSize: 11, color: 'var(--text-3)' }}>#{r.n}</span>
                </div>
                {r.status === 'running'
                  ? <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
                      <div className="meter" style={{ width: 150 }}><i style={{ width: `${r.progress * 100}%` }} /></div>
                      <span style={{ fontSize: 11, color: 'var(--accent-text)' }}>step 6 of 10 · polling</span>
                    </div>
                  : <div className="row-s">{r.suite}</div>}
              </div>
              <span style={{ width: 84 }}><StatusBadge status={r.status} size="sm" /></span>
              <span className="num hide-lg" style={{ width: 80, textAlign: 'right', fontSize: 12, color: r.status === 'running' ? 'var(--text-3)' : 'var(--text)' }}>{r.status === 'queued' ? '—' : fmt.ms(r.ms)}</span>
              <span className="num" style={{ width: 80, textAlign: 'right', fontSize: 12, color: r.tokens === 0 ? 'var(--cache)' : 'var(--text)' }}>{r.tokens === 0 ? 'free' : fmt.n(r.tokens)}</span>
              <span className="hide-md" style={{ width: 78 }}><span className="badge" style={{ background: 'var(--fill)', color: 'var(--text-2)' }}>{r.trigger.toUpperCase()}</span></span>
              <span className="num" style={{ width: 70, textAlign: 'right', fontSize: 11, color: 'var(--text-2)' }}>{r.when}</span>
              <span style={{ width: 22, display: 'grid', placeItems: 'center' }}><I.chevron size={12} style={{ color: 'var(--text-3)' }} /></span>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

function LoginScreen({ mode, onMode, onSubmit }) {
  const signup = mode === 'signup';
  const [email, setEmail] = uSf('ada@acme.io');
  const [pw, setPw] = uSf('••••••••••');
  const [busy, setBusy] = uSf(false);
  const go = () => { setBusy(true); setTimeout(onSubmit, 620); };

  return (
    <div style={{ flex: 1, display: 'grid', placeItems: 'center', padding: 24 }}>
      <div className="rise" style={{ width: 356, textAlign: 'center' }}>
        <div style={{ width: 54, height: 54, borderRadius: 14, background: 'var(--accent)', color: '#fff', display: 'grid', placeItems: 'center', margin: '0 auto', boxShadow: '0 6px 20px -4px rgba(11,98,244,.5)' }}>
          <I.logo size={28} />
        </div>
        <div style={{ fontSize: 21, fontWeight: 600, letterSpacing: '-.02em', marginTop: 15 }}>{signup ? 'Create your workspace' : 'Sign in to Kaizen'}</div>
        <div style={{ fontSize: 13, color: 'var(--text-2)', marginTop: 5, lineHeight: 1.5 }}>
          {signup ? 'Tests written in English that keep passing on their own.' : 'Your tests have been running while you were away.'}
        </div>

        <div className="card" style={{ marginTop: 22, textAlign: 'left', overflow: 'hidden' }}>
          {signup && (
            <div style={{ padding: '11px 14px', borderBottom: '.5px solid var(--sep)' }}>
              <div className="label">Workspace</div>
              <input className="field" defaultValue="Acme Cloud" style={{ marginTop: 4, border: 'none', boxShadow: 'none', background: 'transparent', height: 22, padding: 0 }} />
            </div>
          )}
          <div style={{ padding: '11px 14px', borderBottom: '.5px solid var(--sep)' }}>
            <div className="label">Email</div>
            <input className="field" value={email} onChange={(e) => setEmail(e.target.value)} style={{ marginTop: 4, border: 'none', boxShadow: 'none', background: 'transparent', height: 22, padding: 0 }} />
          </div>
          <div style={{ padding: '11px 14px' }}>
            <div className="label">Password</div>
            <input className="field" type="password" value={pw} onChange={(e) => setPw(e.target.value)} style={{ marginTop: 4, border: 'none', boxShadow: 'none', background: 'transparent', height: 22, padding: 0 }} />
          </div>
        </div>

        <button className="btn pri lg" style={{ width: '100%', marginTop: 14, height: 34 }} onClick={go} disabled={busy}>
          {busy ? <span className="spinner" style={{ borderTopColor: '#fff', borderColor: 'rgba(255,255,255,.35)' }} /> : null}
          {busy ? 'Signing in…' : signup ? 'Create workspace' : 'Sign in'}
        </button>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 12, fontSize: 12 }}>
          <a href="#" style={{ fontSize: 12 }} onClick={(e) => { e.preventDefault(); onMode(signup ? 'login' : 'signup'); }}>
            {signup ? 'I already have an account' : 'Create a workspace'}
          </a>
          {!signup && <a href="#" style={{ fontSize: 12 }} onClick={(e) => e.preventDefault()}>Forgot password?</a>}
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 20, lineHeight: 1.5 }}>
          Sessions are cookie-based, so you stay signed in on this Mac.
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { RunsScreen, LoginScreen });
