'use client';

import { AuthProvider } from '@/context/auth-context';

export function Providers({ children }: { children: React.ReactNode }) {
  return <AuthProvider>{children}</AuthProvider>;
}
