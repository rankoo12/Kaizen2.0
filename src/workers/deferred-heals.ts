/**
 * Run-outcome-deferred heal persistence.
 * Spec: docs/specs/roadmap/spec-research-adoption-2026-11.md §S4
 *
 * Split from worker.ts (which starts its BullMQ consumer at import) so the rules
 * are unit-testable, like name-fidelity.ts.
 *
 * THE PROBLEM. A heal whose pick shares too few words with the step's target
 * (a legitimate rename — "Post" → "Publish", "Accept" → "Confirm") cannot earn the
 * selector cache on NAME evidence: provenance bypasses the worker's serve-time
 * name gate, so a persistence gate weaker than that gate is a poison vector
 * (finding #16). Before this module such renames healed the run and then
 * re-healed on every later run, forever.
 *
 * THE FIX. What tells a right rename from a wrong pick is the run's OUTCOME, which
 * only exists later. ResolveAndRetry therefore hands the write back as a closure;
 * the worker records it here together with one fact measured BEFORE the healed
 * click — whether the text of the assertion right after it was already on the
 * page. At run end a pending heal is committed only when ALL of these hold:
 *   1. the run passed (every later step, the assertion included, passed);
 *   2. an `assert_text` sits in the block of assertions immediately after the
 *      healed action (no interaction in between — the outcome is the action's);
 *   3. that text was demonstrably ABSENT before the healed click — so it exists
 *      because of the click, not despite it. An assertion that was already true
 *      proves nothing about which element was clicked.
 * Everything else is discarded and the cache is exactly as it was.
 */
import type { StepAST } from '../types';

type FrameLike = { evaluate<R>(fn: () => R): Promise<R> };
type PageLike = { frames(): FrameLike[] };

const normalize = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * The text the assertion block right after `healedIndex` expects to see, or null.
 * Scans only CONTIGUOUS assertion steps: the moment another interaction appears,
 * whatever it asserts later is no longer "the outcome of the healed action". A
 * plain `wait` is transparent — it only lets time pass, so an assertion after it
 * is still the healed action's outcome ("click Post, wait 1.5s, verify the post
 * is shown"; found live on the social bench). A `{{variable}}` value is skipped —
 * it is not concrete until the run resolves it.
 */
export function immediateOutcomeText(steps: StepAST[], healedIndex: number): string | null {
  for (let i = healedIndex + 1; i < steps.length; i++) {
    const s = steps[i];
    if (s.action === 'wait') continue;
    if (!s.action.startsWith('assert')) return null;
    if (s.action === 'assert_text') {
      const v = (s.value ?? '').trim();
      if (v && !v.includes('{{')) return v;
    }
  }
  return null;
}

/**
 * Whether any frame currently renders `text`. true / false, or null when no frame
 * could be read at all — "unknown" must never be mistaken for "absent", because
 * absent is the claim that lets a heal into the cache. Uses innerText, i.e. what
 * is actually rendered.
 */
export async function pageShowsText(page: PageLike, text: string): Promise<boolean | null> {
  const needle = normalize(text);
  if (!needle) return null;
  let readAny = false;
  for (const frame of page.frames()) {
    try {
      const body = await frame.evaluate(() => document.body?.innerText ?? '');
      readAny = true;
      if (normalize(body).includes(needle)) return true;
    } catch {
      // A detached or cross-process frame: skip it, but remember we could not read it.
    }
  }
  return readAny ? false : null;
}

export type PendingHeal = {
  stepIndex: number;
  /** Writes the healed selector to selector_cache. Held back until corroborated. */
  persist: () => Promise<void>;
  /** Text the assertion block right after the healed action expects, if any. */
  outcomeText: string | null;
  /** Was that text on the page before the healed click? null = could not tell. */
  outcomePresentBefore: boolean | null;
};

export type SettleDecision =
  | 'commit'
  | 'run_not_passed'
  | 'no_outcome_assertion'
  | 'outcome_unknown'
  | 'outcome_already_present';

export function settleDecision(
  p: PendingHeal,
  run: { runPassed: boolean; cancelled: boolean },
): SettleDecision {
  if (!run.runPassed || run.cancelled) return 'run_not_passed';
  if (!p.outcomeText) return 'no_outcome_assertion';
  if (p.outcomePresentBefore === null) return 'outcome_unknown';
  if (p.outcomePresentBefore) return 'outcome_already_present';
  return 'commit';
}

export type SettlePlanItem = { pending: PendingHeal; decision: SettleDecision };

/** One run's pending heals. A fresh instance per run attempt. */
export class DeferredHeals {
  private readonly pending = new Map<number, PendingHeal>();

  constructor(private readonly steps: StepAST[]) {}

  /** The outcome text to watch for, for a heal at `stepIndex`. */
  outcomeTextAfter(stepIndex: number): string | null {
    return immediateOutcomeText(this.steps, stepIndex);
  }

  record(p: PendingHeal): void {
    this.pending.set(p.stepIndex, p);
  }

  get size(): number {
    return this.pending.size;
  }

  /** Decide every pending heal — synchronous, so the worker can log the decisions. */
  plan(run: { runPassed: boolean; cancelled: boolean }): SettlePlanItem[] {
    return [...this.pending.values()].map((pending) => ({ pending, decision: settleDecision(pending, run) }));
  }

  /** Persist the committed ones. A failing write never throws out of here. */
  async commit(plan: SettlePlanItem[]): Promise<{ committed: number; failed: number }> {
    let committed = 0;
    let failed = 0;
    for (const item of plan) {
      if (item.decision !== 'commit') continue;
      try {
        await item.pending.persist();
        committed++;
      } catch {
        failed++;
      }
    }
    return { committed, failed };
  }
}
