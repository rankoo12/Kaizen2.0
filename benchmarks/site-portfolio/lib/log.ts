/**
 * Site-portfolio bench — the §9a logging contract.
 * Spec: docs/specs/bench/spec-site-portfolio.md §9a
 *
 * One appended record per loop phase. The end-of-campaign dashboard is
 * DERIVED from these records; anything it cannot derive was not logged, so
 * this file is the contract, not a convenience.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { RunDetail } from '../../changing-sites/lib/api';

export const OUT_DIR = join(__dirname, '..', 'results');
const CAMPAIGN_FILE = join(OUT_DIR, 'campaign.jsonl');

export type PhaseRecord = {
  at: string;
  site: string;
  siteKind: 'fleet' | 'real' | 'nightmare';
  loop: 'mutation' | 'learning';
  phase: 'r1' | 'r2' | 'r3' | 'cold' | 'warm' | 'hot';
  tenant: string;
  model: 'haiku' | 'sonnet';
  runIds: string[];
  cases: { passed: number; failed: number; healed: number };
  tokens: { total: number; perCase: Record<string, number> };
  resolutionLlmSteps: number;
  sourceHistogram: Record<string, number>;
  heals: { attempted: number; succeeded: number; byStrategy: Record<string, number> };
  durationMs: number;
  flags: string[]; // judge-lite findings: staleness, false-pass guards, probe violations
  notes?: string;
};

export function appendRecord(rec: PhaseRecord): void {
  mkdirSync(OUT_DIR, { recursive: true });
  appendFileSync(CAMPAIGN_FILE, JSON.stringify(rec) + '\n');
}

/** Everything a PhaseRecord needs, computed from the suite run's details. */
export function digestPhase(details: RunDetail[], caseNameOf: (runId: string) => string): {
  cases: PhaseRecord['cases'];
  tokens: PhaseRecord['tokens'];
  resolutionLlmSteps: number;
  sourceHistogram: Record<string, number>;
  heals: PhaseRecord['heals'];
  flags: string[];
} {
  const cases = { passed: 0, failed: 0, healed: 0 };
  const perCase: Record<string, number> = {};
  const sourceHistogram: Record<string, number> = {};
  const byStrategy: Record<string, number> = {};
  let total = 0, llmSteps = 0, attempted = 0, succeeded = 0;
  const flags: string[] = [];

  for (const r of details) {
    if (r.status === 'passed') cases.passed++;
    else if (r.status === 'healed') cases.healed++;
    else cases.failed++;
    const name = caseNameOf(r.id);
    let caseTokens = 0;
    for (const s of r.stepResults ?? []) {
      caseTokens += s.tokens_used ?? 0;
      if (s.resolution_source) {
        sourceHistogram[s.resolution_source] = (sourceHistogram[s.resolution_source] ?? 0) + 1;
        if (s.resolution_source === 'llm') llmSteps++;
      }
      for (const h of s.healingEvents ?? []) {
        attempted++;
        if (h.succeeded) succeeded++;
        byStrategy[h.strategy_used] = (byStrategy[h.strategy_used] ?? 0) + 1;
      }
      // Negative control, fleet rule: this error on a GREEN run is a lie.
      if (s.error_type === 'AssertionHealedOntoDifferentElement' && (r.status === 'passed' || r.status === 'healed')) {
        flags.push(`NEG-CTRL: AssertionHealedOntoDifferentElement on green run ${r.id} (${name})`);
      }
    }
    perCase[name] = (perCase[name] ?? 0) + caseTokens;
    total += caseTokens;
  }
  return { cases, tokens: { total, perCase }, resolutionLlmSteps: llmSteps, sourceHistogram, heals: { attempted, succeeded, byStrategy }, flags };
}

/**
 * Judge-lite across a learning loop's phases (real sites do not mutate, so
 * honesty is judged on trajectories and probes, not mutation expectations):
 * - MUST-FAIL probes (case name starts "PROBE-MUSTFAIL") red in EVERY phase;
 *   a green probe is a FALSE-PASS.
 * - staleness: a case green cold but red warm/hot — the cache made it worse.
 * - token trajectory: warm ≤ cold and hot ≤ warm (resolution memory works).
 */
export function judgeLearning(phases: Array<{ phase: string; details: RunDetail[]; caseNameOf: (runId: string) => string; tokensTotal: number }>): string[] {
  const flags: string[] = [];
  const statusByCase = new Map<string, Record<string, string>>();
  for (const p of phases) {
    for (const r of p.details) {
      const name = p.caseNameOf(r.id);
      const entry = statusByCase.get(name) ?? {};
      entry[p.phase] = r.status;
      statusByCase.set(name, entry);
    }
  }
  for (const [name, by] of statusByCase) {
    if (name.startsWith('PROBE-MUSTFAIL')) {
      for (const [phase, status] of Object.entries(by)) {
        if (status !== 'failed') flags.push(`FALSE-PASS: probe "${name}" went ${status} in ${phase}`);
      }
    } else if (by.cold === 'passed' && (by.warm === 'failed' || by.hot === 'failed')) {
      flags.push(`STALENESS: "${name}" passed cold but failed ${by.warm === 'failed' ? 'warm' : 'hot'}`);
    }
  }
  for (let i = 1; i < phases.length; i++) {
    if (phases[i].tokensTotal > phases[i - 1].tokensTotal) {
      flags.push(`TOKEN-TRAJECTORY: ${phases[i].phase} spent ${phases[i].tokensTotal} > ${phases[i - 1].phase}'s ${phases[i - 1].tokensTotal}`);
    }
  }
  return flags;
}
