import { NextRequest, NextResponse } from 'next/server';
import { ACCESS_COOKIE } from '@/lib/cookies';

// Routes that require an authenticated session
const PROTECTED_PREFIXES = ['/tests'];

// Routes that authenticated users should be redirected away from
const AUTH_ONLY_PREFIXES = ['/login', '/signup'];

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  const isProtected = PROTECTED_PREFIXES.some((prefix) => pathname.startsWith(prefix));
  const isAuthOnly  = AUTH_ONLY_PREFIXES.some((prefix)  => pathname.startsWith(prefix));

  const hasSession = Boolean(request.cookies.get(ACCESS_COOKIE)?.value);

  if (isProtected && !hasSession) {
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = '/login';
    loginUrl.searchParams.set('next', pathname);
    return NextResponse.redirect(loginUrl);
  }

  if (isAuthOnly && hasSession) {
    const testsUrl = request.nextUrl.clone();
    testsUrl.pathname = '/tests';
    testsUrl.searchParams.delete('next');
    return NextResponse.redirect(testsUrl);
  }

  return NextResponse.next();
}

export const config = {
  // Run on all routes except Next.js internals and static files
  matcher: ['/((?!_next/static|_next/image|favicon.ico|api/).*)'],
};
