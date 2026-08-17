'use client';
/* Every Test Writer job the workspace has in flight, watched at app level.

   The PROGRESS face tells the user "you can leave — this keeps running, we'll
   flag the sidebar and the tab title when it's your turn." That sentence is a
   promise, and until this hook existed the product did not keep it: there was a
   banner on the tests screen and nothing else. A notification that never
   arrives is worse than none, because the user waits for it.

   Nothing lives only in memory — the whole picture is re-derived from the API on
   mount, so a reload, or a walk away and back, still finds the plan waiting.
   Spec: docs/specs/tests-ux/spec-testwriter-ux.md §6.1, §6.2, §11.6-b */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { GenerationJobStatus } from '@/types/api';

/** Poll while work is moving; back off to a liveness check for a job that can
 *  only change when a human acts, possibly in another tab. */
const WORKING_MS = 4000;
const WAITING_MS = 10000;

const LIVE: GenerationJobStatus[] = ['queued', 'running', 'awaiting_plan_approval'];
const TERMINAL: GenerationJobStatus[] = ['completed', 'failed', 'blocked'];

export type WatchedJob = {
  jobId: string;
  suiteId: string;
  suiteName: string;
  status: GenerationJobStatus;
  /** Proposed drafts, for the delivery banner's count. */
  count: number;
  pagesCrawled: number | null;
};

/** The one job the tests screen offers a way back into. */
export type PendingDelivery = {
  jobId: string; suiteId: string; status: string; count: number; pagesCrawled?: number | null;
};

type Notify = (message: string, kind: string, onClick?: () => void) => void;

/** Its own turn of phrase per transition — a generic "job updated" would make
 *  the one moment the user is actually needed indistinguishable from noise. */
function transitionToast(job: WatchedJob): { message: string; kind: string } | null {
  switch (job.status) {
    case 'awaiting_plan_approval':
      return { message: `Test plan ready for ${job.suiteName} — Kaizen is waiting for you`, kind: 'info' };
    case 'completed':
      return job.count > 0
        ? { message: `${job.count} ${job.count === 1 ? 'test' : 'tests'} proposed for ${job.suiteName}`, kind: 'success' }
        : { message: `Kaizen finished on ${job.suiteName} — no tests this time, but it left notes`, kind: 'info' };
    case 'failed':
      return { message: `The analysis of ${job.suiteName} stopped early`, kind: 'error' };
    case 'blocked':
      return { message: `Kaizen couldn’t explore ${job.suiteName}`, kind: 'error' };
    default:
      return null;
  }
}

/** The away-tab channel. No notification permission, works everywhere, and it is
 *  the only signal that reaches a user who has switched to another tab. */
function titleFor(jobs: WatchedJob[]): string | null {
  if (jobs.some((j) => j.status === 'awaiting_plan_approval')) return '● Plan ready — Kaizen';
  if (jobs.some((j) => j.status === 'running' || j.status === 'queued')) return '◔ Exploring… — Kaizen';
  return null;
}

export function useActiveGenerationJobs(
  suites: Array<{ id: string; name: string }>,
  notify?: Notify,
  onOpenJob?: (suiteId: string, jobId: string) => void,
) {
  const [pendingDelivery, setPendingDelivery] = useState<PendingDelivery | null>(null);
  const [watched, setWatched] = useState<WatchedJob[]>([]);

  /* Last status seen per job. A toast fires on CHANGE only: without this, every
     mount would re-announce a plan the user approved yesterday, and the alert
     that means "you are needed now" would become the one they learned to ignore. */
  const lastStatus = useRef<Map<string, GenerationJobStatus>>(new Map());
  const seeded = useRef(false);
  const notifyRef = useRef(notify);
  const openRef = useRef(onOpenJob);
  notifyRef.current = notify;
  openRef.current = onOpenJob;

  // Suites arrive as a fresh array on every refetch, so depend on their identity
  // rather than the array's — otherwise the scan restarts on unrelated renders.
  const suiteKey = suites.map((s) => `${s.id}:${s.name}`).join('|');

  const scan = useCallback(async () => {
    const list = suiteKey ? suiteKey.split('|').map((entry) => {
      const at = entry.indexOf(':');
      return { id: entry.slice(0, at), name: entry.slice(at + 1) };
    }) : [];
    if (list.length === 0) { setPendingDelivery(null); setWatched([]); return; }
    try {
      const results = await Promise.all(list.map(async (s) => {
        const r = await fetch(`/api/proxy/suites/${s.id}/jobs`);
        if (!r.ok) return null;
        const { jobs } = await r.json();
        const latest = (jobs ?? [])[0];
        if (!latest) return null;
        return {
          jobId: latest.id,
          suiteId: s.id,
          suiteName: s.name,
          status: latest.status as GenerationJobStatus,
          count: latest.report?.validate?.proposed ?? 0,
          pagesCrawled: latest.report?.progress?.pagesCrawled ?? null,
        } satisfies WatchedJob;
      }));
      const jobs = results.filter(Boolean) as WatchedJob[];
      setWatched(jobs);

      // Ranked by what most needs the user: a plan blocking on approval, then a
      // job still working (which must stay reachable — leaving the writer screen
      // used to strand it with no way back), then a finished delivery.
      const waiting = jobs.find((j) => j.status === 'awaiting_plan_approval');
      const working = jobs.find((j) => j.status === 'running' || j.status === 'queued');
      const delivered = jobs.find((j) => j.status === 'completed' && j.count > 0);
      // A job that proposed NOTHING still has to be reachable: its report is
      // where the reasons live, and "0 tests, no way to see why" is the worst
      // possible outcome to hide.
      const finished = jobs.find((j) => TERMINAL.includes(j.status));
      const winner = waiting ?? working ?? delivered ?? finished ?? null;
      setPendingDelivery(winner ? {
        jobId: winner.jobId, suiteId: winner.suiteId, status: winner.status,
        count: winner.count, pagesCrawled: winner.pagesCrawled,
      } : null);

      // First scan of a session records where everything stands, silently. Only
      // what changes afterwards is news.
      for (const job of jobs) {
        const previous = lastStatus.current.get(job.jobId);
        lastStatus.current.set(job.jobId, job.status);
        if (!seeded.current || previous === undefined || previous === job.status) continue;
        const toast = transitionToast(job);
        if (toast) {
          notifyRef.current?.(toast.message, toast.kind,
            () => openRef.current?.(job.suiteId, job.jobId));
        }
      }
      seeded.current = true;
    } catch { /* the banner is a convenience; its absence must not break the list */ }
  }, [suiteKey]);

  useEffect(() => { void scan(); }, [scan]);

  /* Poll only while something can still change, and at the pace it changes: a
     job doing work moves every few seconds, a job waiting on a human does not.
     An idle workspace makes no requests at all. */
  const working = watched.some((j) => j.status === 'running' || j.status === 'queued');
  const waiting = watched.some((j) => j.status === 'awaiting_plan_approval');
  useEffect(() => {
    if (!working && !waiting) return;
    const id = setInterval(scan, working ? WORKING_MS : WAITING_MS);
    return () => clearInterval(id);
  }, [working, waiting, scan]);

  /* The tab title. Restored in cleanup, or a user who walks away from a finished
     job keeps a stale "Exploring…" in their tab strip forever. */
  const baseTitle = useRef<string | null>(null);
  const live = watched.filter((j) => LIVE.includes(j.status));
  const title = titleFor(live);
  useEffect(() => {
    if (typeof document === 'undefined') return;
    if (baseTitle.current === null) baseTitle.current = document.title;
    document.title = title ?? baseTitle.current;
    return () => {
      if (baseTitle.current !== null) document.title = baseTitle.current;
    };
  }, [title]);

  return { pendingDelivery, activeJobs: live, refresh: scan };
}
