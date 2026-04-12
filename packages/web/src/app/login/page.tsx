'use client';

import { useRouter } from 'next/navigation';
import { Bell, Settings } from 'lucide-react';
import { NavBar } from '@/components/molecules/nav-bar';
import { LoginForm } from '@/components/organisms/login-form';

export default function LoginPage() {
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
        <LoginForm
          onSignUp={() => router.push('/signup')}
          onForgotPassword={() => {}}
          onGoogle={() => {}}
          onFacebook={() => {}}
        />
      </main>
    </div>
  );
}
