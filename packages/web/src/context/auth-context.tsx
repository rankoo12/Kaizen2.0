'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from 'react';
import { useRouter } from 'next/navigation';

// ─── Types ────────────────────────────────────────────────────────────────────

export type AuthUser = {
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  tenantId: string;
};

type AuthContextValue = {
  user: AuthUser | null;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, displayName?: string) => Promise<void>;
  logout: () => Promise<void>;
};

// ─── Context ──────────────────────────────────────────────────────────────────

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

// ─── Provider ─────────────────────────────────────────────────────────────────

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [user, setUser]         = useState<AuthUser | null>(null);
  const [isLoading, setLoading] = useState(true);

  // Hydrate auth state on mount by checking the session cookie via /api/auth/me
  useEffect(() => {
    fetch('/api/auth/me')
      .then(async (res) => {
        if (res.ok) {
          const { user: u, tenantId } = await res.json();
          setUser({ ...u, tenantId });
        }
      })
      .catch(() => {
        // Network error — treat as unauthenticated
      })
      .finally(() => setLoading(false));
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) throw new Error('Invalid email or password');
      throw new Error(data.message ?? 'Something went wrong. Please try again.');
    }

    const { user: u, tenantId } = await res.json();
    setUser({ ...u, tenantId });
  }, []);

  const register = useCallback(
    async (email: string, password: string, displayName?: string) => {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, displayName }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        if (res.status === 409) {
          throw new Error('An account with this email already exists');
        }
        if (res.status === 400) {
          throw new Error('Please check your details and try again');
        }
        throw new Error(data.message ?? 'Something went wrong. Please try again.');
      }

      const { user: u, tenantId } = await res.json();
      setUser({ ...u, tenantId });
    },
    [],
  );

  const logout = useCallback(async () => {
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
    setUser(null);
    router.push('/login');
  }, [router]);

  return (
    <AuthContext.Provider value={{ user, isLoading, login, register, logout }}>
      {children}
    </AuthContext.Provider>
  );
}
