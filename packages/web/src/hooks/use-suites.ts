'use client';

import { useCallback, useEffect, useState } from 'react';
import type { Suite } from '@/types/api';

type UseSuitesResult = {
  suites: Suite[];
  isLoading: boolean;
  error: string | null;
  refetch: () => void;
};

export function useSuites(): UseSuitesResult {
  const [suites, setSuites]     = useState<Suite[]>([]);
  const [isLoading, setLoading] = useState(true);
  const [error, setError]       = useState<string | null>(null);
  const [tick, setTick]         = useState(0);

  const refetch = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    fetch('/api/proxy/suites')
      .then(async (res) => {
        if (!res.ok) throw new Error(`Failed to load suites (${res.status})`);
        const data = await res.json();
        if (!cancelled) setSuites(data.suites ?? []);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message ?? 'Failed to load suites');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [tick]);

  return { suites, isLoading, error, refetch };
}
