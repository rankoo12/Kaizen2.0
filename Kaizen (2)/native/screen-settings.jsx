/* global React, I, fmt, TENANT, COST_CURVE, API_KEYS, Toolbar, Seg, Stat, Sparkline, Sheet, Menu, Switch */

const { useState: uSu } = React;

const SCOPES = {
  read_only: { label: 'Read only', c: 'var(--text-2)', note: 'Read runs, results and reports.' },
  execute: { label: 'Execute', c: 'var(--accent-text)', note: 'Trigger runs and read everything.' },
  admin: { label: 'Admin', c: 'var(--fail)', note: 'Full access, including keys and members.' },
};

function CostChart({ data }) {
  const max = Math.max(...data.map((d) => d.tokens));
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 118 }}>
      {data.map((d, i) => (
        <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', height: '100%', gap: 4 }} title={`${fmt.n(d.tokens)} tokens/run · ${d.runs} runs`}>
          <div style={{ height: `${d.tokens / max * 100}%`, borderRadius: 3, background: i === data.length - 1 ? 'var(--heal)' : 'var(--accent)', opacity: i === data.length - 1 ? 1 : .16 + i / data.length * .5, transition: 'height .5s' }} />
        </div>
      ))}
    </div>
  );
}

function KeySheet({ onClose, onCreate }) {
  const [name, setName] = uSu('');
  const [scope, setScope] = uSu('execute');
  return (
    <Sheet title="New API key" onClose={onClose} footer={<>
      <button className="btn lg" onClick={onClose}>Cancel</button>
      <button className="btn pri lg" disabled={!name.trim()} onClick={() => onCreate(name, scope)}>Create key</button>
    </>}>
      <div className="label">Label</div>
      <input className="field" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. GitHub Actions — release" style={{ marginTop: 5 }} />
      <div className="label" style={{ marginTop: 14 }}>Scope</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
        {Object.entries(SCOPES).map(([k, s]) => (
          <button key={k} onClick={() => setScope(k)} style={{ display: 'flex', gap: 10, alignItems: 'center', textAlign: 'left', padding: '9px 11px', borderRadius: 8, cursor: 'pointer', background: scope === k ? 'var(--accent-soft)' : 'var(--fill)', border: `.5px solid ${scope === k ? 'var(--accent)' : 'transparent'}` }}>
            <span style={{ width: 15, height: 15, borderRadius: '50%', border: `1.5px solid ${scope === k ? 'var(--accent)' : 'var(--sep-strong)'}`, display: 'grid', placeItems: 'center', flex: 'none' }}>
              {scope === k && <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--accent)' }} />}
            </span>
            <span>
              <span style={{ fontSize: 13, fontWeight: 600, color: s.c }}>{s.label}</span>
              <span style={{ fontSize: 12, color: 'var(--text-3)', display: 'block' }}>{s.note}</span>
            </span>
          </button>
        ))}
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 13, lineHeight: 1.5 }}>
        The secret is shown once at creation. Keys are scoped to {TENANT.name} and can be revoked at any time.
      </div>
    </Sheet>
  );
}

function SettingsScreen({ showToast, appearance, setAppearance, density, setDensity, group, setGroup }) {
  const [tab, setTab] = uSu('usage');
  const [keys, setKeys] = uSu(API_KEYS);
  const [sheet, setSheet] = uSu(false);
  const [confirmRevoke, setConfirmRevoke] = uSu(null);
  const pct = TENANT.used / TENANT.quota * 100;
  const last = COST_CURVE[COST_CURVE.length - 1];

  return (
    <>
      <Toolbar title="Settings" sub={`${TENANT.name} · ${TENANT.plan} plan`}>
        <Seg value={tab} onChange={setTab} options={[
          { value: 'usage', label: 'Usage' }, { value: 'keys', label: 'API keys' },
          { value: 'members', label: 'Members' }, { value: 'appearance', label: 'Appearance' },
        ]} />
      </Toolbar>

      <div className="scroll" style={{ flex: 1, padding: '18px 22px 40px' }}>
        {tab === 'usage' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 940 }}>
            <div className="card rise" style={{ padding: 17 }}>
              <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 20 }}>
                <div>
                  <div className="card-t">Token quota</div>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginTop: 7 }}>
                    <span className="num" style={{ fontSize: 27, fontWeight: 600, letterSpacing: '-.02em' }}>{fmt.n(TENANT.used)}</span>
                    <span style={{ fontSize: 13, color: 'var(--text-3)' }} className="num">of {fmt.n(TENANT.quota)} this cycle</span>
                  </div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <span className="badge" style={{ background: 'var(--pass-soft)', color: 'var(--pass)', height: 22 }}>{fmt.pct(100 - pct)} REMAINING</span>
                  <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 5 }}>Resets {TENANT.cycleEnds}</div>
                </div>
              </div>
              <div className="meter" style={{ marginTop: 13, height: 9 }}><i style={{ width: `${pct}%` }} /></div>
              <div style={{ display: 'flex', gap: 9, alignItems: 'flex-start', marginTop: 13, padding: '10px 12px', background: 'var(--warn-soft)', borderRadius: 8 }}>
                <I.info size={13} style={{ color: 'var(--warn)', marginTop: 1, flex: 'none' }} />
                <div style={{ fontSize: 12, color: 'var(--text-2)', lineHeight: 1.5 }}>
                  If the workspace goes over quota, new runs are rejected the moment they’re submitted — with the reason shown
                  on the run — rather than failing halfway through. Runs already in flight finish.
                </div>
              </div>
            </div>

            <div className="card" style={{ padding: 17 }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
                <div>
                  <div className="card-t">Tokens per run, last 30 days</div>
                  <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 2 }}>
                    The line that matters: a mature test should cost close to nothing.
                  </div>
                </div>
                <span className="badge" style={{ background: 'var(--pass-soft)', color: 'var(--pass)', height: 22 }}>
                  <I.arrowDown size={10} />{Math.round((1 - last.tokens / COST_CURVE[0].tokens) * 100)}% IN 30 DAYS
                </span>
              </div>
              <div style={{ marginTop: 15 }}><CostChart data={COST_CURVE} /></div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, fontSize: 11, color: 'var(--text-3)' }} className="num">
                <span>30d ago · {fmt.n(COST_CURVE[0].tokens)} tok/run</span><span>today · {fmt.n(last.tokens)} tok/run</span>
              </div>
              <div style={{ display: 'flex', marginTop: 15, borderTop: '.5px solid var(--sep)' }}>
                <div style={{ flex: '1 1 148px', minWidth: 0, borderRight: '.5px solid var(--sep)' }}><Stat label="Runs today" value={last.runs} sub="across all suites" /></div>
                <div style={{ flex: '1 1 148px', minWidth: 0, borderRight: '.5px solid var(--sep)' }}><Stat label="Cache hit" value={`${last.cacheHit}%`} tone="var(--cache)" sub={`was ${COST_CURVE[0].cacheHit}% a month ago`} /></div>
                <div style={{ flex: '1 1 148px', minWidth: 0, borderRight: '.5px solid var(--sep)' }}><Stat label="AI calls today" value={Math.round(last.runs * (1 - last.cacheHit / 100) * 2)} tone="var(--warn)" sub="only for new markup" /></div>
                <div style={{ flex: 1 }}><Stat label="Projected cycle" value={fmt.k(Math.round(TENANT.used * 1.18))} unit="tok" sub="within quota" tone="var(--pass)" /></div>
              </div>
            </div>
          </div>
        )}

        {tab === 'keys' && (
          <div style={{ maxWidth: 940 }}>
            <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 11 }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600 }}>API keys</div>
                <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 2 }}>For CI/CD and dashboards. Scoped, revocable, never shown twice.</div>
              </div>
              <button className="btn pri" onClick={() => setSheet(true)}><I.plus size={13} />New key</button>
            </div>
            <div className="list">
              <div className="list-h"><span style={{ width: 14 }} /><span style={{ flex: 1 }}>LABEL</span><span className="hide-md" style={{ width: 150 }}>KEY</span><span style={{ width: 110 }}>SCOPE</span><span className="hide-lg" style={{ width: 90 }}>CREATED</span><span style={{ width: 90, textAlign: 'right' }}>LAST USED</span><span style={{ width: 70 }} /></div>
              {keys.map((k) => (
                <div className="row" key={k.id} style={{ cursor: 'default' }}>
                  <I.keys size={14} style={{ color: 'var(--text-3)', flex: 'none' }} />
                  <div style={{ flex: '1 1 150px', minWidth: 0 }}><div className="row-t">{k.name}</div></div>
                  <span className="num hide-md" style={{ width: 150, flex: 'none', fontSize: 12, color: 'var(--text-2)' }}>{k.prefix}••••••••</span>
                  <span style={{ width: 110, flex: 'none' }}>
                    <span className="badge" style={{ background: 'var(--fill)', color: SCOPES[k.scope].c }}>{k.scope.toUpperCase()}</span>
                  </span>
                  <span className="num hide-lg" style={{ width: 90, flex: 'none', fontSize: 12, color: 'var(--text-3)' }}>{k.created}</span>
                  <span className="num" style={{ width: 90, flex: 'none', fontSize: 12, color: 'var(--text-2)', textAlign: 'right' }}>{k.last}</span>
                  <span className="row-actions" style={{ width: 70, flex: 'none', display: 'flex', gap: 3, justifyContent: 'flex-end' }}>
                    <button className="btn icon ghost" title="Copy prefix" onClick={() => showToast('Key prefix copied', 'success')}><I.copy size={12} /></button>
                    <button className="btn icon ghost" title="Revoke" onClick={() => setConfirmRevoke(k)}><I.trash size={12} /></button>
                  </span>
                </div>
              ))}
            </div>
            <div className="card" style={{ marginTop: 14, padding: 15 }}>
              <div className="label">Trigger a run from CI</div>
              <pre className="num scroll" style={{ margin: '8px 0 0', fontSize: 12, background: 'var(--fill)', padding: '11px 13px', borderRadius: 8, lineHeight: 1.65, overflowX: 'auto' }}>{`curl -X POST https://api.kaizen.dev/v1/runs \\
  -H "Authorization: Bearer kz_live_9f2c…" \\
  -d '{"caseId":"s-auth-01","env":"https://staging.acme.io"}'`}</pre>
            </div>
          </div>
        )}

        {tab === 'members' && (
          <div style={{ maxWidth: 720 }}>
            <div className="list">
              <div className="list-h"><span style={{ width: 26 }} /><span style={{ flex: 1 }}>MEMBER</span><span style={{ width: 130 }}>ROLE</span><span style={{ width: 110, textAlign: 'right' }}>LAST ACTIVE</span></div>
              {[
                { n: TENANT.user.name, e: TENANT.user.email, r: 'Owner', a: 'now', i: 'AL' },
                { n: 'Marcus Reid', e: 'marcus@acme.io', r: 'Engineer', a: '20m ago', i: 'MR' },
                { n: 'Priya Nair', e: 'priya@acme.io', r: 'QA', a: '2h ago', i: 'PN' },
                { n: 'CI Service', e: 'ci@acme.io', r: 'Machine', a: '2m ago', i: 'CI' },
              ].map((m) => (
                <div className="row" key={m.e} style={{ cursor: 'default' }}>
                  <span style={{ width: 26, height: 26, borderRadius: 7, background: 'var(--fill-2)', display: 'grid', placeItems: 'center', fontSize: 11, fontWeight: 700, color: 'var(--text-2)', flex: 'none' }}>{m.i}</span>
                  <div style={{ flex: '1 1 140px', minWidth: 0 }}><div className="row-t">{m.n}</div><div className="row-s num">{m.e}</div></div>
                  <span style={{ width: 130, flex: 'none' }}><span className="pill">{m.r}</span></span>
                  <span className="num" style={{ width: 110, flex: 'none', textAlign: 'right', fontSize: 12, color: 'var(--text-2)' }}>{m.a}</span>
                </div>
              ))}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 12, lineHeight: 1.55, padding: '0 4px' }}>
              Everything in Kaizen belongs to a workspace. Members only ever see {TENANT.name} data; roles decide who can
              author tests, trigger runs, and manage keys.
            </div>
          </div>
        )}

        {tab === 'appearance' && (
          <div style={{ maxWidth: 560, display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div className="list">
              <div className="list-h">APPEARANCE</div>
              <div className="row" style={{ cursor: 'default' }}>
                <div style={{ flex: 1 }}><div className="row-t">Theme</div><div className="row-s">Aperture is the industrial skin; light and dark are the system ones.</div></div>
                <Seg value={appearance} onChange={setAppearance} options={[{ value: 'aperture', label: 'Aperture' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]} />
              </div>
              <div className="row" style={{ cursor: 'default' }}>
                <div style={{ flex: 1 }}><div className="row-t">List density</div><div className="row-s">Comfortable adds the cache-hit column.</div></div>
                <Seg value={density} onChange={setDensity} options={[{ value: 'compact', label: 'Compact' }, { value: 'comfortable', label: 'Comfortable' }]} />
              </div>
              <div className="row" style={{ cursor: 'default' }}>
                <div style={{ flex: 1 }}><div className="row-t">Group tests by suite</div><div className="row-s">Off shows one flat list.</div></div>
                <Switch checked={group} onChange={setGroup} />
              </div>
            </div>
            <div className="list">
              <div className="list-h">SESSION</div>
              <div className="row" style={{ cursor: 'default' }}>
                <div style={{ flex: 1 }}><div className="row-t">{TENANT.user.name}</div><div className="row-s num">{TENANT.user.email} · {TENANT.user.role}</div></div>
                <button className="btn danger" onClick={() => showToast('Signed out — cookie cleared', 'info')}>Sign out</button>
              </div>
            </div>
          </div>
        )}
      </div>

      {confirmRevoke && <window.ConfirmSheet title={`Revoke “${confirmRevoke.name}”?`}
        message={`Anything using ${confirmRevoke.prefix}… stops working immediately — including CI pipelines. This can’t be undone.`}
        confirmLabel="Revoke key"
        onConfirm={() => { setKeys(keys.filter((x) => x.id !== confirmRevoke.id)); showToast(`${confirmRevoke.name} revoked`, 'error'); }}
        onClose={() => setConfirmRevoke(null)} />}

      {sheet && <KeySheet onClose={() => setSheet(false)} onCreate={(name, scope) => {
        setKeys([{ id: `k${Date.now()}`, name, prefix: `kz_live_${Math.random().toString(16).slice(2, 6)}`, scope, created: 'today', last: 'never' }, ...keys]);
        setSheet(false); showToast('Key created — copy the secret now, it won’t be shown again', 'success');
      }} />}
    </>
  );
}

Object.assign(window, { SettingsScreen });
