# Spec: Post-redesign feature backlog

Created: 2026-07-30

## 1. Where this list comes from

The native macOS redesign (`docs/specs/ui/spec-native-macos-port.md`) shipped every screen
on live data. Building it produced an exact inventory of what the design *promised* that
the backend could not yet supply, because `Kaizen (1)/native/data.jsx` is a complete set
of mock fixtures — every field in it is a claim about the product.

Each fixture field was checked against the live schema. That gives three tiers:

- **Tier A — already captured, not plumbed.** The database has the data; the API or the
  UI drops it. Hours, not days.
- **Tier B — needs new schema or a subsystem.** Real features.
- **Tier C — fixture content.** Not gaps (sample names, sample tenant).

Nothing here was faked in the shipped UI. Where a source was missing, the screen omits
the field rather than inventing it — see spec-native-macos-port.md §12 "Deliberately not
faked" for the list as shipped.

## 2. Phase plan

Phases are ordered by (value ÷ effort), and each ends in a state worth showing.

| Phase | Theme | Contents | Rough size |
|---|---|---|---|
| 0 | Plumb what we already capture | A1–A7 | 1–2 days |
| 1 | Finish what the UI already implies | B1, B2, B3, B13, X1 | ~1 week |
| 2 | Make the cost promise provable | B4, B5 | ~1 week |
| 3 | Evidence a QA lead trusts | B6–B10 | 1–2 weeks |
| 4 | Team + automation | B11, B12, B14–B17 | 2–4 weeks |
| 5 | Mobile | B18 | deferred |

**Verification bar for every item** (per `feedback_verify_before_prod`): unit test where
there's logic, plus a real end-to-end pass against the live stack — create/run/observe
through the actual UI, not just a green test. `npm run audit:contrast` must stay at zero
unreadable.

---

## 3. Tier A — already captured, not plumbed

### A1. Heal trace: what broke, how it recovered — ✅ DONE 2026-07-30
**Design promised** an expandable panel per healed step: error class, a
`was → now` selector diff, retry count, and prose on how it recovered.

**Reality** `healing_events` already stores `failure_class`, `strategy_used`, `attempts`,
`succeeded`, `old_selector`, `new_selector`, `duration_ms`, and is populated with real
pairs (e.g. `[data-kaizen-id='kz-16']` → `role=link[name="Football"]`).

**Gap** [runs.ts](../../../src/api/routes/runs.ts) fetches healing rows but its `SELECT`
omits `old_selector`/`new_selector`, and
[use-run-detail.ts](../../../packages/web/src/hooks/use-run-detail.ts) never maps
`healingEvents` onto the step result at all.

**Work** Add the two columns to the query; attach `healingEvents` in the mapper; add
`healingEvents: HealingEvent[]` to `StepResult`; render the real diff in
`screen-run.tsx`'s heal disclosure (the markup already exists, it just has nothing to
show).

**Acceptance** A run that healed shows the actual old and new selector, the strategy that
recovered it, and the attempt count — no invented prose.

**Shipped** `healing_events` now travels per step as `StepResult.healingEvents`. The step
row renders the animated `was → now` diff; the inspector names the strategy and attempt
count, and when healing *failed* it says so and shows the selector it tried. Verified
against this workspace's real failed heal (`LOGIC_FAILURE / EscalationStrategy / tried
body`). The successful `was → now` branch reads the same verified fields but hasn't been
observed live here yet — no successful heal exists in this workspace.

### A2. Cancel a running run — ✅ DONE 2026-08-04
`POST /runs/:id/cancel` existed and worked; nothing called it. Now in the run screen's
overflow menu, present only while the run is non-terminal, behind a confirm sheet whose
dismiss reads "Keep running" (two buttons saying "Cancel" was a mis-click waiting to
happen). The three real outcomes are distinguished: 202 accepted, 200 already cancelled,
409 already finished. Verified against a live run — cancelled at 0/3 steps.
Spec: [spec-phase-0-plumbing.md](./spec-phase-0-plumbing.md).

### A3. Retries per step — ✅ DONE 2026-07-30
`healing_events.attempts` — shipped with A1 as Attempts / Strategies / Healing time in the
inspector's heal panel.

### A4. Resolution confidence per step — ✅ DONE 2026-08-04 (scope corrected)
The premise was wrong in two ways, both found by measuring the live table rather than
reading the schema.

`similarity_score` is populated by **only the two vector tiers** — 455 of 13,198 rows
(3.4%), in a 0.966–1.000 band. A "Confidence" column would be blank on 97% of steps and
would distinguish 99.0% from 100.0% on the rest. It ships as a **Match** cell and a line
of prose on vector-resolved steps only.

`cache_hit` has **never been written** — 0 of 13,198 rows, and no INSERT in `src/workers/`
names it. It was dropped from the contract rather than plumbed. See
[spec-phase-0-plumbing.md §5](./spec-phase-0-plumbing.md) for the measurement, and §5's
follow-on: write it or drop the column.

### A5. Per-run environment — ✅ DONE 2026-08-04
`GET /runs/:id` already sent `environment_url` (it returns the raw row); the web mapper
dropped it. The list neither selected nor returned it. Both fixed, and the run subtitle
now shows **the run's own** environment rather than the case's current `base_url` — the
two diverge when a run overrides `baseUrl` or the case is edited afterwards, which would
misattribute the evidence on screen.

### A8. Selector provenance in the Brain — ✅ DONE 2026-08-02
**Shipped** `GET /brain/selectors` now answers "where did this come from" from real data,
via three CTEs over `step_results.target_hash`:

- *most recent use* → step text, test case, suite, run id, **step-result id**
- *first use* → `resolution_source` of the earliest resolution = how it was originally
  learned (an entry first seen as `llm` was read off the page by the model; `archetype`
  matched a known pattern)
- *spread* → how many distinct tests rely on the entry

The row shows its source test inline; expanding gives the full origin plus **Open the
step that used it**, which deep-links to that run with the exact step preselected
(`Focus.stepResultId` → `RunScreen initialStepId`). This closes the loop the screen
exists for: a selector that looks wrong is one click from its evidence.

### A9. View and edit a test's steps — ✅ DONE 2026-08-02
There was no way to see, let alone fix, a test's definition — clicking a test opened its
latest run, and the author screen only created. A test discovered to be wrong could not be
corrected from the UI at all (the "Rejects a bad password" case asserted the success
message and had to be fixed by hand in the database).

`PATCH /cases/:caseId` already accepted `{name, baseUrl, steps}` with the step-versioning
protocol, so this was purely a UI gap. The author screen takes an optional `editCaseId`:
it loads the current definition, and saves with PATCH instead of POST — the test keeps its
identity, run history, and everything the brain learned for unchanged steps. Reachable
from the Tests row menu and the run screen's overflow menu.

### A10. One truth for a run's token cost — ✅ DONE 2026-08-02
The Tests list reported a run as **free** while that run's own step showed `AI · 97 tok`,
and "Tokens this month" sat unchanged at 97.

**The step was lying, not the list.** `OpenAIGateway.resolveElement` keeps a Redis prompt
cache; on a hit it returns `{...cached, fromCache: true}` and emits **no** billing event,
because no request was sent. But the cached payload still carries the *original* call's
`promptTokens`/`completionTokens`, and `LLMElementResolver` summed them without checking
`fromCache`. So every replay recorded a fresh 97 tokens against a call that never
happened: `step_results` totalled **388 tokens** for this tenant against **181** actually
billed.

Fixed at the source — `tokensUsed: llmResult.fromCache ? 0 : prompt + completion`, at both
the page and in-frame resolution sites. Proven: two consecutive runs now record
`llm:0`, report 0 on every surface, and write **zero** billing events, which is the truth.

Separately, the read paths disagreed because they used different sources: the run detail
summed `step_results`, while the cases list, case detail, runs feed and `run.total_tokens`
summed `billing_events` inside the run's `started_at`–`completed_at` bracket.
`billing_events` has no `run_id`, so that attribution is by timestamp overlap — it cannot
distinguish two concurrent runs in one tenant. All four now sum `step_results.tokens_used`
scoped by `run_id`, which is run-scoped by construction and, after the fix above, honest.

**Note on the earlier diagnosis:** this was first written up as "a billing row landed
outside the run's time window". That was wrong — there was no billing row at all. The
window was a red herring; the prompt cache was the cause.

**Still open:**
- Per-run *billing* attribution needs a `run_id` on `billing_events` before anyone
  invoices from that table.
- A prompt-cache replay still reports `resolution_source = 'llm'`, so the UI shows
  `AI · 0 tok`. Accurate, but a distinct source (say `llm_prompt_cache`) would read
  better and would let the Brain tell a replayed answer from a fresh one.

### A11. Pinning a shared-pool selector did nothing — ✅ DONE 2026-08-02
`PATCH /runs/:id/steps/:id/verdict` with `passed` pinned via
`WHERE content_hash = $1 AND tenant_id = $2`. A step that resolved from the **global
brain** has no tenant-scoped row, so the update matched zero rows and the pin silently
vanished — the user pinned an element, returned to the Brain and found it unchanged. The
`failed` verdict already purged both tenant and shared rows; the positive verdict now
covers both scopes the same way. Verified end to end: a `scope=global` entry went
`pinned=false → true` through the real endpoint.

### A12. "Needs review" that never cleared — ✅ DONE 2026-08-02
The flag was `confidence < 0.75 || fail_count_window > 0`. The resolver only ever
**increments** `fail_count_window` — it never resets on success, despite the name — so a
single bad run marked an entry for review permanently, no matter how many clean runs
followed. Nothing in the resolver reads that column; it is informational only.

The rule is now `!pinned && confidence < 0.75`. Confidence is already recomputed from the
outcome window on every run, so recovery clears the flag on its own, and a human pin
settles it outright.

**Worth fixing separately:** `fail_count_window` should reset (or decay) on success, or be
renamed — as a monotonic counter it cannot mean what "window" implies.

### A14. Tests list went stale after a run — ✅ DONE 2026-08-02
Starting a run from the Tests screen navigates to it (correct), but coming back showed the
row still **RUNNING** with the previous run's cost, because the list is fetched once and
was only refetched 2s after enqueueing — long before the run finished.

Two changes: `go('tests')` refetches on arrival, and while the Tests screen is open with
anything queued or running it polls every 4s, stopping as soon as nothing is in flight
(an idle workspace makes no requests). Verified: row reads **Running · —** on return, then
settles to **Passed · free** after ~9s without navigating.

### A13. Failed steps on the production line — ✅ DONE 2026-08-02
The Line view had no failure state: a failed step rendered identical to a healthy one.
A failed machine is now red, hazard-striped, knocked off true, captioned `failed`, with a
"Broke down — the step failed, the line stops here" legend entry. Failure outranks every
other tone.

### A6. Live progress in the Runs feed — ✅ DONE 2026-08-04 (needed a migration)
"Derivable from the case's step count" stopped being true when A9 shipped test editing in
the same release: `test_steps` rows are immutable and versioned, so a case's active step
set can change **while a run is in flight**, and the denominator would move under a live
meter. Migration `028_run_total_steps` stamps `runs.total_steps` at enqueue (both call
sites already hold the compiled array) and backfills history from `step_results`.
Verified live: `0/3 → 1/3 → 2/3 → 3/3`.

### A7. Restore the audit gate in CI — ◐ PARTIAL 2026-08-04
**There was no CI at all** — no `.github/`, no GitLab or CircleCI config. This was
"create CI", not "add a step".

*Shipped (A7a):* `.github/workflows/ci.yml` — typecheck (api + web), lint, and the unit
suite on push and PR. Blocking, which required fixing the 7 pre-existing lint errors
first: a gate that is red on arrival teaches everyone to ignore it.

*Still open (A7b):* the contrast and mock audits. They drive a real browser against a
logged-in app across three appearances, so they need Postgres, Redis, the API, the web
server and a seeded tenant — an integration environment, not a lint step. Own spec, own
job.

---

## 4. Tier B — needs new schema or a subsystem

### B1. API key management
**Design promised** a table of keys: label, `kz_live_…` prefix, scope badge
(read_only / execute / admin), created date, last used, revoke.

**Reality** The `api_keys` table is **fully built** — `key_hash`, `key_prefix`, `scope`
(enum), `description`, `expires_at`, `last_used_at` — and `requireApiKey` already
authenticates against it, stamping `last_used_at`.

**Gap** No routes. `POST /tenants/:id/api-key` rotates the *legacy* single
`tenants.api_key_hash` instead, which is what the shipped Usage screen uses.

**Work** `GET /tenants/:id/keys`, `POST /tenants/:id/keys {description, scope, expiresAt?}`
returning the raw key exactly once, `DELETE /tenants/:id/keys/:keyId`. Then port the
design's key table + create sheet (it has both, including the scope picker). Retire the
legacy single-key path.

**Acceptance** A key created in the UI can trigger a run via `POST /runs` with
`X-API-Key`; revoking it makes that call 401.

### B2. Test drafts
`test_cases.status` already allows `draft | active | validating | rejected | archived`.
The design's author screen had "Save draft"; the port dropped it. Needs the create/patch
routes to accept status, the list to filter, and a draft affordance in the Tests list.

### B3. Token quota + billing cycle
**Design promised** a quota meter: "1,284,300 of 2,000,000 this cycle", % remaining,
"Resets Aug 12", and a warning that over-quota runs are rejected at submit.

**Reality** `tenants.llm_budget_tokens_monthly` exists and **is enforced** (402
`TOKEN_LIMIT_REACHED` / `INSUFFICIENT_TOKENS`), but no endpoint exposes it, so the shipped
Usage screen shows tokens spent with no denominator.

**Work** Add `budgetTokensMonthly` and a cycle boundary to `GET /tenants/:id/usage`.
Decide the cycle rule (calendar month vs. anniversary) — `usageThisMonth` currently
implies calendar month, so state it. Then the meter + "resets on" copy.

### B4. Per-case aggregates
**Design promised** per test: total runs, cache-hit %, learned-element count, first vs.
last token cost, average duration. It also drove the "comfortable" density mode, which
added a CACHE column.

**Reality** None of it is stored; deriving it live means a scan of `step_results` per case
per page load.

**Work** A `case_stats` table (`case_id` PK, `runs`, `passed`, `healed`, `failed`,
`first_run_tokens`, `last_run_tokens`, `avg_duration_ms`, `cache_hit_pct`,
`learned_elements`, `updated_at`), written on run completion by the worker (or a small
projector off `run_events`). Backfill once from history.

**Acceptance** The Tests list renders per-case cache % and run counts with no extra
per-row queries; numbers match a hand-written aggregate query.

### B5. Cost + cache-hit history (the core promise)
**Design promised** the headline chart: 30 days of tokens-per-run trending toward zero,
plus runs/day and cache-hit/day, and "up from 41% a month ago" on The Brain.

**Reality** Nothing records history. The shipped Usage screen can only chart the tokens of
individual recent runs, and says so when they're all free.

**Work** A `daily_usage` rollup (`tenant_id, day` PK, `runs`, `tokens`, `lookups`,
`cache_hits`, `heals`, `failures`), appended by a nightly job plus incrementally on run
completion. Then the design's `CostChart` and the Brain's trend line become real.

**Acceptance** The 30-day curve renders from the rollup, and its totals reconcile with
`billing_events` for the same window.

### B6. Element highlight on evidence screenshots
**Design promised** the acted-on element outlined in the screenshot (`hl: {x,y,w,h}`),
with a red variant on failure. This is what makes evidence reviewable at a glance instead
of a wall of images.

**Work** The execution engine records the element's bounding rect at action time (it
already has the locator); persist as `step_results.element_rect jsonb` alongside the
viewport size so it can be scaled. The design's `FauxShot` highlight markup then applies
to the real image.

### B7. Before/after screenshots per step
Only one shot per step is stored (`screenshot_key`). The design's Before/After toggle
needs a pre-action capture. Cost: roughly doubles screenshot storage — worth gating per
suite or to failures only.

### B8. Assertion detail
**Design promised** an "Assertion" panel: `contains "Northwind Migration"`, `count == 1`,
met/not-met. `compiled_ast` is NULL on all 196 rows today and no assertion outcome column
exists. Needs the compiler to persist the parsed assertion and the engine to persist the
observed value against the expected one.

### B9. Frame provenance per step
The design showed "Inside frame `iframe#consent`". `SelectorSet.frameUrl` exists in the
types but never reaches `step_results`. **This is also a robustness lead** — iframe-resolved
elements currently return session-only and never persist to cache, so consent banners
re-pay the LLM every run (see `project_prod_brain_robustness`).

### B19. Assertion steps never reach the cache — every run re-pays the model
Found while tracing the token-truth bug (A10). Two runs of *Number input accepts 42*:

| step | run 1 | run 2 |
|---|---|---|
| `type "42" in the number field` | `pgvector_step` · 0 tok | `redis` · 0 tok |
| `verify the number field has value 42` | **`llm` · 97 tok** | **`llm` · 97 tok** |

The interaction step has both a tenant and a shared `selector_cache` row. The assertion
step's `target_hash` (stable across both runs) has **no cache row at all** — so it resolves
via the model every single time and the cost never trends to zero.

This is the same shape as the iframe-consent gap in B9: a resolution path that returns a
selector without persisting it. It matters more than it looks, because assertions are the
last step of most tests — the part that never gets cheaper is the part every test ends on.
Worth confirming whether the assert path skips `persistToCache` entirely or writes under a
hash it never reads back.

### B10. Evidence bundle + run comparison
Two menu items with no backend: "Download evidence bundle" (zip of screenshots + a report
manifest) and "Compare with previous run" / ⌘D (a step-aligned diff of two runs:
status, selector, tier, duration deltas).

### B11. CI integration
**Design promised** a per-test toggle "Run in CI on every push to main", a trigger label
`CI · GitHub Actions`, and a branch per run.

**Reality** `runs.triggered_by` has `api | cli | schedule | web | testwriter` but there
are no branch/commit/provenance columns and no GitHub App or webhook receiver.

**Work** `runs.branch`, `runs.commit_sha`, `runs.ci_provider`; a GitHub App (or a documented
`POST /runs` recipe plus a published Action); per-case CI opt-in. Biggest single item —
worth its own spec before any code.

### B12. Scheduling
`run_trigger` already includes `schedule`, but nothing schedules. Needs a `schedules`
table (cron expression, suite/case target, timezone, enabled) and a scheduler process.
BullMQ repeatable jobs make this small; the UI is a row in the author screen.

### B13. Test author / owner
The design showed an author per test. No `created_by` on `test_cases`; memberships
already exist, so this is a nullable column plus a backfill.

### B14. Member activity
The design's member rows showed "last active: 20m ago". `users.last_login_at` exists;
membership-level activity does not.

### B15. Brain: block and promote
- **Pin** is real (`selector_cache.pinned_at`), reachable from the step inspector.
- **Block** is partial: a `verdict=failed` clears the learned entry and writes an
  archetype cooldown, but there's no durable per-selector blocklist, so a fresh LLM
  resolution can re-learn the same bad selector. Needs a `selector_blocks` table checked
  during resolution.
- **Promote to global brain** — the shared pool, `is_shared`, and `attribution` all exist,
  and there's a seeding script, but no user-facing promotion path with verification.

### B16. Deep links
The app is now a single route holding screen state internally, so "Copy run link" has
nothing to copy. Needs `/tests/:id`, `/runs/:id` etc. mapped onto the design's internal
navigation — do it as URL sync in `kaizen-app.tsx` rather than splitting the shell back
into per-route pages.

### B17. Notifications
"3 runs finished while you were away" needs an event/read-state store per user. Cheap
version: derive from runs completed since `last_login_at`.

### B18. Mobile
`screen-mobile.jsx` was never ported and the redesign spec deferred it. Decide first
whether mobile is a viewer (read runs, approve heals) or an author — they're different
products.

---

## 5. Tier C — fixture content, not gaps

`TENANT` (Acme Cloud, Ada Lovelace, Team plan), `SUITES`/`NAMES`/`CASES`, `RUNS_FEED`,
and the sample sites (`app.acme.io`, `shop.acme.io`). Nothing to build.

One borderline case worth doing: the author screen's **cost estimate**. The design showed
"First run ≈ 1,750 tokens" from an invented constant; the port shows no number at all.
Once B5 exists, the real average first-run cost per lookup makes this honest and it's a
genuine selling point — a credible price before you press run.

---

## 6. Cross-cutting: contrast (X1) — ✅ RESOLVED 2026-08-02

The design's own revision (`Kaizen (2)`) darkened the tertiary token: light
`#9a9aa2` → `#6e6e77`, dark `#75757e` → `#9a9aa5`. Adopted. `npm run audit:contrast` now
covers all three appearances and reports **10 findings below 3:1** (was 159), **none
unreadable**. What remains is the design's own accent-on-panel choices: a `SIMILAR` tag
in portal orange on ceramic (2.79:1), a sidebar count on the accent fill (2.6:1), and the
menu-bar email on the light wallpaper (2.92:1).

### Original note

`npm run audit:contrast` walks every text node on every surface in both appearances and
fails on anything unreadable. It currently reports **0 unreadable** and **124 findings
between 2.5:1 and 2.8:1**, all of them the design's tertiary grey `--text-3: #9a9aa2` used
for labels, table headers and captions.

That is legible but below WCAG AA (4.5:1 for body text, 3.0:1 for large text). Darkening
the light-mode token to about `#6d6d75` reaches ≈4.5:1 on the sidebar ground and ≈5.1:1 on
white, and it is a one-line change — but it shifts the feel of every screen, so it's a
design call, not a bug fix. Dark mode is already almost clean.

If it's taken: change the token, re-run the audit with `--report-under 4.5`, and raise the
gate.

---

## 7. Out of scope

- Anything requiring a payment provider (the design's plan/billing copy).
- Social sign-in (the design's "Or Login with" row) — no OAuth provider is wired, so the
  ported auth screen omits it.
- The old marketing page (`organisms/welcome-hero.tsx`), now unused with `/` redirecting
  to sign-in. Kept in the tree in case a real landing page returns.
