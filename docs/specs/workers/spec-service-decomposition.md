# Spec — Worker Service Decomposition (event bus + async side-effects)

Created: 2026-07-21
Branch: `feat/workers/service-decomposition`
Status: Draft — design agreed; implementation not started.

> Companion: read `COORDINATION.md` at the repo root first — a second Claude is
> hardening the engine in a parallel worktree and shares `worker.ts`.

## 1. Motivation

The end goal is to **run many tests in parallel** — faster and more robust.
Today `src/workers/worker.ts::processRun` is a monolith: for each run it drives
the browser AND performs every side-effect **inline and sequentially** — GCS
screenshot upload, `step_results` writes, `run_events` writes, billing. Those
I/O calls sit on the per-step critical path, so the browser context idles
waiting on the network/DB before it can advance to the next step.

Under concurrency that idle time is the bottleneck: N runs each holding a browser
context blocked on I/O starve each other. Decoupling side-effects off the
critical path is the prerequisite that makes concurrency both **fast** (contexts
only drive pages) and **safe** (a slow/failed consumer can't stall or corrupt
another run).

## 2. Constraints (do not violate)

- **A single run is sequential.** Step N+1 depends on the page state step N left
  behind, and a live Playwright page cannot be shared across processes. The step
  loop stays the single, in-process owner of the browser/page.
- **Element resolution + healing stay with the browser owner** — they need the
  live DOM (pruner snapshot, healing retries). NOT split out.
- **Preserve the `__name` addInitScript shim** and the idempotent-retry logic in
  `worker.ts` from base commit `67a075c`.

## 3. Target architecture (modular monolith → extractable services)

```
Execution service  (owns browser + step loop; the ONLY sequential part)
    │  publish(event)  via IEventBus (BullMQ)
    ├─▶ queue: kaizen-screenshots  → Screenshot consumer  → GCS
    └─▶ queue: kaizen-persist      → Persistence consumer  → Postgres
                                        (step_results, run_events, status)
```

Phase 1: the two consumers are **separate BullMQ Workers co-located in the same
process** — decoupled by queue, not yet by deployment. Extraction to their own
containers later is a new entrypoint (`src/services/screenshot/index.ts`,
`src/services/persistence/index.ts`) with no logic change.

## 4. Key design decisions that make async safe

1. **Deterministic screenshot keys.** The key is already
   `{tenantId}/{runId}/{stepIndex}/{timing}.png` — computable up front. The
   execution service records `step_results.screenshot_key` immediately; the
   screenshot consumer uploads to that known key asynchronously. Persistence
   never blocks on GCS. `/media` returns 404 until the upload lands (eventual,
   acceptable).
2. **Client-generated `step_results` IDs.** Today `insertStepResult` returns the
   DB id, which `healing_events` and the "mark healed" update depend on. With
   async persistence the id isn't available synchronously — so the execution
   service generates the `step_result` UUID (uuid v4) itself before emitting the
   persist event, and references it in subsequent healing/update events. Standard
   client-side-ID pattern.
3. **Order by `seq` / `step_index`, never `created_at`.** Async writes can
   reorder wall-clock timestamps. `run_events.seq` and `step_results.step_index`
   already exist; the runs/report APIs must order on those.
4. **Idempotency under retry.** `processRun` already clears prior
   `step_results`/`run_events` on entry (base commit). With async persistence,
   the clear must fence the persist consumer — tag persist events with an
   `attempt` (from `job.attemptsMade`) and have the consumer ignore events for a
   superseded attempt, OR clear-then-replay is serialized per run. Resolve during
   implementation.

## 5. Interfaces (proposed)

```ts
// src/modules/event-bus/interfaces.ts
export type RunEventEnvelope =
  | { kind: 'screenshot.upload'; tenantId: string; runId: string; stepIndex: number;
      timing: 'before' | 'after'; png: Buffer /* or a Redis blob ref */ }
  | { kind: 'persist.step_result'; row: StepResultRow /* incl. client-gen id */ }
  | { kind: 'persist.run_event';   rows: RunEventRow[] }
  | { kind: 'persist.run_status';  runId: string; tenantId: string;
      status: 'running' | 'passed' | 'failed' | 'healed' | 'cancelled' };

export interface IEventBus {
  publish(e: RunEventEnvelope): Promise<void>;
}
```

- Default `IEventBus` impl publishes to the matching BullMQ queue.
- The execution loop depends only on `IEventBus`, not on `ScreenshotService` or
  the DB directly.
- Large PNG buffers over Redis: prefer writing the buffer to GCS-staging or a
  Redis key with TTL and passing a ref, rather than fattening the job payload.
  Decide during implementation (payload-size vs. extra round-trip).

## 6. Queues

- `kaizen-runs` (existing) — run jobs, consumed by the execution service.
- `kaizen-screenshots` (new) — one job per screenshot upload.
- `kaizen-persist` (new) — step_result / run_event / status writes.

Keep `defaultJobOptions` retries+backoff consistent with the base (attempts 3,
exponential). Persist/screenshot consumers are idempotent (upsert by
client-gen id / deterministic key).

## 7. Concurrency (the payoff)

- Raise execution concurrency past 1 using **one browser, N contexts** (cheaper
  than N browsers). Each run gets an isolated `BrowserContext` + page.
- The screenshot/persist consumers scale their own concurrency independently.
- Prereqs (already in base `67a075c`): per-run context isolation, the `__name`
  shim, idempotent retries.

## 8. Rollout phases

- **P1** — Introduce `IEventBus` + the two queues. Move screenshot upload and
  persistence to in-process consumers. Same process, decoupled. Validate with the
  REST battery: latency should drop, results must be byte-identical.
- **P2** — Split screenshot + persistence into their own entrypoints/containers
  (`Dockerfile.screenshot`, `Dockerfile.persistence`); compose services.
- **P3** — Execution context-pool concurrency (concurrency N).

## 9. Testing

- Unit: `IEventBus` publishes the right envelopes for each step outcome; consumers
  are idempotent (double-delivery → single effect).
- Integration: run the existing REST battery (12 original + 10 hard) against the
  decomposed worker; assert parity with the monolith run (same step statuses,
  same persisted rows, screenshots eventually present).
- Load: N concurrent runs; confirm no cross-run interference and that persistence
  keeps up (queue depth bounded).

## 10. Open questions

- PNG transport over the bus (inline payload vs. staged ref).
- Attempt-fencing for the persist consumer vs. serialized clear-then-replay.
- Whether run *status* transitions stay synchronous in the execution service
  (authoritative) while step rows go async — recommended: status stays sync.
