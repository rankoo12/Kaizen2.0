'use client';

import { useRouter } from 'next/navigation';
import { NavBar } from '@/components/molecules/nav-bar';
import { WelcomeHero } from '@/components/organisms/welcome-hero';

export default function WelcomePage() {
  const router = useRouter();

  return (
    <div className="bg-welcome-bg min-h-screen flex flex-col overflow-hidden relative">
      <NavBar links={[{ label: 'Dashboard', href: '#', active: true }]} />
      <WelcomeHero
        onLogin={() => router.push('/login')}
        onSignUp={() => router.push('/signup')}
      />
    </div>
  );
}
