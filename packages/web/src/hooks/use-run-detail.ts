import { useState, useEffect, useCallback, useRef } from 'react';
import type { RunDetail, StepResult } from '@/types/api';
import { TERMINAL_RUN_STATUSES } from '@/types/api';

const LIVE_POLL_INTERVAL_MS = 2000;

export function useRunDetail(runId: string | null | undefined) {
  const [data, setData] = useState<RunDetail | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [tick, setTick] = useState(0);
  // Single-flight guard: if a fetch is already in flight when the live-poll
  // interval fires, skip — don't queue. Prevents stacking when the API
  // takes longer than the interval.
  const inFlightRef = useRef(false);

  const refetch = useCallback(() => {
    setTick((t) => t + 1);
  }, []);

  useEffect(() => {
    if (!runId) {
      setData(null);
      return;
    }

    const fetchDetail = async () => {
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      setIsLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/proxy/runs/${runId}`);
        if (!res.ok) throw new Error('Failed to fetch run details');
        const raw = await res.json();

        // Map raw snake_case to camelCase StepResult
        const mappedRun: RunDetail = {
          id: raw.id,
          caseId: raw.case_id,
          caseName: raw.case_name || null,
          suiteId: raw.suite_id || null,
          suiteName: raw.suite_name || null,
          status: raw.status,
          triggeredBy: raw.triggered_by,
          createdAt: raw.created_at,
          completedAt: raw.completed_at,
          durationMs: raw.duration_ms || null,
          totalTokens: raw.total_tokens || null,
          stepResults: (raw.stepResults || []).map((sr: any): StepResult => ({
            id: sr.id,
            stepId: sr.step_id,
            rawText: sr.rawText ?? sr.step_raw_text ?? null,
            status: sr.status,
            screenshotKey: sr.screenshot_key || null,
            durationMs: sr.duration_ms || null,
            tokens: sr.tokens || 0,
            errorType: sr.error_type || null,
            failureClass: sr.failure_class || null,
            resolutionSource: sr.resolution_source || null,
            selectorUsed: sr.selector_used || null,
            createdAt: sr.created_at,
            domCandidates: sr.dom_candidates || null,
            llmPickedKaizenId: sr.llm_picked_kaizen_id || null,
            userVerdict: sr.user_verdict || null,
            capturedName: sr.captured_name || null,
            capturedValue: sr.captured_value || null,
          })),
        };

        setData(mappedRun);
      } catch (err) {
        setError(err instanceof Error ? err : new Error('Unknown error'));
      } finally {
        setIsLoading(false);
        inFlightRef.current = false;
      }
    };

    fetchDetail();
  }, [runId, tick]);

  // Live polling: while the loaded run is in a non-terminal status, refetch
  // every LIVE_POLL_INTERVAL_MS so the timeline / inspector list / summary
  // strip update as the worker writes step_results rows.
  //
  // - Skips when the document tab is hidden (no point polling in background).
  // - Stops automatically when the run reaches a terminal status.
  //
  // Spec: docs/specs/workers/spec-live-run-updates.md §5.2.
  useEffect(() => {
    const status = data?.status;
    if (!runId || !status) return;
    if (TERMINAL_RUN_STATUSES.includes(status)) return;

    const interval = window.setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      setTick((t) => t + 1);
    }, LIVE_POLL_INTERVAL_MS);

    return () => window.clearInterval(interval);
  }, [runId, data?.status]);

  return { data, isLoading, error, refetch };
}
