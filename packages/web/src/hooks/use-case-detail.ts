import { useState, useEffect, useCallback } from 'react';
import type { CaseDetail } from '@/types/api';

export function useCaseDetail(caseId: string) {
  const [data, setData] = useState<CaseDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const fetchDetail = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await fetch(`/api/proxy/cases/${caseId}`);
      if (!res.ok) throw new Error('Failed to fetch case details');
      const json = await res.json();
      setData(json.case);
    } catch (err: any) {
      setError(err);
    } finally {
      setIsLoading(false);
    }
  }, [caseId]);

  useEffect(() => {
    if (caseId) fetchDetail();
  }, [caseId, fetchDetail]);

  return { data, isLoading, error, refetch: fetchDetail };
}
