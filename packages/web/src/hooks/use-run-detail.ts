import { useState, useEffect } from 'react';
import type { RunDetail, StepResult } from '@/types/api';

export function useRunDetail(runId: string | null | undefined) {
  const [data, setData] = useState<RunDetail | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!runId) {
      setData(null);
      return;
    }

    const fetchDetail = async () => {
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
            status: sr.status,
            screenshotKey: sr.screenshot_key || null,
            durationMs: sr.duration_ms || null,
            tokens: sr.tokens || 0,
            errorType: sr.error_type || null,
            failureClass: sr.failure_class || null,
            resolutionSource: sr.resolution_source || null,
            createdAt: sr.created_at,
          })),
        };

        setData(mappedRun);
      } catch (err) {
        setError(err instanceof Error ? err : new Error('Unknown error'));
      } finally {
        setIsLoading(false);
      }
    };

    fetchDetail();
  }, [runId]);

  return { data, isLoading, error };
}
