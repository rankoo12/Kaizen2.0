import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { ACCESS_COOKIE, REFRESH_COOKIE } from '@/lib/cookies';

const API_URL = process.env.KAIZEN_API_URL ?? 'http://localhost:3000';

export async function POST() {
  const cookieStore = await cookies();
  const accessToken  = cookieStore.get(ACCESS_COOKIE)?.value;
  const refreshToken = cookieStore.get(REFRESH_COOKIE)?.value;

  // Best-effort: revoke refresh token on the backend.
  // Even if the API call fails we still clear local cookies.
  if (accessToken && refreshToken) {
    await fetch(`${API_URL}/auth/logout`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ refreshToken }),
    }).catch(() => {
      // Ignore network errors — user is logging out regardless
    });
  }

  // Clear both cookies by setting maxAge to 0
  cookieStore.set(ACCESS_COOKIE,  '', { maxAge: 0, path: '/' });
  cookieStore.set(REFRESH_COOKIE, '', { maxAge: 0, path: '/' });

  return NextResponse.json({ ok: true });
}
