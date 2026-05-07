# Spec: Live Run Updates + Step-ID Wiring

Created: 2026-05-01
Updated: 2026-05-01

## 1. Symptoms

Two related defects on the test detail screen, surfaced by user testing of
PR #36:

### 1.1 Timeline shows step number and intent but no description

When a run completes, each step row in the timeline shows
`step 01  STEP  3774ms ⚡0` but **not** the step's natural-language text
(e.g. `Click the signup / login button`). The step inspector list has the
same problem on running steps.

### 1.2 Detail screen freezes until the run finishes

The frontend's existing `useRunPoller` (1.5s loop) only triggers on
**terminal** status (`passed | failed | healed | cancelled`). Until the
run hits terminal, the detail screen renders the case definition only —
no step results, no progress, no per-step duration. All of that lands at
once when the run ends.

## 2. Diagnosis

### 2.1 step_results.step_id is always NULL

[`src/workers/worker.ts:204`](src/workers/worker.ts) inserts a
`step_results` row without a `step_id` column:

```sql
INSERT INTO step_results
  (tenant_id, run_id, content_hash, target_hash, status, ...)
```

The schema permits this (`db/migrations/005_nullable_step_results_step_id.sql`
relaxed the NOT NULL constraint when the test management UI did not yet
exist) but every row is now NULL.

The runs API
([`src/api/routes/runs.ts:163`](src/api/routes/runs.ts)) joins to fetch
the original step text:

```sql
LEFT JOIN test_steps ts ON ts.id = sr.step_id
... ts.raw_text AS step_raw_text
```

With `sr.step_id = NULL`, the JOIN never matches, so `step_raw_text`
returns `null`, the typed `StepResult.rawText` is `null`, and the
timeline renders an empty string.

The cause is upstream of the join: the run-enqueue route at
[`src/api/routes/test-cases.ts:534-543`](src/api/routes/test-cases.ts)
selects `raw_text` from `test_steps` but discards the row IDs, so the
worker never receives them and can't populate `step_results.step_id`.

### 2.2 useRunDetail does not auto-refetch during a running run

[`packages/web/src/hooks/use-run-detail.ts`](packages/web/src/hooks/use-run-detail.ts)
fetches once on mount and once on `refetch()`. There is no loop. The
existing `useRunPoller` does loop — but only to detect terminal status,
and `onComplete` is the **only** signal that drives a refetch upstream.
Mid-run state (steps that have already completed) never flows to the
detail screen.

## 3. Goal

- Every `step_results` row written by the worker carries the originating
  `test_steps.id` so `step_raw_text` resolves on the API JOIN.
- The detail screen polls `GET /runs/:id` every 2s while the run is in a
  non-terminal status, so per-step progress (status, duration, tokens,
  screenshots) appears as the worker writes it.
- Header button renamed from `Run again` to `Run` per user feedback.

## 4. Non-goals

- No SSE / WebSocket. Polling is fine at the scales we run today; a
  deeper protocol change is its own spec when concurrent viewer counts
  warrant it.
- No backfill of historic `step_results` rows whose `step_id` is NULL.
  Old runs continue to show empty step text. The next run after this
  ships will be correct; older runs are read-only history.
- No change to `compiled_ast_cache` keying. Steps are still cached by
  `contentHash`; `step_id` is purely a back-reference for trace display.

## 5. Implementation

### 5.1 Thread step IDs from API enqueue → worker → step_results

#### 5.1.1 API enqueue change

In [`src/api/routes/test-cases.ts`](src/api/routes/test-cases.ts) at the
`POST /cases/:caseId/run` handler, extend the step-fetching query to
also select `ts.id`:

```sql
SELECT ts.id, ts.raw_text
  FROM test_case_steps tcs
  JOIN test_steps ts ON ts.id = tcs.step_id
 WHERE tcs.case_id = $1 AND tcs.is_active = true
 ORDER BY tcs.position
```

Pass IDs into the BullMQ payload alongside the compiled steps:

```ts
await queue.add('run', { runId, tenantId, compiledSteps, stepIds, baseUrl });
```

`stepIds[i]` corresponds to `compiledSteps[i]` by index. The two arrays
are always parallel — simpler than embedding `stepId` inside each
`StepAST` (which would require a wider type change downstream).

#### 5.1.2 Worker payload change

[`src/workers/worker.ts`](src/workers/worker.ts) declares
`RunJobPayload`. Add `stepIds: string[]` (optional for backwards
compatibility — old queued jobs that pre-date this change have no IDs;
they fall back to NULL `step_id` writes, the existing behaviour).

`processRun` passes `stepIds[i]` to `executeStep` / `insertStepResult` /
`recordSkippedSteps` for each iteration.

#### 5.1.3 insertStepResult change

`insertStepResult` gains a `stepId: string | null` parameter. The INSERT
adds the column:

```sql
INSERT INTO step_results
  (tenant_id, run_id, step_id, content_hash, target_hash, status, ...)
```

`recordSkippedSteps` writes a row per skipped step too — also needs the
`step_id` for that step.

### 5.2 Live polling on the detail screen

In [`packages/web/src/hooks/use-run-detail.ts`](packages/web/src/hooks/use-run-detail.ts),
add a `useEffect` that, when the loaded run's `status` is non-terminal,
sets up a `setInterval` calling the existing `refetch()` every 2 seconds.

```ts
useEffect(() => {
  if (!data?.status || TERMINAL_RUN_STATUSES.includes(data.status)) return;
  const id = setInterval(() => { refetch(); }, 2000);
  return () => clearInterval(id);
}, [data?.status, refetch]);
```

Tab-visibility guard: when `document.visibilityState === 'hidden'` skip
the refetch. Keeps polling from running uselessly when the user has
backgrounded the tab.

Single-flight: a `inFlight` ref prevents stacking when the API takes
longer than the interval.

### 5.3 Rename `Run again` → `Run`

[`packages/web/src/components/organisms/test-detail-screen.tsx`](packages/web/src/components/organisms/test-detail-screen.tsx)
header button. One-line change.

## 6. Schema migration

None. `step_results.step_id` already exists and is already nullable. The
fix is purely application-layer — the worker now populates a column it
was always allowed to populate.

## 7. Test plan

### 7.1 Unit / integration

- API enqueue test: `POST /cases/:id/run` body sent to BullMQ now
  includes `stepIds` array of length === `compiledSteps.length`,
  preserving order.
- Worker test: `processRun` receives `stepIds`, passes the right id to
  `insertStepResult` for each step (mock pool, assert the 3rd param of
  the INSERT params array equals the expected step id).
- Worker test: `processRun` with no `stepIds` (backwards-compat) writes
  `null` for `step_id` — preserves the legacy behaviour for any
  pre-deploy in-flight queue jobs.
- `useRunDetail` hook test (jsdom): when initial fetch returns
  `status: 'running'`, refetch is called again ~2s later. When the
  followup returns `status: 'passed'`, no further refetches occur.
- Hook test: `document.visibilityState === 'hidden'` — refetch is
  skipped on the next interval tick; resumes when visible.

### 7.2 Manual

- Truncate caches; create a fresh test case; click `Save & run`.
- Detail page should show:
  - Run summary strip transitions queued → running.
  - Each step row appears with its full natural-language text the
    moment its `step_results` row is written.
  - Duration / tokens / screenshot populate live.
- After completion, every step in the timeline shows its description.
- Refresh — descriptions still present (data persisted in DB, not just
  in client cache).

## 8. Risks

- **Two-array invariant.** `stepIds[i]` ↔ `compiledSteps[i]` is the
  contract. If a future change reorders / filters one without the
  other, step results get the wrong description. Defended by the API
  test that enforces equal length and parallel order.
- **Polling load.** A 2s polling interval with five concurrent active
  runs (single user, multiple tabs) = ~1 fetch per 0.4s. The endpoint
  joins `step_results` + `healing_events` + `billing_events` per call,
  ~5-50 KB. Acceptable for self-hosted dev / single-tenant scales; if
  this becomes an issue, the same hook gains an `If-None-Match` /
  ETag layer or graduates to SSE.
- **Stale-run polling on detail page navigation.** When a user opens a
  detail page for a *historical* finished run, `data.status` is
  terminal and the poll never starts. Verified via the early-return on
  the effect.
- **Backwards-compat on in-flight queue jobs.** When this lands, jobs
  already on Redis from before the API change have no `stepIds` field.
  Worker treats `stepIds === undefined` as "old job" and writes NULL
  step_ids, matching today's behaviour. No crash, just one final batch
  of runs without step text.
