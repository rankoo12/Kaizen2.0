# Distributed Worker Architecture — Decoupling Brain and Brawn

**Branch:** `feat/worker/distributed-orchestration`
**Spec ref:** `kaizen-spec-v4.md` (Distributed Execution Phase)
**Related types:** [src/types/index.ts](../src/types/index.ts), [src/queue/index.ts](../src/queue/index.ts)

---

## 1. Goal — and why the current design blocks it

### What we want

One user submits a run. N worker processes pick up pieces of that work and finish it faster than one worker could. Later, we scale the cluster by adding more machines — not by making each worker fatter.

Concretely: **20+ parallel test executions on a single host** without overloading Postgres, pgvector, or the LLM gateway.

### Why the current worker can't get there

[src/workers/worker.ts](../src/workers/worker.ts) is a single process that does everything for a run: compile → resolve → Playwright → heal → persist. One BullMQ job holds a worker for the entire lifetime of a test. That means:

- **Mixed resource profiles in one process.** LLM calls (network-bound, seconds of latency) and Playwright execution (CPU + RAM heavy, browser per job) fight for the same slot. You can't scale them independently.
- **Coarse-grained concurrency.** To run 20 tests in parallel you need 20 full workers, each holding an LLM client, a resolver chain, a browser, and a DB pool. Memory cost dominates before you hit interesting concurrency.
- **No work sharing.** Two runs hitting the same login page both pay the resolve cost even though the manifest is identical. Cache helps inside a run; it doesn't help *across* runs coordinated in flight.
- **Healing re-enters the same monolith.** When a selector breaks, the worker that was executing has to also do the LLM/pgvector lookup. The job holds the browser open while waiting on the LLM.

### What "divide into services" means in this spec

Two roles, different resource profiles, different queues:

| Role | Process type | Dominant cost | Horizontal scale unit |
|---|---|---|---|
| **Brain** | `brain.worker.ts` | LLM + pgvector + Redis | Add more Brain processes when resolve latency climbs |
| **Brawn** | `brawn.worker.ts` (renamed from `worker.ts`) | Playwright browser, CPU, RAM | Add more Brawn processes when browser queue backs up |

Brain and Brawn communicate **only through the queue** — never in-process, never by shared mutable state. Either role can run on any host. Either role can scale to N instances independently.

---

## 2. The split — what each service owns

### Brain (stateless, no browser)

**Input:** `RunJobPayload` off `kaizen-runs` queue (same shape as today).
**Output:** `ExecutionManifest` pushed onto `kaizen-exec` queue.

Responsibilities:
1. For each `StepAST` in the payload, call the existing resolver chain (`ArchetypeElementResolver` → `CachedElementResolver` → `LLMElementResolver`) to produce ranked selectors.
2. Assemble a complete `ExecutionManifest` — every step has pre-resolved selectors before Brawn sees it.
3. Enqueue the manifest. Update run status `queued → resolving → ready`.

Does **not**:
- Open a Playwright browser.
- Advance DOM state by executing steps (see §3 on why).
- Touch `step_results` — that's Brawn's table.

### Brawn (stateful, owns the browser)

**Input:** `ExecutionManifest` off `kaizen-exec` queue.
**Output:** `step_results` rows + final `RunStatus`, plus a `HealRequest` back onto `kaizen-heal` when a selector is stale.

Responsibilities:
1. Boot a Chromium context.
2. Walk `manifest.steps` in order. For each step, call `engine.executeWithSelectors(action, step.resolvedSelectors, step.params)`.
3. On first-try failure, classify via existing `FailureClassifier`. If `ELEMENT_REMOVED` / `ELEMENT_MUTATED` → enqueue `HealRequest` (see §5). If anything else → local retry or fail per existing worker logic.
4. Persist results. Close browser. Ack job.

Does **not**:
- Import `@anthropic-ai/sdk` or `openai`.
- Import `CachedElementResolver` or `LLMElementResolver`.
- Query `element_embeddings` or call pgvector.

This is the enforceable line. If Brawn's `package.json` imports don't include LLM SDKs, we know the split is real.

---

## 3. Decision: does Brain need a live browser?

**This was the biggest flaw in the original draft and in the first implementation attempt.** The first draft implementation booted a Playwright browser inside Brain, executed each step after resolving it "to advance DOM state for the next step." That collapses the entire point of the split.

### The options

**Option A — Brain is fully stateless (no browser).**
Brain resolves every step using only what's in the `StepAST` + pgvector + archetype tables + element cache. It cannot "see" the post-step DOM because it never executes.

- **Pro:** Brain is cheap. Thousands of manifests per instance. No per-request browser cost. Matches the spec's "cheap spot instances" note.
- **Con:** Cannot resolve selectors that only exist on a page reached via a prior step (e.g. step 2 targets a modal opened by step 1's click). For those, the manifest ships *best-guess* selectors and Brawn heals on miss.

**Option B — Brain boots a browser too.**
Brain executes each step locally to advance DOM, so step N's resolution sees the real post-(N-1) DOM.

- **Pro:** Manifests are "right" on first execution more often. Less healing traffic.
- **Con:** Brain is now as expensive as Brawn. The entire test runs twice (once in Brain to build the manifest, once in Brawn to execute it). Parallelism goal is dead — we've doubled browser cost, not reduced it.

### Decision: **Option A**.

Brain stays stateless. Accept that some step-N selectors will be wrong on first execution and rely on the **healing path (§5)** to catch them. The healing path is the escape valve that makes Option A viable.

Consequence: `resolvedSelectors` is an *attempt*, not a guarantee. `ExecutionManifest` carries enough context (the original `StepAST`) that a healer can re-resolve with live DOM when needed.

---

## 4. Contracts

### 4.1 Action set — use existing types, do not fork

Drop the literal-union redefinition from the old spec. The canonical action type already exists:

```ts
// src/types/index.ts (already present)
export type StepAction =
  | 'navigate' | 'click' | 'type' | 'select'
  | 'assert_visible' | 'wait' | 'press_key' | 'scroll';
```

`ManifestStep` uses `StepAction` directly. No redefinition, no drift.

### 4.2 `ExecutionManifest`

**File:** `src/types/execution.ts` (NEW)

```ts
import type { StepAction, SelectorEntry, StepAST } from './index';

export type ManifestStep = {
  /** UUID generated by Brain. Correlates manifest step ↔ step_results row. */
  id: string;
  /** Ordinal position in the manifest (0-indexed). Matches StepAST order. */
  index: number;
  action: StepAction;
  /** Carried through verbatim from the source StepAST — healer needs these. */
  targetDescription: string | null;
  value: string | null;
  url: string | null;
  /**
   * Ranked selector candidates. Brawn tries in order.
   * May be empty when Brain could not resolve — Brawn treats empty as
   * "heal on execute" and enqueues a HealRequest immediately.
   */
  resolvedSelectors: SelectorEntry[];
  /** Which resolver layer produced these selectors (null if empty). */
  resolutionSource: import('./index').ResolutionSource | null;
  /** Per-step action timeout in ms. Brawn enforces. */
  timeoutMs: number;
  /**
   * Original StepAST preserved so a Healer can re-resolve without
   * re-fetching the run from Postgres.
   */
  sourceAst: StepAST;
};

export type ExecutionManifest = {
  /** Schema version. Bump when ManifestStep changes shape. Brawn rejects mismatched versions. */
  version: 1;
  runId: string;
  tenantId: string;
  baseUrl: string;
  /** Manifest was built at this time. Brawn rejects manifests older than MANIFEST_TTL_MS. */
  builtAt: string; // ISO-8601
  steps: ManifestStep[];
  trace: {
    screenshots: boolean;
    domSnapshots: boolean;
  };
};

/**
 * Emitted by Brawn when a step fails with a stale-selector failure class.
 * Consumed by Brain on the kaizen-heal queue.
 */
export type HealRequest = {
  runId: string;
  tenantId: string;
  stepId: string;            // ManifestStep.id
  stepIndex: number;
  sourceAst: StepAST;
  failureClass: import('./index').FailureClass;
  /** S3 key of the DOM snapshot captured at the moment of failure. */
  domSnapshotKey: string;
  /** Previous selectors that were tried and failed. Brain deprioritizes these. */
  triedSelectors: string[];
};
```

### 4.3 Queues

| Queue name | Producer | Consumer | Payload |
|---|---|---|---|
| `kaizen-runs` (existing) | API (`POST /runs`) | **Brain** | `RunJobPayload` |
| `kaizen-exec` (NEW) | Brain | **Brawn** | `ExecutionManifest` |
| `kaizen-heal` (NEW) | Brawn | **Brain** | `HealRequest` |

Three queues, one direction each. No process consumes from a queue it also produces to. No branching-on-payload inside a single queue.

**Why three and not two:** a heal is triggered mid-execution. Brawn is still holding the browser open. If heals went back on `kaizen-runs`, they'd be serialized behind new runs. Separate heal queue means a dedicated (or priority) Brain lane for in-flight repair.

### 4.4 Run status lifecycle

```
queued   → (Brain picks up)   → resolving
resolving → (manifest pushed)  → ready
ready    → (Brawn picks up)   → running
running  → (stale selector)   → healing → running (after HealResponse)
running  → (done)             → passed | failed | healed
```

Brain owns `queued → resolving → ready`.
Brawn owns `ready → running → {passed,failed,healed}` and `running ↔ healing`.

---

## 5. The Healing Flow — explicit, not a footnote

When a `ManifestStep` fails on all `resolvedSelectors`:

1. **Brawn classifies** via `FailureClassifier.classify(err, step)`.
2. If class ∈ `{ELEMENT_REMOVED, ELEMENT_MUTATED, ELEMENT_OBSCURED}`:
   a. Brawn captures live DOM snapshot → S3 → `domSnapshotKey`.
   b. Brawn enqueues `HealRequest` on `kaizen-heal`.
   c. Brawn **keeps the browser context alive** and blocks on a `BLPOP`-style wait for a `HealResponse` keyed by `runId:stepId` (Redis pub/sub channel `kaizen:heal:${runId}:${stepId}`).
   d. On response: update manifest step in memory with new selectors, retry execute. Mark step as `healed` in `step_results`.
   e. On timeout (`HEAL_TIMEOUT_MS`, default 30s): mark step failed, fail the run.
3. If class ∈ `{TIMING, PAGE_NOT_LOADED}`: Brawn retries locally per existing logic. No Brain involvement.
4. If class ∈ `{LOGIC_FAILURE}`: fail immediately. Not a selector problem.

**Brain's heal handler** consumes `HealRequest`, calls the resolver chain with the attached `sourceAst` + `domSnapshotKey` (loads the live DOM, runs pgvector + LLM), publishes `HealResponse` to `kaizen:heal:${runId}:${stepId}`.

This is the one place Brain needs DOM context. It comes from Brawn's snapshot — Brain never opens a browser.

---

## 6. Concurrency & backpressure

### Per-process concurrency

```
BRAIN_CONCURRENCY  = 10  # default. LLM I/O bound, tune up.
BRAWN_CONCURRENCY  = 4   # default per process. Each job = 1 browser context.
```

Set via env on the `new Worker(...)` call. Brawn is memory-bound — each browser context is ~150MB. A box with 8GB usable → ~4 concurrent browsers = one Brawn process with `concurrency: 4`, or four processes with `concurrency: 1`.

### Horizontal scaling rule

- **Resolve queue depth rising** → add Brain processes.
- **Exec queue depth rising** → add Brawn processes (or Brawn hosts).
- **Heal queue latency rising** → add Brain processes (or give heal priority weighting).

BullMQ's queue-metrics endpoint (already wired via the existing health route) drives this. No autoscaler in v1 — manual scale-up, document the signals.

### Backpressure

- `kaizen-exec` gets a `maxLen` cap. When full, Brain pauses consumption from `kaizen-runs`. Prevents Brain from producing manifests faster than Brawn can drain them (which would balloon Redis memory).
- Brawn rejects manifests older than `MANIFEST_TTL_MS` (default 5min) — manifests for pages that have likely drifted.

---

## 7. What exists, what changes, what's new

### Already exists — do not rebuild

| Component | Location |
|---|---|
| BullMQ `RUNS_QUEUE_NAME` + Redis connection | [src/queue/index.ts](../src/queue/index.ts) |
| `PlaywrightExecutionEngine` | [src/modules/execution-engine/playwright.execution-engine.ts](../src/modules/execution-engine/playwright.execution-engine.ts) |
| Resolver chain (`Archetype` → `Cached` → `LLM`) | [src/modules/element-resolver/](../src/modules/element-resolver/) |
| `FailureClassifier`, `HealingEngine` strategies | [src/modules/healing-engine/](../src/modules/healing-engine/) |
| `StepAST`, `SelectorEntry`, `ResolutionSource`, `FailureClass` | [src/types/index.ts](../src/types/index.ts) |

### Modify

- `src/workers/worker.ts` → rename to `src/workers/brawn.worker.ts`. Strip all LLM/resolver imports. Consumes `kaizen-exec`. Produces `kaizen-heal`.
- `src/modules/execution-engine/playwright.execution-engine.ts` → add `executeWithSelectors(action, selectors: SelectorEntry[], params, timeoutMs)` method. Existing selector-resolving methods stay for tests/direct use.
- `src/queue/index.ts` → export `EXEC_QUEUE_NAME`, `HEAL_QUEUE_NAME`, constructors.

### Create

- `src/types/execution.ts` — `ExecutionManifest`, `ManifestStep`, `HealRequest`, `HealResponse`.
- `src/modules/brain/brain.service.ts` — `generateManifest(payload) → ExecutionManifest`.
- `src/modules/brain/heal.service.ts` — `resolveHeal(req) → HealResponse`.
- `src/workers/brain.worker.ts` — BullMQ worker consuming `kaizen-runs` and `kaizen-heal`.
- `src/modules/execution-engine/dom-snapshot.service.ts` — capture + S3 upload for heal requests (factored out of the current worker).

### Delete (after cut-over)

Nothing in the first pass. The old `worker.ts` becomes `brawn.worker.ts` via rename + strip; we don't delete anything until parity is proven.

---

## 8. Observability

Every span/log already has `runId` and `tenantId`. Add:

- `manifestId` (UUID assigned by Brain) — threads Brain trace to Brawn trace.
- `stepId` (ManifestStep.id) — threads Brawn step trace to heal trace.
- `workerRole` ∈ {`brain`, `brawn`} — so dashboards can filter.

Key log events (all under existing `obs.log`):

- `brain.manifest_generated` — `{ runId, manifestId, stepCount, totalLatencyMs, resolutionSources }`
- `brain.manifest_rejected` — `{ runId, reason }` (e.g. version mismatch, TTL)
- `brawn.manifest_received` — `{ runId, manifestId, ageMs }`
- `brawn.step_executed` — `{ stepId, selectorUsed, durationMs, attempt }`
- `brawn.heal_requested` — `{ stepId, failureClass }`
- `brain.heal_resolved` — `{ stepId, latencyMs, resolutionSource }`
- `brawn.heal_timeout` — `{ stepId, waitedMs }`

---

## 9. Execution order (implementation checklist)

Each box is independently mergeable and testable. Do them in order.

- [ ] **Step 1 — Contract.** Create `src/types/execution.ts` with all four types. Export from `src/types/index.ts`. No consumers yet.
- [ ] **Step 2 — Queue plumbing.** Add `EXEC_QUEUE_NAME`, `HEAL_QUEUE_NAME`, `createExecQueue()`, `createHealQueue()` in `src/queue/index.ts`. Unit test: queue constructors produce valid BullMQ instances.
- [ ] **Step 3 — Engine method.** Add `PlaywrightExecutionEngine.executeWithSelectors(action, selectors, params, timeoutMs): Promise<StepExecutionResult>`. Unit test: pass 3 selectors, first two throw, third succeeds → returns `passed` with third selector. Test: all fail → returns `failed` with `errorType = 'SELECTOR_NOT_FOUND'`.
- [ ] **Step 4 — DOM snapshot service.** Factor current worker's snapshot logic into `DomSnapshotService.captureAndUpload(page, runId, stepId): Promise<string>`. Used by Brawn on heal. Unit test: returns S3 key, uploaded blob is valid HTML.
- [ ] **Step 5 — BrainService.** `generateManifest(payload: RunJobPayload): Promise<ExecutionManifest>`. Iterates steps, calls `CompositeElementResolver.resolve()` for each, assembles manifest. Unit test with mocked resolver: input 3 StepASTs → output manifest with 3 ManifestSteps, correct `resolutionSource` per step.
- [ ] **Step 6 — Brain worker.** `src/workers/brain.worker.ts`. Consumes `kaizen-runs`, calls `BrainService`, pushes manifest to `kaizen-exec`. Also consumes `kaizen-heal`, calls `HealService`, publishes to Redis pub/sub channel. Integration test: end-to-end with real Redis, mocked resolver — job in `kaizen-runs` → manifest appears in `kaizen-exec`.
- [ ] **Step 7 — Brawn worker.** Rename `worker.ts` → `brawn.worker.ts`. Remove `OpenAIGateway`, `LLMElementResolver`, `CachedElementResolver`, `SharedPoolService` imports. Replace `resolve → execute` loop with `manifest.steps.map(s => engine.executeWithSelectors(...))`. Integration test: synthetic manifest → Brawn executes → correct step_results rows.
- [ ] **Step 8 — Heal loop.** Implement pub/sub wait on Brawn side, publish on Brain side. Integration test: inject stale selector in manifest, real Brawn + Brain running, assert `healed` status and new selector in `step_results`.
- [ ] **Step 9 — Backpressure & TTL.** Wire `MANIFEST_TTL_MS` reject path in Brawn. Wire Brain pause on `kaizen-exec` depth. Load test: 100 runs queued, verify no Redis OOM.
- [ ] **Step 10 — Dev runbook.** `npm run dev:brain` and `npm run dev:brawn` scripts in `package.json`. Update [docs/CLAUDE.md](CLAUDE.md) "Running Locally" with three worker processes instead of one.
- [ ] **Step 11 — Parity proof.** Run the full integration suite against the two-process setup. Every test that passed against the monolith must pass against Brain+Brawn. Delete the old monolithic worker entry point from `package.json` *only* after this passes.

---

## 10. Milestone: done when

1. A single `POST /runs` call triggers:
   - Brain consumes from `kaizen-runs`, produces a manifest on `kaizen-exec`.
   - Brawn consumes from `kaizen-exec`, executes without making *any* LLM or pgvector call during steady-state execution (verified via `DISABLE_LLM=1` on Brawn — runs still complete when all resolvers pre-hit cache/archetype).
2. Brawn's `package.json` imports do not include `@anthropic-ai/sdk`, `openai`, or `@pinecone-database/pinecone`. (Enforced by a lint rule added to Step 11.)
3. `BRAWN_CONCURRENCY=4` on one host runs 4 tests truly in parallel (4 browsers, 4 separate execution traces in the log).
4. A stale-selector run completes as `healed` — Brawn pauses, Brain re-resolves, Brawn resumes, step re-executes.
5. A manifest older than `MANIFEST_TTL_MS` is rejected with a re-resolve-and-requeue on Brain. (Prevents stampedes after a deploy when queued manifests reference a stale UI.)

---

## 11. Notes for the team

- **Cost shape:** Brain hosts are network-heavy, memory-light — spot instances or the smallest Fargate task is fine. Brawn hosts are RAM-heavy (browsers) and should be on-demand. Scaling rule in §6 drives which side gets headroom first.
- **Do not share Redis connections across Brain and Brawn processes.** Each process creates its own via `createRedisConnection()`. Easier to reason about, and BullMQ's `maxRetriesPerRequest: null` rule applies per-connection.
- **Brain failure ≠ run failure.** If Brain crashes mid-resolve, BullMQ retries the `kaizen-runs` job. The run is still `queued` from the user's perspective. Only Brawn can move a run to terminal state.
- **Security boundary unchanged.** Multi-tenancy checks remain at the resolver and step_results write paths — neither service bypasses them. `tenantId` is carried on every payload, every manifest, every heal request.
