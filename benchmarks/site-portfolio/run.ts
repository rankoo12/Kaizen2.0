/**
 * Site-portfolio bench — learning-loop orchestrator (one leg per invocation).
 * Spec: docs/specs/bench/spec-site-portfolio.md §4, §5, §9a
 *
 *   npm run bench:portfolio -- --site internet --tenant T1 [--phases cold,warm,hot] [--model haiku]
 *
 * A LEG is (site × tenant × model). Real sites do not mutate, so the loop is:
 *   cold : new suite → analyze (writer, inbox-answered) → accept drafts →
 *          seed the coverage floor (incl. the PROBE-MUSTFAIL) → suite run
 *   warm : immediate rerun — resolution memory should carry it
 *   hot  : worker restart (flushes in-process state; L1/L2 must serve) → rerun
 * Each phase appends a §9a record to results/campaign.jsonl; the leg ends
 * with judge-lite flags (probes, staleness, token trajectory, neg-ctrl).
 *
 * DELIBERATELY ONE LEG PER PROCESS: the tenant matrix is an ordered protocol
 * (T1 before T2 is the "helping" experiment), so sequencing lives with the
 * operator, not in here. The hot phase restarts the shared worker — never run
 * two legs concurrently.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { PORTFOLIO, portfolioSiteById, type PortfolioSite } from './sites';
import {
  API, createSuite, startAnalyze, pollJob, listCases, acceptValidated, runSuite, pollRun, seedCase,
  type AuthRef, type RunDetail,
} from '../changing-sites/lib/api';
import { tenantRef } from './lib/tenants';
import { appendRecord, digestPhase, judgeLearning, OUT_DIR, type PhaseRecord } from './lib/log';

const STATE_FILE = join(OUT_DIR, 'portfolio-state.json');

type Args = { site: PortfolioSite; tenant: string; phases: Array<'cold' | 'warm' | 'hot'>; model: 'haiku' | 'sonnet' };
function parseArgs(): Args {
  const a = process.argv.slice(2);
  const get = (k: string, d: string) => { const i = a.indexOf(`--${k}`); return i >= 0 ? a[i + 1] : d; };
  return {
    site: portfolioSiteById(get('site', 'internet')),
    tenant: get('tenant', 'T1'),
    phases: get('phases', 'cold,warm,hot').split(',') as Args['phases'],
    model: get('model', 'haiku') as Args['model'],
  };
}

// suiteId per (site, tenant) — warm/hot phases and repeat legs reuse it.
type State = Record<string, { suiteId: string; tenantId: string }>;
const loadState = (): State => (existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : {});
const state = loadState();
const saveState = () => { mkdirSync(OUT_DIR, { recursive: true }); writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); };

const log = (msg: string) => process.stdout.write(`${new Date().toISOString().slice(11, 19)} ${msg}\n`);

function dockerRestartWorker(): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('docker', ['compose', '-p', 'kaizen20', 'restart', 'worker'], { windowsHide: true }, (err, _o, stderr) =>
      err ? reject(new Error(stderr || err.message)) : resolve());
  });
}

async function suiteRunPhase(authRef: AuthRef, suiteId: string, label: string): Promise<{ details: RunDetail[]; caseNameOf: (runId: string) => string; durationMs: number; runIds: string[] }> {
  const names = new Map((await listCases(authRef, suiteId)).map((c) => [c.id, c.name]));
  const t0 = Date.now();
  const queued = await runSuite(authRef, suiteId);
  log(`${label}: ${queued.length} runs queued`);
  const details = await Promise.all(queued.map((q) => pollRun(authRef, q.runId)));
  const runToCase = new Map(queued.map((q) => [q.runId, q.caseId]));
  const byStatus = details.reduce<Record<string, number>>((m, r) => { m[r.status] = (m[r.status] ?? 0) + 1; return m; }, {});
  log(`${label}: done — ${JSON.stringify(byStatus)}`);
  return {
    details,
    caseNameOf: (runId) => names.get(runToCase.get(runId) ?? '') ?? runId.slice(0, 8),
    durationMs: Date.now() - t0,
    runIds: queued.map((q) => q.runId),
  };
}

async function main(): Promise<void> {
  const { site, tenant, phases, model } = parseArgs();
  await fetch(`${API}/health`).catch(() => { throw new Error(`API unreachable at ${API}`); });
  const inbox = await fetch('http://127.0.0.1:4141/v1/embeddings', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'text-embedding-3-small', input: 'preflight' }),
  }).catch(() => null);
  if (!inbox?.ok) throw new Error('LLM inbox not answering on :4141');
  if (site.preflightNote) log(`NOTE: ${site.preflightNote}`);

  const authRef = await tenantRef(tenant);
  log(`leg: site=${site.id} tenant=${tenant} (${authRef.auth.tenantId.slice(0, 8)}) model=${model} phases=${phases.join(',')}`);

  const stateKey = `${site.id}:${tenant}`;
  let suiteId = state[stateKey]?.suiteId;

  const phaseOutputs: Array<{ phase: string; details: RunDetail[]; caseNameOf: (id: string) => string; tokensTotal: number }> = [];
  const legEvidence: Record<string, unknown> = { site: site.id, tenant, tenantId: authRef.auth.tenantId, model, startedAt: new Date().toISOString() };

  for (const phase of phases) {
    if (phase === 'cold') {
      if (!suiteId) {
        suiteId = await createSuite(authRef, `portfolio ${site.id} ${tenant} ${new Date().toISOString().slice(0, 16)}`);
        const brief = readFileSync(join(__dirname, site.brief), 'utf8');
        // Authenticated leg: the sign-in case must exist BEFORE analyze — the
        // route validates loginCaseId eligibility up front.
        let loginCaseId: string | undefined;
        if (site.auth) {
          const seed = site.auth.loginSeed();
          loginCaseId = await seedCase(authRef, suiteId, seed.name, `${site.url}${seed.path}`, seed.steps);
          log(`cold: login case seeded (${loginCaseId.slice(0, 8)}) — analyze runs scope=authenticated`);
        }
        const jobId = await startAnalyze(authRef, suiteId, `${site.url}/`, brief, {
          ...site.analyze,
          ...(site.auth ? { scope: 'authenticated' as const, loginCaseId } : {}),
        });
        log(`cold: analyze job ${jobId} on suite ${suiteId}`);
        // 90 min: a haiku answerer's scenario calls run 70–90s each, and the
        // juice leg proved a heavy SPA legitimately needs >45 (job completed
        // at 51 min, six minutes after the default poll gave up).
        const job = await pollJob(authRef, jobId, { timeoutMin: 90, onPhase: (p) => log(`cold: analyze ${p}`) });
        if (job.status !== 'completed') throw new Error(`analyze ended ${job.status}: ${job.error}`);
        state[stateKey] = { suiteId, tenantId: authRef.auth.tenantId };
        saveState();
      } else {
        log(`cold: reusing suite ${suiteId} (state)`);
      }
      const { accepted, leftBehind } = await acceptValidated(authRef, suiteId);
      const existing = new Set((await listCases(authRef, suiteId)).map((c) => c.name));
      const seeds = typeof site.seedCases === 'function' ? site.seedCases() : site.seedCases;
      for (const seed of seeds) {
        if (existing.has(seed.name)) continue;
        await seedCase(authRef, suiteId, seed.name, `${site.url}${seed.path}`, seed.steps);
        log(`cold: seeded ${seed.name}`);
      }
      const active = (await listCases(authRef, suiteId)).filter((c) => c.status === 'active');
      log(`cold: ${accepted.length} accepted, ${active.length} active, ${leftBehind.length} left behind`);
      if (active.length === 0) throw new Error('no active cases');
    }
    if (!suiteId) throw new Error(`phase ${phase} without a suite — run cold first (state key ${stateKey})`);

    if (phase === 'hot') {
      log('hot: restarting worker (flushes in-process state; cache tiers must carry the rerun)');
      await dockerRestartWorker();
      await new Promise((r) => setTimeout(r, 8_000)); // worker boot + queue reattach
    }

    const out = await suiteRunPhase(authRef, suiteId, phase);
    const digest = digestPhase(out.details, out.caseNameOf);
    phaseOutputs.push({ phase, details: out.details, caseNameOf: out.caseNameOf, tokensTotal: digest.tokens.total });

    const rec: PhaseRecord = {
      at: new Date().toISOString(),
      site: site.id, siteKind: site.kind, loop: 'learning', phase,
      tenant, model, runIds: out.runIds,
      cases: digest.cases, tokens: digest.tokens,
      resolutionLlmSteps: digest.resolutionLlmSteps,
      sourceHistogram: digest.sourceHistogram,
      heals: digest.heals, durationMs: out.durationMs,
      flags: digest.flags,
    };
    appendRecord(rec);
    legEvidence[phase] = {
      runs: out.details.map((r) => ({
        runId: r.id, caseName: out.caseNameOf(r.id), status: r.status,
        steps: (r.stepResults ?? []).map((s) => ({
          i: s.step_index, text: s.rawText ?? null, status: s.status, source: s.resolution_source,
          selector: s.selector_used, errorType: s.error_type, failureClass: s.failure_class,
          tokens: s.tokens_used ?? 0,
          heals: (s.healingEvents ?? []).map((h) => ({ class: h.failure_class, strategy: h.strategy_used, ok: h.succeeded })),
        })),
      })),
      record: rec,
    };
    log(`${phase}: tokens=${digest.tokens.total} llmSteps=${digest.resolutionLlmSteps} sources=${JSON.stringify(digest.sourceHistogram)}${digest.flags.length ? ` FLAGS=${JSON.stringify(digest.flags)}` : ''}`);
  }

  const legFlags = judgeLearning(phaseOutputs);
  legEvidence.judge = { flags: legFlags };
  const file = join(OUT_DIR, `${site.id}-${tenant}-${model}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(file, JSON.stringify(legEvidence, null, 2));
  log(`leg evidence saved: ${file}`);

  if (legFlags.length > 0) {
    log(`JUDGE FLAGS (${legFlags.length}):`);
    for (const f of legFlags) log(`  ✗ ${f}`);
    process.exit(1);
  }
  log('JUDGE: leg clean — probes honest, no staleness, token trajectory sane.');
}

main().catch((e) => { console.error(e); process.exit(1); });
