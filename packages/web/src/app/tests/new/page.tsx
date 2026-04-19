'use client';

import { useRouter } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { NavBar } from '@/components/molecules/nav-bar';
import { ProfileDropdown } from '@/components/molecules/profile-dropdown';
import { ThemeSwitcher } from '@/components/molecules/theme-switcher';
import { MusicPlayerToggle } from '@/components/atoms/music-player-toggle';
import { NewTestPanel } from '@/components/organisms/new-test-panel';

export default function NewTestPage() {
  const router = useRouter();

  return (
    <div className="bg-app-bg min-h-screen flex flex-col">
      <NavBar
        sticky
        bordered
        rightSlot={
          <>
            <button
              onClick={() => router.back()}
              className="flex items-center space-x-2 text-brand-pink/80 hover:text-brand-pink transition-colors bg-card-bg px-4 py-2 rounded-lg border border-border-subtle"
            >
              <ArrowLeft className="w-4 h-4" />
              <span className="text-xs font-bold uppercase tracking-wider">Back to Suite</span>
            </button>
            <MusicPlayerToggle />
            <ThemeSwitcher />
            <ProfileDropdown />
          </>
        }
      />
      <NewTestPanel />
    </div>
  );
}
