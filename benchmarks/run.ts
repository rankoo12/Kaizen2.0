/**
 * Kaizen resolution-robustness benchmark runner.
 *
 *   npm run bench                      # score all fixtures vs baseline (regression guard)
 *   npm run bench -- --only=id1,id2    # subset
 *   npm run bench -- --category=e2e-flow
 *   npm run bench -- --no-evict        # warm-only quick sanity (skip cold eviction)
 *   npm run bench -- --write-baseline  # rewrite baseline.scorecard.json (commit the delta)
 *
 * Requires: KAIZEN_KEY (execute scope); API on :3000; postgres + redis up.
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { connect, disconnect, runAll } from './lib/harness';
import { scoreTest, aggregate } from './lib/score';
import { validateVisually, visualEnabled } from './lib/visual';
import { ALL_TESTS } from './fixtures';
import type { TestScore, Scorecard, BenchmarkTest } from './lib/types';

const HERE = __dirname;
const BASELINE = join(HERE, 'baseline.scorecard.json');
const LATEST = join(HERE, 'scorecard.latest.json');

function arg(name: string): string | undefined {
  const p = process.argv.find((a) => a.startsWith(`--${name}=`));
  return p ? p.split('=')[1] : undefined;
}
const has = (name: string) => process.argv.includes(`--${name}`);

function pad(s: string | number, n: number) { return String(s).padEnd(n).slice(0, n); }
function padL(s: string | number, n: number) { return String(s).padStart(n); }

async function main() {
  const only = arg('only')?.split(',');
  const category = arg('category');
  const noEvict = has('no-evict');
  const writeBaseline = has('write-baseline');
  // Screenshot validation: a vision model judges each test's outcome frame, layered on the
  // oracle. ON by default when OPENAI_API_KEY is set; disable with --no-visual.
  const doVisual = !has('no-visual') && visualEnabled();
  if (has('visual') && !visualEnabled()) console.warn('⚠ --visual requested but OPENAI_API_KEY is not set — skipping visual validation.');

  let tests = ALL_TESTS;
  if (only) tests = tests.filter((t) => only.includes(t.id));
  if (category) tests = tests.filter((t) => t.category === category);
  if (!tests.length) { console.error('no fixtures matched'); process.exit(1); }

  await connect();
  const CONC = Number(process.env.BENCH_CONCURRENCY ?? 5) || 5;
  console.log(`Running ${tests.length} fixture(s)${noEvict ? ' (warm-only)' : ' cold→warm'} — parallelism ${CONC}…\n`);

  const scores: TestScore[] = [];
  let done = 0;
  const results = await runAll(tests, {
    concurrency: CONC,
    evict: !noEvict,
    onResult: (t, cw) => {
      const s = scoreTest(t, cw);
      scores.push(s);
      const flag = s.green ? 'GREEN' : s.knownLimitation ? `TRACK(${s.knownLimitation})` : 'RED';
      console.log(`▶ [${String(++done).padStart(3)}/${tests.length}] ${pad(t.id, 30)} ${pad(flag, 22)} c=${pad(s.coldStatus, 6)} w=${pad(s.warmStatus, 6)} tok ${s.coldTokens}→${s.warmTokens}${s.blindSpotSteps.length ? ` blind[${s.blindSpotSteps.join(',')}]` : ''}`);
      for (const n of s.notes) console.log(`        · ${n}`);
    },
  });

  // ── screenshot validation: a vision model looks at each test's outcome frame ──
  if (doVisual) {
    console.log(`\nVisual validation — vision model judging outcome screenshots (${scores.length} tests)…`);
    const testById = new Map<string, BenchmarkTest>(tests.map((t) => [t.id, t]));
    const ids = scores.map((s) => s.id);
    let vi = 0;
    const vworker = async () => {
      while (vi < ids.length) {
        const s = scores[vi++];
        const test = testById.get(s.id);
        const cw = results.get(s.id);
        if (!test || !cw) continue;
        const run = cw.warm.steps.some((x) => x.shot) ? cw.warm : cw.cold;
        const v = await validateVisually(test, run);
        // Divergence = the eye disagrees with the functional oracle. THE signal to inspect:
        // oracle-red/visual-green (assertion mis-fired) or oracle-green/visual-red (false pass).
        if (v.ran && v.pass != null) v.diverges = v.pass !== s.verdictOk;
        s.visual = v;
        const tag = !v.ran ? 'skip' : v.pass == null ? 'err ' : v.pass ? 'PASS' : 'FAIL';
        console.log(`  ${pad(s.id, 30)} 👁 ${tag}${v.diverges ? '  ⚠ DIVERGES-FROM-ORACLE' : ''}  ${(v.observed || v.reason || v.error || '').slice(0, 80)}`);
      }
    };
    await Promise.all(Array.from({ length: 4 }, vworker));
  }

  const card = aggregate(scores, new Date(Number(process.env.BENCH_TS ?? Date.now())).toISOString());

  // ── table ──
  console.log('\n================================= SCORECARD =================================');
  console.log(`${pad('id', 32)} ${pad('cat', 8)} ${pad('verdict', 8)} ${pad('learn', 6)} ${pad('wrong', 6)} ${pad('blind', 6)} ${pad('c→w tok', 10)} ${pad('grn', 4)}${doVisual ? ' 👁' : ''}`);
  for (const s of scores) {
    const vis = !s.visual?.ran ? '' : s.visual.pass == null ? ' ?' : s.visual.diverges ? (s.visual.pass ? ' ⚠✓' : ' ⚠✗') : (s.visual.pass ? ' ✓' : ' ✗');
    console.log(`${pad(s.id, 32)} ${pad(s.category.replace('adversarial-negative', 'adv-neg').replace('small-feature', 'small'), 8)} ${pad(s.verdictOk ? 'ok' : 'BAD', 8)} ${pad(s.mustLearnOk ? 'ok' : (s.knownLimitation ? 'trk' : 'NO'), 6)} ${pad(s.wrongElement ? 'YES' : '-', 6)} ${pad(s.blindSpotSteps.length || '-', 6)} ${pad(`${s.coldTokens}→${s.warmTokens}`, 10)} ${pad(s.green ? '✓' : (s.knownLimitation ? '~' : '✗'), 4)}${doVisual ? vis : ''}`);
  }
  const a = card.aggregate;
  console.log('\n' + `total=${a.total}  green=${a.green}  verdict-correct=${a.verdictCorrect}/${a.total}  must-learn=${a.mustLearnPass}/${a.total}  wrong-element=${a.wrongElement}  blind-spot-steps=${a.blindSpotSteps}  tokens cold=${a.coldTokens} warm=${a.warmTokens}`);
  if (doVisual && a.visualChecked != null) {
    console.log(`visual: pass=${a.visualPass}/${a.visualChecked}  diverge-from-oracle=${a.visualDiverge}`);
    const div = scores.filter((s) => s.visual?.diverges);
    if (div.length) {
      console.log('  ⚠ oracle/screenshot DISAGREE (inspect these):');
      for (const s of div) console.log(`    · ${s.id}: oracle ${s.verdictOk ? 'pass' : 'FAIL'} but eye says ${s.visual!.pass ? 'PASS' : 'fail'} — ${s.visual!.observed || s.visual!.reason}`);
    }
  }

  writeFileSync(LATEST, JSON.stringify(card, null, 2));

  // ── baseline write / regression diff ──
  let exit = 0;
  if (writeBaseline) {
    writeFileSync(BASELINE, JSON.stringify(card, null, 2));
    console.log(`\nbaseline written → ${BASELINE}`);
  } else if (existsSync(BASELINE)) {
    const base: Scorecard = JSON.parse(readFileSync(BASELINE, 'utf8'));
    const byId = new Map(base.tests.map((t) => [t.id, t]));
    const regressions: string[] = [];
    const progress: string[] = [];
    for (const s of scores) {
      const b = byId.get(s.id);
      if (!b) { progress.push(`NEW ${s.id} (${s.green ? 'green' : 'red'})`); continue; }
      if (b.green && !s.green) regressions.push(`${s.id}: green→red`);
      if (!b.green && s.green) progress.push(`${s.id}: red→GREEN`);
      if (b.verdictOk && !s.verdictOk) regressions.push(`${s.id}: verdict regressed`);
      if (s.warmTokens > b.warmTokens && s.warmTokens - b.warmTokens > 20) regressions.push(`${s.id}: warm tokens ${b.warmTokens}→${s.warmTokens}`);
      if (s.blindSpotSteps.length > b.blindSpotSteps.length) regressions.push(`${s.id}: blind spots ${b.blindSpotSteps.length}→${s.blindSpotSteps.length}`);
    }
    console.log('\n── vs baseline ──');
    if (progress.length) console.log('  progress: ' + progress.join(' · '));
    if (regressions.length) { console.log('  REGRESSIONS:\n' + regressions.map((r) => '    ✗ ' + r).join('\n')); exit = 1; }
    if (!progress.length && !regressions.length) console.log('  no change');
  } else {
    console.log(`\nno baseline yet — run with --write-baseline to establish one`);
  }

  await disconnect();
  process.exit(exit);
}
main().catch((e) => { console.error(e); process.exit(1); });
