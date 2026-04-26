import { AuthShell } from '@/components/organisms/auth-shell';
import { SignupForm } from '@/components/organisms/signup-form';

export default function SignupPage() {
  return (
    <AuthShell>
      <SignupForm />
    </AuthShell>
  );
}
