/* global React, ReactDOM, I, CASES, RUNS_FEED, Sidebar, Lights, MenuBar, Toolbar, Toast,
   TestsScreen, RunScreen, AuthorScreen, BrainScreen, SettingsScreen, RunsScreen, LoginScreen, MobileScreen,
   useTweaks, TweaksPanel, TweakSection, TweakRadio, TweakToggle, TweakSelect */

const { useState: uSp, useEffect: uEp } = React;

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "appearance": "light",
  "screen": "tests",
  "density": "comfortable",
  "groupBySuite": true,
  "liveRun": true,
  "framed": true,
  "sidebar": true,
  "device": "desktop"
}/*EDITMODE-END*/;

const SCREENS = ['login', 'signup', 'tests', 'author', 'run', 'runs', 'brain', 'settings'];

function App() {
  const [t, setT] = useTweaks(TWEAK_DEFAULTS);
  const [screen, setScreen] = uSp(t.screen);
  const [suite, setSuite] = uSp(null);
  const [toast, setToast] = uSp(null);
  const [runKey, setRunKey] = uSp(0);
  const [win, setWin] = uSp('open');

  uEp(() => setScreen(t.screen), [t.screen]);
  uEp(() => { document.documentElement.setAttribute('data-appearance', t.appearance); }, [t.appearance]);

  const go = (s, arg) => {
    if (s === 'tests') setSuite(arg || null);
    setScreen(s); setT({ screen: s });
  };
  const showToast = (message, kind = 'info') => {
    const k = Date.now(); setToast({ message, kind, k });
    setTimeout(() => setToast((cur) => (cur && cur.k === k ? null : cur)), 2600);
  };
  const openRun = () => { setRunKey((k) => k + 1); go('run'); };
  const runNow = () => { showToast('Queued — a worker is booting a browser', 'info'); openRun(); };

  const authed = screen !== 'login' && screen !== 'signup';

  // real shortcuts, the ones the menu bar advertises
  uEp(() => {
    const h = (e) => {
      const tag = e.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (!(e.metaKey || e.ctrlKey)) return;
      const k = e.key.toLowerCase();
      const map = { 1: 'tests', 2: 'runs', 3: 'brain', 4: 'usage' };
      if (map[k]) { e.preventDefault(); go(map[k] === 'usage' ? 'settings' : map[k]); return; }
      if (k === 'n') { e.preventDefault(); go('author'); }
      else if (k === 'r') { e.preventDefault(); runNow(); }
      else if (k === ',') { e.preventDefault(); go('settings'); }
      else if (k === 'a' && e.shiftKey) { e.preventDefault(); setT({ appearance: t.appearance === 'dark' ? 'light' : 'dark' }); }
      else if (k === 's' && e.altKey) { e.preventDefault(); setT({ sidebar: !t.sidebar }); }
      else if (k === 'f' && e.ctrlKey) { e.preventDefault(); setT({ framed: !t.framed }); }
      else if (k === 'w') { e.preventDefault(); setWin('min'); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [t.appearance, t.framed, screen]);

  const active = RUNS_FEED.filter((r) => r.status === 'running' || r.status === 'queued').length;
  const counts = { tests: CASES.length, runs: active || null };

  const menus = [
    { label: 'File', items: [
      { label: 'New Test', key: '⌘N', onClick: () => go('author') },
      { label: 'Save Draft', key: '⌘S', disabled: screen !== 'author' },
      '-',
      { label: 'Close Window', key: '⌘W', onClick: () => setWin('min') },
    ] },
    { label: 'Test', items: [
      { label: 'Run', key: '⌘R', onClick: runNow },
      { label: 'Open Latest Run', key: '⏎', onClick: openRun },
      { label: 'Compare With Previous', key: '⌘D', onClick: () => showToast('Run comparison is next on the list', 'info') },
      '-',
      { label: 'Cancel Run', key: '⌘.', disabled: screen !== 'run' },
    ] },
    { label: 'View', items: [
      { label: t.sidebar ? 'Hide Sidebar' : 'Show Sidebar', key: '⌥⌘S', onClick: () => setT({ sidebar: !t.sidebar }) },
      '-',
      { label: 'Tests', key: '⌘1', onClick: () => go('tests') },
      { label: 'Runs', key: '⌘2', onClick: () => go('runs') },
      { label: 'The Brain', key: '⌘3', onClick: () => go('brain') },
      { label: 'Usage', key: '⌘4', onClick: () => go('settings') },
      '-',
      { label: t.appearance === 'dark' ? 'Light Appearance' : 'Dark Appearance', key: '⇧⌘A', onClick: () => setT({ appearance: t.appearance === 'dark' ? 'light' : 'dark' }) },
      { label: t.framed ? 'Fill the Screen' : 'Windowed', key: '⌃⌘F', onClick: () => setT({ framed: !t.framed }) },
      { label: t.device === 'phone' ? 'Desktop App' : 'iPhone App', onClick: () => setT({ device: t.device === 'phone' ? 'desktop' : 'phone' }) },
    ] },
    { label: 'Help', items: [
      { label: 'Keyboard Shortcuts', key: '⌘/' , onClick: () => showToast('↑↓ move · ⏎ open · ⌘R run · ⌘N new · ⌘1–4 sections', 'info') },
    ] },
  ];

  const body = (() => {
    if (!authed) {
      return (
        <>
          <div className="toolbar" style={{ background: 'transparent', borderBottom: 'none', backdropFilter: 'none' }}>
            <Lights onAction={() => setWin('min')} />
            <div style={{ flex: 1 }} />
            <button className="btn ghost" onClick={() => go(screen === 'login' ? 'signup' : 'login')}>
              {screen === 'login' ? 'Create workspace' : 'Sign in'}
            </button>
          </div>
          <LoginScreen mode={screen} onMode={go} onSubmit={() => { go('tests'); showToast('Signed in — 3 runs finished while you were away', 'success'); }} />
        </>
      );
    }
    return (
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        {t.sidebar && <Sidebar active={suite || (screen === 'author' || screen === 'run' ? 'tests' : screen)}
          onNav={go} counts={counts} onSettings={() => go('settings')} onLights={() => setWin('min')}
          onToggle={() => setT({ sidebar: false })} />}
        {!t.sidebar && (
          <div style={{ position: 'absolute', top: 0, left: 8, height: 52, display: 'flex', alignItems: 'center', gap: 0, zIndex: 40 }}>
            <Lights onAction={() => setWin('min')} />
            <button className="btn icon ghost" title="Show sidebar (⌥⌘S)" onClick={() => setT({ sidebar: true })}><I.sidebar size={15} /></button>
          </div>
        )}
        <main style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, background: 'var(--window)' }}>
          {t.device === 'phone' ? (
            <>
              <Toolbar title="Kaizen for iPhone" sub="The run monitor, reduced to what matters on a phone" />
              <MobileScreen dark={t.appearance === 'dark'} />
            </>
          ) : screen === 'tests' ? (
            <TestsScreen onOpen={openRun} onNew={() => go('author')} onRun={runNow} showToast={showToast}
              suiteFilter={suite} onClearSuite={() => setSuite(null)} density={t.density} group={t.groupBySuite} />
          ) : screen === 'author' ? (
            <AuthorScreen onBack={() => go('tests')} showToast={showToast}
              onCreate={() => { showToast('Compiled — 5 steps from memory, 1 needs the AI', 'info'); openRun(); }} />
          ) : screen === 'run' ? (
            <RunScreen key={runKey} onBack={() => go('tests')} showToast={showToast} liveDefault={t.liveRun} />
          ) : screen === 'runs' ? (
            <RunsScreen onOpen={openRun} />
          ) : screen === 'brain' ? (
            <BrainScreen showToast={showToast} />
          ) : (
            <SettingsScreen showToast={showToast}
              appearance={t.appearance} setAppearance={(v) => setT({ appearance: v })}
              density={t.density} setDensity={(v) => setT({ density: v })}
              group={t.groupBySuite} setGroup={(v) => setT({ groupBySuite: v })} />
          )}
        </main>
      </div>
    );
  })();

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <MenuBar menus={menus} status={
        <span style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 12 }}>
          {active > 0 && <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <span className="dot pulse" style={{ background: 'var(--accent)', width: 6, height: 6 }} />{active} runs active
          </span>}
          <span className="num">14:26</span>
        </span>
      } />
      <div style={{ flex: 1, minHeight: 0, padding: t.framed ? '0 clamp(8px,2vh,20px) clamp(8px,2vh,20px)' : 0, position: 'relative' }}>
        {win === 'open' ? (
          <div className={`win${t.sidebar || !authed ? '' : ' no-side'}`} style={t.framed ? null : { borderRadius: 0, boxShadow: 'none' }}>
            {body}
            <Toast toast={toast} />
          </div>
        ) : (
          <div style={{ height: '100%', display: 'grid', placeItems: 'center' }}>
            <button className="dock" onClick={() => setWin('open')} style={{ position: 'static', transform: 'none' }}>
              <span style={{ width: 20, height: 20, borderRadius: 6, background: 'var(--accent)', color: '#fff', display: 'grid', placeItems: 'center' }}><I.logo size={12} /></span>
              Kaizen — click to reopen
            </button>
          </div>
        )}
      </div>

      <TweaksPanel title="Kaizen">
        <TweakSection label="Screen" />
        <TweakSelect label="Screen" value={t.screen} options={SCREENS} onChange={(v) => { setT({ screen: v }); setScreen(v); }} />
        <TweakRadio label="Device" value={t.device} options={['desktop', 'phone']} onChange={(v) => setT({ device: v })} />
        <TweakSection label="Appearance" />
        <TweakRadio label="Theme" value={t.appearance} options={['light', 'dark']} onChange={(v) => setT({ appearance: v })} />
        <TweakRadio label="Density" value={t.density} options={['compact', 'comfortable']} onChange={(v) => setT({ density: v })} />
        <TweakToggle label="Sidebar" value={t.sidebar} onChange={(v) => setT({ sidebar: v })} />
        <TweakToggle label="Group tests by suite" value={t.groupBySuite} onChange={(v) => setT({ groupBySuite: v })} />
        <TweakToggle label="Window frame" value={t.framed} onChange={(v) => setT({ framed: v })} />
        <TweakSection label="Run detail" />
        <TweakToggle label="Replay the run live" value={t.liveRun} onChange={(v) => setT({ liveRun: v })} />
      </TweaksPanel>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
