'use client';

import { useRouter } from 'next/navigation';
import { ArrowLeft, Printer, Loader2, Zap, Cpu, Database } from 'lucide-react';
import { useRunReport, type RunLogEntry } from '@/hooks/use-run-report';
import { cn } from '@/lib/cn';

const PHASE_COLOR: Record<RunLogEntry['phase'], string> = {
  run:     'var(--color-text-mid)',
  resolve: 'var(--color-brand-accent)',
  execute: 'var(--color-brand-primary)',
  assert:  'var(--color-success)',
  llm:     'var(--color-warning)',
  heal:    'var(--color-brand-accent)',
  capture: 'var(--color-brand-accent)',
};

export function RunReport({ caseId, runId }: { caseId: string; runId: string }) {
  const router = useRouter();
  const { data, isLoading, error } = useRunReport(runId);

  if (isLoading) {
    return <div className="flex-1 grid place-items-center text-text-low"><Loader2 size={28} className="animate-orbit" /></div>;
  }
  if (error || !data) {
    return (
      <div className="flex-1 grid place-items-center text-danger text-sm">
        {error?.message ?? 'No report data.'}
      </div>
    );
  }

  const { run, log, llmSummary } = data;
  const t0 = log.length ? new Date(log[0].at).getTime() : 0;
  const totalSteps = new Set(log.filter((e) => e.stepIndex != null).map((e) => e.stepIndex)).size;

  return (
    <div className="flex-1 overflow-auto bg-app-bg">
      {/* ── Toolbar (hidden when printing) ── */}
      <div className="print:hidden flex items-center gap-3 px-6 py-3 border-b border-border-subtle">
        <button
          onClick={() => router.push(`/tests/${caseId}`)}
          className="inline-flex items-center gap-1.5 text-xs text-text-mid hover:text-text-hi"
        >
          <ArrowLeft size={13} /> Back to test
        </button>
        <div className="flex-1" />
        <button
          onClick={() => window.print()}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs bg-surface-elevated border border-border-strong text-text hover:text-text-hi"
        >
          <Printer size={12} /> Print / Save PDF
        </button>
      </div>

      <div className="max-w-4xl mx-auto px-6 py-6">
        <h1 className="font-display text-[20px] font-semibold text-text-hi mb-1">Run Report</h1>
        <div className="font-mono text-[11px] text-text-low mb-5">
          #{run.id.slice(-8)} · {run.environmentUrl ?? '—'}
        </div>

        {/* ── Rollup ── */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
          <Stat label="Status" value={run.status} valueClass={statusColorClass(run.status)} />
          <Stat label="Steps" value={String(totalSteps)} />
          <Stat label="Total tokens" value={llmSummary.totalTokens.toLocaleString()} icon={<Zap size={11} />} />
          <Stat
            label="LLM / cache"
            value={`${llmSummary.llmResolvedSteps} / ${llmSummary.cacheResolvedSteps}`}
            icon={<Cpu size={11} />}
          />
        </div>

        {/* ── Chronological log ── */}
        <SectionTitle>Run log</SectionTitle>
        <div className="font-mono text-[11px] leading-relaxed bg-app-bg-deep border border-border-subtle rounded-lg p-4 mb-6 overflow-x-auto">
          {log.length === 0 ? (
            <div className="text-text-low">No log events recorded for this run.</div>
          ) : log.map((e) => {
            const rel = t0 ? new Date(e.at).getTime() - t0 : 0;
            return (
              <div key={e.seq} className={cn('whitespace-pre-wrap', e.level === 'error' && 'text-danger', e.level === 'warn' && 'text-warning')}>
                <span className="text-text-faint">[{String(rel).padStart(6, ' ')}ms]</span>{' '}
                <span style={{ color: PHASE_COLOR[e.phase], fontWeight: 600 }}>{e.phase.toUpperCase().padEnd(7)}</span>{' '}
                <span className="text-text">{e.message}</span>
              </div>
            );
          })}
        </div>

        {/* ── LLM decision summary ── */}
        <SectionTitle>LLM decisions</SectionTitle>
        {llmSummary.steps.length === 0 ? (
          <div className="flex items-center gap-2 text-[12px] text-text-mid mb-6">
            <Database size={13} className="text-success" />
            Every step resolved from cache / archetype — no LLM calls.
          </div>
        ) : (
          <div className="border border-border-subtle rounded-lg overflow-hidden mb-6">
            <table className="w-full text-[11px]">
              <thead className="bg-surface-sunken text-text-low">
                <tr>
                  <th className="text-left font-medium px-3 py-2">Step</th>
                  <th className="text-left font-medium px-3 py-2">Chosen element</th>
                  <th className="text-right font-medium px-3 py-2">Candidates</th>
                  <th className="text-right font-medium px-3 py-2">Tokens</th>
                </tr>
              </thead>
              <tbody>
                {llmSummary.steps.map((s, i) => (
                  <tr key={i} className="border-t border-border-subtle">
                    <td className="px-3 py-2 text-text">{s.rawText ?? '—'}</td>
                    <td className="px-3 py-2 text-text-hi">{s.chosen ? `${s.chosen.role}: "${s.chosen.name}"` : '—'}</td>
                    <td className="px-3 py-2 text-right font-mono text-text-mid">{s.candidateCount}</td>
                    <td className="px-3 py-2 text-right font-mono text-text-mid">{s.tokens.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, icon, valueClass }: { label: string; value: string; icon?: React.ReactNode; valueClass?: string }) {
  return (
    <div className="px-3 py-2.5 rounded-lg bg-surface-sunken border border-border-subtle">
      <div className="eyebrow !text-[9px] mb-1 flex items-center gap-1">{icon}{label}</div>
      <div className={cn('font-mono tabular text-[15px] font-semibold capitalize', valueClass ?? 'text-text-hi')}>{value}</div>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <div className="eyebrow mb-2">{children}</div>;
}

function statusColorClass(status: string): string {
  if (status === 'passed') return 'text-success';
  if (status === 'failed') return 'text-danger';
  if (status === 'healed') return 'text-brand-accent';
  return 'text-text-mid';
}
