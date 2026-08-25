# Spec: Parallel Test-Writer Pipeline

Created: 2026-08-24
Updated: 2026-08-24

## Problem

Run 32 (the-internet, 50 pages) is on course for ~2.5 hours wall-clock. Almost all
of it is waiting: one LLM prompt at a time, one scenario written at a time, one fact
verified at a time — while every one of those units is independent of its siblings.
An analyze of a mid-size site should be a coffee break, not an afternoon.

Measured sequential costs (runs 30–32, file-inbox answering at 30–90s/prompt):

| Phase              | Cost in run 32              | Nature of the work            |
| ------------------ | --------------------------- | ----------------------------- |
| Fact transcribe    | ~90 min (~100 prompts)      | 2–3 LLM calls per page        |
| Journey write      | ~25 min across fill rounds  | 1 LLM call per scenario       |
| Repair loop        | ~15 min across rounds       | 1 LLM call per failed run     |
| Batch verify       | ~20–30 min (~150 facts)     | Playwright replay, no LLM     |
| Validation runs    | overlapped, worker-bound    | engine runs via BullMQ        |
| Explorer / crawl   | ~5 min                      | one browser walking, stateful |

## Principle

Parallelize the **independent units**, keep every **merge deterministic**. Nothing
about scoring, gating, dedup, or delivery order may depend on completion order.
Every fan-out has a fixed bounded width — this is a shared machine and a shared
answering backend, not a cluster.

## 1. Fact transcription — IMPLEMENTED 2026-08-24

`runGenerationPhases` fact-tier block (`src/modules/test-writer/pipeline.ts`).

- Worker-pool fan-out, `TRANSCRIBE_CONCURRENCY = 4`: each worker claims the next
  dossier by index and runs `transcribePage` (its own per-lens containment is
  unchanged).
- Results land in an `outcomes` array **indexed by dossier position**; the merge
  (counters, gate rejections, cross-page name dedup, screen-qualified renames)
  runs sequentially over that array in dossier order after the fan-out completes.
  Dedup outcomes are therefore identical to the sequential pipeline's.
- Progress reports facts-transcribed-so-far as pages complete (order-independent
  count, not order-dependent narrative).

Expected: ~90 min → ~20–25 min.

## 2. Journey writes — IMPLEMENTED 2026-08-24

`runWriteRound` writes scenarios one `generateScenario` call at a time.

- Same worker-pool shape, width 4, over the round's planned scenarios.
- Judge input order must stay the plan order: collect into a position-indexed
  array, judge the batch only after the round's writes settle.
- The writer's per-call try/catch + repair attempt is per-unit and untouched.

Expected: write phases ~3–4× faster; applies to every fill round too.

## 2b. Validation feed for authenticated jobs — IMPLEMENTED 2026-08-24

The worker service executes `WORKER_CONCURRENCY` (local: 4) runs at once, but the
validation-runner feeds it 2 scenarios at a time for public jobs and **1 for
authenticated jobs** (same-credential parallel sign-ins trip lockout on customer
accounts — the guard is correct as a default). Every benchmark run is
authenticated, so validation has been running one-at-a-time on a 4-slot worker.

- **Shared authenticated session** (the production-grade fix): the risk is N
  parallel sign-ins, not N parallel sessions. The runner performs ONE seed
  login, exports the browser `storageState` (cookies + localStorage), and every
  parallel validation run starts its context pre-authenticated from that state,
  skipping the login-prefix steps — one user, several tabs, no repeated
  credential submissions. Auth validation then uses the worker's full
  concurrency safely, on customer sites too.
  - State is session-cookie material: Redis only, short TTL, tenant-scoped,
    never Postgres or logs.
  - The FIRST proving run executes the real login steps, so the login flow
    itself stays validated; parallel runs prove scenario bodies.
  - Session expiry mid-batch: one run re-signs-in (serialized), refreshes the
    shared state, the rest retry from it.
  - Same pattern the fact-verifier (`acquireSession`) and crawler already use;
    the engine's per-run login is the last serial holdout.
- Worker capacity itself is config/infra: `WORKER_CONCURRENCY` env, or replicas
  (`docker compose up -d --scale worker=N`; BullMQ locks make it safe) — see §5.

## 3. Repair loop — IMPLEMENTED 2026-08-24 (via §2)

Repair rounds flow through `runRound`, so §2's parallel WRITE covers them; re-validation was already engine-queue parallel.

- Fan out repair generations (width 3) per validation round; re-validation of the
  repaired scenarios already flows through the engine queue, which is parallel
  by worker concurrency.
- Cap total in-flight validation work at the worker's own concurrency so repairs
  don't starve first-pass runs.

## 4. Batch verifier — IMPLEMENTED 2026-08-24

`FactVerifier.verifyAll` drives one page/session for the whole batch.

- Shard the fact list across `VERIFY_CONTEXTS = 3` browser contexts in the one
  browser; each context signs in once (auth flow already supports re-login) and
  verifies its shard sequentially.
- Fixture registry keys on `gotoUrl|hops` — sharding must group facts by that key
  so one screen's fixture is created exactly once, in exactly one shard.
- Verdicts are collected by fact index; the report order is unchanged.

Expected: ~20–30 min → ~8–10.

## 4b. Fill-round planning — IMPLEMENTED 2026-08-24

`planPageBatch` is called once per page per fill round, sequentially — ~60s x
~45 pages on the-internet made fill planning the biggest serial stretch left
(~10 min per round) once §§1–4 landed. The calls are independent per page:
same worker-pool shape as §1, width 4, merge in page order.

## 5. Engine execution — INFRA, NO CODE

Engine runs (journey validation, audit sample, production runs) execute on the
worker service, BullMQ queue `kaizen-runs`.

- Parallelism today: `WORKER_CONCURRENCY` (local .env: 4) — N runs concurrently
  in one service process, one browser context each.
- Scaling beyond a process: run more worker service replicas; BullMQ's job locks
  make distribution safe with zero code changes. This is the production-shaped
  answer ("more worker services"), bounded by browser memory per replica.

## Not parallelized, deliberately

- **Explorer and crawler** — a browser walking stateful UI; parallel walkers
  would fight over shared app state and double-visit views.
- **Planner / conventions / judge synthesis** — cheap single calls whose whole
  point is seeing everything at once.
- **Anything that mutates the target app** — fixture creation stays
  once-per-screen, serialized within its verifier shard.

## Answering-side concurrency (dev harness)

The file-inbox answerer (`scripts/llm-answerer.ts`) runs `ANSWERER_CONCURRENCY`
(default 4) one-shot `claude -p` processes. It must be ≥ the widest pipeline
fan-out or the queue re-serializes at the inbox. Production (direct API) has no
such coupling — rate limits far exceed these widths, and per-call latency drops
from 30–90s to 10–30s.

## Rollout order and expected wall-clock

§§1–4 implemented 2026-08-24 (gates: typecheck, lint, 1204 jest tests); §5 is an env/infra knob available any time.

Run-32-shaped analyze, file-inbox answering: ~150 min → **~35–45 min**.
Same analyze on direct API: **~15–20 min**.

Every fan-out width is a named constant at the top of its module; tuning them is
config work, not surgery.
