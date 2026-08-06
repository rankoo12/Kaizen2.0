import { createHash } from 'crypto';
import { normaliseStepText } from '../../test-compiler/learned.compiler';
import { isAssertion } from './step-intent.schema';

/**
 * Kind-aware dedup.
 * Spec: docs/specs/test-writer/spec-generation-pipeline.md §4.5
 *
 * Two guards, and one subtlety that matters: a happy path and its negative
 * twin share most of their steps and differ only in the input and the oracle.
 * Comparing whole step lists across kinds silently collapses the pair and
 * throws away the negative — the more valuable of the two. So comparison is
 * scoped WITHIN kind, and the fingerprint keeps the oracle steps that carry
 * the difference.
 */

export type DedupCandidate = {
  planRef: string;
  kind: 'positive' | 'negative';
  name: string;
  /** Rendered canonical sentences. */
  steps: string[];
};

export type DedupResult = {
  kept: DedupCandidate[];
  dropped: Array<{ planRef: string; name: string; duplicateOf: string }>;
};

/** Stable fingerprint of a scenario's action sequence, kind-scoped. */
export function fingerprint(kind: string, steps: string[]): string {
  const body = steps.map((s) => normaliseStepText(s)).join(' | ');
  return createHash('sha256').update(`${kind}::${body}`).digest('hex');
}

/**
 * Cheap lexical similarity over the ACTION steps only (assertions excluded):
 * two scenarios that do the same things and differ only in what they check are
 * still different tests.
 */
function actionSignature(steps: string[]): Set<string> {
  return new Set(
    steps
      .filter((s) => !/^verify /i.test(s.trim()))
      .map((s) => normaliseStepText(s)),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const item of a) if (b.has(item)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * @param existing - fingerprints of the suite's existing cases (per kind), so a
 *   generated scenario that repeats one the tenant already owns is dropped.
 */
export function dedupeScenarios(
  candidates: DedupCandidate[],
  existing: Array<{ kind: string; steps: string[]; name: string }> = [],
  similarityThreshold = 0.9,
): DedupResult {
  const kept: DedupCandidate[] = [];
  const dropped: DedupResult['dropped'] = [];

  const seen = new Map<string, string>();  // fingerprint → owning name
  for (const prior of existing) {
    seen.set(fingerprint(prior.kind, prior.steps), prior.name);
  }
  const keptSignatures: Array<{ name: string; kind: string; sig: Set<string> }> = existing.map((e) => ({
    name: e.name, kind: e.kind, sig: actionSignature(e.steps),
  }));

  for (const candidate of candidates) {
    const fp = fingerprint(candidate.kind, candidate.steps);
    const exact = seen.get(fp);
    if (exact) {
      dropped.push({ planRef: candidate.planRef, name: candidate.name, duplicateOf: exact });
      continue;
    }

    const sig = actionSignature(candidate.steps);
    const near = keptSignatures.find(
      (k) => k.kind === candidate.kind && jaccard(k.sig, sig) >= similarityThreshold,
    );
    if (near) {
      dropped.push({ planRef: candidate.planRef, name: candidate.name, duplicateOf: near.name });
      continue;
    }

    seen.set(fp, candidate.name);
    keptSignatures.push({ name: candidate.name, kind: candidate.kind, sig });
    kept.push(candidate);
  }

  return { kept, dropped };
}

export { isAssertion };
