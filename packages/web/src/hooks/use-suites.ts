'use client';

import { useCallback, useEffect, useState } from 'react';
import type { Suite } from '@/types/api';
import { useAuth } from '@/context/auth-context';

type UseSuitesResult = {
  suites: Suite[];
  isLoading: boolean;
  error: string | null;
  refetch: () => void;
};

export function useSuites(): UseSuitesResult {
  const { user } = useAuth();
  const [suites, setSuites]     = useState<Suite[]>([]);
  const [isLoading, setLoading] = useState(true);
  const [error, setError]       = useState<string | null>(null);
  const [tick, setTick]         = useState(0);

  const refetch = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    if (!user?.id) {
      setSuites([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);

    fetch('/api/proxy/suites', { cache: 'no-store' })
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
  }, [tick, user?.id]);

  return { suites, isLoading, error, refetch };
}
