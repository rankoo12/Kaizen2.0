/**
 * Site-portfolio bench — multi-tenant auth.
 * Spec: docs/specs/bench/spec-site-portfolio.md §5
 *
 * The changing-sites bench authenticates ONE throwaway user (fixed creds
 * file). The tenant matrix needs T1/T2/T3 as genuinely separate tenants, so
 * each label gets its own creds file in TEMP (never the repo) and its own
 * registered user — registration creates the personal tenant that IS the
 * bench tenant. Re-runs reuse the stored creds, so tenant identity is stable
 * across legs (T2's "after T1" leg must be the same T2 every time).
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { API, type Auth, type AuthRef } from '../../changing-sites/lib/api';
import { grantBudget } from '../../changing-sites/lib/evidence';

const credsFile = (label: string) =>
  join(process.env.TEMP ?? process.env.TMPDIR ?? '/tmp', `kaizen-portfolio-${label}-creds.json`);

async function json<T>(res: Response): Promise<T> {
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${res.url}: ${text.slice(0, 400)}`);
  return JSON.parse(text) as T;
}

async function fetchRetry(url: string, init?: RequestInit, attempts = 3): Promise<Response> {
  let lastErr: unknown;
  for (let i = 1; i <= attempts; i++) {
    try { return await fetch(url, init); } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 400 * i + Math.floor(Math.random() * 300)));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export async function getAuthFor(label: string): Promise<Auth> {
  const file = credsFile(label);
  let creds: { email: string; password: string } | null = null;
  if (existsSync(file)) creds = JSON.parse(readFileSync(file, 'utf8'));
  if (!creds) {
    creds = {
      email: `portfolio-${label.toLowerCase()}-${Date.now()}@kaizen.local`,
      password: `bench-${Math.random().toString(36).slice(2)}A1!`,
    };
    await json(await fetchRetry(`${API}/auth/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...creds, displayName: `Portfolio ${label}`, personalTenantName: `Portfolio-${label}` }),
    }));
    writeFileSync(file, JSON.stringify(creds));
  }
  const login = await json<{ sessionToken: string; tenants: Array<{ id: string }> }>(
    await fetchRetry(`${API}/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(creds),
    }));
  const tenantId = login.tenants[0].id;
  const pair = await json<{ accessToken: string }>(
    await fetchRetry(`${API}/auth/token`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionToken: login.sessionToken, tenantId }),
    }));
  return { token: pair.accessToken, tenantId, headers: { 'content-type': 'application/json', authorization: `Bearer ${pair.accessToken}` } };
}

/** Auth + budget in one call; every leg starts here. reauth is label-bound,
 * so a 401 mid-leg can never swap tenants (see AuthRef.reauth in api.ts). */
export async function tenantRef(label: string): Promise<AuthRef & { label: string }> {
  const auth = await getAuthFor(label);
  await grantBudget(auth.tenantId);
  return { auth, label, reauth: () => getAuthFor(label) };
}
