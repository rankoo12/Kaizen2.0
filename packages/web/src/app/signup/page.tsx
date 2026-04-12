'use client';

import { useRouter } from 'next/navigation';
import { Bell, Settings } from 'lucide-react';
import { NavBar } from '@/components/molecules/nav-bar';
import { SignupForm } from '@/components/organisms/signup-form';

export default function SignupPage() {
  const router = useRouter();

  return (
    <div className="bg-app-bg min-h-screen flex flex-col">
      <NavBar
        links={[{ label: 'Dashboard', href: '#', active: true }]}
        bordered
        rightSlot={
          <>
            <button className="hover:text-white transition-colors" aria-label="Notifications">
              <Bell className="w-5 h-5" />
            </button>
            <button className="hover:text-white transition-colors" aria-label="Settings">
              <Settings className="w-5 h-5" />
            </button>
          </>
        }
      />
      <main className="flex-1 flex items-center justify-center p-4">
        <SignupForm
          onLogin={() => router.push('/login')}
          onGoogle={() => {}}
          onFacebook={() => {}}
        />
      </main>
    </div>
  );
}
