'use client';

import { useCallback, useEffect, useState } from 'react';
import type { CaseSummary } from '@/types/api';
import { useAuth } from '@/context/auth-context';

type UseCasesResult = {
  cases: CaseSummary[];
  isLoading: boolean;
  error: string | null;
  refetch: () => void;
};

export function useCases(suiteId: string | null): UseCasesResult {
  const { user } = useAuth();
  const [cases, setCases]       = useState<CaseSummary[]>([]);
  const [isLoading, setLoading] = useState(false);
  const [error, setError]       = useState<string | null>(null);
  const [tick, setTick]         = useState(0);

  const refetch = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    if (!suiteId) {
      setCases([]);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    fetch(`/api/proxy/suites/${suiteId}/cases`, { cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) throw new Error(`Failed to load cases (${res.status})`);
        const data = await res.json();
        if (!cancelled) setCases(data.cases ?? []);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message ?? 'Failed to load cases');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [suiteId, tick, user?.id]);

  return { cases, isLoading, error, refetch };
}
