import { Suspense } from 'react';
import { AuthShell } from '@/components/organisms/auth-shell';
import { LoginForm } from '@/components/organisms/login-form';

export default function LoginPage() {
  return (
    <AuthShell>
      <Suspense fallback={null}>
        <LoginForm />
      </Suspense>
    </AuthShell>
  );
}
