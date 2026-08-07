'use client';
/* Every analysis Kaizen has run, newest first. This is the audit surface — and
   the answer to "it finished and I can't get back to it": a job that proposed
   nothing is still listed, because its report is where the reasons live.
   Spec: docs/specs/tests-ux/spec-testwriter-ux.md §4.6 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import * as React from 'react';
import { Toolbar, Stat } from './chrome';
import { I } from './icons';
import { fmt } from './data';
import type { GenerationJob } from '@/types/api';
import type { DesignSuite } from './use-design-data';

const { useState, useEffect, useCallback } = React;

const STATUS_TONE: Record<string, string> = {
  completed: 'var(--pass)',
  awaiting_plan_approval: 'var(--accent)',
  running: 'var(--idle)',
  queued: 'var(--idle)',
  failed: 'var(--fail)',
  blocked: 'var(--fail)',
};

const STATUS_LABEL: Record<string, string> = {
  completed: 'DONE',
  awaiting_plan_approval: 'NEEDS YOU',
  running: 'WORKING',
  queued: 'QUEUED',
  failed: 'FAILED',
  blocked: 'BLOCKED',
};

function relTime(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24); if (d === 1) return 'yesterday'; if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}

/** One line of what the analysis actually produced — including "nothing, and here's the count of why". */
function outcomeOf(job: GenerationJob): string {
  const r = job.report;
  if (job.status === 'awaiting_plan_approval') {
    return `${job.testPlan?.scenarios?.length ?? 0} scenarios planned — waiting for your approval`;
  }
  if (job.status === 'running' || job.status === 'queued') {
    const pages = r?.progress?.pagesCrawled;
    return pages ? `exploring — ${pages} pages so far` : 'starting up';
  }
  if (job.status === 'failed' || job.status === 'blocked') return job.error ?? 'stopped';
  const proposed = r?.validate?.proposed ?? 0;
  const rejected = r?.rejected?.length ?? 0;
  if (proposed > 0) return `${proposed} proposed${rejected ? ` · ${rejected} rejected` : ''}`;
  return rejected ? `nothing proposed · ${rejected} rejected, with reasons` : 'nothing proposed';
}

export function AnalysesScreen({ suites, onOpen, onAnalyze }: {
  suites: DesignSuite[];
  onOpen: (suiteId: string, jobId: string) => void;
  onAnalyze: () => void;
}) {
  const [jobs, setJobs] = useState<Array<GenerationJob & { suiteName: string }>>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (suites.length === 0) { setJobs([]); setLoading(false); return; }
    try {
      const results = await Promise.all(suites.map(async (s) => {
        const r = await fetch(`/api/proxy/suites/${s.id}/jobs`);
        if (!r.ok) return [];
        const { jobs: list } = await r.json();
        return (list ?? []).map((j: GenerationJob) => ({ ...j, suiteName: s.name }));
      }));
      setJobs(results.flat().sort((a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()));
    } catch { /* an empty list is honest; a crash is not */ }
    setLoading(false);
  }, [suites]);

  useEffect(() => { void load(); }, [load]);

  // Keep the list truthful while something is working, then stop.
  const anyActive = jobs.some((j) => j.status === 'running' || j.status === 'queued');
  useEffect(() => {
    if (!anyActive) return;
    const id = setInterval(load, 4000);
    return () => clearInterval(id);
  }, [anyActive, load]);

  const proposed = jobs.reduce((a, j) => a + (j.report?.validate?.proposed ?? 0), 0);
  const spent = jobs.reduce((a, j) => a + (j.report?.tokenUsage?.total ?? 0), 0);

  return (
    <>
      <Toolbar title="Analyses" sub="Every time Kaizen explored an app and proposed tests">
        <button className="btn pri" onClick={onAnalyze}><I.sparkle size={13} />Analyze an app</button>
      </Toolbar>

      <div className="scroll" style={{ flex: 1, padding: '18px 22px 40px' }}>
        {jobs.length > 0 && (
          <div className="card rise" style={{ display: 'flex', flexWrap: 'wrap', marginBottom: 16 }}>
            <Stat label="Analyses" icon="sparkle" value={jobs.length} sub="all time" />
            <Stat label="Tests proposed" icon="check" value={proposed} tone="var(--pass)" sub="across all analyses" />
            <Stat label="Spent writing" icon="usage" value={spent ? fmt.k(spent) : '—'}
              sub={spent ? 'tokens, one-time per app' : 'not measured yet'} />
          </div>
        )}

        {loading ? (
          <div className="card" style={{ padding: '40px 20px', textAlign: 'center', color: 'var(--text-2)', fontSize: 12.5 }}>
            Loading…
          </div>
        ) : jobs.length === 0 ? (
          <div className="card" style={{ padding: '48px 20px', textAlign: 'center' }}>
            <I.sparkle size={24} style={{ color: 'var(--accent)' }} />
            <div style={{ fontSize: 15, fontWeight: 600, marginTop: 10 }}>No analyses yet</div>
            <div style={{ fontSize: 12.5, color: 'var(--text-2)', marginTop: 6, marginBottom: 16, lineHeight: 1.6 }}>
              Point Kaizen at an app and it explores it, plans what a QA engineer would test,
              and proves every test before proposing it.
            </div>
            <button className="btn pri lg" onClick={onAnalyze}><I.sparkle size={13} />Analyze an app</button>
          </div>
        ) : (
          <>
            <div className="list-h" style={{ background: 'transparent', borderBottom: 'none', padding: '0 14px 5px' }}>
              <span style={{ flex: 1 }}>APP</span>
              <span className="hide-md" style={{ width: 110 }}>SUITE</span>
              <span style={{ width: 92 }}>STATUS</span>
              <span className="hide-md" style={{ width: 78, textAlign: 'right' }}>COST · TOK</span>
              <span style={{ width: 76, textAlign: 'right' }}>WHEN</span>
            </div>
            <div className="list rise">
              {jobs.map((j) => (
                <button key={j.id} className="row focus-row" onClick={() => onOpen(j.suiteId, j.id)}
                  style={{ width: '100%', textAlign: 'left', background: 'none', border: 'none',
                    cursor: 'pointer', padding: '11px 14px' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="row-t">{hostOf(j.targetUrl)}</div>
                    <div className="row-s">{outcomeOf(j)}</div>
                  </div>
                  <div className="hide-md" style={{ width: 110, flex: 'none', fontSize: 12, color: 'var(--text-2)',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {j.suiteName}
                  </div>
                  <div style={{ width: 92, flex: 'none' }}>
                    <span className="badge" style={{ color: STATUS_TONE[j.status] ?? 'var(--text-2)', fontSize: 10 }}>
                      {STATUS_LABEL[j.status] ?? j.status.toUpperCase()}
                    </span>
                  </div>
                  <div className="num hide-md" style={{ width: 78, flex: 'none', textAlign: 'right', fontSize: 12,
                    color: 'var(--accent)' }}>
                    {j.report?.tokenUsage?.total ? fmt.k(j.report.tokenUsage.total) : '—'}
                  </div>
                  <div className="num" style={{ width: 76, flex: 'none', textAlign: 'right', fontSize: 11,
                    color: 'var(--text-2)' }}>
                    {relTime(j.createdAt)}
                  </div>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </>
  );
}
