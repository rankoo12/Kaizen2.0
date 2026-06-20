import { useState, useEffect } from 'react';

export type RunLogEntry = {
  seq: number;
  stepIndex: number | null;
  level: 'debug' | 'info' | 'warn' | 'error';
  phase: 'run' | 'resolve' | 'execute' | 'assert' | 'llm' | 'heal' | 'capture';
  message: string;
  data: Record<string, unknown> | null;
  at: string;
};

export type RunReport = {
  run: {
    id: string;
    status: string;
    environmentUrl: string | null;
    triggeredBy: string | null;
    createdAt: string;
    startedAt: string | null;
    completedAt: string | null;
  };
  log: RunLogEntry[];
  llmSummary: {
    totalTokens: number;
    llmResolvedSteps: number;
    cacheResolvedSteps: number;
    steps: { rawText: string | null; tokens: number; candidateCount: number; chosen: { role: string; name: string } | null }[];
  };
};

export function useRunReport(runId: string | null | undefined) {
  const [data, setData] = useState<RunReport | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!runId) { setData(null); return; }
    let cancelled = false;
    (async () => {
      setIsLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/proxy/runs/${runId}/report`);
        if (!res.ok) throw new Error('Failed to fetch run report');
        const json = (await res.json()) as RunReport;
        if (!cancelled) setData(json);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err : new Error('Unknown error'));
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [runId]);

  return { data, isLoading, error };
}
