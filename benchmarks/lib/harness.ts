/**
 * Benchmark harness: cold→warm execution + metric extraction.
 *
 * Correctness note: the cache stores domains WITH subdomain (e.g. `www.saucedemo.com`).
 * Eviction/scoping must match the EXACT stored host — matching the registrable domain
 * (`saucedemo.com`) silently misses, leaving a "cold" run reading stale cache. The
 * prototype `_brain_experiment.mjs` had this bug; `hostsFor()` fixes it.
 */
import pg from 'pg';
import Redis from 'ioredis';
import type { BenchmarkTest, RunResult, StepResult, ColdWarm } from './types';

const API = process.env.KAIZEN_API ?? 'http://127.0.0.1:3000';
const KEY = process.env.KAIZEN_KEY;
// 127.0.0.1 (not 'localhost'): localhost resolves to IPv6 ::1 first here, which is flaky
// against the docker port map — force IPv4.
const PG_URL = process.env.DATABASE_URL ?? 'postgres://kaizen:kaizen@127.0.0.1:5432/kaizen';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
const POLL_TIMEOUT_MS = 180_000;
const POLL_INTERVAL_MS = 2_500;

const H = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' } as const;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let pgc: pg.Client;
let redis: Redis;

export async function connect(): Promise<void> {
  if (!KEY) throw new Error('KAIZEN_KEY is required (execute-scope API key)');
  pgc = new pg.Client({ connectionString: PG_URL });
  await pgc.connect();
  redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 3 });
  redis.on('error', (e) => { if (process.env.BENCH_DEBUG) console.error('redis:', e.message); });
}
export async function disconnect(): Promise<void> {
  await pgc?.end();
  await redis?.quit();
}

/** Exact hosts a test touches: baseUrl host + every `navigate to <url>` host + declared extras. */
export function hostsFor(test: BenchmarkTest): string[] {
  const hosts = new Set<string>();
  const add = (u: string) => { try { hosts.add(new URL(u).hostname); } catch { /* ignore */ } };
  add(test.baseUrl);
  for (const s of test.steps) {
    const m = s.match(/https?:\/\/[^\s"')]+/);
    if (m) add(m[0]);
  }
  for (const h of test.hosts ?? []) hosts.add(h);
  return [...hosts];
}

/** Wipe the brain for these exact hosts so the next run is genuinely cold. */
export async function evict(hosts: string[]): Promise<void> {
  await pgc.query(`DELETE FROM selector_cache WHERE domain = ANY($1)`, [hosts]);
  await pgc.query(`DELETE FROM archetype_failures WHERE domain = ANY($1)`, [hosts]).catch(() => {});
  for (const host of hosts) {
    const keys = await redis.keys(`sel:*:${host}`);
    if (keys.length) await redis.del(...keys);
  }
  // healing budget + llm dedup would otherwise mask a true cold resolve
  for (const pat of ['healing:*', 'llm:dedup:*']) {
    const keys = await redis.keys(pat);
    if (keys.length) await redis.del(...keys);
  }
}

async function enqueue(test: BenchmarkTest): Promise<string> {
  const res = await fetch(`${API}/runs`, { method: 'POST', headers: H, body: JSON.stringify({ steps: test.steps, baseUrl: test.baseUrl }) });
  const body = await res.json().catch(() => ({}));
  if (res.status !== 202) throw new Error(`enqueue ${res.status}: ${JSON.stringify(body)}`);
  return (body as { runId: string }).runId;
}

async function poll(runId: string): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    const res = await fetch(`${API}/runs/${runId}`, { headers: H });
    if (res.ok) {
      const j = (await res.json()) as { status: string };
      if (['passed', 'failed', 'healed', 'cancelled'].includes(j.status)) return j.status;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return 'timeout';
}

/** Accurate per-run resolution tokens + llm/cache counts from the report endpoint. */
async function report(runId: string): Promise<{ tokens: number; llm: number; cache: number }> {
  const res = await fetch(`${API}/runs/${runId}/report`, { headers: H });
  if (!res.ok) return { tokens: 0, llm: 0, cache: 0 };
  const j = (await res.json()) as { llmSummary?: { totalTokens?: number; llmResolvedSteps?: number; cacheResolvedSteps?: number } };
  const s = j.llmSummary ?? {};
  return { tokens: s.totalTokens ?? 0, llm: s.llmResolvedSteps ?? 0, cache: s.cacheResolvedSteps ?? 0 };
}

/** Per-step granularity the report omits — the wrong-element / blind-spot signal. */
async function stepRows(runId: string): Promise<StepResult[]> {
  const { rows } = await pgc.query(
    `SELECT step_index AS index, status, resolution_source AS src, COALESCE(tokens_used,0)::int AS tok,
            COALESCE(duration_ms,0)::int AS dur, COALESCE(selector_used,'') AS sel,
            captured_name AS "capturedName", captured_value AS "capturedValue",
            screenshot_key AS shot
       FROM step_results WHERE run_id = $1 ORDER BY step_index ASC NULLS LAST`, [runId]);
  return rows as StepResult[];
}

const INFRA_RE = /timeout|net::|ERR_|ECONN|socket hang up|navigation|target closed|5\d\d/i;

async function runOnce(test: BenchmarkTest): Promise<RunResult> {
  const runId = await enqueue(test);
  const status = await poll(runId);
  const [rep, steps] = await Promise.all([report(runId), stepRows(runId)]);
  const res: RunResult = {
    runId, status, resolutionTokens: rep.tokens, llmResolvedSteps: rep.llm, cacheResolvedSteps: rep.cache, steps,
  };
  // Retry-worthy transient failures (real bugs persist through retries, so this tolerates
  // flakes without masking them):
  //  - poll timeout / network / nav errors;
  //  - a run that failed AFTER a step healed — an intermittent heal that didn't take effect
  //    (e.g. a first-interaction-after-load timing jitter) rather than a genuine assertion bug.
  if (status === 'timeout') res.infraError = 'poll timeout';
  else if (status === 'failed') {
    const failed = steps.find((s) => s.status === 'failed');
    if (failed && INFRA_RE.test(failed.sel + ' ' + (failed.src ?? ''))) res.infraError = `infra: ${failed.sel}`;
    else if (steps.some((s) => s.status === 'healed')) res.infraError = 'flaky-heal';
  }
  return res;
}

/** Cold → warm for one test (NO eviction — eviction is done once globally by runAll).
 * Retries the whole pair up to `retries` times on an infra-class flake. */
// persistToCache is fire-and-forget (void) in the resolver, so a cold run's cache write
// may still be in flight when it returns — especially under parallel DB/embedding load.
// Settle before the warm run so "did it learn?" measures caching, not a write race.
const CACHE_SETTLE_MS = Number(process.env.BENCH_SETTLE_MS ?? 5000) || 5000;

async function runTest(test: BenchmarkTest, retries = 2): Promise<ColdWarm> {
  // Retry a positive-oracle test that FAILS, not just infra flakes: under parallel load a
  // multi-step flow can occasionally jitter (slow load/timeout). A genuine failure persists
  // through every retry (so real bugs still surface red); a flake passes on a retry.
  const expectsPass = test.oracle.verdict !== 'failed';
  const bad = (r: RunResult) => !!r.infraError || (expectsPass && (r.status === 'failed' || r.status === 'timeout'));
  for (let attempt = 0; attempt <= retries; attempt++) {
    const cold = await runOnce(test);
    if (bad(cold) && attempt < retries) continue;
    await sleep(CACHE_SETTLE_MS);
    const warm = await runOnce(test);
    if (bad(warm) && attempt < retries) continue;
    return { cold, warm };
  }
  const cold = await runOnce(test);
  await sleep(CACHE_SETTLE_MS);
  const warm = await runOnce(test);
  return { cold, warm };
}

/**
 * Run a whole suite with bounded PARALLELISM. Cache-safe because:
 *   1. all hosts are evicted exactly ONCE up front (no per-test evict to clobber a
 *      concurrent test warming the same host);
 *   2. concurrent runs each write their own distinct targetHash rows — additive, no race;
 *   3. a test's own cold→warm stays ordered within runTest.
 * Parallelism is ultimately capped by the worker's WORKER_CONCURRENCY (browser contexts).
 */
export async function runAll(
  tests: BenchmarkTest[],
  opts: { concurrency: number; evict: boolean; onResult?: (t: BenchmarkTest, cw: ColdWarm) => void },
): Promise<Map<string, ColdWarm>> {
  if (opts.evict) {
    const hosts = new Set<string>();
    for (const t of tests) for (const h of hostsFor(t)) hosts.add(h);
    await evict([...hosts]);
  }
  const results = new Map<string, ColdWarm>();
  let next = 0;
  const worker = async () => {
    while (next < tests.length) {
      const t = tests[next++];
      let cw: ColdWarm;
      try {
        cw = await runTest(t);
      } catch (e: any) {
        const err: RunResult = { runId: '', status: 'error', resolutionTokens: 0, llmResolvedSteps: 0, cacheResolvedSteps: 0, steps: [], infraError: e?.message ?? 'error' };
        cw = { cold: err, warm: err };
      }
      results.set(t.id, cw);
      opts.onResult?.(t, cw);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.concurrency, tests.length)) }, worker));
  return results;
}
