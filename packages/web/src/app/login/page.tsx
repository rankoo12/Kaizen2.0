import { Suspense } from 'react';
import { NavBar } from '@/components/molecules/nav-bar';
import { LoginForm } from '@/components/organisms/login-form';

export default function LoginPage() {
  return (
    <div className="bg-app-bg min-h-screen flex flex-col">
      <NavBar bordered />
      <main className="flex-1 flex items-center justify-center p-4">
        <Suspense fallback={null}>
          <LoginForm />
        </Suspense>
      </main>
    </div>
  );
}
