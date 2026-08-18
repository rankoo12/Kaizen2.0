# Spec: Validation Trust — the oracle-integrity contract

Created: 2026-08-12
Updated: 2026-08-18 — §5 executed sign-in proof probe
Status: approved for implementation (founder accepted 2026-08-12; assessment
`docs/assessments/2026-08-12-testwriter-full-assessment.md`)
Owner: Test Writer workstream
Migration: **035_validation_trust.sql** (claimed in COORDINATION.md 2026-08-12)

## 0. Why this spec exists

The quality audit (39 findings adversarially verified, 0 refuted) proved that
**every one of the 4 validated-green drafts on the dogfood tenant carries an
oracle that cannot fail**:

- Runs `bf259685`/`7c5463f9`/`6a03cac7`: assertions described as "the no-results
  message" / "the results header" resolved to `role=button[name="File"]` — the
  always-visible menubar button.
- Run `f235e94f`: "verify {{firstName}} is shown" resolved to `input.field` —
  the search box the test had just typed that value into. The engine deliberately
  scans input values (`playwright.execution-engine.ts:647-653`), so this literally
  cannot fail.
- The wrong anchors were then written to `selector_cache` at
  `confidence_score = 1.0` and replayed by later runs (`db_exact`, then `redis`).
- The one falsifiable oracle in the corpus (`assert_url "/prod.html"`) failed
  honestly and was **rejected**. Selection pressure is inverted: the gate stack
  currently selects FOR unfalsifiable tests.

Root cause, precisely: `judgeRun` (`validation-runner.ts:214-234`) accepts on run
status alone. A green run proves the resolver found *some* element for every
step and nothing threw — with a cache the pipeline itself pre-warmed
(`selector-seeder.ts`). Nothing anywhere compares **what the assertion resolved
to** against **what the assertion claims to check**.

## 1. The contract

A generated test is **validated** if and only if:

1. **Every action hit its grounded element** — the resolution the run used is
   consistent with the element the intent cited.
2. **The terminal oracle is discriminating** — it is not satisfiable by the
   test's own input, it is anchored on an element consistent with its
   description, and it observes state the scenario's actions changed.
3. **The sign-in premise (authenticated jobs) is itself proven** — the run
   demonstrably reached the signed-in app before the body ran.

Everything in this spec is a deterministic enforcement of those three clauses.
LLM-judge improvements are explicitly **not** the mechanism (the judge provably
ran and rejected 8 siblings, yet passed both live false-pass shapes); the two
worked BAD examples in §9 are the only judge change.

## 2. Deterministic post-run oracle audit (defect 1)

A pure-SQL/TS audit over `step_results` + the scenario's `StepIntent`s, run in
`ValidationRunner.validateOne` after `pollToTerminal` and **before** any
promotion UPDATE. Zero browser minutes, zero tokens.

For each assertion step in the run (body and prefix), join its `step_results`
row (`selector_used`, resolved role/name where recorded, `resolution_source`)
against the intent and every earlier step of the same run:

| Rule | Condition | Verdict |
|---|---|---|
| **self-echo** | assertion's `selector_used` equals the `selector_used` of any earlier `type` step in the same run, OR the assertion's expected text equals a value typed earlier and the resolved element is an input/textarea/searchbox | reject (`oracle_self_echo`) |
| **faithfulness** | resolved element's role+name share **zero** normalized tokens with the intent's target description (token = lowercased word ≥3 chars; "no-results message" vs `button "File"` = zero overlap) | reject (`oracle_unfaithful`) |
| **fragile terminal resolve** | terminal assertion resolved via `llm` (L5) — the least-constrained resolver picked the anchor for the step that carries the whole verdict | flag → `validation_state = 'weak_oracle'`, promotion allowed but surfaced (§6) |
| **prefix integrity** | any prefix step healed, or a prefix assertion fails faithfulness | do not certify: `validation_state = 'unproven_signin'` (§5) |

Rejections use the existing `rejected` path with `stage: 'validation'` and the
rule name in the reason. The audit also runs retroactively over existing drafts
via a one-off script (§10).

Implementation note: `step_results` already records `selector_used` and
`resolution_source` per step (migration 027 lineage); where role/name of the
resolved element is not yet recorded, the worker capture in §8 adds it to the
assert-step `run_events` payload — the audit uses what exists and tightens as §8
lands.

## 3. Executed vacuity probe (defect 1, second stage)

After the audit passes, before promotion: re-enqueue a **probe run** containing
only the login prefix (if any) + the scenario's `navigate` steps + the terminal
assertion. No typing, no clicking — read-only by construction, so it is
consent-neutral and safe on any target.

- Terminal assertion **passes** on the probe → the oracle is true without the
  scenario's actions → **reject** (`oracle_vacuous_executed`).
- Probe fails (the expected outcome) → the oracle genuinely depends on the
  scenario's actions → promote.

Cost: one short browser run per surviving draft, cache-warm. Ships after §2
(the audit alone kills all four live false-greens; the probe closes the
remainder the audit cannot see statically). `report.validate` records
`probeRuns` and per-scenario probe verdicts.

## 4. Schema-gate lints — reject at write time (defect 2)

New checks in `step-intent.schema.ts` (hard rejects, same repair-round
semantics as existing schema failures) and one fix in `write/lints.ts`:

1. **Typed-value assert**: an `assert_text`/`assert_visible` whose expected
   value equals (case-insensitive, token-trimmed) a value typed by an earlier
   step is rejected unless its target cites a **different elementId** than the
   type step's target. Catches `{{firstName}}`-echo shapes at authoring time
   (case `73cc9af4`; also authored-but-unrun `49a193d6` — systemic).
2. **Disjunction oracle**: a description-target assertion matching
   `/\b(or|either)\b/i` is rejected — "the results or no-results header" is true
   by construction. (This exact string is quoted as the flagship success in
   spec-authenticated-scope.md §14.1; that spec gains a retrospective note.)
3. **Tautological assert_url**: track the in-force URL through the scenario
   (baseUrl, then each `navigate`). An `assert_url` whose expected fragment is
   already satisfied by the in-force URL at that point is rejected (case
   `73cc9af4` asserts "tests" after navigating to `/tests`; same shape authored
   in `ff62a99c`).
4. **Delta lint scope fix** (`lints.ts:41-48`): the state-change scan must only
   consider steps **after the last `navigate`** — today the body's leading
   navigate guarantees the lint passes, which is how "assert the page you just
   loaded" shapes slipped through as "delta" assertions.

Worker twin of rule 1 (engine-level, small): `assert_text` must never be
satisfied by the **value attribute of an input this run typed into** — scan DOM
text but exclude self-typed input values (`playwright.execution-engine.ts:647-653`).
This protects human-authored tests too, not only generated ones.

## 5. The sign-in premise (defect 4)

Verified failure: the prefix's only signed-in evidence ("verify the text
'Tests' is visible") resolved via redis to the **search textbox**, and
`healing_events` shows the cached selector it healed FROM was the **login
page's email field** — "signed in" could verify while still on the login page.
The exculpation guard (`validation-runner.ts:168`) excludes `healed`, so a
prefix heal bypasses the did-signin-work check entirely.

Contract:

- Prefix steps are **included** in the §2 audit. A prefix heal or an unfaithful
  prefix resolution ⇒ `validation_state = 'unproven_signin'`; the draft is
  proposed (the scenario may be fine) but never labeled proven, with the honest
  reason surfaced.
- The login recipe's terminal assertion must target a **signed-in-only
  element**: at job start the pipeline verifies the assert's target maps to a
  `page_elements` row on a `requires_auth = true` page (the crawl knows which
  elements exist only behind login). If it cannot, the job proceeds but every
  draft carries `unproven_signin` — fail-closed on the label, not the work.

> **Amended 2026-08-18 — executed proof replaces the static lookup as the primary
> evidence.** Observed on saucedemo (prod): three green drafts, all labelled
> `SIGN-IN UNPROVEN`, because the static rule cannot see. On an authenticated-only
> analysis every page was seen signed in, so `requires_auth` is an assumption, and
> a recipe ending in `verify the url contains "inventory"` or `verify the
> "Products" heading is visible` names nothing in `page_elements` at all. The
> label was answering "did the crawl happen to record this element as private?",
> not "was the browser signed in?".
>
> The question has a direct answer, and it is the same shape as the §3 vacuity
> probe: run the login recipe's terminal assertion **signed out** — its `navigate`
> steps plus the assertion, no credentials, cold browser — once per job.
> - Probe **fails** ⇒ the assertion cannot hold without a session ⇒ every green
>   proving run in this job witnessed one ⇒ `signinAssertionProves = true`.
> - Probe **passes** ⇒ the assertion holds signed out ⇒ `unproven_signin` for the
>   job, whatever the static lookup said (executed evidence wins).
> - Probe **inconclusive** (queue/browser error) ⇒ fall back to the static lookup.
>
> One extra small run per authenticated job; the §2 audit of the prefix (heals,
> unfaithful resolutions) still applies per scenario and can still withhold the
> label. `validation-runner.ts` `probeSigninAssertionIsPrivate`; the report
> records `validate.signinProbe: 'private' | 'public' | 'inconclusive'`.

## 6. `validation_state` — stop collapsing evidence levels (defect 5)

Today `status = 'draft'` is written by four different UPDATE sites meaning four
different things (`validation-runner.ts:113` unvalidated, `:171` signin-failed,
`:192-195` validated-or-healed), and the UI renders healed drafts as PROVEN
("ran green against your site") while captioning signin-unproven drafts "needs
consent" — both wrong.

**Migration 035_validation_trust.sql** (additive, one transaction):

```sql
ALTER TABLE test_cases
  ADD COLUMN IF NOT EXISTS validation_state TEXT
    CHECK (validation_state IN
      ('validated','healed','weak_oracle','flaky','unproven_signin','consent_held','unvalidated')),
  ADD COLUMN IF NOT EXISTS expected_outcome TEXT
    CHECK (expected_outcome IN ('pass','fail')),          -- Tier-2 persistence (§7)
  ADD COLUMN IF NOT EXISTS validation_seed JSONB;         -- the seed values the green run used (§7, defect 7)
```

Write sites: exactly the four existing UPDATEs plus the §2/§3 verdicts. UI
(`screen-writer.tsx` DeliveryFace): PROVEN = `validated` only; `healed` gets its
own chip ("passed after self-healing — review the heal"); `weak_oracle`,
`unproven_signin`, `consent_held` each get honest one-line captions. No status
enum change — `status` stays the lifecycle, `validation_state` is the evidence.

## 7. Tier-2 expected-fail + flake policy (defects 6, 7)

Current `judgeRun` accepts **any** `status='failed'` as "expected-fail
confirmed" (`validation-runner.ts:227-233`) — a step-0 selector crash would
validate a negative test green.

- Accept Tier-2 iff the run's **first failure is at step
  `prefix.length + failStepIndex`** (`failedWithinFirstSteps` already proves the
  step-index machinery exists — note `failStepIndex` is body-relative; the
  prefix offset is mandatory) **and** the failure is assertion-class (the
  worker's failure taxonomy), not resolution/timeout-class.
- Persist `expected_outcome` on the case (035) so re-runs judge correctly
  forever, not just at validation time.
- **Flake policy, both directions**: a failed validation run is re-enqueued
  **once**; pass-after-retry ⇒ `validation_state = 'flaky'` (proposed, honestly
  labeled), fail-twice ⇒ rejected. A `timeout` poll re-polls once before
  cancel+reject (observed step durations reach 34.8s against a 5-min cap —
  one slow page must not burn a valid scenario).
- **Known-entity binding (defect 7)**: schema-gate rejects a
  `search.find-known-entity`-slotted scenario whose query value is a `{{seed}}`
  token — the archetype's premise is an entity that EXISTS; a random seed
  ('Taylor') proves one random roll. Query values must be literals drawn from
  crawled evidence (`page_elements` text / classifier `entities`). The green
  run's actual seed values are persisted to `validation_seed` so the proven
  test is reproducible. Full entity sourcing consumes the app-entity model
  (spec-app-entity.md) once 036 lands; the rejection ships now.

## 8. Worker-side final-state capture

One capture at run end (worker.ts, after the last step, before terminal
status): a `run_events` row `phase='final_state'` with
`{ finalUrl, h1, alertText (role=alert innerText, first 300 chars),
consoleErrorCount, httpErrorCount (4xx/5xx responses observed this run) }`, plus
resolved role/name on assert-step events (feeds §2 faithfulness).

This single capture unblocks three consumers: the §3 probe verdict, the
never-fired oracle harvest (`report.harvest` is `{}` in all 28 jobs —
`harvestRunState` finds nothing because the worker records nothing), and the
findings channel (spec-findings-and-coverage.md). Replaces the deferred-capture
comment at `validation-runner.ts:252-259`.

## 9. Assert resolution: cache and healing exclusions (defect 3)

Verified: `selector_cache` holds `role=button[name="File"]` at confidence 1.0,
written the instant the bad L5 pick happened; run `c50b7744`'s assertion
**healed** via ResolveAndRetry from the login email field onto the Search
textbox and counted satisfied.

- Testwriter-triggered runs (`triggered_by='testwriter'` / `behindAuth` payload
  flag): assert-step resolutions are **never written** to `selector_cache`.
- Assert steps are **ineligible for ResolveAndRetry healing** in testwriter
  runs; in customer runs, a heal that resolved a **different element** for an
  assertion auto-fails the assertion rather than certifying it (an assertion
  that "healed" onto another element did not verify what it claims).
- Reconciliation: `spec-generation-pipeline.md` §5's "assertions use the
  cache-free resolver chain" is stale against the sanctioned
  `assertion-cache-policy.ts`; that line is amended to cite this section as the
  binding rule.

Judge addition (the only LLM change): add the two live false-green shapes as
worked BAD examples to the D1 dimension prompt — self-caused truth and
complementary disjunction. Cheap; the deterministic gates above remain the
backstop.

## 10. Dedup (defect 8)

`eb0bc7cd` and `e43478ef`: byte-identical bodies, 8 minutes apart, `deduped: 0`
— existing cases are fingerprinted WITH the login prefix while candidates are
body-only (Jaccard 0.6 < 0.9; `pipeline.ts:581-598` vs `:430-434`).

- Strip the known login prefix from existing-case step lists before
  fingerprinting (the prefix is loaded per job — same source, same strip).
- Plan-time behavioral dedup: reject a planned scenario whose
  `(archetype_key, normalized targetPages)` matches an existing non-rejected
  generated case (column exists since 032).

## 11. Retroactive audit + rollout

- One-off script `scripts/audit-existing-drafts.ts`: run the §2 audit over
  every `origin='generated'` case with a `validation_run_id`, stamping
  `validation_state` (035 backfills the column as `unvalidated`/`consent_held`
  from current status semantics first). The four known false-greens on the
  dogfood tenant must come out `oracle_self_echo`/`oracle_unfaithful` —
  they are the acceptance fixture.
- Order: 035 + §2 audit + §4 lints (one PR, stops the production line) →
  §5-§7 + §9-§10 (second PR) → §8 capture + §3 probe (third PR).
- Tests: unit per rule (fixtures lifted verbatim from the four live runs'
  step_results); lint goldens for each §4 rule (positive and negative);
  Tier-2 offset test (prefix.length ≠ 0); flake-retry test; a regression test
  asserting testwriter runs write zero assert-step selector_cache rows.

## 12. Explicitly out of scope

More judge prompt-hardening as primary defense; widening scenario budgets;
RECON form-submit tier and journey grounding (sequenced after oracle integrity
— journey tests with vacuous oracles would be worse than none); `assert_count`
in WRITE and boundary archetypes (assessment step 8); MAINTAIN.
