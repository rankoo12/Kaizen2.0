# Spec: Playwright Harvest — capabilities we pay for and do not use

Created: 2026-11-01
Status: Roadmap (audit complete; implementation sequenced after the
site-portfolio campaign, so the campaign's failures rank the items)

## 1. Why

Playwright ships evidence and control surfaces we already load into every
worker but never read. Each unharvested capability is diagnosis we re-derive
by hand (or lose). This spec is the audit; items get their own specs when
scheduled.

## 2. In use today

Role/CSS selectors, actions, per-step screenshots, frames (incl. srcdoc),
dialog handling, accessibility snapshot (classifier signals A/B),
`ariaSnapshot` (dom-pruner), per-run **video** (feat/media/run-video — built,
verified, unmerged).

## 3. The harvest list

| Tier | Capability | What it buys | Landing zone |
|---|---|---|---|
| 1 | **Tracing** (`context.tracing.start/stop`) | Per-action DOM snapshots + network + console + screencast in one zip; B10 "evidence bundle" nearly for free; `trace.playwright.dev` as the free viewer | worker: start on run begin, stop+attach on failure (trace-on-retry economics: keep only failing runs' traces) |
| 1 | **Console + `pageerror` capture** | A JS exception at failure time turns `LOGIC_FAILURE ?` into "the app threw X at step N" — classifier signal D | worker page listeners → ring buffer → stamped onto failed step_results |
| 1 | **Network capture on failure** (request/response summaries) | The 500 behind a "late outcome" failure names the real cause; also catches mock-site misbehavior in benches | same ring-buffer pattern; summaries only, bodies capped |
| 2 | **`expect()` auto-waiting audit** | Our hand-rolled polling (assert_text 8s poll, visibility checks) audited against Playwright's semantics — keep deliberate differences, document them, adopt where ours is weaker | engine; audit doc first, changes only with bench proof |
| 2 | **Clock API** (`page.clock`) | Deterministic time for latency-game bench sites; reproducible "the widget appears at T+20s" | bench harness only, never production runs |
| 3 | WebSocket / download / popup events | Coverage for app classes we have not met in a bench yet | deferred until a site demands it |

## 4. Non-goals

- `codegen` (we generate from NL, not recordings).
- Replacing the resolver's selector strategy with Playwright locator chains —
  the cache and healing own selector identity.

## 5. Sequencing

Campaign first on the sealed engine; then Tier 1 as one branch
(`feat/engine/evidence-harvest`), each item verified on a bench failure it
makes legible. Backlog entry: B22.
