# Spec: Phase 0 — plumb what we already capture

Created: 2026-08-04

Branch: `feat/api/phase-0-plumbing`
Parent: [spec-feature-backlog.md](./spec-feature-backlog.md) §2, Phase 0

---

## 1. Scope

Phase 0 is the backlog's cheapest tier: the database already holds the data, and the API
or the UI drops it on the floor. Five items remain (A1, A3, A8–A14 shipped with the
redesign):

| | Item | Shape after investigation |
|---|---|---|
| A2 | Cancel a running run | UI only — the endpoint is complete |
| A4 | Resolution confidence per step | Web mapper only — the API already sends it |
| A5 | Per-run environment | Web mapper (detail) + one column on the list query |
| A6 | Live progress in the Runs feed | **Needs a migration** — see §3 |
| A7 | Restore the audit gate in CI | **There is no CI** — see §7 |

## 2. Ground truth

Every claim below was read out of the code before writing this spec, because two of the
five items are not the size the backlog assumed.

**`GET /runs/:id` returns the raw row.** [runs.ts:257](../../../src/api/routes/runs.ts#L257)
ends in `reply.send(run)` with no field mapping, so every column named in the SELECT is
already on the wire in snake_case. The detail SELECT
([runs.ts:186](../../../src/api/routes/runs.ts#L186), [:204](../../../src/api/routes/runs.ts#L204))
already includes `environment_url`, `similarity_score` and `cache_hit`.

That makes **A4 entirely, and A5's detail half, a frontend gap**: the API is correct and
[use-run-detail.ts:50](../../../packages/web/src/hooks/use-run-detail.ts#L50) simply
doesn't map the fields, so `StepResult` never carries them.

**`GET /runs` (the list) maps explicitly** and omits `environment_url` entirely — it isn't
even in the SELECT ([runs.ts:137](../../../src/api/routes/runs.ts#L137)). A5's list half is
a real API change.

**`POST /runs/:id/cancel` is finished work.**
[runs.ts:677](../../../src/api/routes/runs.ts#L677) is tenant-scoped, sets a Redis
cancellation signal on a 5-minute TTL that the worker polls between steps, and immediately
marks still-`queued` runs cancelled so the UI doesn't wait on a worker that may never pick
them up. It answers 202 on accept, 409 `CANNOT_CANCEL` for a terminal run, 404 for a run
outside the tenant. Nothing in the app calls it.

## 3. A6 is not derivable — it needs a column

The backlog says run progress is "derivable now from step-result count vs. the case's step
count". That was true when it was written and **is no longer true**, because A9 shipped
test editing in the same release.

`step_results` only gains a row once a step finishes, so a running run supplies the
numerator but not the denominator. The denominator has to come from the case definition —
and a case's step set can now change *while a run is in flight*. `test_steps` rows are
immutable and versioned via `parent_step_id`, so the case's currently-active steps are not
necessarily the steps the run is executing. Deriving `of 10` from the case would make a
running run's progress bar jump or exceed 100% the moment someone edits the test.

The run already knows its own length at enqueue: both call sites compile the steps first
and hold the array — [test-cases.ts:693](../../../src/api/routes/test-cases.ts#L693)
(`compiledSteps`) and [runs.ts:88](../../../src/api/routes/runs.ts#L88). Stamping it is one
column and two one-line changes.

### Migration `028_run_total_steps.sql`

```sql
ALTER TABLE runs ADD COLUMN total_steps INT;

-- Historical runs are all terminal, so their executed length is exactly their
-- step_results count. Backfilling makes the feed consistent for existing rows
-- instead of showing progress only for runs created after this migration.
UPDATE runs r
   SET total_steps = (SELECT COUNT(*)::int FROM step_results sr WHERE sr.run_id = r.id)
 WHERE r.total_steps IS NULL;
```

Left nullable rather than `NOT NULL DEFAULT 0`: a run whose length is genuinely unknown
must read as unknown, not as zero-length. The UI omits the meter when it's null.

## 4. Contract changes

Interfaces first, per SDD. Everything else in this spec is an implementation of these.

### 4.1 `GET /runs` list item

```ts
{
  // …existing fields unchanged…
  environmentUrl: string | null;   // A5 — runs.environment_url
  totalSteps:     number | null;   // A6 — runs.total_steps, null for pre-migration rows
  completedSteps: number;          // A6 — count of this run's step_results
}
```

`completedSteps` comes from the same correlated-subquery shape the list already uses for
`total_tokens`, so it costs one scan of an indexed `run_id`, not a per-row round trip.

### 4.2 `StepResult` (web)

```ts
{
  // …existing fields unchanged…
  /** Vector similarity for the tier that resolved this step. Null when the tier
   *  doesn't produce one (see §5) or when the step resolved no element at all. */
  similarityScore: number | null;
  /** Whether this step's element came from a cache tier rather than the model.
   *  Null when the step never resolved an element (navigate, wait). */
  cacheHit: boolean | null;
}
```

### 4.3 `RunSummary` (web)

```ts
{
  // …existing fields unchanged…
  environmentUrl: string | null;
  totalSteps:     number | null;
  completedSteps: number;
}
```

## 5. A4 — what the confidence number is allowed to claim

`similarity_score` is written per step by the worker, but it does not mean the same thing
at every tier. A pgvector tier produces a genuine cosine similarity; an exact Redis or
`db_exact` hit matched a key, not a neighbourhood; an archetype match is a pattern rule;
an LLM resolution has no similarity at all.

Displaying one number labelled "confidence" across all of them would be the same class of
mistake as A10, where a step reported 97 tokens for a call that never happened.

**Resolution rule:** before rendering, query the live `step_results` table for the
distinct `(resolution_source, similarity_score IS NULL)` pairs actually present, and show
the number only for the sources that genuinely populate it. Sources that don't get the
tier name alone. This is settled by measurement during implementation and the result is
recorded back into this section — not guessed here.

### 5.1 Measured, 2026-08-04 — 13,198 live rows

```
 resolution_source | rows | with_score |  min  |  max  | with_cache_hit
-------------------+------+------------+-------+-------+----------------
 (null)            | 6036 |          0 |       |       |              0
 archetype         | 2404 |          0 |       |       |              0
 llm               | 1759 |          0 |       |       |              0
 redis             | 1413 |          0 |       |       |              0
 db_exact          | 1131 |          0 |       |       |              0
 pgvector_element  |  399 |        399 | 0.990 | 1.000 |              0
 pgvector_step     |   56 |         56 | 0.966 | 1.000 |              0
```

Two findings, both of which change what A4 can honestly ship.

**`similarity_score` covers 3.4% of steps.** Only the two vector tiers populate it — 455
rows of 13,198 — and the observed range is 0.966–1.000. A "Confidence" column would
therefore be empty on ~97% of steps, and where it did appear it would separate 99.0% from
100.0%: a spread too narrow to inform any decision. It is not a confidence signal; it is a
vector-match score, and it is only meaningful next to the tier that produced it.

*Shipped as:* the "How it was resolved" panel names the similarity in prose, and adds a
**Match** cell to the stat strip — both only for `pgvector_element` / `pgvector_step`. Every
other tier shows the tier alone, with no empty cell implying a missing measurement.
`resolution_source` already answers the question a confidence column was reaching for
(*did this cost a model call?*), and the UI already renders it.

**`cache_hit` has never been written.** Zero of 13,198 rows are non-null, and no INSERT in
`src/workers/` names the column — the field is in the initial schema and nothing has
populated it since. It was therefore **dropped from the contract** rather than plumbed: a
`cacheHit: boolean | null` on `StepResult` that is null for every step in existence is
worse than no field, because it invites downstream code to branch on it.

*Follow-on (not this branch):* either write `cache_hit` at the persistence consumer, or
drop the column. Note it is fully derivable from `resolution_source` today, which is why
nothing has missed it — that is also the argument for dropping rather than backfilling.

## 6. A2 — cancel in the UI

- The action appears only while `status` is `queued` or `running`. A terminal run has no
  cancel affordance at all, rather than one that errors when pressed.
- Confirm before firing: cancelling discards an in-flight run's remaining steps.
- On 202, refetch immediately. `useRunDetail` already polls non-terminal runs every 2s
  ([use-run-detail.ts:103](../../../packages/web/src/hooks/use-run-detail.ts#L103)), so
  the row settles to `cancelled` on its own; the immediate refetch just removes the lag.
- On 409, the run finished between render and click. Refetch and surface the real status
  rather than an error — the user's intent is already satisfied.
- Placement: the run screen's overflow menu (where the design put "Cancel run"), and the
  Tests-list row menu for a run started from there.

## 7. A7 — there is no CI

The backlog says "add it to the pipeline". There is no pipeline: no `.github/`, no
`.gitlab-ci.yml`, no CircleCI config anywhere in the tree. This item is *create CI*, which
is materially larger than the one-line change the backlog implies. Flagging rather than
silently absorbing it.

It also can't all land at once. `scripts/audit-contrast.mjs` drives a real browser against
a **logged-in app on `localhost:4000` across three appearances**
([audit-contrast.mjs:22-26](../../../scripts/audit-contrast.mjs#L22-L26)) — it needs
Postgres, Redis, the API, the web app, and a seeded tenant with working credentials. That
is an integration environment, not a lint step.

So A7 splits:

**A7a — this branch.** `.github/workflows/ci.yml` running on push and PR: `npm ci`,
`npm run typecheck`, `npm run lint`, `npm test`. No services required; these are the gates
that would have caught most of what CI is for, and they run in a couple of minutes.

*Precondition:* `npm run lint` currently fails with 7 pre-existing errors (unused imports
and `Function` types in the identity and billing modules — files untouched by the
redesign, left alone at the time to avoid widening that diff). A gate that is red on
arrival teaches everyone to ignore it, so these get fixed here and the gate lands
blocking.

**A7b — its own item.** The contrast and mock audits in CI, which needs `docker compose`
services, `npm run db:migrate`, a seeded tenant, and both servers booted before the audit
runs. Deferred to Phase 1 with a real spec rather than bolted on here.

## 8. Verification

Per `feedback_verify_before_prod` — unit tests where there's logic, plus a real end-to-end
pass against the live stack. Green tests alone do not close an item.

| Item | Proof required |
|---|---|
| A2 | Start a real run, cancel it mid-flight from the UI, confirm the worker stops and the run reaches `cancelled` in the DB. Press cancel on a finished run's stale menu → 409 handled, no error shown. |
| A4 | A run whose steps resolved from different tiers shows a number only where §5 says one exists. |
| A5 | Environment URL matches `runs.environment_url` on both the list and the detail. |
| A6 | Watch a live run: the meter advances step by step and lands exactly on `n/n`. Edit the case mid-run → the denominator does **not** move. |
| A7 | The workflow runs green on this PR, and a deliberately broken type fails it. |

`npm run audit:contrast` must stay at zero unreadable throughout.

### 8.1 Result, 2026-08-04

Run against the containerised stack (web on `:3001` → `api:3000`), not the host dev
servers — see §8.2.

- **A2** — a genuinely-running run cancelled with `202`, reached `cancelled`, and stopped
  at **0/3 steps**. Re-cancelling a cancelled run is `200` (idempotent), cancelling a
  *passed* run is `409`, an unknown run is `404`. The overflow menu showed **Cancel run**
  only while the run was live.
- **A4** — the vector step reads *"The nearest remembered element scored 100.0%
  similarity"* with a **Match 100.0%** cell; the LLM step in the same run shows neither,
  with no empty placeholder. No non-vector tier carried a score across the whole run.
- **A5** — `#0F8B8BC1 · THE-INTERNET.HEROKUAPP.COM/INPUTS · WEB` in the run subtitle, the
  host beside the suite name in the feed, list and detail agreeing.
- **A6** — the feed advanced `0/3 → 1/3 → 2/3 → 3/3` and landed exactly on `3/3`;
  `step 1 of 3` plus a meter rendered on the live row.
- Audits: contrast **0 unreadable** (9 findings below 3:1, all the design's existing
  accent-on-panel choices, unchanged by this branch); mock audit clean.
- Gates: `typecheck` + `typecheck:web` clean, `lint` **0 errors**, **568/568** tests.

Two things the verification changed in the implementation rather than merely confirming:

1. `POST /runs/:id/cancel` answers **200** for an already-cancelled run and **409** only
   for other terminal states. The UI now distinguishes the three, instead of treating
   anything non-409 as a fresh cancellation.
2. The confirm sheet had two buttons reading "Cancel" — the dismiss and the destructive
   action. `ConfirmSheet` gained an optional `dismissLabel`; this caller passes
   **"Keep running"**.

### 8.2 A stale host dev-server was shadowing the stack

Worth recording because it nearly produced a confident wrong result. A leftover
`tsx watch src/api/server.ts` was bound to `0.0.0.0:3000` from before Postgres came up,
so its pg pool was dead: it answered `/health` with 200 and `/auth/login` with a 500
"Connection terminated due to connection timeout", while the containerised API — which
had the actual changes — logged no requests at all.

Two Windows-specific traps alongside it: Node 24 resolves `localhost` to `::1` where the
container publishes IPv4 only, and Git Bash rewrites `/tmp/x` into a Windows path when
passed to `docker cp`/`exec`.

Verification therefore runs **inside** the container (`docker compose exec api node …`)
against the containerised web on `:3001`, which has no host process in the path.

## 9. Out of scope

Carried from the backlog's completed items, not addressed here:

- `run_id` on `billing_events` (per-run billing attribution).
- A distinct `resolution_source` for prompt-cache replays.
- `fail_count_window` resetting or decaying on success.
- B19 — assertion steps never persisting to `selector_cache`. The largest engine item and
  the one that most affects the cost curve, but it is not plumbing and does not belong in
  a phase whose whole premise is that no new behaviour is being built.
