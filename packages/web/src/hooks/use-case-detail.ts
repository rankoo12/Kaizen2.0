import { useState, useEffect, useCallback } from 'react';
import type { CaseDetail } from '@/types/api';
import { useAuth } from '@/context/auth-context';

export function useCaseDetail(caseId: string) {
  const { user } = useAuth();
  const [data, setData] = useState<CaseDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const fetchDetail = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await fetch(`/api/proxy/cases/${caseId}`, { cache: 'no-store' });
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
    if (!user?.id || !caseId) {
      setData(null);
      setIsLoading(false);
      return;
    }
    fetchDetail();
  }, [caseId, fetchDetail, user?.id]);

  return { data, isLoading, error, refetch: fetchDetail };
}
