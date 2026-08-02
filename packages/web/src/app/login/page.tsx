import { Suspense } from 'react';
import { AuthScreen } from '@/components/design/screen-auth';

/* The design owns its own auth layout (centred card on the window ground), so the old
 * AuthShell wrapper is gone along with the pre-redesign form components. */
export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <AuthScreen mode="login" />
    </Suspense>
  );
}
