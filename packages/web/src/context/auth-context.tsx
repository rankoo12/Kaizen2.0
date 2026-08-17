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
  /** Membership role in the current tenant, from the access token's claims.
   *  Presentation only — it decides what a control explains, never what the
   *  API permits. Null when the token predates this field or could not be read. */
  role: MembershipRole | null;
};

/** Mirrors the API's membership roles. */
export type MembershipRole = 'owner' | 'admin' | 'member' | 'viewer';

/** Grants Kaizen treats as administrative — signed-in exploration among them.
 *  Written as a positive list rather than a rank comparison, matching the API:
 *  a rank check would admit an unknown or missing role by accident. */
export function isWorkspaceAdmin(role: MembershipRole | null | undefined): boolean {
  return role === 'admin' || role === 'owner';
}

type AuthContextValue = {
  user: AuthUser | null;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<void>;
  /** Sign in as the shared demo account. Takes no credentials on purpose — the server
   *  route holds them, so the demo password is never in the client bundle. */
  loginAsDemo: () => Promise<void>;
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
          const { user: u, tenantId, role } = await res.json();
          setUser({ ...u, tenantId, role: role ?? null });
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

    const { user: u, tenantId, role } = await res.json();
    setUser({ ...u, tenantId, role: role ?? null });
  }, []);

  const loginAsDemo = useCallback(async () => {
    // No body: the server route supplies the credentials.
    const res = await fetch('/api/auth/demo', { method: 'POST' });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      // 404 = deliberately switched off for this deployment; 401 = the account is
      // missing or its password changed. Different causes, different fixes, so they
      // must not collapse into one message.
      if (res.status === 404) throw new Error('Demo access is turned off on this deployment');
      if (res.status === 401) throw new Error('The demo account is unavailable right now');
      throw new Error(data.message ?? 'Could not open the demo. Please try again.');
    }

    const { user: u, tenantId, role } = await res.json();
    setUser({ ...u, tenantId, role: role ?? null });
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

      const { user: u, tenantId, role } = await res.json();
      setUser({ ...u, tenantId, role: role ?? null });
    },
    [],
  );

  const logout = useCallback(async () => {
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
    setUser(null);
    router.push('/login');
  }, [router]);

  return (
    <AuthContext.Provider value={{ user, isLoading, login, loginAsDemo, register, logout }}>
      {children}
    </AuthContext.Provider>
  );
}
