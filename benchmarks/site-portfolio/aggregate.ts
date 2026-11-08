/**
 * Site-portfolio bench — dashboard data aggregator.
 * Spec: docs/specs/bench/spec-site-portfolio.md §9/§9a
 *
 *   npx tsx benchmarks/site-portfolio/aggregate.ts
 *
 * DERIVES results/dashboard-data.json from the primary records — campaign.jsonl
 * (learning-loop §9a records) and the LATEST evidence JSON per mutation site,
 * re-judged through the real judge (never hand-copied scoreboards). Every fleet
 * row carries its evidence file's timestamp, because stale-replay masqueraded
 * as results twice on 2026-11-08 and the dashboard must make freshness visible.
 */
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { judgeSite } from '../changing-sites/lib/judge';
import { EXPECTATIONS } from '../changing-sites/expectations';
import { FLEET } from '../changing-sites/fleet';
import type { SiteEvidence } from '../changing-sites/lib/types';

const PORTFOLIO_RESULTS = join(__dirname, 'results');
const FLEET_RESULTS = join(__dirname, '..', 'changing-sites', 'results');

function latestEvidence(siteId: string): { file: string; at: string; evidence: SiteEvidence } | null {
  const files = readdirSync(FLEET_RESULTS)
    .filter((f) => f.startsWith(`${siteId}-`) && f.endsWith('.json'))
    .sort(); // ISO timestamps in names sort chronologically
  if (files.length === 0) return null;
  const file = files[files.length - 1];
  const at = /(\d{4}-\d{2}-\d{2}T[\d-]+Z)/.exec(file)?.[1]?.replace(/-(\d{2})-(\d{2})-(\d+)Z$/, ':$1:$2.$3Z') ?? '';
  return { file, at, evidence: JSON.parse(readFileSync(join(FLEET_RESULTS, file), 'utf8')) as SiteEvidence };
}

function main(): void {
  // ── Learning-loop records (§9a) ────────────────────────────────────────────
  const jsonlPath = join(PORTFOLIO_RESULTS, 'campaign.jsonl');
  const records = existsSync(jsonlPath)
    ? readFileSync(jsonlPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    : [];

  // ── Mutation sites: latest evidence, re-judged live ────────────────────────
  const fleet = FLEET.map((site) => {
    const latest = latestEvidence(site.id);
    if (!latest) return { site: site.id, missing: true };
    const version = site.versions[site.versions.length - 1];
    const exps = EXPECTATIONS[site.id];
    const verdict = exps ? judgeSite(latest.evidence, exps, version) : null;
    return {
      site: site.id,
      evidenceFile: latest.file,
      evidenceAt: latest.at,
      version,
      counts: verdict?.counts ?? null,
      negativeControlViolations: verdict?.negativeControlViolations ?? [],
      verdicts: verdict?.verdicts.map((v) => ({
        caseName: v.caseName, expectationId: v.expectationId, outcome: v.outcome,
        verdict: v.verdict, reasons: v.reasons,
      })) ?? [],
    };
  });

  const manifest = JSON.parse(readFileSync(join(PORTFOLIO_RESULTS, 'campaign-manifest.json'), 'utf8'));

  const out = {
    generatedAt: new Date().toISOString(),
    manifest,
    records,
    fleet,
  };
  const outPath = join(PORTFOLIO_RESULTS, 'dashboard-data.json');
  writeFileSync(outPath, JSON.stringify(out, null, 1));
  const fresh = fleet.filter((f) => 'evidenceAt' in f && String(f.evidenceAt).startsWith(new Date().toISOString().slice(0, 10)));
  console.log(`dashboard-data.json: ${records.length} §9a records, ${fleet.length} fleet sites (${fresh.length} with evidence fresh today) → ${outPath}`);
}

main();
