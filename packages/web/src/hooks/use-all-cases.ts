'use client';

import { useEffect, useState } from 'react';
import type { CaseSummary, Suite } from '@/types/api';
import { useAuth } from '@/context/auth-context';

type CasesBySuite = Record<string, CaseSummary[]>;

type UseAllCasesResult = {
  bySuite: CasesBySuite;
  all: CaseSummary[];
  isLoading: boolean;
};

/**
 * Fetches all cases for every suite in parallel and returns:
 *  - bySuite: a map of suiteId → cases
 *  - all: a flat list of every case across all suites
 *
 * Used by the tests dashboard to compute aggregate stats (pass rate, totals,
 * median duration) from a single source instead of polling per-suite.
 */
export function useAllCases(suites: Suite[]): UseAllCasesResult {
  const { user } = useAuth();
  const [bySuite, setBySuite] = useState<CasesBySuite>({});
  const [isLoading, setLoading] = useState(true);

  useEffect(() => {
    if (!user?.id || suites.length === 0) {
      setBySuite({});
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);

    Promise.all(
      suites.map(async (s) => {
        try {
          const res = await fetch(`/api/proxy/suites/${s.id}/cases`, { cache: 'no-store' });
          if (!res.ok) return [s.id, [] as CaseSummary[]] as const;
          const data = await res.json();
          return [s.id, (data.cases ?? []) as CaseSummary[]] as const;
        } catch {
          return [s.id, [] as CaseSummary[]] as const;
        }
      }),
    ).then((entries) => {
      if (cancelled) return;
      const next: CasesBySuite = {};
      for (const [id, cases] of entries) next[id] = cases;
      setBySuite(next);
      setLoading(false);
    });

    return () => { cancelled = true; };
  }, [suites, user?.id]);

  const all = Object.values(bySuite).flat();
  return { bySuite, all, isLoading };
}
