# Spec: Worker — Stop Run On Unrecovered Step Failure

**Status:** Draft
**Created:** 2026-04-24
**Updated:** 2026-04-24
**Branch:** `fix/element-resolver/cache-semantic-guard` (bundled with the cache semantic guard per user request: "One focused fix")
**Depends on:**
- [src/workers/worker.ts](../../../src/workers/worker.ts)
- [src/types/index.ts](../../../src/types/index.ts) — `StepResultStatus = 'passed' | 'failed' | 'healed' | 'skipped'` already exists

---

## Problem

When a step fails _and_ the healing engine cannot recover it, the current worker loop keeps iterating through the remaining steps. Every subsequent step:

- Re-enters the resolver chain (burning cache lookups and, on miss, LLM tokens).
- Runs against a page state that no longer matches what the test author wrote.
- Can mis-report status: steps that happen to find _any_ matching selector on the wrong page get marked `passed`, polluting `step_results` and the run's verdict.

Real repro, 2026-04-24 (same run as the cache semantic guard spec):

> **Step 7** failed semantically (wrong selector resolved, navigation fired, test drifted to an unrelated page).
> **Steps 8..N** continued to execute. Playwright found random matching elements on the unrelated page. Some reported `passed`. LLM resolution was invoked on misses, spending tokens on a run that was already broken.
> User quote: "all the other steps (even the ones who said passed) did not do their job."

### Why the existing cancellation path doesn't cover this

[worker.ts:154](../../../src/workers/worker.ts#L154) already honors a `POST /runs/:id/cancel` signal between steps — but that's a **user-initiated** interrupt. There is no **automatic** bail-out on execution failure. The loop's `if (status === 'failed')` branch at [worker.ts:164](../../../src/workers/worker.ts#L164) only flips `runPassed = false` and continues.

### Why this is a separate concern from the cache semantic guard

The cache semantic guard (sibling spec) reduces the _probability_ of a wrong cached selector reaching the execution engine. It does not eliminate it, and even a correctly-resolved selector can fail at runtime (element obscured, network error, timing). Stop-on-fail is the defense-in-depth layer: regardless of _why_ a step failed, we stop spending tokens on subsequent steps that cannot meaningfully execute.

They ship together because both were triggered by the same bug report and together they deliver the user's "don't burn tokens on a broken run" ask.

---

## Goal

When a step finishes with status `failed` _and_ the healing engine did not recover it, immediately stop executing further steps in the run. Record the remaining compiled steps with status `skipped` and a skip reason, then mark the run `failed`.

**Non-goals:**
- Interrupting a step mid-execution. The current step is always allowed to finish.
- Changing the healing engine's retry logic. If healing succeeds, the step's final status is `healed` and the loop continues exactly as today.
- Making stop-on-fail configurable per-run. Always-on behavior matches the user's token-cost concern; a future spec can add an override if we ever need one.

---

## Solution

### S1 — Break the loop on unrecovered failure

In `processRun` ([worker.ts:150](../../../src/workers/worker.ts#L150)):

```ts
for (let i = 0; i < compiledSteps.length; i++) {
  if (await isCancelled(runId)) {
    cancelled = true;
    logger.info({ event: 'run_cancelled', runId, stepsCompleted: i });
    break;
  }

  const step = compiledSteps[i];
  const { status, healed, afterPng } = await executeStep(step, page, tenantId, runId, domain, i, previousAfterPng);
  previousAfterPng = afterPng;

  if (status === 'failed') {
    runPassed = false;
    logger.warn({ event: 'step_failed', runId, action: step.action, rawText: step.rawText });
    // Stop-on-fail: a failed step that healing couldn't recover invalidates
    // every subsequent step's page-state assumption. Record the remainder as
    // skipped and abort the loop.
    await recordSkippedSteps(tenantId, runId, compiledSteps, i + 1, 'prior_step_failed');
    obs.increment('worker.stopped_on_failure', { stepIndex: String(i) });
    break;
  } else if (healed) {
    anyHealed = true;
  }
}
```

**Why the `status === 'failed'` branch:** `executeStep` already returns `{ status, healed }` where `healed` is only true when the healing engine succeeded. A returned `status: 'failed'` is the post-healing verdict — exactly the "unrecovered" case we want to stop on.

### S2 — Record remaining steps as skipped

New helper alongside `insertStepResult`:

```ts
async function recordSkippedSteps(
  tenantId: string,
  runId: string,
  compiledSteps: StepAST[],
  startIndex: number,
  reason: 'prior_step_failed',
): Promise<void> {
  for (let i = startIndex; i < compiledSteps.length; i++) {
    const step = compiledSteps[i];
    // Write a lean row — no screenshot, no selector, no tokens consumed.
    // error_type carries the skip reason so the UI can distinguish "skipped
    // due to upstream failure" from "passed" / "failed" in the step timeline.
    await insertStepResult(
      tenantId, runId, step,
      'skipped',
      null,          // selectorUsed
      null,          // screenshotKey
      0,             // durationMs
      null,          // resolutionSource
      null,          // similarityScore
      null,          // domCandidates
      null,          // llmPickedKaizenId
      0,             // tokensUsed
      null,          // archetypeName
      reason,        // errorType
    ).catch((e) => obs.log('warn', 'worker.skip_record_failed', { error: e.message, stepIndex: i }));
  }
}
```

**Why `status = 'skipped'`:** `StepResultStatus` at [src/types/index.ts:275](../../../src/types/index.ts#L275) already includes `'skipped'`. The `step_results.status` column accepts it (verify schema doesn't constrain via CHECK to a smaller set — see S5).

**Why write a row per skipped step:** the UI's run timeline enumerates `step_results` rows. Without a row, skipped steps simply vanish from the timeline, which is more confusing than seeing them as explicitly skipped.

**Widen `insertStepResult` status parameter type:** currently `'passed' | 'failed' | 'healed'`; add `'skipped'`. One-line signature change.

### S3 — Final run status unchanged

The existing computation at [worker.ts:178](../../../src/workers/worker.ts#L178):

```ts
const finalStatus = cancelled ? 'cancelled' : runPassed ? (anyHealed ? 'healed' : 'passed') : 'failed';
```

Still produces the correct result: `runPassed` was flipped to `false` by the failed step, so the run is marked `failed`. No change needed.

### S4 — Observability

New counter:
- `worker.stopped_on_failure` with label `{ stepIndex }` — fires once per run that triggered stop-on-fail.

New log:
- `event: 'run_stopped_on_failure'` with `{ runId, stepIndex, stepsSkipped: compiledSteps.length - (i + 1) }`.

Existing counters (`worker.step_result_insert_failed`, etc.) cover the skip-write failure path.

### S5 — Verify the DB schema accepts `skipped`

Check `db/migrations/*step_results*.sql` for any CHECK constraint on `status`. If one exists and doesn't include `'skipped'`, add a migration to widen it. If `status` is a plain `TEXT` column with no constraint, no migration needed.

This is a pre-implementation verification task, not a code change owned by this spec body. Call it out here so it's not missed.

---

## Acceptance Tests

### AT-1: Unrecovered failure stops the loop

Fixture: a 5-step run where step 3's `executeStep` returns `{ status: 'failed', healed: false }`. Expected:
- Steps 1 and 2 execute and insert `passed` rows.
- Step 3 inserts a `failed` row (existing path).
- Steps 4 and 5 are **not** passed to `executeStep`.
- Steps 4 and 5 have `skipped` rows in `step_results` with `error_type = 'prior_step_failed'`.
- `worker.stopped_on_failure` counter fires with `stepIndex: '2'`.
- Run finalizes as `failed`.
- Zero LLM / resolver calls for steps 4 and 5 (assert via spy on the resolver mock).

### AT-2: Healed failure does not stop the loop

Fixture: step 3 returns `{ status: 'passed', healed: true }` (healing engine recovered it). Expected:
- All 5 steps execute.
- `anyHealed = true` → run finalizes as `healed`.
- No `skipped` rows.
- `worker.stopped_on_failure` does not fire.

### AT-3: Cancellation still takes precedence

Fixture: step 3 fails _and_ the cancellation key is set before step 4. Expected: the cancellation check at the top of the loop runs first on the next iteration — but the stop-on-fail already broke out, so we never reach that check. Final status is `failed` (not `cancelled`), which is the correct ordering: an execution failure that the user did not cancel is still a failure.

### AT-4: Skip row survives `insertStepResult` failure

If `insertStepResult` throws for a skipped step (DB blip), the loop continues issuing skip writes for subsequent steps and the run still terminates cleanly. Covered by the `.catch` in `recordSkippedSteps`.

### AT-5: The failing step itself is recorded normally

The `failed` status row for step 3 is written by `executeStep` → `insertStepResult` on its normal failure path. `recordSkippedSteps` starts at `i + 1` so it does not double-write the failing step.

---

## Affected Files

| File | Change |
|---|---|
| `src/workers/worker.ts` | Break loop on unrecovered failure; add `recordSkippedSteps` helper; widen `insertStepResult` status parameter type to include `'skipped'`. |
| `src/workers/__tests__/worker.test.ts` (or equivalent) | AT-1 through AT-5. |
| `db/migrations/023_step_results_status_skipped.sql` (new, **only if** an existing CHECK constraint excludes `'skipped'`) | Widen the constraint. Verify before writing. |

---

## Out of Scope

- Per-run opt-out of stop-on-fail. User explicitly asked for always-on; revisit only if a use case emerges.
- Continuing execution "for coverage" after a failure to collect more screenshots. The UI can surface the failed step's screenshot plus the skipped list; running broken steps to produce garbage screenshots is what this spec explicitly prevents.
- Mid-step interruption. The current cancellation protocol already takes the "let the step finish" stance; stop-on-fail inherits it.
- Stopping on a _passing_ step whose semantic guard later proves wrong. The cache semantic guard sibling spec prevents the wrong selector from executing; once a step has already been executed and reported `passed`, this spec does not re-litigate it.

---

## Known Risks

- **Flaky tests that self-recover via `page.reload()` in a later step.** Some test authors write "click X, if it fails just continue" style flows. Stop-on-fail makes those impossible. Mitigation: the healing engine already retries within a step. If users genuinely need "continue on failure," it's an explicit opt-in via a future `onFailure: 'continue' | 'stop'` setting — not the default.
- **Skipped steps inflate `step_results` row count.** Trivial; each row is a few hundred bytes and writes scale linearly with step count, not quadratically.
- **`status = 'skipped'` not previously written by the worker.** Any UI aggregation that assumes only `passed | failed | healed` must be audited. `packages/web` run-detail views: verify the status renderer has a `skipped` branch (or a default case that at least doesn't crash). This is a follow-up UI task captured in the affected-files table.
