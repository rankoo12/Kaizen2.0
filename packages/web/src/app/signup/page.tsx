import { Suspense } from 'react';
import { AuthScreen } from '@/components/design/screen-auth';

export default function SignupPage() {
  return (
    <Suspense fallback={null}>
      <AuthScreen mode="signup" />
    </Suspense>
  );
}
