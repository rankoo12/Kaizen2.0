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
import { AnalysesScreen } from './screen-analyses';
import { AnalyzeSheet, type AnalyzeDraft } from './writer-analyze-sheet';
import { useActiveGenerationJobs } from './use-active-generation-jobs';
import { useDesignData, type DesignCase } from './use-design-data';
import { useAuth } from '@/context/auth-context';

/** Prefill handed to the authoring screen when a new test starts from a template. */
type AuthorTemplate = { name: string; url: string; steps: string[] };

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
  const { logout, user: authUser } = useAuth();
  const role = authUser?.role ?? null;
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
  /** The analyze form, parked while the user goes to author a sign-in test. */
  const [analyzeDraft, setAnalyzeDraft] = useState<AnalyzeDraft | null>(null);
  /** Prefill for a brand-new test — currently only the sign-in recipe template. */
  const [authorTemplate, setAuthorTemplate] = useState<AuthorTemplate | null>(null);

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

  /** Leaving the authoring screen returns to the analyze form when one was parked
   *  there — otherwise the user who went to write a sign-in test would have to
   *  find their way back to a dialog they had half filled in. */
  const returnToAnalyze = () => {
    setAuthorTemplate(null);
    if (analyzeDraft) {
      setScreen('tests');
      setAnalyzeOpen(true);
      refetch();
      return;
    }
    go('tests', suite);
  };

  /** `onClick` makes a toast a way IN, not just an announcement: "your plan is
   *  ready" is only useful if it also takes you to the plan. */
  const showToast = useCallback((message: string, kind = 'info', onClick?: () => void) => {
    const k = Date.now(); setToast({ message, kind, k, onClick });
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

  /* Which job the workspace has in flight, plus the tab title, the sidebar chip
     and the transition toasts that the PROGRESS face promises. */
  const { pendingDelivery, activeJobs, refresh: scanJobs } = useActiveGenerationJobs(
    suites,
    (message, kind, onClick) => showToast(message, kind, onClick),
    (suiteId, jobId) => { setWriterFocus({ suiteId, jobId }); setSuite(suiteId); setScreen('writer'); },
  );

  /** Accepting a draft is reversible, so it is announced rather than confirmed. */
  const acceptDraft = useCallback(async (c: DesignCase) => {
    try {
      const r = await fetch(`/api/proxy/cases/${c.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'active' }),
      });
      if (!r.ok) throw new Error();
      showToast(`Added “${c.name}” to ${c.suiteName}`, 'success');
      refetch();
    } catch {
      showToast('Could not accept that draft', 'error');
    }
  }, [refetch, showToast]);

  /** Creates a suite and makes the whole app aware of it. Returns false so the
   *  caller can keep the name the user typed when the create didn't land. */
  const createSuite = useCallback(async (name: string): Promise<boolean> => {
    try {
      const r = await fetch('/api/proxy/suites', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!r.ok) throw new Error();
      const { suite } = await r.json();
      refetch();
      showToast(`Suite “${suite.name}” created`, 'success');
      return true;
    } catch {
      showToast('Could not create the suite', 'error');
      return false;
    }
  }, [refetch, showToast]);

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
        '3': () => go('analyses'),
        '4': () => go('brain'),
        '5': () => go('usage'),
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
      { label: 'Analyses', key: '⌘3', onClick: () => go('analyses') },
      { label: 'The Brain', key: '⌘4', onClick: () => go('brain') },
      { label: 'Usage', key: '⌘5', onClick: () => go('usage') },
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
        onAnalyze={() => setAnalyzeOpen(true)}
        onAcceptDraft={acceptDraft}
        onOpenProof={(c) => {
          if (!c.validationRunId) return;
          setFocus({ caseId: c.id, runId: c.validationRunId, name: c.name });
          setScreen('run');
        }}
        pendingDelivery={pendingDelivery}
        onOpenDelivery={() => {
          if (!pendingDelivery) return;
          setWriterFocus({ suiteId: pendingDelivery.suiteId, jobId: pendingDelivery.jobId });
          setScreen('writer');
        }} />
    ) : screen === 'author' ? (
      <AuthorScreen suites={suites} defaultSuiteId={suite} editCaseId={editing}
        template={authorTemplate}
        onBack={() => { setEditing(null); returnToAnalyze(); }}
        onSuitesChanged={refetch} showToast={showToast}
        onCreated={(caseId, runId) => {
          refetch();
          // Clear the edit target, or the next visit to this screen would re-open the
          // test we just finished editing. The name comes from the list when we have it,
          // so an edited test doesn't land on a run titled "New test".
          const known = cases.find((c) => c.id === caseId)?.name;
          setEditing(null);
          // A test authored to unblock an analyze sends the user back to that
          // decision with it already chosen. Watching it run first is the right
          // instinct and stays one click away — but the analysis was the errand.
          if (authorTemplate && analyzeDraft) {
            setAnalyzeDraft({ ...analyzeDraft, loginCaseId: caseId });
            setAuthorTemplate(null);
            setAnalyzeOpen(true);
            setScreen('tests');
            showToast('Sign-in test created and selected. Worth running it once before you rely on it.', 'info');
            return;
          }
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
      : screen === 'analyses' ? (
        <AnalysesScreen suites={suites}
          onAnalyze={() => setAnalyzeOpen(true)}
          onOpen={(suiteId, jobId) => { setWriterFocus({ suiteId, jobId }); setScreen('writer'); }} />
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
          onOpenCase={editCase}
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
                activeJobs={activeJobs}
                onCreateSuite={createSuite}
                onOpenJob={(suiteId: string, jobId: string) => {
                  setWriterFocus({ suiteId, jobId }); setSuite(suiteId); setScreen('writer');
                }}
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
          role={role} draft={analyzeDraft}
          onClose={() => { setAnalyzeOpen(false); setAnalyzeDraft(null); }}
          onSuitesChanged={refetch}
          showToast={showToast}
          onCreateLoginTest={(draft, template) => {
            // Park the form, not discard it: the user is leaving mid-decision to
            // author the prerequisite, and coming back to a blank sheet would
            // make the flagship feature feel like a maze.
            setAnalyzeDraft(draft);
            setAnalyzeOpen(false);
            setEditing(null);
            setAuthorTemplate(template);
            if (draft.suiteId) setSuite(draft.suiteId);
            setScreen('author');
          }}
          onStarted={(suiteId, jobId) => {
            setAnalyzeOpen(false);
            setAnalyzeDraft(null);
            setWriterFocus({ suiteId, jobId });
            setSuite(suiteId);
            setScreen('writer');
            // Pull the new job into the watch set now. Without this the shell has
            // nothing live to poll, so the sidebar chip and tab title — the very
            // things the next screen promises — would not appear until something
            // unrelated triggered a rescan.
            //
            // The re-read is the safety net for the case where the suite was made
            // in this same dialog seconds ago: the job poller only watches suites
            // the shell has, and a scan that runs before the list catches up would
            // skip the very job just started. A fresh list re-triggers the scan.
            refetch();
            void scanJobs();
            showToast('Exploring your app — this keeps running if you leave', 'info');
          }} />
      )}
    </div>
  );
}
