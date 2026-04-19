'use client';

import { useState, useEffect, useRef } from 'react';
import {
  CheckCircle2, Loader2, Clock, XCircle as XCircleStatus,
  Eye, Cpu, Play, ArrowLeft, XCircle, Image as ImageIcon, X,
  Plus, Save, Trash2, Zap, Globe,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { cn } from '@/lib/cn';
import { useCaseDetail } from '@/hooks/use-case-detail';
import { useRunDetail } from '@/hooks/use-run-detail';
import { useRunPoller } from '@/hooks/use-run-poller';
import type { RunStatus, DomCandidate } from '@/types/api';

// ─── Types ────────────────────────────────────────────────────────────────────

type TestOverviewPanelProps = {
  caseId: string;
};

// ─── Component ───────────────────────────────────────────────────────────────

export function TestOverviewPanel({ caseId }: TestOverviewPanelProps) {
  const router = useRouter();
  const { data: test, isLoading: caseLoading, error: caseError, refetch } = useCaseDetail(caseId);

  // ── Editable steps + URL state ────────────────────────────────────────────
  const [localSteps, setLocalSteps] = useState<string[]>([]);
  const [localUrl, setLocalUrl] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // ── Run state ─────────────────────────────────────────────────────────────
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [isEnqueuing, setIsEnqueuing] = useState(false);

  // ── UI state ──────────────────────────────────────────────────────────────
  const [viewMode, setViewMode] = useState<'preview' | 'results'>('results');
  const [activeScreenshot, setActiveScreenshot] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // Ref for auto-focusing newly added step input
  const lastStepRef = useRef<HTMLInputElement | null>(null);

  // Fetch run detail: prefer the active polling run, fall back to last historical run
  const displayRunId = activeRunId ?? test?.recentRuns?.[0]?.id;
  const { data: runDetail, isLoading: runLoading } = useRunDetail(displayRunId ?? null);

  // ── Sync local state from API data ───────────────────────────────────────
  useEffect(() => {
    if (test) {
      setLocalSteps(test.steps.map((s) => s.rawText));
      setLocalUrl(test.baseUrl);
    }
  }, [test]);

  // ── Derived ───────────────────────────────────────────────────────────────
  const isStepsDirty = test?.steps
    ? localSteps.length !== test.steps.length ||
      localSteps.some((s, i) => s !== (test.steps[i]?.rawText ?? ''))
    : false;

  const isUrlDirty = test ? localUrl !== test.baseUrl : false;

  const isDirty = isStepsDirty || isUrlDirty;

  const runStatus: RunStatus | 'pending' =
    runDetail?.status ?? test?.recentRuns?.[0]?.status ?? 'pending';

  // ── Helpers ───────────────────────────────────────────────────────────────
  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 3500);
  }

  function addStep() {
    setLocalSteps((prev) => [...prev, '']);
    // Focus new input after render
    setTimeout(() => lastStepRef.current?.focus(), 50);
  }

  function updateStep(i: number, value: string) {
    setLocalSteps((prev) => prev.map((s, idx) => (idx === i ? value : s)));
  }

  function removeStep(i: number) {
    setLocalSteps((prev) => prev.filter((_, idx) => idx !== i));
  }

  // ── Save (PATCH steps and/or baseUrl) ────────────────────────────────────
  async function handleSave() {
    const active = localSteps.filter((s) => s.trim());
    if (active.length === 0) {
      setSaveError('At least one step is required.');
      return;
    }
    if (isUrlDirty && !localUrl.trim()) {
      setSaveError('Base URL is required.');
      return;
    }

    const patch: Record<string, unknown> = {};
    if (isStepsDirty) patch.steps = active;
    if (isUrlDirty)   patch.baseUrl = localUrl.trim();

    setIsSaving(true);
    setSaveError(null);
    try {
      const res = await fetch(`/api/proxy/cases/${caseId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error();
      await refetch();
      showToast('Changes saved.');
    } catch {
      setSaveError('Failed to save. Please try again.');
    } finally {
      setIsSaving(false);
    }
  }

  // ── Run ───────────────────────────────────────────────────────────────────
  async function handleRun() {
    setIsEnqueuing(true);
    try {
      const res = await fetch(`/api/proxy/cases/${caseId}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!res.ok) throw new Error();
      const { runId } = await res.json();
      setActiveRunId(runId);
      showToast('Run enqueued — polling for results...');
    } catch {
      showToast('Failed to start run.');
    } finally {
      setIsEnqueuing(false);
    }
  }

  // Poll the active run until terminal status
  useRunPoller({
    runId: activeRunId,
    onComplete: (result) => {
      showToast(`Run ${result.status.toUpperCase()}.`);
      setActiveRunId(null);
      refetch();
    },
  });

  // ── Loading / error states ────────────────────────────────────────────────
  if (caseLoading) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center py-40 gap-4 text-gray-500">
        <Loader2 className="w-8 h-8 animate-spin" />
        <p className="text-xs font-bold tracking-widest uppercase">Fetching Neural Trace...</p>
      </div>
    );
  }

  if (caseError || !test) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center py-40 gap-4 text-brand-red">
        <XCircle className="w-12 h-12" />
        <p className="text-sm font-bold tracking-widest uppercase">Test data not found</p>
        <button onClick={() => router.push('/tests')} className="text-xs underline text-gray-400">
          Back to dashboard
        </button>
      </div>
    );
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="flex-1 p-6 md:p-8 max-w-[1600px] mx-auto w-full grid grid-cols-1 xl:grid-cols-12 gap-8 relative">

      {/* TOAST */}
      {toast && (
        <div className="fixed top-6 left-1/2 -translate-x-1/2 z-[300] bg-[#1b1422]/95 backdrop-blur-md border border-brand-orange/50 text-white px-6 py-3 rounded-full flex items-center space-x-3 shadow-[0_0_30px_rgba(213,96,28,0.2)] animate-in slide-in-from-top-4">
          <span className="text-sm font-bold tracking-wider">{toast}</span>
        </div>
      )}

      {/* SCREENSHOT LIGHTBOX */}
      {activeScreenshot && (
        <div
          className="fixed inset-0 z-[200] bg-black/90 backdrop-blur-xl flex items-center justify-center p-4 md:p-20 animate-in fade-in duration-300"
          onClick={() => setActiveScreenshot(null)}
        >
          <button
            className="absolute top-8 right-8 p-3 rounded-full bg-white/10 text-white hover:bg-white/20 transition-all z-[210]"
            onClick={() => setActiveScreenshot(null)}
          >
            <X className="w-8 h-8" />
          </button>
          <img
            src={`/api/proxy/media?key=${activeScreenshot}`}
            alt="Full Screen Trace"
            className="max-w-full max-h-full object-contain shadow-[0_0_100px_rgba(213,96,28,0.3)] rounded-lg"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}

      {/* ── LEFT COLUMN ─────────────────────────────────────────────────── */}
      <div className="xl:col-span-8 space-y-6 animate-in fade-in slide-in-from-left-4 duration-500">

        {/* Header */}
        <div className="space-y-3">
          <div className="flex items-center gap-4">
            <button
              onClick={() => router.push('/tests')}
              className="p-2 rounded-lg bg-white/5 hover:bg-white/10 text-gray-400 hover:text-white transition-colors"
            >
              <ArrowLeft className="w-4 h-4" />
            </button>
            <h1 className="text-4xl md:text-5xl font-bold tracking-tight">{test.name}</h1>
          </div>
          <p className="text-brand-pink/80 text-sm md:text-base ml-12">
            Edit steps, then save and run the test against the Kaizen Engine.
          </p>

          {/* Editable Base URL */}
          <div className="ml-12 flex items-center gap-2 group">
            <Globe className="w-3.5 h-3.5 text-gray-500 shrink-0 group-focus-within:text-brand-orange transition-colors" />
            <input
              type="url"
              value={localUrl}
              onChange={(e) => setLocalUrl(e.target.value)}
              placeholder="https://app.example.com"
              className="flex-1 bg-transparent text-sm text-gray-400 outline-none border-b border-transparent focus:border-brand-orange/40 transition-colors py-0.5 placeholder:text-gray-600 font-mono"
              aria-label="Base URL"
            />
            {isUrlDirty && (
              <span className="text-[9px] font-bold text-brand-orange uppercase tracking-widest shrink-0">
                unsaved
              </span>
            )}
          </div>
        </div>

        {/* Steps Table */}
        <div className="bg-panel-bg rounded-2xl border border-white/10 overflow-hidden shadow-2xl">

          {/* Table Header */}
          <div className="grid grid-cols-12 gap-4 px-6 py-4 border-b border-white/10 text-xs font-bold tracking-wider text-brand-accent uppercase">
            <div className="col-span-1">ID</div>
            <div className="col-span-9">Description</div>
            <div className="col-span-2 text-right">Status</div>
          </div>

          {/* Step Rows */}
          <div className="flex flex-col divide-y divide-white/5">
            {localSteps.map((stepText, idx) => {
              const savedStep = test.steps[idx];
              const result = runDetail?.stepResults?.find((sr) => sr.stepId === savedStep?.id);
              const status = result?.status ?? (activeRunId && idx === 0 ? 'running' : null);
              const isNewStep = idx >= test.steps.length;
              const isLast = idx === localSteps.length - 1;

              return (
                <div
                  key={idx}
                  className={cn(
                    'grid grid-cols-12 gap-4 px-6 py-3 items-center group transition-colors hover:bg-white/[0.02]',
                    isNewStep && 'bg-brand-orange/[0.03]',
                  )}
                >
                  {/* Step number */}
                  <div className={cn(
                    'col-span-1 font-mono text-sm font-bold',
                    isNewStep ? 'text-brand-orange/60' : 'text-brand-pink',
                  )}>
                    {String(idx + 1).padStart(3, '0')}
                  </div>

                  {/* Editable description */}
                  <div className="col-span-9">
                    <input
                      ref={isLast ? lastStepRef : undefined}
                      type="text"
                      value={stepText}
                      onChange={(e) => updateStep(idx, e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') addStep();
                      }}
                      placeholder="Describe the action..."
                      className="w-full bg-transparent text-sm text-gray-200 outline-none border-b border-transparent focus:border-brand-orange/40 transition-colors py-1 placeholder:text-gray-600"
                    />
                  </div>

                  {/* Status / delete */}
                  <div className="col-span-2 flex items-center justify-end gap-2">
                    {/* Run status badge */}
                    {status === 'passed' && (
                      <div className="flex items-center space-x-1 text-brand-green">
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        <span className="text-[10px] font-bold uppercase tracking-wide hidden sm:block">OK</span>
                      </div>
                    )}
                    {status === 'running' && (
                      <Loader2 className="w-3.5 h-3.5 animate-spin text-brand-orange" />
                    )}
                    {status === 'failed' && (
                      <div className="flex items-center space-x-1 text-brand-red">
                        <XCircleStatus className="w-3.5 h-3.5" />
                        <span className="text-[10px] font-bold uppercase tracking-wide hidden sm:block">FAIL</span>
                      </div>
                    )}
                    {!status && !isNewStep && (
                      <Clock className="w-3.5 h-3.5 text-gray-600" />
                    )}

                    {/* Delete button — always visible on hover */}
                    <button
                      onClick={() => removeStep(idx)}
                      className="opacity-0 group-hover:opacity-100 text-gray-600 hover:text-brand-red transition-all p-1 rounded"
                      aria-label="Remove step"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              );
            })}

            {localSteps.length === 0 && (
              <div className="px-6 py-10 text-center text-gray-600 text-xs font-bold uppercase tracking-widest">
                No steps yet — add one below.
              </div>
            )}
          </div>
        </div>

        {/* Save error */}
        {saveError && (
          <p className="text-brand-red text-sm font-medium px-1">{saveError}</p>
        )}

        {/* Action bar */}
        <div className="bg-panel-bg p-5 rounded-2xl border border-white/10 flex flex-col sm:flex-row gap-3">
          {/* Add step */}
          <button
            onClick={addStep}
            className="flex-1 py-3.5 border-2 border-dashed border-brand-accent/40 text-brand-accent text-xs font-bold tracking-widest uppercase rounded-xl hover:bg-brand-accent/5 transition-colors flex items-center justify-center space-x-2"
          >
            <Plus className="w-4 h-4" />
            <span>Add Neural Step</span>
          </button>

          {/* Save — only when dirty */}
          {isDirty && (
            <button
              onClick={handleSave}
              disabled={isSaving}
              className="flex-1 py-3.5 bg-brand-pink/10 border border-brand-pink/30 text-brand-pink text-xs font-bold tracking-widest uppercase rounded-xl hover:bg-brand-pink/20 transition-colors flex items-center justify-center space-x-2 disabled:opacity-50"
            >
              {isSaving ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <>
                  <Save className="w-4 h-4" />
                  <span>Save Changes</span>
                </>
              )}
            </button>
          )}

          {/* Run */}
          <button
            onClick={handleRun}
            disabled={isEnqueuing || !!activeRunId}
            className="flex-1 py-3.5 bg-gradient-to-r from-brand-orange to-brand-yellow text-black text-sm font-bold tracking-widest uppercase rounded-xl hover:opacity-90 transition-opacity flex items-center justify-center space-x-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isEnqueuing || activeRunId ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Play className="w-4 h-4 fill-current" />
            )}
            <span>{activeRunId ? 'Running...' : 'Run'}</span>
          </button>
        </div>
      </div>

      {/* ── RIGHT COLUMN ────────────────────────────────────────────────── */}
      <div className="xl:col-span-4 space-y-6 animate-in fade-in slide-in-from-right-4 duration-500">

        {/* View toggle */}
        <div className="flex items-center justify-between text-xs font-bold tracking-wider border-b border-white/10 pb-2">
          <button
            onClick={() => setViewMode('preview')}
            className={cn(
              'flex items-center space-x-2 transition-colors px-4 py-2',
              viewMode === 'preview' ? 'text-brand-pink underline underline-offset-8' : 'text-gray-400 hover:text-white',
            )}
          >
            <Eye className="w-4 h-4" />
            <span>LIVE DOM PREVIEW</span>
          </button>
          <button
            onClick={() => setViewMode('results')}
            className={cn(
              'px-6 py-2 rounded-lg transition-all',
              viewMode === 'results' ? 'bg-gradient-to-r from-brand-orange to-brand-yellow text-black' : 'text-gray-400',
            )}
          >
            SUMMARY RESULTS
          </button>
        </div>

        {/* Test Results header */}
        <div className="flex items-center space-x-2 bg-panel-bg rounded-lg p-4 border border-white/10 shadow-md">
          <div className="w-2 h-2 rounded-full bg-brand-accent" />
          <span className="text-sm font-bold tracking-widest text-brand-accent uppercase">Test Results</span>
        </div>

        {/* Metrics */}
        <div className="grid grid-cols-2 gap-4">
          <div className="bg-panel-bg p-5 rounded-2xl border border-white/10 shadow-inner">
            <div className="text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-2">Total Tokens</div>
            <div className="flex items-baseline space-x-1">
              <span className="text-3xl font-bold font-mono text-white">
                {runDetail?.totalTokens?.toLocaleString() ?? test.recentRuns?.[0]?.totalTokens?.toLocaleString() ?? '0'}
              </span>
              <span className="text-[10px] text-gray-500 font-bold uppercase">Unit</span>
            </div>
          </div>
          <div className="bg-panel-bg p-5 rounded-2xl border border-white/10 shadow-inner">
            <div className="text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-2">Duration</div>
            <div className="flex items-baseline space-x-1">
              <span className="text-3xl font-bold font-mono text-white">
                {((runDetail?.durationMs ?? test.recentRuns?.[0]?.durationMs) != null)
                  ? (((runDetail?.durationMs ?? test.recentRuns?.[0]?.durationMs) as number) / 1000).toFixed(1)
                  : '0.0'}
              </span>
              <span className="text-[10px] text-gray-500 font-bold uppercase">Sec</span>
            </div>
          </div>
        </div>

        {/* Execution Status */}
        <div className="bg-panel-bg p-6 rounded-2xl border border-white/10 shadow-inner shadow-black/50">
          <div className="text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-2">Execution Status</div>
          <div className="flex items-center space-x-3">
            <div className={cn(
              'w-2.5 h-2.5 rounded-full',
              runStatus === 'passed' ? 'bg-brand-green shadow-[0_0_10px_rgba(34,197,94,0.5)]' :
              runStatus === 'failed' ? 'bg-brand-red shadow-[0_0_10px_rgba(239,68,68,0.5)]' :
              runStatus === 'running' ? 'bg-brand-orange shadow-[0_0_10px_rgba(213,96,28,0.5)] animate-pulse' :
              'bg-brand-yellow shadow-[0_0_10px_rgba(245,158,11,0.5)]',
            )} />
            <span className="text-3xl font-bold tracking-widest font-mono text-white uppercase">
              {runStatus}
            </span>
          </div>
        </div>

        {/* Execution Cards */}
        <div className="space-y-4 overflow-y-auto max-h-[500px] pr-2">
          <div className="flex justify-between items-center mb-2 px-1">
            <span className="text-xs font-bold tracking-widest text-gray-400 uppercase">Execution</span>
            <span className="text-xs text-gray-500">History Trace</span>
          </div>

          <div className="space-y-4 pb-12">
            {runLoading && !runDetail && (
              <div className="flex items-center justify-center py-10 text-gray-500">
                <Loader2 className="w-5 h-5 animate-spin mr-2" />
                <span className="text-xs font-bold uppercase tracking-widest">Loading run details...</span>
              </div>
            )}

            {runDetail?.stepResults?.map((stepResult, idx) => (
              <ExecutionCard
                key={stepResult.id}
                id={String(idx + 1).padStart(3, '0')}
                title={test.steps[idx]?.rawText ?? `Step ${idx + 1}`}
                type={stepResult.resolutionSource ?? 'LLM RESOLVED'}
                time={`${stepResult.durationMs ?? 0}ms`}
                tool={stepResult.errorType ?? 'GPT-4_Agent'}
                status={stepResult.status}
                tokens={stepResult.tokens}
                screenshotKey={stepResult.screenshotKey}
                onViewScreenshot={setActiveScreenshot}
                icon={<Cpu className="w-3 h-3" />}
                runId={runDetail?.id ?? null}
                stepResultId={stepResult.id}
                domCandidates={stepResult.domCandidates}
                llmPickedKaizenId={stepResult.llmPickedKaizenId}
                selectorUsed={stepResult.selectorUsed}
                onVerdict={(v) => showToast(`Step ${idx + 1} marked ${v.toUpperCase()} — cache cleared.`)}
              />
            ))}

            {!runDetail && !runLoading && (
              <div className="text-center py-10 text-gray-600 text-[10px] font-bold uppercase tracking-widest border border-white/5 rounded-xl border-dashed">
                No execution history yet.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Execution Card ───────────────────────────────────────────────────────────

function ExecutionCard({ id, title, type, time, tool, status, tokens, icon, isActive, screenshotKey, onViewScreenshot, runId, stepResultId, domCandidates, llmPickedKaizenId, selectorUsed, onVerdict }: {
  id: string;
  title: string;
  type: string;
  time: string;
  tool: string;
  status: string;
  tokens: number;
  icon: React.ReactNode;
  isActive?: boolean;
  screenshotKey: string | null;
  onViewScreenshot: (key: string) => void;
  runId: string | null;
  stepResultId: string;
  domCandidates: DomCandidate[] | null;
  llmPickedKaizenId: string | null;
  selectorUsed: string | null;
  onVerdict?: (verdict: 'passed' | 'failed') => void;
}) {
  const [localVerdict, setLocalVerdict] = useState<'passed' | 'failed' | null>(null);
  const [submitting, setSubmitting] = useState<'passed' | 'failed' | null>(null);
  const [verdictError, setVerdictError] = useState<string | null>(null);
  const [showCandidates, setShowCandidates] = useState(false);

  const isLlmResolved = type?.includes('LLM') || type?.includes('llm');

  async function submitVerdict(verdict: 'passed' | 'failed') {
    if (!runId || submitting) return;
    setSubmitting(verdict);
    setVerdictError(null);
    try {
      const res = await fetch(`/api/proxy/runs/${runId}/steps/${stepResultId}/verdict`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ verdict }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(`${res.status} ${body?.error ?? res.statusText}`);
      }
      setLocalVerdict(verdict);
      onVerdict?.(verdict);
    } catch (err) {
      setVerdictError(err instanceof Error ? err.message : 'Request failed');
    } finally {
      setSubmitting(null);
    }
  }

  // Effective verdict: human override takes priority over engine status
  const effectivePass = localVerdict === 'passed' || (!localVerdict && status === 'passed');
  const effectiveFail = localVerdict === 'failed' || (!localVerdict && status === 'failed');

  return (
    <div className={cn(
      'bg-panel-bg p-5 rounded-2xl border border-white/10 relative overflow-hidden transition-all',
      isActive && 'ring-1 ring-brand-orange shadow-[0_0_20px_rgba(213,96,28,0.1)]',
    )}>
      {isActive && <div className="absolute top-0 left-0 w-full h-[2px] bg-brand-orange" />}

      <div className="flex justify-between items-start mb-3">
        <div className="flex-1 min-w-0 pr-2">
          <div className="text-[10px] font-bold text-gray-500 mb-1 uppercase tracking-tighter">STEP {id}</div>
          <h3 className="text-sm font-medium text-gray-200 truncate">{title}</h3>
        </div>
        <button
          onClick={() => isLlmResolved && domCandidates?.length ? setShowCandidates((v) => !v) : undefined}
          className={cn(
            'text-[9px] font-bold border px-2 py-1 rounded uppercase tracking-wider relative whitespace-nowrap transition-all',
            type?.includes('LLM') || type?.includes('llm')
              ? 'text-brand-orange border-brand-orange/30 bg-brand-orange/10'
              : 'text-blue-400 border-blue-400/30 bg-blue-400/10',
            isLlmResolved && domCandidates?.length && 'cursor-pointer hover:bg-brand-orange/20',
          )}
          title={isLlmResolved && domCandidates?.length ? 'View elements sent to LLM' : undefined}
        >
          {type}
          {isActive && (
            <>
              <span className="absolute -top-1 -right-1 w-2 h-2 bg-brand-orange rounded-full animate-ping" />
              <span className="absolute -top-1 -right-1 w-2 h-2 bg-brand-orange rounded-full" />
            </>
          )}
        </button>
      </div>

      <div className="flex items-center justify-between mb-5">
        <div className="flex items-center space-x-4 text-xs text-gray-400">
          <span className="flex items-center space-x-1">
            <Clock className="w-3 h-3" /> <span>{time}</span>
          </span>
          <span className="flex items-center space-x-1">{icon} <span>{tool}</span></span>
          {tokens > 0 && (
            <span className="flex items-center space-x-1 text-brand-orange">
              <Zap className="w-3 h-3" />
              <span className="font-mono">{tokens.toLocaleString()}</span>
            </span>
          )}
        </div>
        {screenshotKey && (
          <button
            onClick={() => onViewScreenshot(screenshotKey)}
            className="flex items-center space-x-1.5 text-[10px] font-bold text-brand-pink hover:text-white transition-colors bg-brand-pink/10 px-2 py-1 rounded border border-brand-pink/20"
          >
            <ImageIcon className="w-3 h-3" />
            <span>IMAGE</span>
          </button>
        )}
      </div>

      <div className="flex gap-3">
        <button
          onClick={() => submitVerdict('passed')}
          disabled={!runId || !!submitting}
          className={cn(
            'flex-1 py-2.5 rounded-lg font-bold text-xs flex items-center justify-center space-x-1.5 transition-all disabled:cursor-not-allowed',
            effectivePass
              ? 'bg-gradient-to-r from-brand-green/80 to-brand-green text-black'
              : 'border border-white/5 text-gray-600 hover:bg-white/5',
          )}
        >
          {submitting === 'passed'
            ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
            : <><CheckCircle2 className="w-3.5 h-3.5" /> <span>PASS</span></>
          }
        </button>
        <button
          onClick={() => submitVerdict('failed')}
          disabled={!runId || !!submitting}
          className={cn(
            'flex-1 py-2.5 rounded-lg font-bold text-xs flex items-center justify-center space-x-1.5 transition-all disabled:cursor-not-allowed',
            effectiveFail
              ? 'bg-gradient-to-r from-brand-red/80 to-brand-red text-white'
              : 'border border-white/5 text-gray-600 hover:bg-white/5',
          )}
        >
          {submitting === 'failed'
            ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
            : <><XCircle className="w-3.5 h-3.5" /> <span>FAIL</span></>
          }
        </button>
      </div>

      {/* Verdict error */}
      {verdictError && (
        <div className="mt-2 text-[10px] text-brand-red font-mono px-1">{verdictError}</div>
      )}

      {/* Resolved selector — always shown when available */}
      {selectorUsed && (
        <div className="mt-3 px-3 py-2 rounded-lg bg-white/[0.03] border border-white/5">
          <div className="text-[9px] font-bold text-gray-500 uppercase tracking-widest mb-1">Resolved selector</div>
          <div className="font-mono text-[10px] text-gray-300 break-all">{selectorUsed}</div>
        </div>
      )}

      {/* LLM Candidates Panel */}
      {showCandidates && domCandidates && domCandidates.length > 0 && (
        <div className="mt-4 border-t border-white/10 pt-4 space-y-2">
          <div className="text-[10px] font-bold text-brand-orange uppercase tracking-widest mb-3">
            Elements sent to LLM
          </div>
          {domCandidates.map((c) => {
            const isPicked = c.kaizenId === llmPickedKaizenId;
            return (
              <div
                key={c.kaizenId}
                className={cn(
                  'rounded-lg px-3 py-2 border font-mono text-[10px] leading-relaxed transition-all',
                  isPicked
                    ? 'border-brand-orange/50 bg-brand-orange/10 text-brand-orange'
                    : 'border-white/5 bg-white/[0.02] text-gray-400',
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <span>
                    <span className="text-gray-500">[{c.kaizenId}]</span>{' '}
                    <span className={isPicked ? 'text-brand-orange' : 'text-gray-300'}>{c.role}</span>
                    {': '}
                    <span className="text-white">"{c.name}"</span>
                    {c.parentContext && (
                      <span className="text-brand-pink ml-2">(in: "{c.parentContext}")</span>
                    )}
                  </span>
                  {isPicked && (
                    <span className="shrink-0 text-[9px] font-bold bg-brand-orange/20 text-brand-orange px-1.5 py-0.5 rounded uppercase">
                      picked
                    </span>
                  )}
                </div>
                <div className="mt-1 text-gray-600 truncate">{c.selector}</div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
