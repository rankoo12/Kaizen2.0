/* global React, I, fmt, BRAIN, SUITES, Toolbar, Seg, Menu, SourceTag */

const { useState: uSa, useMemo: uMa } = React;

const VERBS = [
  ['navigate', 'Navigate'], ['go to', 'Navigate'], ['open', 'Navigate'], ['reload', 'Navigate'], ['go back', 'Navigate'],
  ['type', 'Type'], ['enter', 'Type'], ['fill', 'Type'],
  ['click', 'Click'], ['double-click', 'Click'], ['right-click', 'Click'], ['press', 'Key'],
  ['select', 'Select'], ['choose', 'Select'], ['check', 'Check'], ['uncheck', 'Check'],
  ['drag', 'Drag'], ['drop', 'Drag'], ['scroll', 'Scroll'], ['wait', 'Wait'],
  ['switch to', 'Tabs'], ['close the tab', 'Tabs'], ['dismiss', 'Click'],
  ['verify', 'Assert'], ['assert', 'Assert'], ['expect', 'Assert'], ['confirm', 'Assert'],
  ['remember', 'Capture'], ['capture', 'Capture'],
];

function parseStep(text) {
  const t = text.trim().toLowerCase();
  if (!t) return { verb: '—', known: null };
  const hit = VERBS.find(([k]) => t.startsWith(k)) || VERBS.find(([k]) => t.includes(` ${k} `));
  const verb = hit ? hit[1] : 'Click';
  if (t.includes('random') || t.includes('remember')) return { verb: 'Capture', known: 'vector' };
  const memory = BRAIN.find((b) => !b.blocked && t.includes(b.intent.replace(/^the /, '').split(' ')[0]) && b.conf > .8);
  const known = /^(navigate|go to|open|reload|wait|scroll|press|go back)/.test(t) ? 'pattern'
    : memory ? (memory.scope === 'global' ? 'global' : 'cache') : 'llm';
  return { verb, known, memory };
}

const STARTERS = {
  'Sign-in flow': [
    'navigate to https://app.acme.io/login',
    'dismiss the cookie banner if it appears',
    'type "ada@acme.io" in the email field',
    'type the saved password in the password field',
    'click the "Sign in" button',
    'verify the page contains "Dashboard"',
  ],
  'Checkout a random product': [
    'navigate to https://shop.acme.io',
    'select a random product and remember its name',
    'click the "Add to cart" button',
    'verify there is 1 item in the cart',
    'verify the cart contains {{product}}',
  ],
  'Blank': ['navigate to https://'],
};

function StepEditor({ steps, setSteps }) {
  const [focus, setFocus] = uSa(null);
  const move = (i, d) => {
    const n = [...steps]; const j = i + d;
    if (j < 0 || j >= n.length) return;
    [n[i], n[j]] = [n[j], n[i]]; setSteps(n);
  };
  return (
    <div className="list">
      <div className="list-h">
        <span style={{ flex: 1 }}>STEPS · PLAIN ENGLISH, IN ORDER</span>
        <span className="num">{steps.length}</span>
      </div>
      {steps.map((s, i) => {
        const p = parseStep(s);
        return (
          <div className="row" key={i} style={{ cursor: 'default', alignItems: 'center', padding: '7px 10px 7px 8px', background: focus === i ? 'var(--fill)' : undefined }}>
            <I.drag size={13} style={{ color: 'var(--text-3)', cursor: 'grab', flex: 'none' }} />
            <span className="num" style={{ fontSize: 11, color: 'var(--text-3)', width: 15, flex: 'none' }}>{i + 1}</span>
            <span className="mono-chip hide-sm" style={{ width: 60, flex: 'none', textAlign: 'center', fontSize: 11, fontWeight: 700, letterSpacing: '.03em', color: p.verb === '—' ? 'var(--text-3)' : 'var(--text-2)' }}>{p.verb.toUpperCase()}</span>
            <input className="field" value={s} onFocus={() => setFocus(i)} onBlur={() => setFocus(null)}
              onChange={(e) => { const n = [...steps]; n[i] = e.target.value; setSteps(n); }}
              placeholder="e.g. click the “Sign in” button"
              style={{ height: 26, border: 'none', background: 'transparent', boxShadow: 'none', fontSize: 13, flex: 1, minWidth: 0, padding: '0 2px' }} />
            <div style={{ display: 'flex', gap: 1, flex: 'none' }}>
              <button className="btn icon ghost" onClick={() => move(i, -1)} disabled={!i} title="Move up"><I.chevronUp size={12} /></button>
              <button className="btn icon ghost" onClick={() => move(i, 1)} disabled={i === steps.length - 1} title="Move down"><I.chevronDown size={12} /></button>
              <button className="btn icon ghost" onClick={() => setSteps(steps.filter((_, k) => k !== i))} title="Remove"><I.x size={12} /></button>
            </div>
          </div>
        );
      })}
      <div className="row" style={{ padding: '8px 12px' }} onClick={() => setSteps([...steps, ''])}>
        <I.plus size={13} style={{ color: 'var(--accent)' }} />
        <span style={{ fontSize: 13, color: 'var(--accent-text)', fontWeight: 500 }}>Add a step</span>
      </div>
    </div>
  );
}

function AuthorScreen({ onBack, onCreate, showToast }) {
  const [name, setName] = uSa('Sign in with valid credentials');
  const [url, setUrl] = uSa('https://app.acme.io');
  const [suite, setSuite] = uSa('s-auth');
  const [steps, setSteps] = uSa(STARTERS['Sign-in flow']);
  const [ci, setCi] = uSa(true);

  const plan = uMa(() => steps.map((s, i) => ({ i: i + 1, text: s, ...parseStep(s) })), [steps]);
  const needsAI = plan.filter((p) => p.known === 'llm' && p.text.trim()).length;
  const est = needsAI * 1750;

  return (
    <>
      <Toolbar back={onBack} title="New test" sub="Write it in English — Kaizen finds the elements at run time">
        <button className="btn" onClick={onBack}>Cancel</button>
        <button className="btn" onClick={() => showToast('Draft saved to Authentication', 'success')}>Save draft</button>
        <button className="btn pri" onClick={onCreate} disabled={!steps.filter((s) => s.trim()).length}><I.play size={12} />Save & Run</button>
      </Toolbar>

      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <div className="scroll" style={{ flex: 1, padding: '18px 22px 40px', minWidth: 0 }}>
          <div className="card" style={{ padding: 16, marginBottom: 14 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(190px,1fr))', gap: 14 }}>
              <label>
                <div className="label">Test name</div>
                <input className="field" style={{ marginTop: 5 }} value={name} onChange={(e) => setName(e.target.value)} />
              </label>
              <label>
                <div className="label">Suite</div>
                <select className="field" style={{ marginTop: 5 }} value={suite} onChange={(e) => setSuite(e.target.value)}>
                  {SUITES.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </label>
            </div>
            <label style={{ display: 'block', marginTop: 14 }}>
              <div className="label">Target URL</div>
              <input className="field num" style={{ marginTop: 5 }} value={url} onChange={(e) => setUrl(e.target.value)} />
            </label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 11, marginTop: 15, paddingTop: 14, borderTop: '.5px solid var(--sep)' }}>
              <window.Switch checked={ci} onChange={setCi} />
              <div>
                <div style={{ fontSize: 13, fontWeight: 500 }}>Run in CI on every push to main</div>
                <div style={{ fontSize: 12, color: 'var(--text-3)' }}>Uses the <span className="num">GitHub Actions — main</span> key with the execute scope.</div>
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 2px 8px' }}>
            <span className="label">Start from</span>
            {Object.keys(STARTERS).map((k) => (
              <button key={k} className="btn" style={{ height: 23, fontSize: 12 }} onClick={() => setSteps(STARTERS[k])}>{k}</button>
            ))}
          </div>

          <StepEditor steps={steps} setSteps={setSteps} />

          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginTop: 13, padding: '0 4px' }}>
            <I.info size={13} style={{ color: 'var(--text-3)', marginTop: 2, flex: 'none' }} />
            <div style={{ fontSize: 12, color: 'var(--text-3)', lineHeight: 1.55, maxWidth: 620 }}>
              No selectors, no waits, no code. You can reference something an earlier step remembered with
              <span className="num" style={{ margin: '0 3px' }}>{'{{name}}'}</span>, and steps that touch cookie banners or iframes are handled for you.
            </div>
          </div>
        </div>

        {/* compile preview */}
        <div className="scroll inspector" style={{ flex: 'none', borderLeft: '.5px solid var(--sep)', background: 'var(--content)', padding: '16px 16px 40px' }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>What Kaizen will do</div>
          <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 3, lineHeight: 1.5 }}>
            Compiled from your steps. Anything already in memory costs nothing to resolve.
          </div>

          <div style={{ display: 'flex', gap: 9, margin: '14px 0' }}>
            <div style={{ flex: 1, background: 'var(--cache-soft)', borderRadius: 9, padding: '10px 12px' }}>
              <div className="num" style={{ fontSize: 21, fontWeight: 600, color: 'var(--cache)' }}>{plan.filter((p) => p.known && p.known !== 'llm').length}</div>
              <div style={{ fontSize: 11, color: 'var(--text-2)', marginTop: 1 }}>from memory</div>
            </div>
            <div style={{ flex: 1, background: 'var(--warn-soft)', borderRadius: 9, padding: '10px 12px' }}>
              <div className="num" style={{ fontSize: 21, fontWeight: 600, color: 'var(--warn)' }}>{needsAI}</div>
              <div style={{ fontSize: 11, color: 'var(--text-2)', marginTop: 1 }}>need the AI once</div>
            </div>
          </div>

          <div style={{ background: 'var(--fill)', borderRadius: 9, padding: '10px 12px', display: 'flex', alignItems: 'center', gap: 9 }}>
            <I.bolt size={14} style={{ color: 'var(--text-2)' }} />
            <div style={{ fontSize: 12, color: 'var(--text-2)', lineHeight: 1.45 }}>
              First run ≈ <span className="num" style={{ fontWeight: 600, color: 'var(--text)' }}>{fmt.n(est)}</span> tokens.
              After that it should settle near <span className="num" style={{ fontWeight: 600, color: 'var(--cache)' }}>0</span>.
            </div>
          </div>

          <div className="label" style={{ marginTop: 18, marginBottom: 7 }}>Compiled plan</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {plan.filter((p) => p.text.trim()).map((p) => (
              <div key={p.i} style={{ border: '.5px solid var(--sep)', borderRadius: 8, padding: '8px 10px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                  <span className="num" style={{ fontSize: 11, color: 'var(--text-3)' }}>{String(p.i).padStart(2, '0')}</span>
                  <span className="mono-chip" style={{ fontSize: 11, fontWeight: 700 }}>{p.verb.toUpperCase()}</span>
                  <div style={{ flex: 1 }} />
                  <SourceTag source={p.known} tokens={p.known === 'llm' ? 1750 : 0} />
                </div>
                <div style={{ fontSize: 12, marginTop: 5, color: 'var(--text-2)', lineHeight: 1.4 }}>{p.text}</div>
                {p.memory && <div style={{ fontSize: 11, marginTop: 5 }} className="num">
                  <span style={{ color: 'var(--text-3)' }}>known: </span><span style={{ color: 'var(--cache)' }}>{p.memory.selector}</span>
                </div>}
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

Object.assign(window, { AuthorScreen, parseStep });
