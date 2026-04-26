/* global React, ReactDOM, SideRail, TopBar, MusicPlayer, Toast,
   AuthScreen, TestsDashboard, NewTestScreen, TestDetailScreen,
   NeuralBackground, useTweaks, TweaksPanel, TweakSection, TweakSelect, TweakSlider, TweakToggle, TweakRadio */

const { useState: useStateApp, useEffect: useEffectApp } = React;

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "theme": "nebula",
  "screen": "tests",
  "vizMode": "timeline",
  "viewMode": "grid",
  "density": "compact",
  "neuralIntensity": 60,
  "neuralOn": true,
  "showMusic": true
}/*EDITMODE-END*/;

function App() {
  const [t, setT] = useTweaks(TWEAK_DEFAULTS);
  const [screen, setScreen] = useStateApp(t.screen);
  const [toast, setToast] = useStateApp(null);

  useEffectApp(() => setScreen(t.screen), [t.screen]);

  // Apply theme to <html>
  useEffectApp(() => {
    document.documentElement.setAttribute('data-theme', t.theme);
  }, [t.theme]);

  const goto = (s) => {
    setScreen(s);
    setT({ screen: s });
  };

  const showToast = (message, kind = 'info') => {
    setToast({ message, kind, k: Date.now() });
    setTimeout(() => setToast(null), 2400);
  };

  // Auth flow
  if (screen === 'login' || screen === 'signup') {
    return (
      <div className="app-root" style={{ minHeight: '100vh', background: 'var(--welcome-bg)' }}>
        {t.neuralOn && <NeuralBackground intensity={t.neuralIntensity} />}
        <AuthScreen
          mode={screen}
          onSwitch={(m) => goto(m)}
          onSubmit={() => { showToast('Welcome back, Ada', 'success'); goto('tests'); }}
        />
        <Toast message={toast?.message} kind={toast?.kind} key={toast?.k} />
      </div>
    );
  }

  // App shell with sidebar
  const crumbsByScreen = {
    tests: [{ label: 'Acme' }, { label: 'Tests' }],
    'test-new': [{ label: 'Acme' }, { label: 'Tests' }, { label: 'New' }],
    'test-detail': [{ label: 'Acme' }, { label: 'Tests' }, { label: 'Sign in with valid creds' }, { label: '#run-100', mono: true }],
  };

  return (
    <div className="app-root" style={{
      display: 'flex', minHeight: '100vh', height: '100vh',
      background: 'var(--app-bg)', color: 'var(--text)', overflow: 'hidden',
      position: 'relative',
    }}>
      {t.neuralOn && <NeuralBackground intensity={t.neuralIntensity * 0.4} subtle />}

      <SideRail active={screen === 'test-new' || screen === 'test-detail' ? 'tests' : screen} onNavigate={goto} />

      <main style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', position: 'relative', zIndex: 2 }}>
        <TopBar crumbs={crumbsByScreen[screen] || crumbsByScreen.tests}>
          {screen === 'tests' && (
            <button
              onClick={() => goto('test-new')}
              className="btn btn-sm"
              style={{ display: 'flex', alignItems: 'center', gap: 6 }}
            >
              <span style={{ fontSize: 11, color: 'var(--text-mid)' }}>main</span>
              <span style={{ width: 1, height: 12, background: 'var(--border-subtle)' }} />
              <span className="font-mono" style={{ fontSize: 11 }}>40 tests</span>
            </button>
          )}
        </TopBar>

        {screen === 'tests' && (
          <TestsDashboard
            onOpenTest={() => goto('test-detail')}
            onNew={() => goto('test-new')}
            density={t.density}
            viewMode={t.viewMode}
          />
        )}
        {screen === 'test-new' && (
          <NewTestScreen
            onBack={() => goto('tests')}
            onCreate={() => { showToast('Compiled. Running…', 'info'); setTimeout(() => goto('test-detail'), 600); }}
          />
        )}
        {screen === 'test-detail' && (
          <TestDetailScreen
            caseId={null}
            onBack={() => goto('tests')}
            vizMode={t.vizMode}
          />
        )}
      </main>

      {t.showMusic && <MusicPlayer />}
      <Toast message={toast?.message} kind={toast?.kind} key={toast?.k} />

      <TweaksPanel title="Tweaks">
        <TweakSection title="Screen">
          <TweakRadio
            label="Active screen"
            value={t.screen}
            onChange={(v) => { setT({ screen: v }); setScreen(v); }}
            options={[
              { value: 'login', label: 'Login' },
              { value: 'signup', label: 'Sign up' },
              { value: 'tests', label: 'Tests' },
              { value: 'test-new', label: 'New test' },
              { value: 'test-detail', label: 'Detail' },
            ]}
          />
        </TweakSection>

        <TweakSection title="Theme">
          <TweakRadio
            label="Palette"
            value={t.theme}
            onChange={(v) => setT({ theme: v })}
            options={[
              { value: 'nebula', label: 'Nebula' },
              { value: 'deep-space', label: 'Deep space' },
              { value: 'solar-flare', label: 'Solar flare' },
            ]}
          />
        </TweakSection>

        <TweakSection title="Tests dashboard">
          <TweakRadio
            label="View"
            value={t.viewMode}
            onChange={(v) => setT({ viewMode: v })}
            options={[
              { value: 'grid', label: 'Grid' },
              { value: 'list', label: 'List' },
            ]}
          />
          <TweakRadio
            label="Density"
            value={t.density}
            onChange={(v) => setT({ density: v })}
            options={[
              { value: 'compact', label: 'Compact' },
              { value: 'comfortable', label: 'Comfortable' },
            ]}
          />
        </TweakSection>

        <TweakSection title="Run viz">
          <TweakRadio
            label="Mode"
            value={t.vizMode}
            onChange={(v) => setT({ vizMode: v })}
            options={[
              { value: 'timeline', label: 'Timeline' },
              { value: 'gantt', label: 'Gantt' },
              { value: 'logs', label: 'Logs' },
            ]}
          />
        </TweakSection>

        <TweakSection title="Ambient">
          <TweakToggle
            label="Neural background"
            value={t.neuralOn}
            onChange={(v) => setT({ neuralOn: v })}
          />
          <TweakSlider
            label="Intensity"
            value={t.neuralIntensity}
            onChange={(v) => setT({ neuralIntensity: v })}
            min={0} max={100} step={5}
          />
          <TweakToggle
            label="Music player"
            value={t.showMusic}
            onChange={(v) => setT({ showMusic: v })}
          />
        </TweakSection>
      </TweaksPanel>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
