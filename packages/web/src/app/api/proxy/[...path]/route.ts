import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';
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

async function forwardRequest(
  url: string,
  method: string,
  accessToken: string,
  body: string | undefined,
  ifNoneMatch?: string | null,
): Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  };
  // Forward the conditional-request validator so cacheable upstream responses
  // (e.g. immutable screenshots from GET /media) can answer 304 Not Modified.
  if (ifNoneMatch) headers['If-None-Match'] = ifNoneMatch;
  return fetch(url, { method, headers, body, cache: 'no-store' });
}

/** Copy caching-related headers from an upstream response onto the client response. */
function copyCacheHeaders(from: Response, to: NextResponse): void {
  const cacheControl = from.headers.get('cache-control');
  const etag = from.headers.get('etag');
  if (cacheControl) to.headers.set('Cache-Control', cacheControl);
  if (etag) to.headers.set('ETag', etag);
}

function buildUpstreamUrl(pathSegments: string[], search: string): string {
  return `${API_URL}/${pathSegments.join('/')}${search}`;
}

async function buildResponse(res: Response, cookieUpdates?: {
  access: string;
  refresh: string;
}): Promise<NextResponse> {
  const contentType = res.headers.get('content-type') ?? '';
  const isJson = contentType.includes('application/json');

  let response: NextResponse;

  if (res.status === 304) {
    // Not Modified — no body; preserve the validator/cache headers.
    response = new NextResponse(null, { status: 304 });
    copyCacheHeaders(res, response);
  } else if (res.status === 204) {
    response = new NextResponse(null, { status: 204 });
  } else if (isJson) {
    const data = await res.json();
    response = NextResponse.json(data, { status: res.status });
  } else {
    // Handle binary data (images, etc)
    const buffer = await res.arrayBuffer();
    response = new NextResponse(buffer, {
      status: res.status,
      headers: {
        'Content-Type': contentType,
      },
    });
    // Propagate upstream caching so the browser serves repeat views from cache.
    copyCacheHeaders(res, response);
  }

  if (cookieUpdates) {
    response.cookies.set(ACCESS_COOKIE,  cookieUpdates.access,  ACCESS_COOKIE_OPTIONS);
    response.cookies.set(REFRESH_COOKIE, cookieUpdates.refresh, REFRESH_COOKIE_OPTIONS);
  }

  return response;
}

async function handler(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> },
) {
  const { path } = await context.params;
  const cookieStore = await cookies();
  const accessToken  = cookieStore.get(ACCESS_COOKIE)?.value;
  const refreshToken = cookieStore.get(REFRESH_COOKIE)?.value;

  if (!accessToken && !refreshToken) {
    return NextResponse.json({ error: 'UNAUTHENTICATED' }, { status: 401 });
  }

  const upstreamUrl = buildUpstreamUrl(path, request.nextUrl.search);
  const method = request.method;
  const ifNoneMatch = request.headers.get('if-none-match');
  const body = ['GET', 'HEAD', 'DELETE'].includes(method)
    ? undefined
    : await request.text();

  // First attempt with current access token
  if (accessToken) {
    const res = await forwardRequest(upstreamUrl, method, accessToken, body, ifNoneMatch);

    if (res.status !== 401) {
      return buildResponse(res);
    }
  }

  // Access token missing or returned 401 — try refresh
  if (!refreshToken) {
    const response = NextResponse.json({ error: 'UNAUTHENTICATED' }, { status: 401 });
    response.cookies.set(ACCESS_COOKIE, '', { maxAge: 0, path: '/' });
    return response;
  }

  const newTokens = await tryRefresh(refreshToken);
  if (!newTokens) {
    // Refresh failed — clear cookies so middleware redirects on next navigation
    const response = NextResponse.json({ error: 'UNAUTHENTICATED' }, { status: 401 });
    response.cookies.set(ACCESS_COOKIE,  '', { maxAge: 0, path: '/' });
    response.cookies.set(REFRESH_COOKIE, '', { maxAge: 0, path: '/' });
    return response;
  }

  // Retry with new access token and return updated cookies in response
  const retryRes = await forwardRequest(upstreamUrl, method, newTokens.accessToken, body, ifNoneMatch);
  return buildResponse(retryRes, {
    access:  newTokens.accessToken,
    refresh: newTokens.refreshToken,
  });
}

export const GET    = handler;
export const POST   = handler;
export const PATCH  = handler;
export const PUT    = handler;
export const DELETE = handler;
