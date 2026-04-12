'use client';

import { useCallback, useEffect, useRef } from 'react';
import type { RunStatus } from '@/types/api';
import { TERMINAL_RUN_STATUSES } from '@/types/api';

const POLL_INTERVAL_MS = 1500;

type PollResult = {
  id: string;
  status: RunStatus;
  completedAt: string | null;
};

type UseRunPollerOptions = {
  runId: string | null;
  onComplete: (result: PollResult) => void;
};

/**
 * Polls GET /api/proxy/runs/:runId every 1500ms until the run reaches a
 * terminal status (passed | failed | healed | cancelled).
 * Calls onComplete with the final run object.
 * Stops automatically when unmounted or when runId becomes null.
 */
export function useRunPoller({ runId, onComplete }: UseRunPollerOptions): void {
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  useEffect(() => {
    if (!runId) return;

    let stopped = false;
    let timerId: ReturnType<typeof setTimeout>;

    async function poll() {
      if (stopped) return;

      try {
        const res = await fetch(`/api/proxy/runs/${runId}`);
        if (!res.ok) return; // transient error — retry next tick

        const run: PollResult = await res.json();

        if (TERMINAL_RUN_STATUSES.includes(run.status)) {
          stopped = true;
          onCompleteRef.current(run);
          return;
        }
      } catch {
        // Network error — retry next tick
      }

      if (!stopped) {
        timerId = setTimeout(poll, POLL_INTERVAL_MS);
      }
    }

    timerId = setTimeout(poll, POLL_INTERVAL_MS);
    return () => {
      stopped = true;
      clearTimeout(timerId);
    };
  }, [runId]);
}
