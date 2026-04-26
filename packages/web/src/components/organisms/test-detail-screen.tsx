'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft, ChevronRight, Play, Copy, GitBranch, GitCompare, Image as ImageIcon,
  Loader2, X, Check, AlertTriangle, Trash2, Plus, Save, ListIcon as ListIc,
  BarChart2, Terminal, Zap, MousePointerClick, Type as TypeIcon, Navigation,
  History as HistoryIc, Cpu,
} from 'lucide-react';
import type { CaseDetail, RunDetail, RunStatus, StepResult, RunSummary } from '@/types/api';
import { useCaseDetail } from '@/hooks/use-case-detail';
import { useRunDetail } from '@/hooks/use-run-detail';
import { useRunPoller } from '@/hooks/use-run-poller';
import { TopBar } from '@/components/organisms/app-shell/top-bar';
import { StatusDot, type StatusKind } from '@/components/atoms/status-dot';
import { Wip } from '@/components/atoms/wip';
import { Toast } from '@/components/atoms/toast';
import { cn } from '@/lib/cn';

type Viz = 'timeline' | 'gantt' | 'logs';
type ToastState = { msg: string; kind: 'info' | 'success' | 'danger' } | null;

// ─── Page ────────────────────────────────────────────────────────────────────

export function TestDetailScreen({ caseId }: { caseId: string }) {
  const router = useRouter();
  const { data: test, isLoading: caseLoading, refetch } = useCaseDetail(caseId);

  // ── Editable steps state (preserved from previous panel) ──────────────────
  const [localSteps, setLocalSteps] = useState<string[]>([]);
  const [localUrl, setLocalUrl] = useState('');
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);

  // ── Run state ─────────────────────────────────────────────────────────────
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [enqueuing, setEnqueuing] = useState(false);
  const [activeStepId, setActiveStepId] = useState<string | null>(null);
  const [viz, setViz] = useState<Viz>('timeline');
  const [toast, setToast] = useState<ToastState>(null);
  const [lightbox, setLightbox] = useState<string | null>(null);

  function showToast(msg: string, kind: 'info' | 'success' | 'danger' = 'info') {
    setToast({ msg, kind });
    window.setTimeout(() => setToast(null), 3000);
  }

  useEffect(() => {
    if (test) {
      setLocalSteps(test.steps.map((s) => s.rawText));
      setLocalUrl(test.baseUrl);
    }
  }, [test]);

  const displayRunId = activeRunId ?? test?.recentRuns?.[0]?.id ?? null;
  const { data: run } = useRunDetail(displayRunId);

  // Auto-select the first step result when run loads
  useEffect(() => {
    if (run?.stepResults?.length && !activeStepId) {
      setActiveStepId(run.stepResults[0].id);
    }
  }, [run, activeStepId]);

  // Preload all step screenshots when the run loads. Without this, switching
  // to a step kicks off a fresh fetch + decode (~300-800ms perceived lag).
  // We trigger the browser's HTTP cache via new Image() so subsequent <img>
  // renders in the inspector hit cache instantly.
  useEffect(() => {
    if (!run?.stepResults?.length) return;
    const seen = new Set<string>();
    for (const sr of run.stepResults) {
      if (sr.screenshotKey && !seen.has(sr.screenshotKey)) {
        seen.add(sr.screenshotKey);
        const img = new Image();
        img.src = `/api/proxy/media?key=${sr.screenshotKey}`;
      }
    }
  }, [run?.id, run?.stepResults]);

  useRunPoller({
    runId: activeRunId,
    onComplete: (r) => {
      showToast(`Run ${r.status.toUpperCase()}.`, r.status === 'failed' ? 'danger' : 'success');
      setActiveRunId(null);
      refetch();
    },
  });

  const startRun = useCallback(async () => {
    setEnqueuing(true);
    try {
      const res = await fetch(`/api/proxy/cases/${caseId}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        if (res.status === 402 && body?.message) { showToast(body.message, 'danger'); return; }
        throw new Error('failed');
      }
      const { runId } = (await res.json()) as { runId: string };
      setActiveRunId(runId);
      showToast('Run enqueued — polling…');
    } catch {
      showToast('Failed to start run.', 'danger');
    } finally {
      setEnqueuing(false);
    }
  }, [caseId]);

  const saveSteps = useCallback(async () => {
    if (!test) return;
    const active = localSteps.map((s) => s.trim()).filter(Boolean);
    if (!active.length) { showToast('At least one step is required.', 'danger'); return; }
    if (!localUrl.trim()) { showToast('Base URL is required.', 'danger'); return; }

    setSaving(true);
    try {
      const res = await fetch(`/api/proxy/cases/${caseId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ steps: active, baseUrl: localUrl.trim() }),
      });
      if (!res.ok) throw new Error();
      await refetch();
      setEditing(false);
      showToast('Saved.', 'success');
    } catch {
      showToast('Save failed.', 'danger');
    } finally {
      setSaving(false);
    }
  }, [test, localSteps, localUrl, caseId, refetch]);

  // ── Loading / not found ──
  if (caseLoading) {
    return (
      <div className="flex-1 flex flex-col overflow-hidden">
        <TopBar crumbs={[{ label: 'Tests', href: '/tests' }, { label: '…' }]} />
        <div className="flex-1 grid place-items-center text-text-low">
          <Loader2 size={28} className="animate-orbit" />
        </div>
      </div>
    );
  }

  if (!test) {
    return (
      <div className="flex-1 flex flex-col overflow-hidden">
        <TopBar crumbs={[{ label: 'Tests', href: '/tests' }, { label: 'Not found' }]} />
        <div className="flex-1 flex flex-col items-center justify-center gap-3 text-danger">
          <AlertTriangle size={32} />
          <p className="text-sm">Test not found.</p>
          <button
            onClick={() => router.push('/tests')}
            className="text-xs underline text-text-mid"
          >
            Back to dashboard
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <TopBar
        crumbs={[
          { label: 'Tests', href: '/tests' },
          { label: test.name },
        ]}
      />

      <PageHeader
        test={test}
        onBack={() => router.push('/tests')}
        onRun={startRun}
        running={enqueuing || !!activeRunId}
        editing={editing}
        onToggleEdit={() => setEditing((v) => !v)}
        onSave={saveSteps}
        saving={saving}
      />

      <RunSummaryStrip run={run ?? null} fallback={test.recentRuns?.[0] ?? null} />

      <div className="flex-1 grid overflow-hidden" style={{ gridTemplateColumns: '220px 1fr 380px' }}>
        <RunHistoryRail runs={test.recentRuns ?? []} active={displayRunId} onSelect={(id) => { setActiveRunId(null); setActiveStepId(null); /* render last historical run */ /* (the rail acts on recentRuns; selecting persists locally only) */ }} />

        <div className="flex flex-col overflow-hidden border-r border-border-subtle">
          <div className="flex items-center gap-2 px-5 py-2.5 border-b border-border-subtle bg-app-bg">
            <span className="eyebrow">execution</span>
            <div className="flex-1" />
            <VizToggle value={viz} onChange={setViz} />
          </div>

          <GanttStrip stepResults={run?.stepResults ?? []} active={activeStepId} onSelect={setActiveStepId} />

          <div className="flex-1 overflow-auto px-5 py-3.5 pb-16">
            {editing ? (
              <StepsEditor
                steps={localSteps}
                onChange={setLocalSteps}
                baseUrl={localUrl}
                onUrl={setLocalUrl}
              />
            ) : viz === 'timeline' ? (
              <StepTimeline
                steps={test.steps}
                stepResults={run?.stepResults ?? []}
                activeStepId={activeStepId}
                onSelect={setActiveStepId}
              />
            ) : viz === 'gantt' ? (
              <GanttDetail
                stepResults={run?.stepResults ?? []}
                steps={test.steps}
                activeStepId={activeStepId}
                onSelect={setActiveStepId}
              />
            ) : (
              <LogsView steps={test.steps} stepResults={run?.stepResults ?? []} />
            )}
          </div>
        </div>

        <StepInspectorList
          steps={test.steps}
          stepResults={run?.stepResults ?? []}
          activeStepId={activeStepId}
          onSelect={setActiveStepId}
          runId={run?.id ?? null}
          onLightbox={setLightbox}
          onVerdict={() => refetch()}
        />
      </div>

      {lightbox && (
        <button
          onClick={() => setLightbox(null)}
          aria-label="Close"
          className="fixed inset-0 z-[200] bg-black/90 backdrop-blur-md grid place-items-center p-12"
        >
          <X size={28} className="absolute top-6 right-6 text-white" />
          <img
            src={`/api/proxy/media?key=${lightbox}`}
            alt="step screenshot"
            className="max-w-full max-h-full object-contain rounded-lg shadow-2xl"
          />
        </button>
      )}

      {toast && <Toast message={toast.msg} kind={toast.kind} />}
    </div>
  );
}

// ─── Page header ─────────────────────────────────────────────────────────────

function PageHeader({
  test, onBack, onRun, running, editing, onToggleEdit, onSave, saving,
}: {
  test: CaseDetail;
  onBack: () => void;
  onRun: () => void;
  running: boolean;
  editing: boolean;
  onToggleEdit: () => void;
  onSave: () => void;
  saving: boolean;
}) {
  return (
    <div className="px-6 pt-4 pb-3 border-b border-border-subtle">
      <div className="flex items-end justify-between gap-6">
        <div className="flex items-center gap-2.5 min-w-0">
          <button
            onClick={onBack}
            className="inline-flex items-center justify-center w-6 h-6 rounded-md text-text-mid hover:text-text-hi hover:bg-surface-elevated shrink-0"
            aria-label="Back to tests"
          >
            <ArrowLeft size={12} />
          </button>
          <h1 className="font-display text-[22px] font-semibold tracking-tight text-text-hi leading-none truncate">
            {test.name}
          </h1>
        </div>
        <div className="flex gap-2">
          {editing ? (
            <>
              <button
                onClick={onToggleEdit}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs bg-surface-elevated border border-border-strong text-text"
              >
                Cancel
              </button>
              <button
                onClick={onSave}
                disabled={saving}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold bg-brand-primary text-app-bg-deep disabled:opacity-60"
                style={{ boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.15)' }}
              >
                {saving ? <Loader2 size={11} className="animate-orbit" /> : <Save size={11} />}
                Save changes
              </button>
            </>
          ) : (
            <>
              <button
                onClick={onToggleEdit}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs bg-surface-elevated border border-border-strong text-text hover:text-text-hi"
              >
                <Copy size={12} /> Edit steps
              </button>
              <button
                disabled
                title="Compare runs not wired yet"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs bg-surface-elevated border border-border-strong text-text-faint cursor-not-allowed"
              >
                <GitCompare size={12} /> Compare
              </button>
              <button
                onClick={onRun}
                disabled={running}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold bg-brand-primary text-app-bg-deep disabled:opacity-60"
                style={{ boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.15)' }}
              >
                {running ? <Loader2 size={11} className="animate-orbit" /> : <Play size={11} />}
                Run again
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Run summary strip ───────────────────────────────────────────────────────

function RunSummaryStrip({ run, fallback }: { run: RunDetail | null; fallback: RunSummary | null }) {
  const r = run ?? fallback;
  const status: StatusKind = r ? statusKind(r.status) : 'pending';
  const dur = r?.durationMs ?? null;
  const tokens = r?.totalTokens ?? 0;
  const heals = run?.stepResults.filter((s) => s.status === 'healed').length ?? 0;

  return (
    <div className="grid border-b border-border-subtle bg-surface-sunken" style={{ gridTemplateColumns: 'auto 1fr 1fr 1fr 1fr 1fr' }}>
      <div className="flex items-center gap-2.5 px-4 py-2.5 border-r border-border-subtle min-w-[180px]">
        <StatusDot status={status} size={8} />
        <div>
          <div className="eyebrow !text-[9px] mb-0.5">{r ? `run #${r.id.slice(-4)}` : 'no runs yet'}</div>
          <div
            className="font-display tabular text-[15px] font-semibold leading-none capitalize"
            style={{ color: statusColor(status) }}
          >
            {r ? r.status : '—'}
          </div>
        </div>
      </div>
      <RunCell label="Duration" value={dur != null ? `${(dur / 1000).toFixed(1)}s` : null} />
      <RunCell label="Steps" value={run ? `${run.stepResults.length}` : null} />
      <RunCell label="Self-heals" value={`${heals}`} />
      <RunCell label="Tokens" value={tokens.toLocaleString()} />
      <RunCell label="When" value={r?.completedAt ? formatRelative(r.completedAt) : null} />
    </div>
  );
}

function RunCell({ label, value, wip = false }: { label: string; value?: string | null; wip?: boolean }) {
  return (
    <div className="px-4 py-2.5 border-r border-border-subtle last:border-r-0">
      <div className="eyebrow !text-[9px] mb-0.5">{label}</div>
      <div className="font-mono tabular text-[14px] font-medium text-text-hi">
        {wip ? <Wip /> : (value ?? '—')}
      </div>
    </div>
  );
}

// ─── Run history rail ────────────────────────────────────────────────────────

function RunHistoryRail({
  runs, active, onSelect,
}: { runs: RunSummary[]; active: string | null; onSelect: (id: string) => void }) {
  return (
    <div className="border-r border-border-subtle overflow-auto bg-app-bg">
      <div className="px-4 pt-3 pb-2">
        <div className="eyebrow">history · {runs.length}</div>
      </div>
      {runs.length === 0 ? (
        <div className="px-4 py-3 text-[11px] text-text-low">
          No runs yet.
        </div>
      ) : runs.map((r) => {
        const selected = r.id === active;
        const status = statusKind(r.status);
        return (
          <button
            key={r.id}
            onClick={() => onSelect(r.id)}
            className={cn(
              'w-full flex items-center gap-2.5 px-4 py-2 text-left',
              selected ? 'bg-surface-elevated' : 'hover:bg-surface',
            )}
            style={selected ? { borderLeft: '2px solid var(--color-brand-primary)' } : { borderLeft: '2px solid transparent' }}
          >
            <StatusDot status={status} size={6} />
            <div className="flex-1 min-w-0">
              <div className="flex items-baseline gap-1.5">
                <span className="font-mono tabular text-[11px] text-text-hi font-medium">#{r.id.slice(-4)}</span>
                <span className="text-[11px] text-text-mid truncate">{formatRelative(r.completedAt ?? r.createdAt)}</span>
              </div>
              <div className="font-mono text-[10px] text-text-low truncate">
                {r.durationMs != null ? `${(r.durationMs / 1000).toFixed(1)}s` : '—'}
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}

// ─── Viz toggle ──────────────────────────────────────────────────────────────

function VizToggle({ value, onChange }: { value: Viz; onChange: (v: Viz) => void }) {
  const opts: { id: Viz; label: string; Icon: typeof ListIc }[] = [
    { id: 'timeline', label: 'Timeline', Icon: ListIc },
    { id: 'gantt',    label: 'Gantt',    Icon: BarChart2 },
    { id: 'logs',     label: 'Logs',     Icon: Terminal },
  ];
  return (
    <div className="flex bg-surface border border-border-subtle rounded-md p-0.5">
      {opts.map(({ id, label, Icon }) => (
        <button
          key={id}
          onClick={() => onChange(id)}
          className={cn(
            'flex items-center gap-1.5 px-2.5 py-1 rounded-[5px] text-[11px] font-medium transition-colors',
            value === id ? 'bg-surface-elevated text-text-hi' : 'text-text-mid hover:text-text-hi',
          )}
        >
          <Icon size={11} /> {label}
        </button>
      ))}
    </div>
  );
}

// ─── Gantt strip (compact bar across top of execution panel) ────────────────

function GanttStrip({
  stepResults, active, onSelect,
}: { stepResults: StepResult[]; active: string | null; onSelect: (id: string) => void }) {
  if (!stepResults.length) {
    return (
      <div className="px-5 py-3.5 border-b border-border-subtle">
        <div className="flex items-center justify-between mb-2">
          <span className="eyebrow">timeline</span>
          <Wip />
        </div>
        <div className="h-[26px] bg-surface-sunken border border-border-subtle rounded-md" />
      </div>
    );
  }

  const total = stepResults.reduce((s, sr) => s + (sr.durationMs ?? 0), 0) || 1;
  let cursor = 0;

  return (
    <div className="px-5 py-3.5 border-b border-border-subtle">
      <div className="flex justify-between mb-2">
        <span className="eyebrow">timeline · {(total / 1000).toFixed(1)}s total</span>
        <span className="eyebrow font-mono">0ms ─── {total}ms</span>
      </div>
      <div className="relative h-[26px] bg-surface-sunken border border-border-subtle rounded-md overflow-hidden">
        {[0.25, 0.5, 0.75].map((t, i) => (
          <span
            key={i}
            className="absolute top-0 bottom-0 w-px bg-border-subtle"
            style={{ left: `${t * 100}%` }}
          />
        ))}
        {stepResults.map((sr) => {
          const dur = sr.durationMs ?? 0;
          const left = (cursor / total) * 100;
          const width = (dur / total) * 100;
          cursor += dur;
          const c = stepColor(statusKind(sr.status));
          const selected = sr.id === active;
          return (
            <button
              key={sr.id}
              onClick={() => onSelect(sr.id)}
              title={`${sr.status} · ${dur}ms`}
              className={cn('absolute rounded-sm transition-opacity')}
              style={{
                left: `${left}%`,
                width: `${Math.max(width, 0.5)}%`,
                top: 4, bottom: 4,
                background: c,
                opacity: selected ? 1 : 0.7,
                boxShadow: selected ? `0 0 0 2px var(--color-app-bg-deep), 0 0 0 3px ${c}` : undefined,
                border: 'none',
                cursor: 'pointer',
              }}
            />
          );
        })}
      </div>
    </div>
  );
}

// ─── Step timeline (vertical list with ribbon) ──────────────────────────────

function StepTimeline({
  steps, stepResults, activeStepId, onSelect,
}: {
  steps: CaseDetail['steps'];
  stepResults: StepResult[];
  activeStepId: string | null;
  onSelect: (id: string) => void;
}) {
  if (!stepResults.length) {
    return (
      <div className="text-center py-12 text-text-low text-sm">
        <p>No run data yet.</p>
        <p className="mt-1"><Wip /></p>
      </div>
    );
  }

  return (
    <div className="relative">
      <div className="absolute left-[19px] top-2 bottom-2 w-px bg-border-subtle" />
      {stepResults.map((sr, i) => {
        const stepText = sr.rawText ?? steps.find((s) => s.id === sr.stepId)?.rawText ?? '';
        const status = statusKind(sr.status);
        const isActive = sr.id === activeStepId;
        const intent = textIntent(stepText);

        return (
          <button
            key={sr.id}
            onClick={() => onSelect(sr.id)}
            className={cn(
              'grid w-full text-left rounded-lg mb-1 px-1 py-2 transition-colors',
              isActive ? 'bg-surface-elevated' : 'hover:bg-surface',
            )}
            style={{ gridTemplateColumns: '40px 1fr', columnGap: 12 }}
          >
            <div className="flex justify-center pt-1">
              <StepNode status={status} />
            </div>
            <div>
              <div className="flex items-center gap-2 mb-1">
                <span className="font-mono tabular text-[10px] text-text-low">step {String(i + 1).padStart(2, '0')}</span>
                <IntentChipMini intent={intent} />
                <div className="flex-1" />
                <span className="font-mono tabular text-[11px] text-text-mid">
                  {sr.durationMs != null ? `${sr.durationMs}ms` : <Wip />}
                </span>
                <span className="font-mono tabular text-[10px] text-text-low inline-flex items-center gap-0.5">
                  <Zap size={9} /> {sr.tokens.toLocaleString()}
                </span>
              </div>
              <div className="text-[13px] text-text-hi leading-relaxed">{stepText}</div>
              {status === 'healed' && (
                <div className="mt-1.5 px-2.5 py-1.5 rounded-md text-[11px] text-brand-accent bg-brand-accent/[0.06] border border-brand-accent/20">
                  Self-healed · <Wip />
                </div>
              )}
              {status === 'failed' && sr.errorType && (
                <div className="mt-1.5 px-2.5 py-1.5 rounded-md text-[11px] text-danger bg-danger/[0.06] border border-danger/30 font-mono">
                  {sr.errorType}{sr.failureClass ? ` · ${sr.failureClass}` : ''}
                </div>
              )}
            </div>
          </button>
        );
      })}
    </div>
  );
}

function StepNode({ status }: { status: StatusKind }) {
  const c = stepColor(status);
  return (
    <span
      className="w-2.5 h-2.5 rounded-full block"
      style={{
        background: status === 'pending' ? 'transparent' : c,
        border: status === 'pending' ? '1px dashed var(--color-text-faint)' : `2px solid var(--color-app-bg)`,
        boxShadow: status === 'pending' ? 'none' : `0 0 0 2px ${c}, 0 0 12px ${c}`,
      }}
    />
  );
}

function IntentChipMini({ intent }: { intent: ReturnType<typeof textIntent> }) {
  const Icon = intent.icon;
  return (
    <span
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded font-mono text-[9px] uppercase font-semibold tracking-[0.1em] border"
      style={{ color: intent.color, borderColor: intent.border, background: intent.bg }}
    >
      <Icon size={9} /> {intent.label}
    </span>
  );
}

function textIntent(text: string) {
  const t = text.toLowerCase();
  if (t.startsWith('navig') || t.includes('go to') || t.includes('open ')) {
    return { label: 'NAV',    icon: Navigation,        color: 'var(--color-brand-accent)',  border: 'rgba(219,135,175,0.3)', bg: 'rgba(219,135,175,0.08)' };
  }
  if (t.startsWith('type') || t.startsWith('enter ') || t.startsWith('fill')) {
    return { label: 'TYPE',   icon: TypeIcon,          color: 'var(--color-brand-primary)', border: 'rgba(213,96,28,0.3)',   bg: 'rgba(213,96,28,0.08)' };
  }
  if (t.startsWith('click') || t.startsWith('press') || t.startsWith('tap')) {
    return { label: 'CLICK',  icon: MousePointerClick, color: 'var(--color-brand-primary)', border: 'rgba(213,96,28,0.3)',   bg: 'rgba(213,96,28,0.08)' };
  }
  if (t.startsWith('verify') || t.startsWith('expect') || t.startsWith('check') || t.startsWith('assert')) {
    return { label: 'ASSERT', icon: Check,             color: 'var(--color-success)',       border: 'rgba(34,197,94,0.3)',   bg: 'rgba(34,197,94,0.08)' };
  }
  if (t.startsWith('wait')) {
    return { label: 'WAIT',   icon: HistoryIc,         color: 'var(--color-warning)',       border: 'rgba(245,158,11,0.3)',  bg: 'rgba(245,158,11,0.08)' };
  }
  return    { label: 'STEP',   icon: Cpu,               color: 'var(--color-text-mid)',      border: 'var(--color-border-subtle)', bg: 'var(--color-surface-sunken)' };
}

// ─── Gantt detail (full-width per-step bars) ────────────────────────────────

function GanttDetail({
  stepResults, steps, activeStepId, onSelect,
}: {
  stepResults: StepResult[];
  steps: CaseDetail['steps'];
  activeStepId: string | null;
  onSelect: (id: string) => void;
}) {
  if (!stepResults.length) return <div className="text-text-low text-sm py-8 text-center"><Wip label="NO RUN DATA WIP" /></div>;
  const total = stepResults.reduce((s, sr) => s + (sr.durationMs ?? 0), 0) || 1;
  let cursor = 0;
  return (
    <div className="flex flex-col gap-1">
      {stepResults.map((sr, i) => {
        const dur = sr.durationMs ?? 0;
        const left = (cursor / total) * 100;
        const width = (dur / total) * 100;
        cursor += dur;
        const status = statusKind(sr.status);
        const isActive = sr.id === activeStepId;
        const c = stepColor(status);
        const stepText = sr.rawText ?? steps.find((s) => s.id === sr.stepId)?.rawText ?? '';
        return (
          <button
            key={sr.id}
            onClick={() => onSelect(sr.id)}
            className={cn(
              'grid items-center px-1.5 py-1.5 rounded-md text-left',
              isActive ? 'bg-surface-elevated' : 'hover:bg-surface',
            )}
            style={{ gridTemplateColumns: '32px 200px 1fr 60px', columnGap: 8 }}
          >
            <span className="font-mono tabular text-[10px] text-text-low text-right">{String(i + 1).padStart(2, '0')}</span>
            <span className="text-xs text-text-hi truncate">{stepText}</span>
            <span className="relative h-3.5 bg-surface-sunken rounded-sm">
              <span
                className="absolute top-px bottom-px rounded-[2px]"
                style={{ left: `${left}%`, width: `${Math.max(width, 0.5)}%`, background: c, boxShadow: isActive ? `0 0 8px ${c}` : undefined }}
              />
            </span>
            <span className="font-mono tabular text-[11px] text-text-mid text-right">{dur}ms</span>
          </button>
        );
      })}
    </div>
  );
}

// ─── Logs view ───────────────────────────────────────────────────────────────

function LogsView({ steps, stepResults }: { steps: CaseDetail['steps']; stepResults: StepResult[] }) {
  if (!stepResults.length) return <div className="text-text-low text-sm py-8 text-center"><Wip label="NO RUN DATA WIP" /></div>;
  let cursor = 0;
  return (
    <div className="font-mono bg-app-bg-deep border border-border-subtle rounded-lg p-4 text-[11px] leading-relaxed text-text-mid">
      {stepResults.map((sr) => {
        const text = sr.rawText ?? steps.find((s) => s.id === sr.stepId)?.rawText ?? '';
        const intent = textIntent(text);
        const status = statusKind(sr.status);
        const c = stepColor(status);
        const t = String(cursor).padStart(5, '0');
        cursor += sr.durationMs ?? 0;
        return (
          <div key={sr.id} className="mb-1.5">
            <span className="text-text-faint">[{t}ms]</span>{' '}
            <span style={{ color: c, fontWeight: 600 }}>{intent.label.padEnd(7)}</span>{' '}
            <span className="text-text">{text}</span>
            {sr.errorType && (
              <div className="pl-20 text-danger mt-0.5">↳ ERROR: {sr.errorType}</div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Steps editor (preserved CRUD) ──────────────────────────────────────────

function StepsEditor({
  steps, onChange, baseUrl, onUrl,
}: {
  steps: string[];
  onChange: (next: string[]) => void;
  baseUrl: string;
  onUrl: (next: string) => void;
}) {
  const lastRef = useRef<HTMLInputElement | null>(null);

  return (
    <div className="space-y-4">
      <div>
        <div className="eyebrow mb-1">target url</div>
        <input
          value={baseUrl}
          onChange={(e) => onUrl(e.target.value)}
          className="w-full bg-surface border border-border-strong rounded-md px-3 py-2 text-[13px] text-text font-mono outline-none focus:border-brand-primary"
        />
      </div>
      <div>
        <div className="flex items-center justify-between mb-2">
          <span className="eyebrow">steps</span>
          <button
            onClick={() => {
              onChange([...steps, '']);
              setTimeout(() => lastRef.current?.focus(), 50);
            }}
            className="inline-flex items-center gap-1 text-xs text-text-mid hover:text-text-hi"
          >
            <Plus size={11} /> Add step
          </button>
        </div>
        <div className="flex flex-col gap-1.5">
          {steps.map((s, i) => (
            <div key={i} className="flex items-center gap-2">
              <span className="font-mono tabular text-[10px] text-text-low w-6 text-right">{String(i + 1).padStart(2, '0')}</span>
              <input
                ref={i === steps.length - 1 ? lastRef : undefined}
                value={s}
                onChange={(e) => onChange(steps.map((p, j) => (j === i ? e.target.value : p)))}
                placeholder="Describe the action…"
                className="flex-1 bg-surface border border-border-strong rounded-md px-3 py-1.5 text-[13px] text-text outline-none focus:border-brand-primary"
              />
              <button
                onClick={() => onChange(steps.filter((_, j) => j !== i))}
                className="text-text-mid hover:text-danger px-1.5"
                title="Remove step"
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Step inspector list (right column) ─────────────────────────────────────
//
// Renders every step's full block stacked vertically.
//   - Clicking a row in the timeline scrolls this list to that step's block.
//   - Scrolling this list (via wheel / trackpad) updates activeStepId so the
//     timeline highlights the step that's currently in view.
//
// A "did user just click" ref suppresses the IntersectionObserver-driven
// update during the smooth-scroll animation kicked off by activeStepId
// changes — without it the smooth scroll fires intersection events that
// fight the click and ping-pong the selection.

function StepInspectorList({
  steps, stepResults, activeStepId, onSelect, runId, onLightbox, onVerdict,
}: {
  steps: CaseDetail['steps'];
  stepResults: StepResult[];
  activeStepId: string | null;
  onSelect: (id: string) => void;
  runId: string | null;
  onLightbox: (key: string) => void;
  onVerdict: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  // Set true for ~600ms after a click so IntersectionObserver doesn't fight
  // the smooth-scroll animation (the scroll itself triggers intersection
  // events which would re-set activeStepId mid-flight).
  const suppressUntilRef = useRef<number>(0);

  // When activeStepId changes, scroll the matching block into view.
  useEffect(() => {
    if (!activeStepId) return;
    const root = containerRef.current;
    if (!root) return;
    const el = root.querySelector<HTMLElement>(`[data-step-id="${activeStepId}"]`);
    if (!el) return;

    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    suppressUntilRef.current = Date.now() + (reduce ? 0 : 600);
    el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
  }, [activeStepId]);

  // Set activeStepId based on which block is most-visible during scroll.
  useEffect(() => {
    const root = containerRef.current;
    if (!root || stepResults.length === 0) return;

    const blocks = Array.from(root.querySelectorAll<HTMLElement>('[data-step-id]'));
    if (blocks.length === 0) return;

    // Track the most-visible block. A small Map keyed by id captures the latest
    // intersection ratio for each entry; on every callback we pick the max.
    const ratios = new Map<string, number>();

    const observer = new IntersectionObserver(
      (entries) => {
        if (Date.now() < suppressUntilRef.current) return;
        for (const e of entries) {
          const id = (e.target as HTMLElement).dataset.stepId;
          if (id) ratios.set(id, e.intersectionRatio);
        }
        let topId: string | null = null;
        let topRatio = 0;
        for (const [id, ratio] of ratios) {
          if (ratio > topRatio) { topRatio = ratio; topId = id; }
        }
        if (topId && topId !== activeStepId && topRatio > 0.25) {
          onSelect(topId);
        }
      },
      { root, threshold: [0, 0.25, 0.5, 0.75, 1] },
    );

    blocks.forEach((b) => observer.observe(b));
    return () => observer.disconnect();
  }, [stepResults, activeStepId, onSelect]);

  if (stepResults.length === 0) {
    return (
      <div className="overflow-auto px-5 py-5 bg-app-bg">
        <div className="eyebrow mb-2">step inspector</div>
        <p className="text-[13px] text-text-mid">No run data yet.</p>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="overflow-auto px-5 bg-app-bg pb-4">
      <div className="eyebrow mb-3 sticky top-0 bg-app-bg pt-4 pb-2 z-10">step inspector</div>
      <div className="flex flex-col">
        {stepResults.map((sr, i) => {
          const stepText = sr.rawText
            ?? steps.find((s) => s.id === sr.stepId)?.rawText
            ?? '';
          const isActive = sr.id === activeStepId;
          return (
            <StepInspectorBlock
              key={sr.id}
              index={i}
              stepText={stepText}
              stepResult={sr}
              runId={runId}
              isActive={isActive}
              onLightbox={onLightbox}
              onVerdict={onVerdict}
              onClick={() => onSelect(sr.id)}
            />
          );
        })}
      </div>
    </div>
  );
}

function StepInspectorBlock({
  index, stepText, stepResult, runId, isActive, onLightbox, onVerdict, onClick,
}: {
  index: number;
  stepText: string;
  stepResult: StepResult;
  runId: string | null;
  isActive: boolean;
  onLightbox: (key: string) => void;
  onVerdict: () => void;
  onClick: () => void;
}) {
  const [submitting, setSubmitting] = useState<'passed' | 'failed' | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function vote(v: 'passed' | 'failed') {
    if (!runId) return;
    setSubmitting(v);
    setErr(null);
    try {
      const res = await fetch(`/api/proxy/runs/${runId}/steps/${stepResult.id}/verdict`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ verdict: v }),
      });
      if (!res.ok) throw new Error();
      onVerdict();
    } catch {
      setErr('Failed to submit verdict.');
    } finally {
      setSubmitting(null);
    }
  }

  const status = statusKind(stepResult.status);
  const intent = textIntent(stepText);

  return (
    <div
      data-step-id={stepResult.id}
      onClick={onClick}
      className={cn(
        'scroll-mt-14 rounded-lg px-3 py-3 mb-2 transition-colors cursor-pointer',
        isActive
          ? 'bg-surface-elevated ring-1 ring-border-accent'
          : 'bg-transparent hover:bg-surface',
      )}
    >
      <div className="flex items-center gap-2 mb-1.5">
        <span className="font-mono tabular text-[10px] text-text-low shrink-0">
          step {String(index + 1).padStart(2, '0')}
        </span>
        <IntentChipMini intent={intent} />
        <span
          className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 border font-mono text-[10px] uppercase font-semibold tracking-[0.12em]"
          style={{ color: stepColor(status), borderColor: stepColor(status) + '40', background: stepColor(status) + '14' }}
        >
          <StatusDot status={status} size={5} /> {stepResult.status}
        </span>
        <div className="flex-1" />
        {stepResult.tokens > 0 && (
          <span className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 border border-brand-primary/30 bg-brand-primary/10 text-brand-primary font-mono text-[10px] tabular">
            <Zap size={9} /> {stepResult.tokens.toLocaleString()}
          </span>
        )}
        {stepResult.durationMs != null && (
          <span className="font-mono text-[10px] text-text-mid tabular">
            {stepResult.durationMs}ms
          </span>
        )}
      </div>

      <div className="text-[13px] text-text-hi font-medium mb-2 leading-relaxed">{stepText}</div>

      {stepResult.screenshotKey ? (
        <button
          onClick={(e) => {
            e.stopPropagation();
            if (stepResult.screenshotKey) onLightbox(stepResult.screenshotKey);
          }}
          className="w-full mb-2 rounded-lg overflow-hidden bg-app-bg-deep border border-border-subtle hover:border-border-accent transition-colors"
        >
          <img
            src={`/api/proxy/media?key=${stepResult.screenshotKey}`}
            alt="step screenshot"
            className="w-full block"
          />
          <div className="flex justify-between px-2.5 py-1.5 border-t border-border-subtle">
            <span className="eyebrow font-mono !text-[9px]">frame · {stepResult.id.slice(-6)}</span>
            <span className="text-[11px] text-text-mid"><ImageIcon size={11} className="inline mr-1" /> open</span>
          </div>
        </button>
      ) : (
        <div className="mb-2 rounded-lg border border-border-subtle bg-app-bg-deep py-6 grid place-items-center text-text-low">
          <Wip label="NO SCREENSHOT" />
        </div>
      )}

      {status === 'healed' && (
        <div className="mb-2 px-3 py-2 rounded-md bg-brand-accent/[0.04] border border-brand-accent/20 text-[11px] text-brand-accent">
          Selector recovered · <Wip label="DIFF WIP" />
        </div>
      )}

      {status === 'failed' && stepResult.errorType && (
        <div className="mb-2 px-3 py-2 rounded-md bg-danger/[0.04] border border-danger/30">
          <div className="text-[11px] text-danger font-medium mb-0.5">{stepResult.errorType}</div>
          {stepResult.failureClass && (
            <div className="font-mono text-[10px] text-text leading-relaxed">{stepResult.failureClass}</div>
          )}
        </div>
      )}

      <div className="mb-2 px-3 py-2 rounded-md bg-surface-sunken border border-border-subtle">
        {stepResult.selectorUsed ? (
          <div className="font-mono text-[10px] text-text-mid break-all">{stepResult.selectorUsed}</div>
        ) : (
          <Wip />
        )}
        {stepResult.resolutionSource && (
          <div className="eyebrow !text-[9px] mt-1">via {stepResult.resolutionSource}</div>
        )}
      </div>

      {stepResult.domCandidates && stepResult.domCandidates.length > 0 && (
        <div className="mb-2 flex flex-col gap-1">
          <div className="eyebrow text-brand-primary">llm candidates</div>
          {stepResult.domCandidates.map((c) => {
            const picked = c.kaizenId === stepResult.llmPickedKaizenId;
            return (
              <div
                key={c.kaizenId}
                className={cn(
                  'rounded-md px-2 py-1.5 border font-mono text-[10px] leading-relaxed',
                  picked
                    ? 'border-brand-primary/50 bg-brand-primary/10 text-brand-primary'
                    : 'border-border-subtle bg-surface-sunken text-text-mid',
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <span>
                    <span className="text-text-low">[{c.kaizenId}]</span>{' '}
                    <span className={picked ? 'text-brand-primary' : 'text-text'}>{c.role}</span>
                    {': '}
                    <span className="text-text-hi">&quot;{c.name}&quot;</span>
                  </span>
                  {picked && (
                    <span className="shrink-0 text-[9px] font-bold bg-brand-primary/20 text-brand-primary px-1.5 py-px rounded uppercase">
                      picked
                    </span>
                  )}
                </div>
                <div className="mt-1 text-text-low truncate">{c.selector}</div>
              </div>
            );
          })}
        </div>
      )}

      <div className="grid grid-cols-2 gap-2">
        <button
          onClick={(e) => { e.stopPropagation(); vote('passed'); }}
          disabled={!runId || !!submitting}
          className="inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-md text-[11px] font-semibold border bg-surface-elevated text-success border-success/30 hover:bg-success/10 disabled:opacity-50"
        >
          {submitting === 'passed' ? <Loader2 size={11} className="animate-orbit" /> : <Check size={11} />} Mark pass
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); vote('failed'); }}
          disabled={!runId || !!submitting}
          className="inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-md text-[11px] font-semibold border bg-surface-elevated text-danger border-danger/30 hover:bg-danger/10 disabled:opacity-50"
        >
          {submitting === 'failed' ? <Loader2 size={11} className="animate-orbit" /> : <X size={11} />} Mark fail
        </button>
      </div>
      {err && <div className="mt-1.5 text-[11px] text-danger font-mono">{err}</div>}
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function statusKind(s: RunStatus): StatusKind {
  if (s === 'cancelled') return 'pending';
  return s as StatusKind;
}

function statusColor(s: StatusKind): string {
  switch (s) {
    case 'passed':  return 'var(--color-success)';
    case 'failed':  return 'var(--color-danger)';
    case 'healed':  return 'var(--color-brand-accent)';
    case 'running': return 'var(--color-brand-primary)';
    case 'queued':  return 'var(--color-warning)';
    default:        return 'var(--color-text-low)';
  }
}

function stepColor(s: StatusKind): string {
  return statusColor(s);
}

function formatRelative(iso: string): string {
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return d.toLocaleDateString();
}
