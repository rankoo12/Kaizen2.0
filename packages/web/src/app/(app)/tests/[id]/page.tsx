'use client';

import { useParams } from 'next/navigation';
import { TestDetailScreen } from '@/components/organisms/test-detail-screen';

export default function TestDetailPage() {
  const params = useParams();
  const id = params.id as string;

  return <TestDetailScreen caseId={id} />;
}
