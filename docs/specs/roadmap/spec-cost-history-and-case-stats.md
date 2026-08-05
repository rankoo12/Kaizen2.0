# Spec: cost history and per-case aggregates

Created: 2026-08-04

Branch: `feat/api/cost-history-and-case-stats`
Parent: [spec-feature-backlog.md](./spec-feature-backlog.md) §2 — B4, B5

---

## 1. Scope

The two items that make the product's central claim visible: **cost per run trends toward
zero as the brain learns**. Today the Usage screen can only chart the tokens of individual
recent runs, and says so.

| | Item | Delivered as |
|---|---|---|
| B4 | Per-case aggregates | runs / passed / healed / failed, avg duration, cache-hit %, first-vs-last token cost on the cases list |
| B5 | Cost + cache-hit history | `GET /tenants/:id/usage/history?days=30` and the real 30-day chart |

## 2. The backlog specced rollup tables. Measured, they are not warranted yet

B4 says *"deriving live means a scan of `step_results` per case per page load"* and B5
proposes a `daily_usage` rollup appended by a nightly job plus incremental updates on run
completion. Both assume the direct query is too expensive. It is not — measured against the
live database (3,226 runs, 13,212 step results, 53 cases, 6 tenants, 21 distinct days):

| Query | `EXPLAIN ANALYZE` |
|---|---|
| Per-case runs / passed / healed / failed / avg duration, whole tenant | **1.06 ms** |
| Per-case cache-hit %, joining `step_results` (the heaviest) | **1.13 ms** |
| Full daily rollup — every tenant, every day | **21 ms** |

The scan the backlog feared is not per case; it is one grouped query per page load, and it
costs about a millisecond.

Against that, rollup tables would cost real things:

- **A write seam on run completion.** Run status is finalised in `markRunComplete`
  ([worker.ts:169](../../../src/workers/worker.ts#L169)) — the file `COORDINATION.md` flags
  as the highest conflict risk in the repo, with another session active. Adding an
  incremental-update call there buys a merge conflict for a millisecond.
- **A staleness class of bug.** A cached aggregate can disagree with its source. The
  previous branch spent most of its time on exactly that shape of bug (A10: four read paths
  summing two different sources and reporting a run as free while its own step showed 97
  tokens). Introducing a second copy of numbers that are already derivable invites it back.
- **A reconciliation burden.** B5's own acceptance criterion is "its totals reconcile with
  `billing_events` for the same window" — a test that only exists because the rollup can
  drift. Computing directly makes it true by construction.

**Decision: compute directly, index properly, and record the trigger for revisiting.**
The user-visible deliverable is unchanged — the chart and the columns are real either way.

### 2.1 When to revisit

Growth is roughly linear in run count. At 3,226 runs the cross-tenant rollup is 21 ms, so
~100k runs lands near 650 ms — and that is the *all-tenant* case; the endpoints here are
tenant-scoped and far smaller. Revisit when either holds:

- a single tenant passes ~50,000 runs, or
- `GET /tenants/:id/usage/history` p95 exceeds 200 ms.

At that point the right shape is a `daily_usage` table rebuilt by **recompute** rather than
event increments — idempotent, self-healing, and still free of a worker hot-path coupling.

## 3. Migration `031_runs_case_id_index.sql`

Numbered 031 because 028 is taken twice (`028_run_total_steps` here,
`028_test_writer` on an unmerged branch) and 029/030 are used.

`runs` is indexed on `(tenant_id, status, created_at DESC)` but **not on `case_id`**, and
the per-case aggregate joins on it. At 3,226 rows a sequential scan is already fast enough;
the index is what keeps §2's decision true as the table grows, so it ships with the
decision rather than after it.

```sql
CREATE INDEX IF NOT EXISTS runs_case_created_idx ON runs (case_id, created_at DESC);
```

## 4. Contracts

### 4.1 `GET /tenants/:tenantId/usage/history?days=30`

```ts
{
  days: number;                    // echoed back, clamped 1..90
  series: Array<{
    day: string;                   // ISO date, one entry per day INCLUDING empty days
    runs: number;
    tokens: number;                // summed from step_results, run-scoped
    lookups: number;               // step results that resolved an element
    cacheHits: number;             // those resolved by anything other than the model
    heals: number;
    failures: number;
  }>;
}
```

Empty days are present with zeros rather than omitted. A chart that silently drops quiet
days compresses time and makes a downward trend look steeper than it is.

`tokens` sums `step_results.tokens_used` scoped by `run_id`, consistent with every other
run-cost surface since A10. `cacheHits` counts `resolution_source IS NOT NULL AND
resolution_source <> 'llm'` — deliberately *not* `step_results.cache_hit`, which is a dead
column that has never been written (measured: 0 of 13,198 rows).

Authorization matches the sibling `/usage` route: `requireAuth` + `requireRole('admin')`,
and the path tenant must be the caller's own.

### 4.2 Per-case aggregates on `GET /suites/:suiteId/cases`

Each case gains:

```ts
stats: {
  runs: number;
  passed: number;
  healed: number;
  failed: number;
  avgDurationMs: number | null;    // null when nothing has completed
  cacheHitPct: number | null;      // null when no lookups yet — NOT 0
  firstRunTokens: number | null;   // the learning cost
  lastRunTokens: number | null;    // what it costs now
}
```

`cacheHitPct` is null, not zero, when a case has never resolved an element. Zero means
"every lookup needed the model", which is the opposite of "nothing measured yet", and the
Tests screen must not render them the same.

`firstRunTokens` and `lastRunTokens` are the pair that demonstrates the product's claim on
a single row: what the first run cost to learn, and what the latest one costs now.

## 5. Verification

Per `feedback_verify_before_prod`.

| Item | Proof required |
|---|---|
| B5 | The 30-day series reconciles with a hand-written aggregate over the same window, and quiet days appear as zeros rather than gaps. |
| B4 | Per-case counts match a hand-written query per case; a case that has never run reports nulls, not zeros. |
| §2 | The measured timings above are re-checked after the endpoints exist, against the live database, not asserted from the plan. |
| §3 | The index is actually used — `EXPLAIN` shows an index scan, not a sequential one. |

`npm run audit:contrast` stays at zero unreadable; CI green.

### 5.1 Result, 2026-08-04

**Timings, re-measured through the running API** (12 requests each, not `EXPLAIN`):

| Endpoint | median | p95 |
|---|---|---|
| `GET /tenants/:id/usage/history?days=30` | 6 ms | 9 ms |
| `GET /tenants/:id/usage/history?days=90` | 5 ms | 9 ms |
| `GET /suites/:id/cases` with every aggregate | 6 ms | 7 ms |

Roughly 20× under §2.1's revisit trigger of 200 ms p95, and the 90-day window costs no
more than the 30-day one. The decision to compute directly holds comfortably.

`EXPLAIN` confirms the new index carries the per-case join:
`Index Scan using runs_case_created_idx on runs`.

**Correctness**, verified against the live stack:

- 30 points for `days=30`, ascending, **quiet days present as zeros**; `days=500` clamps
  to 90 and `days=abc` falls back to 30; `cacheHits ≤ lookups` on every point.
- Per-case counts match an independent recount from the runs feed across all 7 cases.
- A never-run case reports `runs: 0` with `cacheHitPct: null` and `avgDurationMs: null` —
  not zeros that would read as measurements.
- The claim is visible in the data: *Number input accepts 42* reports
  `firstRunTokens: 97, lastRunTokens: 0` — learned once, free since.

**One thing the implementation changed.** The old `CostChart` plotted one bar per recent
run, which cannot show a trend: a busy day and a quiet day occupied the same width, so the
curve's shape depended on how often someone happened to run tests rather than on what runs
cost. `HistoryChart` plots days, and plots **tokens per run** rather than tokens total, so
a day with twenty cheap runs does not tower over a day with one expensive one. The
"N% cheaper" badge is computed only across days that actually had runs — an idle stretch is
not a cost improvement, and counting it as one would be the chart flattering itself.

## 6. Out of scope

- `daily_usage` / `case_stats` tables — deferred with a trigger, §2.1.
- B19 (assertion steps never reaching `selector_cache`) — **another session is on it**
  (`fix/element-resolver/selector-cache-not-populated`). It is the change that would make
  the cost curve actually bend; this branch only makes the curve visible.
- The author screen's "first run ≈ N tokens" estimate. It becomes honest once this data
  exists, but it is a separate change.
