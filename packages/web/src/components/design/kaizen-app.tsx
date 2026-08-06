'use client';
/* Orchestrator (from `Kaizen (1)/native/app.jsx`, authed branch) — window shell + screen
   switching, driven by REAL data (useDesignData) with every action wired to the API
   proxy. Menu bar, sidebar, keyboard shortcuts and appearance all live here. */
/* eslint-disable @typescript-eslint/no-explicit-any */
import * as React from 'react';
import { MenuBar, Sidebar, Toast, Lights } from './chrome';
import { I } from './icons';
import { TestsScreen } from './screen-tests';
import { AuthorScreen } from './screen-author';
import { RunScreen } from './screen-run';
import { RunsScreen } from './screen-runs';
import { BrainScreen } from './screen-brain';
import { UsageScreen } from './screen-usage';
import { WriterScreen } from './screen-writer';
import { AnalyzeSheet } from './writer-analyze-sheet';
import { useDesignData, type DesignCase } from './use-design-data';
import { useAuth } from '@/context/auth-context';

const { useState, useEffect, useCallback } = React;

/** What the run screen is currently showing. */
type Focus = {
  caseId: string;
  runId: string | null;
  name: string;
  /** Step result to select on arrival — set when jumping in from the Brain. */
  stepResultId?: string | null;
};

const APPEARANCE_KEY = 'kaizen.appearance';
/** Cycle order for ⇧⌘A. Aperture first — it's the design's default. */
const APPEARANCES = ['aperture', 'light', 'dark'];
const GROUP_KEY = 'kaizen.groupBySuite';

export default function KaizenApp() {
  const { suites, cases, stats, user, refetch } = useDesignData();
  const { logout } = useAuth();
  const [screen, setScreen] = useState('tests');
  const [suite, setSuite] = useState<string | null>(null);
  const [focus, setFocus] = useState<Focus | null>(null);
  const [toast, setToast] = useState<any>(null);
  const [appearance, setAppearance] = useState(APPEARANCES[0]);
  const [group, setGroup] = useState(true);
  const [sidebar, setSidebar] = useState(true);
  /** Test being edited on the author screen; null means 'creating a new one'. */
  const [editing, setEditing] = useState<string | null>(null);
  /** Which Test Writer job the writer screen is showing. */
  const [writerFocus, setWriterFocus] = useState<{ suiteId: string; jobId: string } | null>(null);
  const [analyzeOpen, setAnalyzeOpen] = useState(false);

  // Appearance + grouping are per-device preferences, so they live in localStorage
  // rather than on the tenant (the API has nowhere to put them).
  useEffect(() => {
    const saved = localStorage.getItem(APPEARANCE_KEY);
    // Aperture is a deliberate look rather than a system preference, so it's the default
    // regardless of prefers-color-scheme; light/dark are only chosen explicitly.
    setAppearance(saved && APPEARANCES.includes(saved) ? saved : APPEARANCES[0]);
    setGroup(localStorage.getItem(GROUP_KEY) !== '0');
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute('data-appearance', appearance);
    localStorage.setItem(APPEARANCE_KEY, appearance);
  }, [appearance]);

  useEffect(() => { localStorage.setItem(GROUP_KEY, group ? '1' : '0'); }, [group]);

  const nextAppearance = useCallback(() => {
    setAppearance((cur) => APPEARANCES[(APPEARANCES.indexOf(cur) + 1) % APPEARANCES.length]);
  }, []);

  /* While the Tests list is on screen and something is still in flight, keep it live.
     Without this a run started from this screen sits at RUNNING until you navigate away
     and back — the row is showing a status that stopped being true minutes ago. Polling
     stops as soon as nothing is running, so an idle workspace makes no requests. */
  const anyRunning = cases.some((c) => c.status === 'running' || c.status === 'queued');
  useEffect(() => {
    if (screen !== 'tests' || !anyRunning) return;
    const id = setInterval(refetch, 4000);
    return () => clearInterval(id);
  }, [screen, anyRunning, refetch]);

  /* Leaving Tests must clear the suite filter. It used to persist, and since activeNav
     prefers `suite` over `screen`, the sidebar kept the suite row highlighted while you
     were on Runs/Brain/Usage — those items never lit up. Author and Run are the two
     screens reached *from* a suite, so they keep it. */
  const go = (s: string, arg?: any) => {
    if (s === 'tests') setSuite(arg || null);
    else if (s !== 'author' && s !== 'run') setSuite(null);
    setScreen(s);
    /* The list is fetched once, so coming back from a run you'd just watched finish still
       showed it as RUNNING with the previous run's cost. Re-read on arrival. */
    if (s === 'tests') refetch();
  };

  const showToast = useCallback((message: string, kind = 'info') => {
    const k = Date.now(); setToast({ message, kind, k });
    setTimeout(() => setToast((cur: any) => (cur && cur.k === k ? null : cur)), 2600);
  }, []);

  /** Enqueues a run and returns its id, or null when it couldn't start. */
  const startRun = useCallback(async (caseId: string): Promise<string | null> => {
    try {
      const r = await fetch(`/api/proxy/cases/${caseId}/run`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      if (!r.ok) {
        const b = await r.json().catch(() => ({}));
        showToast(b.message || 'Could not start the run', 'error');
        return null;
      }
      const { runId } = await r.json();
      showToast('Queued — booting a browser', 'success');
      setTimeout(refetch, 2000);
      return runId ?? null;
    } catch {
      showToast('Could not start the run', 'error');
      return null;
    }
  }, [refetch, showToast]);

  /** Run now goes straight to the live run, as the design does — staying on the list
   *  left the row pointing at the *previous* run until the next refetch, so opening it
   *  showed stale results for a test that was running right then. */
  async function runNow(c: DesignCase) {
    const runId = await startRun(c.id);
    if (!runId) return;
    setFocus({ caseId: c.id, runId, name: c.name });
    setScreen('run');
  }

  async function deleteCase(c: DesignCase) {
    try {
      const r = await fetch(`/api/proxy/cases/${c.id}`, { method: 'DELETE' });
      if (!r.ok) throw new Error();
      showToast(`Deleted “${c.name}”`, 'error');
      refetch();
    } catch {
      showToast('Could not delete the test', 'error');
    }
  }

  function editCase(caseId: string) { setEditing(caseId); setScreen('author'); }

  function openCase(c: DesignCase) {
    setFocus({ caseId: c.id, runId: c.runId, name: c.name });
    setScreen('run');
  }

  // ⌘N new test, ⌘1–4 switch screens. ⌘R lives in the Tests screen, where the
  // selected row is.
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      // ⌥⌘S / Ctrl+Alt+S toggles the sidebar, matching the View menu entry.
      if (e.altKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        setSidebar((v) => !v);
        return;
      }
      // ⇧⌘A cycles aperture → light → dark.
      if (e.shiftKey && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        nextAppearance();
        return;
      }
      const map: Record<string, () => void> = {
        n: () => { setEditing(null); go('author'); },
        '1': () => go('tests'),
        '2': () => go('runs'),
        '3': () => go('brain'),
        '4': () => go('usage'),
      };
      const fn = map[e.key.toLowerCase()];
      if (!fn) return;
      e.preventDefault();
      fn();
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  const counts: any = { tests: cases.length };

  const menus = [
    { label: 'File', items: [
      { label: 'New Test', key: '⌘N', onClick: () => { setEditing(null); go('author'); } },
      { label: 'New Suite', onClick: () => go('author') },
      '-',
      { label: 'Analyze an app…', onClick: () => setAnalyzeOpen(true) },
    ] },
    { label: 'View', items: [
      { label: 'Tests', key: '⌘1', onClick: () => go('tests') },
      { label: 'Runs', key: '⌘2', onClick: () => go('runs') },
      { label: 'The Brain', key: '⌘3', onClick: () => go('brain') },
      { label: 'Usage', key: '⌘4', onClick: () => go('usage') },
      '-',
      { label: 'Next appearance', key: '⇧⌘A', onClick: nextAppearance },
      { label: sidebar ? 'Hide sidebar' : 'Show sidebar', key: '⌥⌘S', onClick: () => setSidebar(!sidebar) },
    ] },
    { label: 'Account', items: [
      { label: user?.email ?? 'Signed in', disabled: true },
      { label: 'Usage & settings', onClick: () => go('usage') },
      '-',
      { label: 'Sign out', onClick: () => logout() },
    ] },
    { label: 'Help', items: [
      { label: 'Keyboard: ⌘N new · ⌘R run · ⌘1–4 screens', disabled: true },
    ] },
  ];

  const body =
    screen === 'tests' ? (
      <TestsScreen cases={cases} suites={suites} stats={stats}
        onOpen={openCase} onNew={() => { setEditing(null); go('author'); }} onRun={runNow}
        onEdit={(c) => editCase(c.id)} onDelete={deleteCase}
        suiteFilter={suite} onClearSuite={() => setSuite(null)} group={group} showToast={showToast}
        onAnalyze={() => setAnalyzeOpen(true)} />
    ) : screen === 'author' ? (
      <AuthorScreen suites={suites} defaultSuiteId={suite} editCaseId={editing}
        onBack={() => { setEditing(null); go('tests', suite); }}
        onSuitesChanged={refetch} showToast={showToast}
        onCreated={(caseId, runId) => {
          refetch();
          // Clear the edit target, or the next visit to this screen would re-open the
          // test we just finished editing. The name comes from the list when we have it,
          // so an edited test doesn't land on a run titled "New test".
          const known = cases.find((c) => c.id === caseId)?.name;
          setEditing(null);
          setFocus({ caseId, runId, name: known ?? 'New test' });
          setScreen('run');
        }} />
    ) : screen === 'run' && focus ? (
      <RunScreen key={focus.caseId} caseId={focus.caseId} runId={focus.runId} caseName={focus.name}
        initialStepId={focus.stepResultId ?? null}
        onBack={() => go('tests', suite)} showToast={showToast}
        onEdit={() => editCase(focus.caseId)}
        onRerun={() => startRun(focus.caseId)} />
    ) : screen === 'runs' ? (
      <RunsScreen onOpen={(r) => {
        if (!r.caseId) { showToast('That test has been deleted', 'error'); return; }
        setFocus({ caseId: r.caseId, runId: r.id, name: r.caseName ?? 'Run' });
        setScreen('run');
      }} />
    ) : screen === 'brain' ? (
        <BrainScreen onOpenStep={(caseId, runId, stepResultId, caseName) => {
          setFocus({ caseId, runId, name: caseName, stepResultId });
          setScreen('run');
        }} />
      )
      : screen === 'writer' && writerFocus ? (
        <WriterScreen suiteId={writerFocus.suiteId} jobId={writerFocus.jobId}
          suiteName={suites.find((s) => s.id === writerFocus.suiteId)?.name ?? 'this suite'}
          onBack={() => go('tests', writerFocus.suiteId)}
          onOpenRun={(caseId, runId) => {
            const known = cases.find((c) => c.id === caseId)?.name;
            setFocus({ caseId, runId, name: known ?? 'Proving run' });
            setScreen('run');
          }}
          onAnalyzeAgain={() => setAnalyzeOpen(true)}
          onCasesChanged={refetch}
          showToast={showToast} />
      )
      : screen === 'usage' ? (
        <UsageScreen appearance={appearance} setAppearance={setAppearance}
          group={group} setGroup={setGroup} showToast={showToast} />
      )
      : (
        <TestsScreen cases={cases} suites={suites} stats={stats}
          onOpen={openCase} onNew={() => { setEditing(null); go('author'); }} onRun={runNow}
          onEdit={(c) => editCase(c.id)} onDelete={deleteCase}
          suiteFilter={suite} onClearSuite={() => setSuite(null)} group={group} showToast={showToast} />
      );

  const activeNav = suite || (screen === 'author' || screen === 'run' ? 'tests' : screen === 'usage' ? 'usage' : screen);

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <MenuBar menus={menus} status={<span className="num" style={{ fontSize: 12, color: 'var(--text-3)' }}>{user?.email ?? ''}</span>} />
      <div style={{ flex: 1, minHeight: 0, padding: '0 clamp(8px,2vh,20px) clamp(8px,2vh,20px)', position: 'relative' }}>
        <div className={`win${sidebar ? '' : ' sidebar-off'}`}>
          <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
            {sidebar ? (
              <Sidebar active={activeNav} onNav={go} counts={counts}
                suites={suites} user={user}
                onSettings={() => go('usage')} onLights={() => {}} onToggle={() => setSidebar(false)} />
            ) : (
              /* Collapsed: the window controls and the toggle move into the content
                 toolbar, the way a real desktop app behaves — losing the traffic lights
                 with the sidebar would leave the window with no chrome at all. */
              <div style={{ position: 'absolute', top: 0, left: 8, height: 52, display: 'flex', alignItems: 'center', zIndex: 40 }}>
                <Lights onAction={() => {}} />
                <button className="btn icon ghost" title="Show sidebar (⌥⌘S)" onClick={() => setSidebar(true)}>
                  <I.sidebar size={15} />
                </button>
              </div>
            )}
            <main style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, background: 'var(--window)' }}>
              {body}
            </main>
          </div>
          <Toast toast={toast} />
        </div>
      </div>
      {analyzeOpen && (
        <AnalyzeSheet suites={suites} defaultSuiteId={suite}
          defaultUrl={cases.find((c) => !suite || c.suiteId === suite)?.baseUrl}
          onClose={() => setAnalyzeOpen(false)}
          showToast={showToast}
          onStarted={(suiteId, jobId) => {
            setAnalyzeOpen(false);
            setWriterFocus({ suiteId, jobId });
            setSuite(suiteId);
            setScreen('writer');
            showToast('Exploring your app — this keeps running if you leave', 'info');
          }} />
      )}
    </div>
  );
}
