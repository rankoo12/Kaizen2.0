/**
 * Changing-sites bench — orchestrator.
 * Spec: docs/specs/bench/spec-changing-sites.md §6
 *
 *   npm run bench:sites -- --site vanilla [--skip-analyze] [--rounds 1]
 *   npm run bench:sites -- --sites react-spa,angular-forms --rounds 1
 *   npm run bench:sites -- --all
 *
 * SITES RUN IN PARALLEL: each site gets its own suite and its own analyze job
 * (TESTWRITER_CONCURRENCY must allow it), and all loops advance concurrently —
 * one slow analyze never blocks the fleet. Logs are prefixed per site.
 *
 * Phase-1 walking skeleton: drives the full loop (preflight → analyze v1 →
 * accept → r1 baseline → mutate → clear budgets → r2 → r3) and dumps RAW
 * evidence per run. The judge arrives in Phase 2, calibrated by what this
 * skeleton observes on the real engine.
 *
 * Needs: compose stack up (incl. `sites`), `npm run inbox`, and
 * `ANSWERER_MODEL=haiku npm run answerer` in their own terminals.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { FLEET, siteById, type SiteDef } from './fleet';
import { API, getAuth, createSuite, startAnalyze, pollJob, listCases, acceptValidated, runSuite, pollRun, seedCase, type AuthRef, type RunDetail } from './lib/api';
import { setVersion, siteGet } from './lib/mutate';
import { selectorCacheSnapshot, grantBudget, clearHealingBudget, type CacheRow } from './lib/evidence';

const OUT_DIR = join(__dirname, 'results');
const STATE_FILE = join(OUT_DIR, 'state.json');

type Args = { sites: SiteDef[]; skipAnalyze: boolean; rounds: number };
function parseArgs(): Args {
  const a = process.argv.slice(2);
  const get = (k: string, d: string) => { const i = a.indexOf(`--${k}`); return i >= 0 ? a[i + 1] : d; };
  const sites = a.includes('--all')
    ? FLEET
    : get('sites', '') !== ''
      ? get('sites', '').split(',').map((s) => siteById(s.trim()))
      : [siteById(get('site', 'vanilla'))];
  return { sites, skipAnalyze: a.includes('--skip-analyze'), rounds: Number(get('rounds', '1')) };
}

type BenchState = Record<string, { suiteId: string; tenantId: string }>;
const loadState = (): BenchState => (existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : {});
// All sites run in ONE process; the shared object + sync write make saves race-free.
const state: BenchState = loadState();
const saveState = () => { mkdirSync(OUT_DIR, { recursive: true }); writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); };

type Logger = (msg: string) => void;
const makeLog = (prefix: string): Logger => (msg) =>
  process.stdout.write(`${new Date().toISOString().slice(11, 19)} [${prefix}] ${msg}\n`);

type SuiteRunResult = { details: RunDetail[]; runToCase: Map<string, string> };

/** One suite execution: queue every active case, poll ALL runs in parallel. */
async function suiteRun(authRef: AuthRef, suiteId: string, label: string, slog: Logger): Promise<SuiteRunResult> {
  const queued = await runSuite(authRef, suiteId);
  slog(`${label}: ${queued.length} runs queued`);
  const details = await Promise.all(queued.map((q) => pollRun(authRef, q.runId)));
  const runToCase = new Map(queued.map((q) => [q.runId, q.caseId]));
  const byStatus = details.reduce<Record<string, number>>((m, r) => { m[r.status] = (m[r.status] ?? 0) + 1; return m; }, {});
  slog(`${label}: done — ${JSON.stringify(byStatus)}`);
  return { details, runToCase };
}

/** Compact per-run evidence for the raw dump (Phase 2's judge consumes the full detail). */
function digest(result: SuiteRunResult, caseNames: Map<string, string>) {
  return result.details.map((r) => ({
    runId: r.id,
    caseName: caseNames.get(result.runToCase.get(r.id) ?? '') ?? null,
    status: r.status,
    steps: (r.stepResults ?? []).map((s) => ({
      i: s.step_index,
      text: (s as { rawText?: string | null }).rawText ?? null,
      status: s.status,
      source: s.resolution_source,
      selector: s.selector_used,
      errorType: s.error_type,
      failureClass: s.failure_class,
      tokens: s.tokens_used ?? 0,
      heals: (s.healingEvents ?? []).map((h) => ({
        class: h.failure_class, strategy: h.strategy_used, ok: h.succeeded,
        old: h.old_selector, new: h.new_selector,
      })),
    })),
  }));
}

async function preflightShared(): Promise<void> {
  await fetch(`${API}/health`).catch(() => { throw new Error(`API unreachable at ${API} — is the compose stack up?`); });
  const inbox = await fetch('http://127.0.0.1:4141/v1/embeddings', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'text-embedding-3-small', input: 'preflight' }),
  }).catch(() => null);
  if (!inbox || !inbox.ok) {
    throw new Error('LLM inbox not answering on :4141 — start `npm run inbox` and `ANSWERER_MODEL=haiku npm run answerer`');
  }
}

async function benchSite(site: SiteDef, args: Args): Promise<string> {
  const slog = makeLog(site.id);
  mkdirSync(OUT_DIR, { recursive: true });

  await setVersion(site, site.versions[0]);
  const v = await siteGet(site.host, '/__version.txt');
  slog(`preflight: ${site.host} serving ${v.body.trim()}`);

  const authRef: AuthRef = { auth: await getAuth() };
  await grantBudget(authRef.auth.tenantId);

  let suiteId = args.skipAnalyze ? state[site.id]?.suiteId : undefined;

  if (!suiteId) {
    suiteId = await createSuite(authRef, `sites-bench ${site.id} ${new Date().toISOString().slice(0, 16)}`);
    const brief = readFileSync(join(__dirname, site.brief), 'utf8');
    const jobId = await startAnalyze(authRef, suiteId, `http://${site.host}/`, brief);
    slog(`analyze: job ${jobId} on suite ${suiteId}`);
    const job = await pollJob(authRef, jobId, { onPhase: (p) => slog(`analyze: ${p}`) });
    if (job.status !== 'completed') throw new Error(`[${site.id}] analyze ended ${job.status}: ${job.error}`);
    state[site.id] = { suiteId, tenantId: authRef.auth.tenantId };
    saveState();
  } else {
    slog(`reusing suite ${suiteId} (--skip-analyze)`);
  }

  const { accepted, leftBehind } = await acceptValidated(authRef, suiteId);

  // Coverage floor: seed hand-authored cases the generated suite is missing,
  // so every mutation is exercised even when the writer under-covers.
  const existingNames = new Set((await listCases(authRef, suiteId)).map((c) => c.name));
  for (const seed of site.seedCases ?? []) {
    if (existingNames.has(seed.name)) continue;
    await seedCase(authRef, suiteId, seed.name, `http://${site.host}${seed.path}`, seed.steps);
    slog(`seeded: ${seed.name}`);
  }

  const active = (await listCases(authRef, suiteId)).filter((c) => c.status === 'active');
  slog(`accept: ${accepted.length} newly accepted, ${active.length} active total, ${leftBehind.length} left behind`);
  if (active.length === 0) throw new Error(`[${site.id}] no active cases — nothing to bench`);
  const caseNames = new Map(active.map((c) => [c.id, c.name]));

  const evidence: Record<string, unknown> = {
    site: site.id, host: site.host, suiteId, tenantId: authRef.auth.tenantId,
    startedAt: new Date().toISOString(),
    cases: active.map((c) => ({ id: c.id, name: c.name })),
    unvalidated: leftBehind.map((c) => ({ id: c.id, name: c.name, status: c.status, validationState: c.validationState })),
  };

  const r1 = await suiteRun(authRef, suiteId, 'r1 baseline (v1)', slog);
  evidence.r1 = digest(r1, caseNames);
  evidence.cacheAfterR1 = await selectorCacheSnapshot(authRef.auth.tenantId, site.host);

  for (let round = 1; round <= args.rounds; round++) {
    const version = site.versions[round];
    if (!version) break;

    await setVersion(site, version);
    slog(`mutate: ${site.host} now serving ${version}`);
    const cleared = await clearHealingBudget();
    slog(`cleared healing budget (${cleared.healing} keys) + llm dedup (${cleared.dedup} keys)`);

    const r2 = await suiteRun(authRef, suiteId, `r2 mutated (${version})`, slog);
    evidence[`r2_${version}`] = digest(r2, caseNames);
    evidence[`cacheAfter_${version}`] = await selectorCacheSnapshot(authRef.auth.tenantId, site.host);

    await new Promise((r) => setTimeout(r, 5_000)); // fire-and-forget heal persistence
    await clearHealingBudget();

    const r3 = await suiteRun(authRef, suiteId, `r3 learned-proof (${version})`, slog);
    evidence[`r3_${version}`] = digest(r3, caseNames);
    evidence[`cacheAfterR3_${version}`] = await selectorCacheSnapshot(authRef.auth.tenantId, site.host);
  }

  const file = join(OUT_DIR, `${site.id}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, JSON.stringify(evidence, null, 2));
  slog(`evidence saved: ${file}`);

  // Raw console digest — what Phase 2's judge will formalize.
  let summary = '';
  for (const key of ['r1', ...site.versions.slice(1).flatMap((v2) => [`r2_${v2}`, `r3_${v2}`])]) {
    const runs = evidence[key] as ReturnType<typeof digest> | undefined;
    if (!runs) continue;
    summary += `\n── [${site.id}] ${key} ──\n`;
    for (const r of runs) {
      const heals = r.steps.flatMap((s) => s.heals);
      const healTxt = heals.length ? ` heals: ${heals.map((h) => `${h.strategy}(${h.class})${h.ok ? '✓' : '✗'}`).join(', ')}` : '';
      const fails = r.steps.filter((s) => s.status === 'failed').map((s) => `#${s.i} ${s.errorType ?? s.failureClass ?? '?'}`);
      summary += `  ${r.status.padEnd(6)} ${(r.caseName ?? r.runId.slice(0, 8)).slice(0, 52).padEnd(52)}${healTxt}${fails.length ? ` failed: ${fails.join('; ')}` : ''}\n`;
    }
  }
  return summary;
}

async function main(): Promise<void> {
  const args = parseArgs();
  await preflightShared();
  process.stdout.write(`running ${args.sites.length} site(s) in parallel: ${args.sites.map((s) => s.id).join(', ')}\n`);

  const outcomes = await Promise.allSettled(args.sites.map((site) => benchSite(site, args)));

  let failed = 0;
  outcomes.forEach((o, i) => {
    if (o.status === 'fulfilled') {
      process.stdout.write(o.value + '\n');
    } else {
      failed++;
      process.stdout.write(`\n✗ [${args.sites[i].id}] ${o.reason instanceof Error ? o.reason.message : o.reason}\n`);
    }
  });
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
