import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  ACCESS_COOKIE_OPTIONS,
  REFRESH_COOKIE_OPTIONS,
} from '@/lib/cookies';

const API_URL = process.env.KAIZEN_API_URL ?? 'http://localhost:3000';

export async function POST(request: Request) {
  let body: { email?: string; password?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
  }

  const { email, password } = body;
  if (!email || !password) {
    return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
  }

  // Step 1: validate credentials → sessionToken + tenant list
  const loginRes = await fetch(`${API_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });

  if (!loginRes.ok) {
    if (loginRes.status === 401) {
      return NextResponse.json({ error: 'INVALID_CREDENTIALS' }, { status: 401 });
    }
    return NextResponse.json({ error: 'LOGIN_FAILED' }, { status: loginRes.status });
  }

  const { sessionToken, tenants } = await loginRes.json();

  // Users always have exactly one personal tenant (created at registration)
  const tenantId: string | undefined = tenants?.[0]?.id;
  if (!tenantId) {
    return NextResponse.json({ error: 'NO_TENANT' }, { status: 403 });
  }

  // Step 2: exchange sessionToken + tenantId → JWT pair
  const tokenRes = await fetch(`${API_URL}/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionToken, tenantId }),
  });

  if (!tokenRes.ok) {
    return NextResponse.json({ error: 'TOKEN_EXCHANGE_FAILED' }, { status: 401 });
  }

  const { accessToken, refreshToken } = await tokenRes.json();

  // Fetch full user profile
  const meRes = await fetch(`${API_URL}/users/me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const meData = meRes.ok ? await meRes.json() : null;
  const user = meData?.user ?? null;

  // Set httpOnly cookies — tokens never reach the browser JS environment
  const cookieStore = await cookies();
  cookieStore.set(ACCESS_COOKIE, accessToken, ACCESS_COOKIE_OPTIONS);
  cookieStore.set(REFRESH_COOKIE, refreshToken, REFRESH_COOKIE_OPTIONS);

  return NextResponse.json({ user, tenantId });
}
