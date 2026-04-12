'use client';

import { useParams } from 'next/navigation';
import { Settings } from 'lucide-react';
import { NavBar } from '@/components/molecules/nav-bar';
import { ProfileDropdown } from '@/components/molecules/profile-dropdown';
import { TestOverviewPanel } from '@/components/organisms/test-overview-panel';

export default function TestOverviewPage() {
  const params = useParams();
  const id = params.id as string;

  return (
    <div className="bg-app-bg min-h-screen flex flex-col">
      <div className="flex-1 flex flex-col bg-[#110c14] overflow-y-auto">
        <TestOverviewPanel caseId={id} />
      </div>
    </div>
  );
}
