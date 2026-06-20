'use client';

import { useParams } from 'next/navigation';
import { RunReport } from '@/components/organisms/run-report';

export default function RunReportPage() {
  const params = useParams();
  const caseId = params.id as string;
  const runId = params.runId as string;

  return <RunReport caseId={caseId} runId={runId} />;
}
