# The Test Writer — What We Have and What We Don't

Created: 2026-08-24
Updated: 2026-08-24

One feature: a customer points Kaizen at their site, clicks Analyze, and gets a
full test suite without writing anything. Under the hood it is a pipeline of
specialized stages — an LLM wherever judgment is needed, deterministic code
wherever trust is needed. The bar: produce at least what a skilled human-driven
agent session produced (226 tests on the Kaizen app), on any site,
**memorylessly** — every run starts from nothing but the site and a brief.

---

## The pipeline, in order

**1. Recon** — crawls the site (login recipe first if given) and records every
page: elements with stable selectors, forms, text. Caps at the page budget.

**2. Explorer** — an LLM drives a real browser over the crawled app: click,
open, go home, record. It finds the *screens* that have no URL — menus, sheets,
tabs, dialogs — and records the click-path ("hops") that reaches each one.
A safety gate decides what it may click; it cannot leave the site or touch
dangerous controls.

**3. Comprehend + Plan** — classifies every page's purpose, then plans test
scenarios per batch of pages, guided by the run's brief (priorities, cautions,
what data is throwaway).

**4. Journey tier (the deep tests)** — per planned scenario:
LLM **writer** produces steps from real observed elements →
LLM **judge** kills plan-infidelity and nonsense →
the **engine executes a proving run** (self-healing, screenshots) →
failures enter a **repair loop** (rewrite with the failure as a lesson,
revalidate). After each round a **fill planner** re-scans pages that still have
untested material and adds scenarios — "12 requested" typically becomes ~25–29
written. Only run-proven journeys deliver as `validated`.

**5. Fact tier (the wide tests)** — the volume engine. Every screen is
transcribed through **three focused lenses**:

- *structure* — what is present ("the Search box is visible")
- *interactions* — action → outcome ("New Test reveals the name field",
  filters, tabs, openers open **and** close, empty states, keyboard shortcuts)
- *fixture* — create a record named `{{fixture}}`, then assert around it
  (only on screens that can create, only with synthetic-data consent)

Every fact passes a **hard deterministic gate**: observed element ids only,
≤5 steps, must end in an assertion, echo trap (no asserting text you just
typed — with search-box and submit-click exceptions), non-event rule (never
assert only the control you acted on), role compatibility, no new-tab targets,
`{{fixture}}` only where defined.

**6. Batch verification** — pure Playwright, no LLM. One browser session signs
in once; three parallel contexts share that login and replay every surviving
fact against the **live site**. Confirmed → kept; not confirmed → declined with
the exact reason. Seconds per fact instead of an engine run each.

A **batch-verified fact** is therefore a test whose claim was confirmed against
the real running app, but via fast shared-session replay rather than a
dedicated engine run — hence the honest label `verified_batch`, distinct from
`validated`.

**7. Engine audit** — a random sample (min 8, ~10%) of delivered facts runs
through the real engine with a step-fidelity check: a step only counts if the
element it *used* is the element it *names*. This exists because the verifier
is our own machinery checking our own machinery — the audit catches its
systematic blind spots (vacuous oracles, unfaithful step resolution). Why only
10%: each fact was already individually live-confirmed; the sample certifies
the *process*. A systemic 20% blind spot is caught by a 20-fact sample with
~99% probability, and a hard-failing sample flags `quarantineAdvised` for the
whole batch. Auditing everything would add ~2 hours to re-check already-checked
items.

**8. Report** — delivered counts per state, every rejection with stage and
reason, token usage, and findings about the app itself (console errors, broken
pages).

---

## The trust model

- Nothing delivers on an LLM's word alone: journeys are engine-proven; facts
  are live-replayed; an audit sample double-checks the replay.
- Every decline is recorded with a reason; per-run decline audits separate
  correct refusals from our bugs (this produced most of the week's fixes).
- Containment everywhere: one malformed LLM answer costs one
  scenario/lens/fact, never the run.
- Safety: billing/API-key/settings pages are read-only knowledge, never write
  targets; destructive confirms are cancelled; fixtures require consent.

## Parallelism (spec-parallel-pipeline, all implemented)

| Stage | Width | Mechanism |
| --- | --- | --- |
| Journey writes (+ repairs) | 4 | worker pool, deterministic merge in plan order |
| Plan / fill-round batches | 4 | worker pool per page-batch |
| Fact transcription | 4 pages | worker pool, merge in dossier order |
| Batch verification | 3 contexts | facts sharded by screen; fixtures stay once-per-screen |
| Engine validation | 3 (was 1) | **shared authenticated session**: the first proving run logs in and exports its browser state to Redis (short TTL); siblings start pre-authenticated — one credential submission per batch, no lockout risk |
| Engine capacity | env | `WORKER_CONCURRENCY` (4 local) or worker replicas via BullMQ |

Result: ~2.5 h per run → ~60 min on the dev harness (~20 min on a direct API).

## The dev harness (not product code)

Kaizen believes it calls an LLM API; actually it hits a local inbox
(`scripts/llm-inbox.ts`, :4141) that writes each prompt to a file, and a
watcher (`scripts/llm-answerer.ts`) answers each with a one-shot
**`claude -p` on sonnet** — fresh process per prompt, so no conversation ever
grows (no /compact), billed to the Claude Code subscription, ~4 concurrent.
Around it: the bench runner (fresh suite per run, full report file), a 2-minute
heartbeat monitor that also greps service logs for failure signatures
(sign-in failures, gateway failures, unhandled errors), and pre-run
environment validation (containers, queues, zombie jobs, stale rows, target
reachability).

## Scoreboard against the 226 bar

| Run | Target | Delivered | What it taught |
| --- | --- | --- | --- |
| 26 | Kaizen | 45 | recon coverage was the wall |
| 28 | Kaizen | 67 | per-screen yield + sibling dedup |
| 29 | Kaizen | 66 | one wide prompt returns thin → three lenses |
| 30 | Kaizen | **100** | lenses worked; decline audit → 5 bug classes fixed |
| 32 | the-internet | cancelled | 2.5 h pace unacceptable → parallel pipeline built |
| 34 | the-internet | 8 | 62-min run; `__name` bug failed sign-in and killed all 285 facts |
| 35 | the-internet | in flight | all fixes in; ~290 fact candidates expected |

## What we DON'T have

- **A run ≥ 226.** Best honest capability ≈ 130 (run 30 plus its wrongly
  declined). ~190 is realistic for run 35 if verification passes at 60%+.
- **The policy lever (user's decision, parked):** reversible settings toggles,
  delete-own-record, auth-scoped public pages — ~45 additional tests on the
  Kaizen app. The 226 baseline included these.
- **Fact-tier circuit breaker:** if every fact fails with the same reason, the
  tier should halt loudly instead of completing with zero (run 34's lesson).
- **Engine backlog (real bugs found, deferred):** sheet-field NoSelectorsError
  false negative; `possible_app_defect` noise when the test (not the app) is
  wrong; pipeline must refuse jobs whose DB row is already terminal.
- **Production LLM wiring:** everything runs through the dev inbox; the direct
  API path (faster, cheaper at scale, parallel) is not wired.
- **No commits:** the entire week sits uncommitted on
  `fix/test-writer/run-two-lessons` behind the gate — nothing lands until a
  run clears 226.
