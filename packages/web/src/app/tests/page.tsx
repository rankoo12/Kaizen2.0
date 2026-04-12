'use client';

import { Settings } from 'lucide-react';
import { NavBar } from '@/components/molecules/nav-bar';
import { ProfileDropdown } from '@/components/molecules/profile-dropdown';
import { TestsPanel } from '@/components/organisms/tests-panel';

export default function TestsPage() {
  return (
    <div className="bg-app-bg min-h-screen flex flex-col">
      <NavBar
        sticky
        bordered
        subtitle="Analysis Engine"
        rightSlot={
          <>
            <button
              type="button"
              className="text-gray-400 hover:text-white transition-colors"
              aria-label="Settings"
            >
              <Settings className="w-5 h-5" />
            </button>
            <ProfileDropdown />
          </>
        }
      />
      <TestsPanel />
    </div>
  );
}
