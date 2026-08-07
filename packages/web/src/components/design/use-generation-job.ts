'use client';
/* Polls one Test Writer job. Cadence follows the run poller (2s while work is in
   flight); a job parked at the approval checkpoint changes only when a human acts,
   so it drops to a cheap liveness poll. Terminal jobs stop polling entirely — an
   idle workspace makes no requests. */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { GenerationJob, GenerationJobStatus } from '@/types/api';

const ACTIVE_MS = 2000;
const WAITING_MS = 10000;

const TERMINAL: GenerationJobStatus[] = ['completed', 'failed', 'blocked'];
export const isTerminal = (s?: GenerationJobStatus): boolean => !!s && TERMINAL.includes(s);

export function useGenerationJob(
  jobId: string | null,
  onTransition?: (next: GenerationJob, previous: GenerationJobStatus | null) => void,
) {
  const [job, setJob] = useState<GenerationJob | null>(null);
  const [isLoading, setLoading] = useState(!!jobId);
  const [error, setError] = useState<string | null>(null);
  const previousStatus = useRef<GenerationJobStatus | null>(null);
  const transitionRef = useRef(onTransition);
  transitionRef.current = onTransition;

  const fetchJob = useCallback(async () => {
    if (!jobId) return;
    try {
      const r = await fetch(`/api/proxy/testwriter/jobs/${jobId}`);
      if (r.status === 404) { setError('gone'); setLoading(false); return; }
      if (!r.ok) throw new Error(String(r.status));
      const { job: next } = (await r.json()) as { job: GenerationJob };
      setJob(next);
      setError(null);
      if (previousStatus.current !== next.status) {
        transitionRef.current?.(next, previousStatus.current);
        previousStatus.current = next.status;
      }
    } catch {
      setError('unreachable');
    } finally {
      setLoading(false);
    }
  }, [jobId]);

  useEffect(() => {
    previousStatus.current = null;
    setJob(null);
    setLoading(!!jobId);
    if (jobId) void fetchJob();
  }, [jobId, fetchJob]);

  useEffect(() => {
    if (!jobId || !job || isTerminal(job.status)) return;
    const interval = job.status === 'awaiting_plan_approval' ? WAITING_MS : ACTIVE_MS;
    const id = setInterval(fetchJob, interval);
    return () => clearInterval(id);
  }, [jobId, job, fetchJob]);

  return { job, isLoading, error, refetch: fetchJob };
}

/** A suite's job history — newest first. The audit surface; nothing is ever removed. */
export function useSuiteJobs(suiteId: string | null) {
  const [jobs, setJobs] = useState<GenerationJob[]>([]);

  const fetchJobs = useCallback(async () => {
    if (!suiteId) { setJobs([]); return; }
    try {
      const r = await fetch(`/api/proxy/suites/${suiteId}/jobs`);
      if (!r.ok) return;
      const { jobs: list } = (await r.json()) as { jobs: GenerationJob[] };
      setJobs(list ?? []);
    } catch { /* history is supporting detail; its absence must not break the screen */ }
  }, [suiteId]);

  useEffect(() => { void fetchJobs(); }, [fetchJobs]);

  return { jobs, refetch: fetchJobs };
}
