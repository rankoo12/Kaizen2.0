# Spec: Run Details Showcase Page

Created: 2026-06-20
Updated: 2026-06-20

## 0. Motivation

A passing run is not enough on its own — users (and external stakeholders with
whom a run is shared) need to see, step by step, exactly what the automation
did and how Kaizen made its decisions: which element was chosen for each
natural-language step, which resolver tier produced it, the concrete selector
used, any self-healing, captured values, and the result of each assertion.

The existing run detail screen
([`packages/web/src/app/(app)/tests/[id]/page.tsx`](packages/web/src/app/(app)/tests/[id]/page.tsx),
hook [`use-run-detail.ts`](packages/web/src/hooks/use-run-detail.ts)) already
live-polls and renders a step timeline. This spec defines the *showcase*
enhancements that turn it into a self-explanatory, shareable artifact.

## 1. What already exists (do not rebuild)

- `GET /runs/:id` ([`src/api/routes/runs.ts:141`](src/api/routes/runs.ts))
  returns per-step: `status`, `cache_hit`, `selector_used`, `duration_ms`,
  `error_type`, `failure_class`, `healing_event_id`, `screenshot_key`,
  `resolution_source`, `similarity_score`, `dom_candidates`,
  `llm_picked_kaizen_id`, `tokens_used`, `user_verdict`, plus the step's
  natural-language `rawText`.
- `useRunDetail` maps that to camelCase and polls every 2s while non-terminal.
- A per-step candidate-override endpoint exists
  (`PATCH /runs/:runId/steps/:stepId/candidate`).

So the data backbone is present. This spec adds **presentation** + two new
fields (`captured_name`, `captured_value` from
[spec-engine-capabilities-assert-random-capture.md](../workers/spec-engine-capabilities-assert-random-capture.md) §3.5).

## 2. Showcase requirements

### 2.1 Per-step "decision card"

Each step row expands to show:
- **NL intent** — the original English step text (`rawText`).
- **Action** — `click`, `type`, `assert_text`, `click_random`, etc.
- **Chosen element** — accessible name + role of the picked candidate
  (resolved from `dom_candidates` via `llm_picked_kaizen_id`).
- **How it was chosen** — `resolution_source` rendered as a human label:
  `L0 Archetype`, `L1 Redis`, `L2 Postgres exact`, `L3 pgvector (tenant)`,
  `L4 pgvector (shared)`, `L5 LLM`. Include `cache_hit` badge and
  `similarity_score` when present. **This is the differentiator** — it shows
  Kaizen's self-healing/learning brain, which no plain Playwright report has.
- **Selector used** — the concrete `selector_used` string (monospace).
- **Captured value** — when `captured_name` is set: "captured
  `<name>` = '<value>'". When the step interpolates a variable
  (assert_text), show "asserted contains '<value>' ✓/✗".
- **Healing** — if `healing_event_id` is set, a badge linking to what healed.
- **Timing + tokens** — `duration_ms`, `tokens_used`.
- **Screenshot** — thumbnail from `screenshot_key` (lightbox on click).

### 2.2 Run header summary

Status pill, total duration, total tokens, step pass/heal/fail counts,
target URL, triggered-by, timestamps. Live-updates while running.

### 2.3 Cross-step linkage callout

A visible connector between a capturing step (one with `captured_name` set) and
any later step that asserts against that variable: both show the same captured
value, making the linkage obvious at a glance rather than requiring the reader
to correlate steps manually.

### 2.4 Shareability

A shared link must render for an external viewer without exposing the rest of
the tenant's data. Options (decide at impl): a read-only run-share token, or a
scoped public-read endpoint for a single run id. MUST NOT leak other
runs/tenants. Until decided, the safe interim is a screen-recorded walkthrough
plus screenshots.

## 3. Frontend changes

- Extend `StepResult` type + `useRunDetail` mapping with `capturedName`,
  `capturedValue`, `similarityScore`, `cacheHit`, `healingEventId`.
- New molecule/organism: `StepDecisionCard` under the atomic-design hierarchy
  (Tailwind only, no inline styles — per CLAUDE.md).
- A `resolutionSourceLabel(source)` util mapping raw source → human tier label.

## 4. Out of scope

- Editing/re-running from the share view.
- Auth model for sharing beyond a single read-only run token (track separately
  if the interim recording path is taken).

## 5. Acceptance criteria

1. Opening a finished run shows every step as a decision card with chosen
   element, resolver tier, selector, timing, and screenshot.
2. A capturing step shows its captured value; a later asserting step shows the
   matching assertion against the same value.
3. The page live-updates while the run is in flight (existing 2s poll).
4. `npm run typecheck` and `npm run lint` pass.
