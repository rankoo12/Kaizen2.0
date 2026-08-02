/* global React, I, fmt, STEPS, RUN, FOCUS_CASE, IOSDevice, TENANT */

const { useState: uSm, useEffect: uEm } = React;

function MobileScreen({ dark }) {
  const [landed, setLanded] = uSm(3);
  uEm(() => {
    const id = setInterval(() => setLanded((n) => (n >= STEPS.length ? 0 : n + 1)), 1300);
    return () => clearInterval(id);
  }, []);

  const text = dark ? '#fff' : '#000';
  const sec = dark ? 'rgba(235,235,245,.6)' : 'rgba(60,60,67,.6)';
  const cardBg = dark ? '#1C1C1E' : '#fff';
  const pageBg = dark ? '#000' : '#F2F2F7';
  const done = landed >= STEPS.length;
  const tokens = STEPS.slice(0, landed).reduce((a, s) => a + s.tokens, 0);
  const healed = STEPS.slice(0, landed).some((s) => s.heal);

  return (
    <div style={{ flex: 1, display: 'grid', placeItems: 'center', padding: 20, background: 'transparent' }}>
      <div style={{ display: 'flex', gap: 34, alignItems: 'center' }}>
        <div style={{ maxWidth: 268 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-3)', letterSpacing: '.02em' }}>ON THE PHONE</div>
          <div style={{ fontSize: 21, fontWeight: 600, letterSpacing: '-.02em', marginTop: 7, lineHeight: 1.3 }}>
            Watch a run land while you’re away from the desk
          </div>
          <div style={{ fontSize: 13, color: 'var(--text-2)', marginTop: 9, lineHeight: 1.6 }}>
            The same run, the same evidence — reduced to the two questions that matter on a phone:
            did it pass, and did anything have to heal itself. Tap a step for the element it used.
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7, marginTop: 16 }}>
            {[['Push notification when a run needs a human', 'info'], ['Self-heals are called out, never buried', 'heal'], ['Cost per run visible at a glance', 'usage']].map(([t, ic]) => (
              <div key={t} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, color: 'var(--text-2)' }}>
                {React.createElement(I[ic], { size: 13, style: { color: 'var(--accent)', flex: 'none' } })}{t}
              </div>
            ))}
          </div>
        </div>

        <IOSDevice dark={dark} width={330} height={690}>
          <div style={{ height: '100%', background: pageBg, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            <div style={{ padding: '4px 20px 10px' }}>
              <div style={{ fontSize: 12, color: sec, fontFamily: 'var(--font-num)' }}>#{RUN.n} · {RUN.trigger}</div>
              <div style={{ fontSize: 25, fontWeight: 700, letterSpacing: '-.02em', color: text, marginTop: 2, lineHeight: 1.15 }}>{FOCUS_CASE.name}</div>
            </div>

            <div style={{ margin: '0 16px 14px', borderRadius: 18, background: cardBg, padding: 15 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
                {done
                  ? <span style={{ width: 34, height: 34, borderRadius: '50%', background: healed ? 'rgba(122,77,240,.16)' : 'rgba(31,157,85,.16)', color: healed ? '#7a4df0' : '#1f9d55', display: 'grid', placeItems: 'center' }}>
                      {healed ? <I.heal size={17} /> : <I.check size={18} />}
                    </span>
                  : <span className="spinner" style={{ width: 30, height: 30, borderWidth: 3, borderColor: dark ? 'rgba(255,255,255,.18)' : 'rgba(0,0,0,.1)', borderTopColor: '#0b62f4' }} />}
                <div>
                  <div style={{ fontSize: 17, fontWeight: 600, color: text, letterSpacing: '-.01em' }}>
                    {done ? (healed ? 'Passed, self-healed' : 'Passed') : `Step ${landed + 1} of ${STEPS.length}`}
                  </div>
                  <div style={{ fontSize: 13, color: sec, marginTop: 1 }}>
                    {done ? `${fmt.ms(STEPS.reduce((a, s) => a + s.ms, 0))} · ${fmt.n(tokens)} tokens` : 'Live · polling every 2s'}
                  </div>
                </div>
              </div>
              <div style={{ height: 6, borderRadius: 99, background: dark ? 'rgba(255,255,255,.12)' : 'rgba(0,0,0,.08)', marginTop: 13, overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${landed / STEPS.length * 100}%`, background: done ? (healed ? '#7a4df0' : '#1f9d55') : '#0b62f4', borderRadius: 99, transition: 'width .5s cubic-bezier(.32,.72,0,1)' }} />
              </div>
            </div>

            <div style={{ fontSize: 13, fontWeight: 600, color: sec, padding: '0 32px 7px', letterSpacing: '.02em' }}>STEPS</div>
            <div className="scroll" style={{ flex: 1, padding: '0 16px 20px' }}>
              <div style={{ borderRadius: 18, background: cardBg, overflow: 'hidden' }}>
                {STEPS.map((st, i) => {
                  const on = i < landed;
                  const s = window.STATUS[st.status];
                  return (
                    <div key={st.i} style={{ display: 'flex', gap: 11, alignItems: 'center', padding: '11px 15px', minHeight: 52, borderTop: i ? `.5px solid ${dark ? 'rgba(255,255,255,.09)' : 'rgba(60,60,67,.13)'}` : 'none', opacity: on ? 1 : .38 }}>
                      <span style={{ width: 22, height: 22, borderRadius: '50%', flex: 'none', display: 'grid', placeItems: 'center', background: on ? s.s : 'transparent', color: on ? s.c : sec, border: on ? 'none' : `1.5px solid ${sec}` }}>
                        {on ? React.createElement(I[st.heal ? 'heal' : s.icon], { size: 12 }) : <span className="num" style={{ fontSize: 9 }}>{st.i}</span>}
                      </span>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontSize: 15, color: text, letterSpacing: '-.01em', lineHeight: 1.3 }}>{st.text}</div>
                        {on && <div style={{ fontSize: 12, color: st.heal ? '#7a4df0' : sec, marginTop: 2, fontFamily: st.heal ? undefined : 'var(--font-num)' }}>
                          {st.heal ? 'Healed — selector re-learned' : `${window.SOURCES[st.source].short.toLowerCase()} · ${fmt.ms(st.ms)} · ${st.tokens ? `${fmt.n(st.tokens)} tok` : 'free'}`}
                        </div>}
                      </div>
                      {on && <I.chevron size={12} style={{ color: sec, flex: 'none' }} />}
                    </div>
                  );
                })}
              </div>
              <div style={{ fontSize: 12, color: sec, padding: '10px 16px 0', lineHeight: 1.45 }}>
                {TENANT.name} · {fmt.n(TENANT.quota - TENANT.used)} tokens left this cycle
              </div>
            </div>
          </div>
        </IOSDevice>
      </div>
    </div>
  );
}

Object.assign(window, { MobileScreen });
