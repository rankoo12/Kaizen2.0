import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  ACCESS_COOKIE_OPTIONS,
  REFRESH_COOKIE_OPTIONS,
} from '@/lib/cookies';

const API_URL = process.env.KAIZEN_API_URL ?? 'http://localhost:3000';

async function tryRefresh(refreshToken: string): Promise<{
  accessToken: string;
  refreshToken: string;
} | null> {
  const res = await fetch(`${API_URL}/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  });
  if (!res.ok) return null;
  return res.json();
}

export async function GET() {
  const cookieStore = await cookies();
  const accessToken  = cookieStore.get(ACCESS_COOKIE)?.value;
  const refreshToken = cookieStore.get(REFRESH_COOKIE)?.value;

  if (!accessToken && !refreshToken) {
    return NextResponse.json({ error: 'UNAUTHENTICATED' }, { status: 401 });
  }

  // Try the current access token first
  if (accessToken) {
    const meRes = await fetch(`${API_URL}/users/me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (meRes.ok) {
      const { user } = await meRes.json();
      // Extract tenantId from the JWT claims embedded in the access token payload
      // (We decode the middle segment — no signature verification needed here,
      //  the backend already validated the token)
      let tenantId: string | null = null;
      try {
        const payload = JSON.parse(
          Buffer.from(accessToken.split('.')[1], 'base64url').toString('utf8'),
        );
        tenantId = payload.tenantId ?? null;
      } catch {
        // Non-fatal — tenantId just won't be available
      }
      return NextResponse.json({ user, tenantId });
    }

    // 401 from /users/me — access token is expired, fall through to refresh
    if (meRes.status !== 401) {
      return NextResponse.json({ error: 'UNAUTHENTICATED' }, { status: 401 });
    }
  }

  // Attempt refresh
  if (!refreshToken) {
    cookieStore.set(ACCESS_COOKIE, '', { maxAge: 0, path: '/' });
    return NextResponse.json({ error: 'UNAUTHENTICATED' }, { status: 401 });
  }

  const newTokens = await tryRefresh(refreshToken);
  if (!newTokens) {
    // Refresh failed — clear both cookies and force re-login
    cookieStore.set(ACCESS_COOKIE,  '', { maxAge: 0, path: '/' });
    cookieStore.set(REFRESH_COOKIE, '', { maxAge: 0, path: '/' });
    return NextResponse.json({ error: 'UNAUTHENTICATED' }, { status: 401 });
  }

  // Refresh succeeded — update cookies and retry
  cookieStore.set(ACCESS_COOKIE,  newTokens.accessToken,  ACCESS_COOKIE_OPTIONS);
  cookieStore.set(REFRESH_COOKIE, newTokens.refreshToken, REFRESH_COOKIE_OPTIONS);

  const meRes = await fetch(`${API_URL}/users/me`, {
    headers: { Authorization: `Bearer ${newTokens.accessToken}` },
  });

  if (!meRes.ok) {
    return NextResponse.json({ error: 'UNAUTHENTICATED' }, { status: 401 });
  }

  const { user } = await meRes.json();
  let tenantId: string | null = null;
  try {
    const payload = JSON.parse(
      Buffer.from(newTokens.accessToken.split('.')[1], 'base64url').toString('utf8'),
    );
    tenantId = payload.tenantId ?? null;
  } catch {
    // Non-fatal
  }
  return NextResponse.json({ user, tenantId });
}
