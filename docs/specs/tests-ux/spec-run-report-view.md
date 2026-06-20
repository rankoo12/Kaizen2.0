# Spec: Full-Run Report View

Created: 2026-06-20
Updated: 2026-06-20

## 0. Goal

A dedicated, share/print-friendly **run report** for reviewing one completed
run in depth — the "everything an evaluator would want" overview. Distinct from
the existing `/tests/[id]` working screen; this is a read-focused report for a
single run.

Priority feature: a **full chronological run log** — a readable timeline of
everything that happened (each step's resolve → execute → assert, LLM calls,
healing attempts, errors), in order, like `pytest -v` for the whole run. LLM
interaction is shown as a **decision summary** (which steps used the LLM, token
count, chosen element + why) — not raw prompts/responses.

## 1. Data inventory (what we can render)

Persisted today, queryable per run:
- **`step_results`** — per step: status, action, selector_used, resolution_source
  (L0–L5), tokens_used, duration_ms, dom_candidates, llm_picked_kaizen_id,
  captured_name/value, screenshot_key, error_type, failure_class, created_at.
- **`healing_events`** — per step_result: failure_class, strategy_used, attempts,
  succeeded, old/new selector, duration_ms, created_at.
- **`billing_events`** / **`llm_call_log`** — token spend; LLM call metadata
  (model, prompt/completion tokens, latency, cache_hit, purpose).

### 1.1 Persisted run-event stream (chosen)
`llm_call_log` is not linked to a run/step and pino worker logs are ephemeral,
so neither gives a faithful chronological log. v1 therefore **persists a
run-event stream**: a `run_events` table the worker appends to as it works, at
sub-step granularity (resolve → execute → assert → LLM call → heal, plus
errors). The report renders this stream directly, giving a true `pytest -v`-style
log including raw worker-log lines.

**`run_events` schema:**
```
run_events (
  id           UUID PK,
  tenant_id    UUID NOT NULL,       -- RLS, matches runs.tenant_id
  run_id       UUID NOT NULL,       -- FK runs(id)
  step_index   INT,                 -- which compiled step (null for run-level events)
  seq          INT NOT NULL,        -- monotonic order within the run
  level        TEXT NOT NULL,       -- 'info' | 'warn' | 'error' | 'debug'
  phase        TEXT NOT NULL,       -- 'run' | 'resolve' | 'execute' | 'assert' | 'llm' | 'heal' | 'capture'
  message      TEXT NOT NULL,       -- human-readable line
  data         JSONB,               -- structured detail (tier, tokens, selector, candidate count…)
  created_at   TIMESTAMPTZ DEFAULT now()
)
```
Ordered by `(run_id, seq)`. RLS tenant-isolated like other tables.

A lightweight `RunLogger` in the worker wraps pino: every line it would log is
*also* appended to `run_events` (buffered, flushed per step to limit round-trips).
This makes the worker's real log the report's log — single source of truth.

## 2. Report sections

### 2.1 Header rollup
Run status, target URL, triggered-by, start/end + total duration, step counts
(passed / healed / failed / skipped), **total tokens** and an **LLM-vs-cache
ratio** (steps resolved by LLM vs by cache/archetype), self-heal count.

### 2.2 Chronological run log (priority)
A single ordered list, one entry per event, newest-last, rendered console-style:
```
[00:000ms]  STEP 01  navigate         → demowebshop.tricentis.com            ✓ 312ms
[00:312ms]  STEP 02  click "register" → resolved L1 Redis · button           ✓ 88ms
[01:120ms]  STEP 09  click_random     → picked "Music 2" (1 of 7)            ✓ 240ms  [captured selectedItem]
[01:360ms]  STEP 10  click cart       → resolved L5 LLM · 412 tok            ✓ 510ms
[01:870ms]  STEP 11  assert_text      → "Music 2" found in td.product        ✓ 90ms
            └ HEAL   (if any) classified=SELECTOR_DRIFT strategy=resolve-retry ✓
```
Each line: relative timestamp, step #, action, a one-line outcome (resolved
tier + element / captured var / assertion match / error), status, duration.
Healing and errors render as indented sub-lines under their step. Built by
ordering `step_results` (and joined `healing_events`) by `created_at`.

### 2.3 LLM decision summary
A compact table: for each step that used the LLM (`resolution_source = 'llm'`),
show the chosen element (role + name), tokens, and the candidate count it chose
from. No raw prompt/response. Footer totals: LLM steps, total LLM tokens, % of
steps that hit cache instead.

### 2.4 Per-step detail (reuse)
Link each log line to the existing step inspector block (resolved element,
selector, candidates, screenshot, captured value) — don't duplicate it.

## 3. API

`GET /runs/:id/report` (or extend `GET /runs/:id`) returns the run + ordered
step_results + healing_events already; add a derived `log` array (the §2.2
entries) and `llmSummary` (§2.3) computed server-side so the client renders
without re-deriving. Tenant-scoped; respects the same auth as `GET /runs/:id`.

## 4. Frontend

- New route `/tests/[id]/runs/[runId]/report` (or a `?report=1` view) rendering
  sections §2.1–2.4. Print-friendly (clean CSS, no side rails).
- Reuses `useRunDetail` data; adds the `log`/`llmSummary` fields.
- Atomic-design components; Tailwind only.

## 5. Out of scope (v1)
- Raw LLM prompt/response capture (decision summary only, per direction).
- Downloadable artifacts bundle (screenshots are already viewable per step).
- Live tail of `run_events` while a run is in flight (the existing 2s poll on the
  detail screen is enough; the report targets completed runs).

## 6. Acceptance criteria
1. Opening the report for a completed run shows the header rollup, a correct
   chronological log of all steps (+ healing sub-lines), and the LLM decision
   summary.
2. Token totals and LLM-vs-cache ratio match `step_results`.
3. The view is shareable/printable and does not leak other runs/tenants.
4. `npm run typecheck` + `npm run lint` clean; tests for the log/summary
   derivation added.
