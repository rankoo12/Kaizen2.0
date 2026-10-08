/**
 * Changing-sites bench — judge CLI. Re-judges saved evidence without re-running.
 *
 *   npx tsx benchmarks/changing-sites/judge-cli.ts            # judge every site's latest evidence
 *   npx tsx benchmarks/changing-sites/judge-cli.ts --site vanilla
 *
 * Reads the newest results/<site>-*.json per site, applies the expectations,
 * prints a per-case verdict table and the fleet scoreboard. Exit 1 on any
 * FAIL / FALSE-PASS / negative-control violation (GAPs report, don't fail).
 * Spec: docs/specs/bench/spec-changing-sites.md §7-§8
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXPECTATIONS } from './expectations';
import { judgeSite } from './lib/judge';
import type { SiteEvidence, SiteVerdict } from './lib/types';

const OUT_DIR = join(__dirname, 'results');

function latestEvidence(site: string): SiteEvidence | null {
  let files: string[];
  try {
    files = readdirSync(OUT_DIR).filter((f) => f.startsWith(`${site}-`) && f.endsWith('.json')).sort();
  } catch { return null; }
  if (files.length === 0) return null;
  return JSON.parse(readFileSync(join(OUT_DIR, files[files.length - 1]), 'utf8')) as SiteEvidence;
}

function mutatedVersions(evidence: SiteEvidence): string[] {
  return Object.keys(evidence).filter((k) => k.startsWith('r2_')).map((k) => k.slice(3));
}

function printSite(v: SiteVerdict): void {
  process.stdout.write(`\n═══ ${v.site} @ ${v.version} ═══\n`);
  for (const c of v.verdicts) {
    const mark = c.verdict === 'PASS' ? '✓' : c.verdict === 'GAP' ? '◐' : '✗';
    process.stdout.write(`  ${mark} ${c.verdict.padEnd(10)} ${c.caseName.slice(0, 56).padEnd(56)} [${c.expectationId}]\n`);
    for (const r of c.reasons) process.stdout.write(`      · ${r}\n`);
  }
  for (const n of v.negativeControlViolations) process.stdout.write(`  ⚠ NEGATIVE CONTROL: ${n}\n`);
}

function main(): void {
  const a = process.argv.slice(2);
  const i = a.indexOf('--site');
  const only = i >= 0 ? a[i + 1] : null;
  const sites = only ? [only] : Object.keys(EXPECTATIONS);

  const all: SiteVerdict[] = [];
  for (const site of sites) {
    const evidence = latestEvidence(site);
    if (!evidence) { process.stdout.write(`(no evidence for ${site} — skipped)\n`); continue; }
    const exps = EXPECTATIONS[site];
    if (!exps) { process.stdout.write(`(no expectations for ${site} — skipped)\n`); continue; }
    for (const version of mutatedVersions(evidence)) {
      const verdict = judgeSite(evidence, exps, version);
      printSite(verdict);
      all.push(verdict);
    }
  }

  process.stdout.write('\n══════════ FLEET SCOREBOARD ══════════\n');
  process.stdout.write('site               PASS  GAP  FAIL  FALSE-PASS  neg-ctrl\n');
  let hardFails = 0;
  for (const v of all) {
    hardFails += v.counts.FAIL + v.counts['FALSE-PASS'] + v.negativeControlViolations.length;
    process.stdout.write(
      `${v.site.padEnd(18)} ${String(v.counts.PASS).padStart(4)} ${String(v.counts.GAP).padStart(4)} ${String(v.counts.FAIL).padStart(5)} ${String(v.counts['FALSE-PASS']).padStart(11)} ${String(v.negativeControlViolations.length).padStart(9)}\n`);
  }
  process.stdout.write(hardFails === 0
    ? '\nBENCH: GREEN — no false-passes, no decoy grabs, no negative-control violations.\n'
    : `\nBENCH: ${hardFails} hard failure(s).\n`);
  if (hardFails > 0) process.exit(1);
}

main();
