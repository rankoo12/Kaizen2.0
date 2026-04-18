'use client';

import { useRouter } from 'next/navigation';
import { WelcomeHero } from '@/components/organisms/welcome-hero';

export default function WelcomePage() {
  const router = useRouter();

  return (
    <div className="bg-welcome-bg h-screen w-full flex flex-col overflow-hidden relative m-0 p-0 font-sans text-white">
      <WelcomeHero
        onLogin={() => router.push('/login')}
        onSignUp={() => router.push('/signup')}
      />
    </div>
  );
}
