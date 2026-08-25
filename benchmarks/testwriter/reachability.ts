/**
 * Reachability audit — could the pipeline even WRITE each reference test?
 *
 *   npx tsx reachability.ts --reference reference/kaizen30.json [--suite <id>]
 *
 * For every reference entry it checks, against the STORED site model of the
 * latest (or given) bench suite, with no browser and no LLM:
 *
 *   1. observed   — every control the test needs exists in page_elements;
 *   2. plannable  — each control survives into the planner dossier
 *                   (chrome rules + the per-page cap in listPageDossiers);
 *   3. writable   — each control survives into the writer grounding, and a
 *                   scenario touching only these controls would pass the
 *                   chrome-only write gate;
 *   4. oracle     — the oracle mechanism the entry needs exists (rows for
 *                   row-asserts, an element for attr-asserts, …);
 *   5. fixture    — any fixture the entry names is noted, not judged.
 *
 * Every blocked entry names its gate. Iterate here in seconds; burn a real run
 * only when this board is green. Works against any stored site model — point
 * it at the-internet's suite and the same board grades that site.
 * Spec: docs/specs/test-writer/spec-close-the-gap-32.md
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { Pool } from 'pg';
import * as dotenv from 'dotenv';

dotenv.config({ path: join(__dirname, '../../.env') });

type Entry = {
  id: number; area: string; name: string; controls: string[];
  assertVia: 'text' | 'delta' | 'row' | 'attr' | 'state';
  exploratory?: boolean; fixture?: string;
};

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : null;
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
const matches = (need: string, have: string) =>
  norm(have).includes(norm(need)) || norm(need).includes(norm(have));

async function main(): Promise<void> {
  const refPath = arg('reference') ?? 'reference/kaizen30.json';
  const ref = JSON.parse(readFileSync(join(__dirname, refPath), 'utf8')) as { site: string; entries: Entry[] };
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  const suiteId = arg('suite') ?? (await pool.query(
    `SELECT id FROM test_suites WHERE tenant_id = (SELECT id FROM tenants WHERE name = 'Bench')
      ORDER BY created_at DESC LIMIT 1`)).rows[0]?.id;
  if (!suiteId) throw new Error('no bench suite found');

  // The full observed surface.
  const observed = (await pool.query(
    `SELECT pe.role, pe.name, pe.kind, pe.revealed_by,
            pe.attributes->>'nav-context' AS nav, (pe.attributes ? 'aria-current') AS current
       FROM page_elements pe JOIN site_pages sp ON sp.id = pe.page_id
      WHERE sp.suite_id = $1 AND pe.name <> ''`, [suiteId])).rows as
    Array<{ role: string; name: string; kind: string; revealed_by: string | null; nav: string | null; current: boolean }>;

  // Chrome as listPageDossiers computes it (count rule + nav rule + creation exception).
  const pages = Number((await pool.query(
    `SELECT count(*) FROM site_pages WHERE suite_id = $1`, [suiteId])).rows[0].count);
  const byName = new Map<string, number>();
  for (const { rows } of [await pool.query(
    `SELECT pe.role || '|' || pe.name AS k, count(DISTINCT pe.page_id) AS n
       FROM page_elements pe JOIN site_pages sp ON sp.id = pe.page_id
      WHERE sp.suite_id = $1 AND pe.name <> '' GROUP BY 1`, [suiteId])]) {
    for (const r of rows) byName.set(r.k, Number(r.n));
  }
  const creation = /^(new|add|create)\b/i;
  const isChrome = (el: { role: string; name: string; nav: string | null; current: boolean }): boolean => {
    if (creation.test(el.name)) return false;
    if (pages >= 5 && (byName.get(`${el.role}|${el.name}`) ?? 0) >= 0.6 * pages) return true;
    if (el.nav && ['nav', 'aside', 'header', 'navigation', 'menubar', 'nav-class'].includes(el.nav)) return true;
    return el.current === true;
  };

  // Planner dossier: round-robin cap per page — approximated site-wide here by
  // asking "does the control survive chrome?" (the cap is per page; round-robin
  // means a control's KIND must not be starved — flag kinds over the cap).
  const rowsExist = observed.some((el) => el.role === 'row');

  // The reach-path exception of the chrome-only write gate: clicking exactly
  // the controls a screen is reached by IS testing that screen's opening.
  const reachNames = new Set<string>();
  for (const r of (await pool.query(
    `SELECT reached_by FROM site_pages WHERE suite_id = $1 AND reached_by IS NOT NULL`, [suiteId])).rows) {
    for (const hop of (r.reached_by as Array<{ name?: string }> | null) ?? []) {
      if (hop?.name) reachNames.add(norm(hop.name));
    }
  }

  let reachable = 0, blocked = 0, exploratory = 0;
  const lines: string[] = [];
  for (const e of ref.entries) {
    const gates: string[] = [];
    const found: Array<{ name: string; chrome: boolean }> = [];
    for (const need of e.controls) {
      const el = observed.find((o) => matches(need, o.name));
      if (!el) { gates.push(`not observed: "${need}"`); continue; }
      found.push({ name: el.name, chrome: isChrome(el) });
    }
    // chrome-only write gate (with the reach/behaviour exceptions of run 16)
    const interactive = found.filter((f) => f.name);
    if (interactive.length > 0 && interactive.every((f) => f.chrome)) {
      const behaviour = interactive.every((f) => /^(hide|show|toggle|collapse|expand|open|close|refresh)\b/i.test(f.name));
      const allReach = interactive.every((f) => reachNames.has(norm(f.name)));
      if (!behaviour && !allReach) gates.push(`chrome-only: ${interactive.map((f) => `"${f.name}"`).join(', ')}`);
    }
    if (e.assertVia === 'row' && !rowsExist) gates.push('oracle: no row surface in the survey');
    if (e.fixture) gates.push(`fixture needed: ${e.fixture}`);

    const status = gates.length === 0 ? 'REACHABLE' : (e.exploratory ? 'exploratory' : 'BLOCKED');
    if (status === 'REACHABLE') reachable++; else if (status === 'BLOCKED') blocked++; else exploratory++;
    lines.push(`  ${status === 'REACHABLE' ? '✓' : status === 'BLOCKED' ? '✗' : '?'} #${String(e.id).padStart(2)} ${e.name.padEnd(36)} ${gates.join(' · ')}`);
  }
  process.stdout.write(`reachability — ${ref.site} — suite ${suiteId}\n`);
  for (const l of lines) process.stdout.write(l + '\n');
  process.stdout.write(`\n${reachable} reachable · ${blocked} blocked · ${exploratory} exploratory-with-gates of ${ref.entries.length}\n`);
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
