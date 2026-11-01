/**
 * Changing-sites bench â€” Kaizen API client.
 * Spec: docs/specs/bench/spec-changing-sites.md Â§6
 *
 * Patterns ported from benchmarks/testwriter/run.ts: throwaway bench user with
 * creds cached outside the repo, 401-reauth mid-poll (access tokens live 15
 * minutes; an analyze outlives one), transient-error-tolerant polling.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const API = process.env.KAIZEN_API ?? 'http://localhost:3000';
const CREDS_FILE = join(process.env.TEMP ?? process.env.TMPDIR ?? '/tmp', 'kaizen-sites-bench-creds.json');

async function json<T>(res: Response): Promise<T> {
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${res.url}: ${text.slice(0, 400)}`);
  return JSON.parse(text) as T;
}

/**
 * fetch with transport-level retries. Four sites authenticating at the same
 * instant produced bare `fetch failed` (undici connect flake on Windows
 * loopback) and killed three loops at round 2's start â€” a parallel bench
 * cannot be allowed to die on a connect hiccup.
 */
async function fetchRetry(url: string, init?: RequestInit, attempts = 3): Promise<Response> {
  let lastErr: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fetch(url, init);
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 400 * i + Math.floor(Math.random() * 300)));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export type Auth = { token: string; tenantId: string; headers: Record<string, string> };

export async function getAuth(): Promise<Auth> {
  let creds: { email: string; password: string } | null = null;
  if (existsSync(CREDS_FILE)) creds = JSON.parse(readFileSync(CREDS_FILE, 'utf8'));
  if (!creds) {
    creds = { email: `sites-bench-${Date.now()}@kaizen.local`, password: `bench-${Math.random().toString(36).slice(2)}A1!` };
    await json(await fetchRetry(`${API}/auth/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...creds, displayName: 'Changing-Sites Bench', personalTenantName: 'SitesBench' }),
    }));
    writeFileSync(CREDS_FILE, JSON.stringify(creds));
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

export type AuthRef = {
  auth: Auth;
  /**
   * Re-auth override for multi-tenant callers (site-portfolio): without it a
   * 401 mid-leg would re-auth as THIS bench's single user and silently swap
   * tenants under a T2/T3 leg — the one bug a tenant-isolation bench cannot
   * afford to have in its own harness.
   */
  reauth?: () => Promise<Auth>;
};

/**
 * Fetch with one 401-reauth retry. Access tokens live 15 minutes and every
 * phase of a site loop can outlive one â€” the stress site's first fleet run
 * died at r1 when its suite-run polls started 401ing mid-loop. EVERY API call
 * goes through this.
 */
async function authedFetch(authRef: AuthRef, path: string, init?: { method?: string; body?: string }): Promise<Response> {
  const go = () => fetchRetry(`${API}${path}`, { ...init, headers: authRef.auth.headers });
  let res = await go();
  if (res.status === 401) {
    authRef.auth = await (authRef.reauth ? authRef.reauth() : getAuth());
    res = await go();
  }
  return res;
}

export async function createSuite(authRef: AuthRef, name: string): Promise<string> {
  const { suite } = await json<{ suite: { id: string } }>(await authedFetch(authRef, '/suites', {
    method: 'POST', body: JSON.stringify({ name }),
  }));
  return suite.id;
}

export async function startAnalyze(authRef: AuthRef, suiteId: string, targetUrl: string, brief: string, opts?: { maxPages?: number; maxScenarios?: number; scope?: 'public' | 'authenticated'; loginCaseId?: string }): Promise<string> {
  const started = await json<{ jobId?: string; job?: { id: string } }>(await authedFetch(authRef, `/suites/${suiteId}/analyze`, {
    method: 'POST',
    body: JSON.stringify({
      targetUrl,
      initBrief: brief,
      allowSyntheticData: true,
      // Authenticated scope (site-portfolio wp-admin leg): a fixed-credentials
      // sign-in case + explicit consent, per the analyze route's contract. The
      // bench user registered the tenant, so it holds the owner role the
      // route demands.
      ...(opts?.scope === 'authenticated'
        ? { scope: 'authenticated', loginCaseId: opts.loginCaseId, authConsent: true }
        : {}),
      options: { maxPages: opts?.maxPages ?? 6, maxScenarios: opts?.maxScenarios ?? 8, planApproval: 'auto' },
    }),
  }));
  const jobId = started.jobId ?? started.job?.id;
  if (!jobId) throw new Error(`no jobId in ${JSON.stringify(started)}`);
  return jobId;
}

export type JobRow = { id: string; status: string; error: string | null; report: { progress?: { phase?: string } } | null };

/** Poll a generation job to terminal, re-authing on 401 and shrugging off transient poll faults. */
export async function pollJob(authRef: AuthRef, jobId: string, opts?: { timeoutMin?: number; onPhase?: (p: string) => void }): Promise<JobRow> {
  const t0 = Date.now();
  let lastPhase = '';
  for (;;) {
    await new Promise((r) => setTimeout(r, 5_000));
    let job: JobRow;
    try {
      job = (await json<{ job: JobRow }>(await authedFetch(authRef, `/testwriter/jobs/${jobId}`))).job;
    } catch {
      continue; // one flaky poll must not kill the bench
    }
    const phase = job.report?.progress?.phase ?? job.status;
    if (phase !== lastPhase) { opts?.onPhase?.(phase); lastPhase = phase; }
    if (['completed', 'failed', 'blocked', 'cancelled'].includes(job.status)) return job;
    if (Date.now() - t0 > (opts?.timeoutMin ?? 45) * 60_000) throw new Error(`analyze ${jobId} timed out`);
  }
}

export type CaseRow = {
  id: string; name: string; status: string; origin: string;
  validationState?: string | null; validationRunId?: string | null;
};

export async function listCases(authRef: AuthRef, suiteId: string, status?: string): Promise<CaseRow[]> {
  const q = status ? `?status=${status}` : '';
  const { cases } = await json<{ cases: CaseRow[] }>(await authedFetch(authRef, `/suites/${suiteId}/cases${q}`));
  return cases;
}

/**
 * Seed a hand-authored case into the suite (origin: user, active immediately).
 * The bench tests the ENGINE, not the writer â€” when the generated suite
 * under-covers a mutation (no checkout flow for the decoy, no click on the
 * renamed button), a seeded case guarantees the mutation is exercised. Seeds
 * are clearly labeled in the case name.
 */
export async function seedCase(authRef: AuthRef, suiteId: string, name: string, baseUrl: string, steps: string[]): Promise<string> {
  const created = await json<{ case: { id: string } }>(await authedFetch(authRef, `/suites/${suiteId}/cases`, {
    method: 'POST', body: JSON.stringify({ name, baseUrl, steps }),
  }));
  return created.case.id;
}

/**
 * Accept every validated generated draft: PATCH to active. A case still in
 * 'validating' 400s on PATCH, so wait for the suite to settle first.
 */
export async function acceptValidated(authRef: AuthRef, suiteId: string, opts?: { settleTimeoutMs?: number }): Promise<{ accepted: CaseRow[]; leftBehind: CaseRow[] }> {
  const deadline = Date.now() + (opts?.settleTimeoutMs ?? 180_000);
  for (;;) {
    const validating = (await listCases(authRef, suiteId)).filter((c) => c.status === 'validating');
    if (validating.length === 0) break;
    if (Date.now() > deadline) break; // stuck validations are recorded, not fatal
    await new Promise((r) => setTimeout(r, 3_000));
  }
  const all = await listCases(authRef, suiteId);
  const accepted: CaseRow[] = [];
  const leftBehind: CaseRow[] = [];
  for (const c of all) {
    if (c.origin !== 'generated') continue;
    if (c.status === 'draft' && c.validationState === 'validated') {
      await json(await authedFetch(authRef, `/cases/${c.id}`, {
        method: 'PATCH', body: JSON.stringify({ status: 'active' }),
      }));
      accepted.push(c);
    } else if (c.status !== 'active') {
      leftBehind.push(c);
    }
  }
  return { accepted, leftBehind };
}

export type RunDetail = {
  id: string; status: string; case_id?: string | null;
  stepResults: Array<{
    id: string; step_index: number; status: string; rawText?: string | null;
    selector_used: string | null; resolution_source: string | null; error_type: string | null;
    failure_class: string | null; tokens_used?: number | null; dom_candidates?: unknown;
    healingEvents: Array<{ failure_class: string; strategy_used: string; succeeded: boolean; old_selector: string | null; new_selector: string | null }>;
  }>;
};

export async function runSuite(authRef: AuthRef, suiteId: string): Promise<Array<{ caseId: string; runId: string }>> {
  const res = await json<{ queued: Array<{ caseId: string; runId: string }>; skipped: unknown[] }>(
    await authedFetch(authRef, `/suites/${suiteId}/run`, { method: 'POST', body: '{}' }));
  return res.queued;
}

const TERMINAL = ['passed', 'failed', 'healed', 'cancelled'];

export async function pollRun(authRef: AuthRef, runId: string, timeoutMs = 300_000): Promise<RunDetail> {
  const t0 = Date.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, 2_500));
    let run: RunDetail;
    try {
      run = await json<RunDetail>(await authedFetch(authRef, `/runs/${runId}`));
    } catch {
      continue; // transient poll fault must not abort a whole site's loop
    }
    if (TERMINAL.includes(run.status)) return run;
    if (Date.now() - t0 > timeoutMs) throw new Error(`run ${runId} did not finish in ${timeoutMs}ms`);
  }
}
