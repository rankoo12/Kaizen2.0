# Spec: Run a whole suite

**Created:** 2026-08-17
**Status:** Approved by founder ask ("I want to be able to run a full suite"), 2026-08-17
**Owner:** runs / tests-ux

---

## 1. What a user gets

On a suite's page, one button — **Run suite** — that queues a run for every test in the suite,
the same way ⌘R does for one row. The list updates as runs start and finish; suite health at
the top reflects the new results as they land. No new screen.

## 2. Behaviour

- Runs **active** cases only. Drafts (not yet accepted), rejected and archived cases are skipped
  and reported back, never run — the same rule `POST /cases/:caseId/run` already enforces.
- The tenant's monthly LLM budget is checked **once**, before anything is queued. If it would
  refuse a single run it refuses the suite (402, same codes).
- Each case becomes its own `runs` row (`triggered_by='web'`) and its own queue job. There is
  no "suite run" entity in v1 — the suite's page already aggregates by case, and CI's needs
  (spec-ci-integration) will decide whether a grouping row is warranted.
- Order: cases in the suite's listing order (`created_at`). The worker's concurrency decides
  how many run at once; the API does not throttle.
- Response is 202 with what was queued and what was skipped, so the UI can say "Queued 12
  tests, skipped 3 drafts" honestly.

## 3. API

`POST /suites/:suiteId/run` — JWT (`requireAuth`), tenant-scoped.

Body: `{ baseUrl?: string }` (optional override applied to every case, mirroring the per-case
route).

Responses:
- `202 { queued: [{ caseId, runId }], skipped: [{ caseId, name, reason }] }`
- `404 SUITE_NOT_FOUND`
- `402 INSUFFICIENT_TOKENS | TOKEN_LIMIT_REACHED` (same shapes as the case route)
- `400 NO_RUNNABLE_CASES` when the suite has no active case (message says why: empty, or all
  drafts).

Implementation: the per-case enqueue (fetch case + active steps → reuse stored ASTs, compile the
rest → insert run → queue) is lifted out of the case route into one function both routes call.
Budget check stays in the routes.

## 4. UI

`TestsScreen`, suite view only (`suiteFilter` set): a **Run suite** button in the toolbar left of
Analyze, disabled while the suite has no active cases. On success, toast
*"Queued N tests"* (with *"— skipped M drafts"* when applicable), refetch after 2s so the rows
flip to QUEUED/RUNNING. Errors use the API's `message`.

## 5. Tests

- `test-cases.test.ts`: suite run queues one job per active case, skips drafts with a reason,
  402s before queueing anything when the budget is spent, 400s on an all-draft suite, 404s on a
  foreign suite (tenant scope in the query).
