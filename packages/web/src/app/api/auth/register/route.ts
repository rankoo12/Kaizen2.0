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
  let body: { email?: string; password?: string; displayName?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
  }

  const { email, password, displayName } = body;
  if (!email || !password) {
    return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
  }

  // Register creates user + personal tenant + issues JWT pair in one shot
  const registerRes = await fetch(`${API_URL}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email,
      password,
      displayName: displayName ?? email.split('@')[0],
    }),
  });

  if (!registerRes.ok) {
    const data = await registerRes.json().catch(() => ({}));
    // 409 = email already taken; 400 = validation failure
    return NextResponse.json(
      { error: data.error ?? 'REGISTER_FAILED', message: data.message },
      { status: registerRes.status },
    );
  }

  const { user, tenant, accessToken, refreshToken } = await registerRes.json();

  // Set httpOnly cookies
  const cookieStore = await cookies();
  cookieStore.set(ACCESS_COOKIE, accessToken, ACCESS_COOKIE_OPTIONS);
  cookieStore.set(REFRESH_COOKIE, refreshToken, REFRESH_COOKIE_OPTIONS);

  return NextResponse.json({ user, tenantId: tenant.id }, { status: 201 });
}
