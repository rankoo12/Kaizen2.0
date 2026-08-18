/**
 * Test Writer bench — the same job the UI starts, run against the LOCAL stack,
 * with a per-page ledger at the end.
 *
 * The question this answers is the founder's: "if I ask for 30 tests on a
 * 40-page site, do I get 30?" Everything else the pipeline reports is detail
 * under that number. Run it, change something, run it again.
 *
 *   npx tsx benchmarks/testwriter/run.ts [--pages 50] [--tests 30] [--brief benchmarks/testwriter/brief.the-internet.txt]
 *
 * Talks to the API over HTTP exactly as the web app does — no shortcuts into
 * the pipeline — so a number here is a number prod would produce with the same
 * code. Needs the local stack up (`docker compose -p kaizen20 up -d`) and
 * OPENAI_API_KEY in the containers' env. Creates a throwaway bench user + suite
 * on first run and reuses them after (credentials in the scratchpad, never the
 * repo).
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const API = process.env.KAIZEN_API ?? 'http://localhost:3000';
const TARGET = process.env.KAIZEN_TARGET ?? 'https://the-internet.herokuapp.com/';
const OUT_DIR = join(__dirname, 'results');

type Args = { pages: number; tests: number; brief: string; label: string; target: string; login: string | null };
function parseArgs(): Args {
  const a = process.argv.slice(2);
  const get = (k: string, d: string) => { const i = a.indexOf(`--${k}`); return i >= 0 ? a[i + 1] : d; };
  return {
    pages: Number(get('pages', '50')),
    tests: Number(get('tests', '30')),
    brief: get('brief', join(__dirname, 'brief.the-internet.txt')),
    label: get('label', 'run'),
    target: get('target', TARGET),
    // --login "step one|step two|…": creates an ACTIVE sign-in test in the fresh
    // suite and runs the analyze in authenticated scope with consent. The steps
    // are plain English, exactly as a user types them.
    login: get('login', ''),
  };
}

// ── auth: a bench user that lives only in the local DB ─────────────────────
const CREDS_FILE = join(process.env.TEMP ?? process.env.TMPDIR ?? '/tmp', 'kaizen-bench-creds.json');

async function json<T>(res: Response): Promise<T> {
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${res.url}: ${text.slice(0, 400)}`);
  return JSON.parse(text) as T;
}

async function getToken(): Promise<string> {
  let creds: { email: string; password: string } | null = null;
  if (existsSync(CREDS_FILE)) creds = JSON.parse(readFileSync(CREDS_FILE, 'utf8'));
  if (!creds) {
    creds = { email: `bench-${Date.now()}@kaizen.local`, password: `bench-${Math.random().toString(36).slice(2)}A1!` };
    await json(await fetch(`${API}/auth/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...creds, displayName: 'Test Writer Bench', personalTenantName: 'Bench' }),
    }));
    writeFileSync(CREDS_FILE, JSON.stringify(creds));
  }
  const login = await json<{ sessionToken: string; tenants: Array<{ id: string }> }>(
    await fetch(`${API}/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(creds),
    }),
  );
  const pair = await json<{ accessToken: string }>(
    await fetch(`${API}/auth/token`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionToken: login.sessionToken, tenantId: login.tenants[0].id }),
    }),
  );
  return pair.accessToken;
}

// ── the job ────────────────────────────────────────────────────────────────
type Job = {
  id: string; status: string; error: string | null;
  testPlan: { scenarios?: Array<{ name: string; targetPages: string[]; outline: string; source: { kind: string } }> } | null;
  report: {
    progress?: { phase?: string };
    recon?: { pagesCrawled?: number; errorPages?: unknown[] };
    plan?: { scenariosPlanned?: number; fromCatalog?: number; fromLlm?: number; fromRepertoire?: number; pagesPlannedFor?: number; pagesExcludedByBrief?: string[]; dropped?: unknown[] };
    write?: Record<string, number | string | null>;
    validate?: { proposed?: number; validated?: number; unvalidated?: number };
    rejected?: Array<{ name: string; stage: string; reason: string; steps?: string[] }>;
    auditFindings?: Record<string, string[]>;
    findings?: Array<{ kind: string; title: string }>;
    tokenUsage?: Record<string, number>;
  } | null;
};

async function main(): Promise<void> {
  const args = parseArgs();
  let token = await getToken();
  let h = { 'content-type': 'application/json', authorization: `Bearer ${token}` };

  // A fresh suite per run: the ledger must not be polluted by an earlier run's
  // cases (dedup would silently eat repeats and hide the real number).
  const { suite } = await json<{ suite: { id: string } }>(await fetch(`${API}/suites`, {
    method: 'POST', headers: h,
    body: JSON.stringify({ name: `bench ${args.label} ${new Date().toISOString().slice(0, 16)}` }),
  }));

  // Authenticated scope: the sign-in recipe is a real, active test in the suite.
  let auth: { loginCaseId: string } | null = null;
  if (args.login) {
    const steps = args.login.split('|').map((x) => x.trim()).filter(Boolean);
    const created = await json<{ case: { id: string } }>(await fetch(`${API}/suites/${suite.id}/cases`, {
      method: 'POST', headers: h,
      body: JSON.stringify({ name: 'Sign in (bench recipe)', baseUrl: args.target, steps }),
    }));
    auth = { loginCaseId: created.case.id };
    process.stdout.write(`sign-in recipe ${auth.loginCaseId}: ${steps.join(' → ')}
`);
  }

  const t0 = Date.now();
  const started = await json<{ jobId?: string; job?: { id: string } }>(await fetch(`${API}/suites/${suite.id}/analyze`, {
    method: 'POST', headers: h,
    body: JSON.stringify({
      targetUrl: args.target,
      initBrief: readFileSync(args.brief, 'utf8'),
      allowSyntheticData: true,
      ...(auth ? { scope: 'authenticated', loginCaseId: auth.loginCaseId, authConsent: true } : {}),
      options: { maxPages: args.pages, maxScenarios: args.tests, planApproval: 'auto' },
    }),
  }));
  const jobId = started.jobId ?? started.job?.id;
  if (!jobId) throw new Error(`no jobId in ${JSON.stringify(started)}`);
  process.stdout.write(`job ${jobId} on suite ${suite.id} — ${args.pages} pages / ${args.tests} tests\n`);

  let job: Job | null = null;
  let lastPhase = '';
  for (;;) {
    await new Promise((r) => setTimeout(r, 5_000));
    // Access tokens live 15 minutes; a screen-discovery crawl of a real app
    // outlives one. Re-authenticate rather than lose the run's ledger.
    let res = await fetch(`${API}/testwriter/jobs/${jobId}`, { headers: h });
    if (res.status === 401) {
      token = await getToken();
      h = { ...h, authorization: `Bearer ${token}` };
      res = await fetch(`${API}/testwriter/jobs/${jobId}`, { headers: h });
    }
    job = (await json<{ job: Job }>(res)).job;
    const phase = job.report?.progress?.phase ?? job.status;
    if (phase !== lastPhase) { process.stdout.write(`  ${Math.round((Date.now() - t0) / 1000)}s ${phase}\n`); lastPhase = phase; }
    if (['completed', 'failed', 'blocked', 'cancelled'].includes(job.status)) break;
    if (Date.now() - t0 > 40 * 60_000) throw new Error('bench timed out after 40 minutes');
  }

  // ── the ledger ────────────────────────────────────────────────────────────
  const r = job.report ?? {};
  const rejected = r.rejected ?? [];
  const planned = job.testPlan?.scenarios ?? [];
  const audits = r.auditFindings ?? {};

  const rejectedNames = new Set(rejected.map((x) => x.name));
  const byStage: Record<string, number> = {};
  for (const x of rejected) byStage[x.stage] = (byStage[x.stage] ?? 0) + 1;

  const proposedCount = r.validate?.proposed ?? 0;
  const validated = r.validate?.validated ?? 0;
  const vacuous = Object.values(audits).filter((n) => n.some((s) => /vacuous|page_load_only/.test(s))).length;

  // Which planned scenarios reached delivery, per page.
  const pageOf = (s: { targetPages: string[] }) => (s.targetPages[0] ?? '').replace(args.target.replace(/\/$/, ''), '') || '/';
  const perPage = new Map<string, { planned: number; delivered: number; names: string[] }>();
  for (const s of planned) {
    const p = pageOf(s);
    const row = perPage.get(p) ?? { planned: 0, delivered: 0, names: [] };
    row.planned++;
    if (!rejectedNames.has(s.name)) { row.delivered++; row.names.push(s.name); }
    perPage.set(p, row);
  }

  const summary = {
    label: args.label, jobId, suiteId: suite.id, status: job.status, error: job.error,
    requested: { pages: args.pages, tests: args.tests },
    seconds: Math.round((Date.now() - t0) / 1000),
    pagesCrawled: r.recon?.pagesCrawled ?? null,
    screens: r.recon?.screensDiscovered ?? 0,
    planned: planned.length,
    planSources: { catalog: r.plan?.fromCatalog ?? null, llm: r.plan?.fromLlm ?? null, dropped: r.plan?.dropped ?? null },
    write: r.write ?? null,
    planSourcesDetail: { repertoire: r.plan?.fromRepertoire ?? null, excluded: r.plan?.pagesExcludedByBrief ?? [] },
    proposed: proposedCount,
    proven: validated,
    needsReview: proposedCount - validated,
    vacuousOrPageLoad: vacuous,
    rejected: rejected.length,
    rejectedByStage: byStage,
    tokens: r.tokenUsage?.total ?? null,
    pagesWithDelivery: [...perPage.values()].filter((v) => v.delivered > 0).length,
    pagesPlannedFor: perPage.size,
  };

  process.stdout.write('\n' + '═'.repeat(72) + '\n');
  process.stdout.write(`  ${args.label}: requested ${args.tests} → planned ${summary.planned} → proposed ${summary.proposed} (proven ${summary.proven}, review ${summary.needsReview}) · rejected ${summary.rejected}\n`);
  process.stdout.write(`  pages crawled ${summary.pagesCrawled} (screens ${summary.screens}) · pages planned for ${summary.pagesPlannedFor} · pages with a delivered test ${summary.pagesWithDelivery} · ${summary.seconds}s · ${summary.tokens ?? '?'} tok\n`);
  process.stdout.write(`  rejected by stage: ${JSON.stringify(byStage)}\n`);
  process.stdout.write('─'.repeat(72) + '\n  per page (delivered/planned):\n');
  for (const [p, v] of [...perPage.entries()].sort()) {
    process.stdout.write(`    ${v.delivered}/${v.planned}  ${p.padEnd(28)} ${v.names.slice(0, 2).join(' · ')}\n`);
  }
  process.stdout.write('─'.repeat(72) + '\n  rejections:\n');
  for (const x of rejected) {
    process.stdout.write(`    [${x.stage}] ${x.name}\n        ${x.reason.slice(0, 160)}\n`);
    for (const s of x.steps ?? []) process.stdout.write(`          · ${s}\n`);
  }
  process.stdout.write('═'.repeat(72) + '\n');

  mkdirSync(OUT_DIR, { recursive: true });
  const file = join(OUT_DIR, `${args.label}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, JSON.stringify({ summary, job }, null, 2));
  process.stdout.write(`saved ${file}\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
