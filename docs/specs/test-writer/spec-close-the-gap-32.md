# Spec: Closing the gap to the 32 — what blocks each reference test, and the fix for it

**Created:** 2026-08-19
**Updated:** 2026-08-20 — §2.7: run-21 audit; field-semantics rule, activity-feed pairing, duplicate_control_name finding, Analyze-sheet Cancel bug confirmed and filed
**Status:** Approved by the founder (2026-08-19: "list and add these features/fixes to a spec, and run
the loop again. the goal is achieving this 32 tests")
**Owner:** test-writer / engine
**Companion:** spec-reference-plan-grading.md (the 32-entry plan and per-run scores)

---

## 0. Where the loop stands

Runs 9 → 10 → 11 (Claude as the model, audit between every run): false passes 3 → 1 → 0. The
proving machinery is now honest — everything it proves is real, and everything it rejects carries
the true reason. What remains is coverage: 2 genuinely good tests of the 32.

## 1. The four gaps, measured

| # | Gap | Reference tests blocked | Evidence |
|---|-----|--------------------------|----------|
| F3 | **Row surface** — list rows are `<div onClick>`, no role, invisible to the pruner survey | 9, 10, 13, 17, 19, 20 (+ weakens 11, 12, 18) | runs 9–11: every open/edit/delete/timeline flow unplannable; run 9's needs-human row assert found nothing |
| F1 | **Survivor scope** — "a failed row *still* shown" is not in the delta, because it did not change | 11, 12, 18 (presence half of every filter) | run 11: all 6 paired filter assertions failed exactly there |
| F2 | **Failure feedback** — validation rejects with "failed against the live site"; the fill round re-plans the same mistake | 1, 6, 14-adjacent (create flows) | runs 10–11: the create-test scenario failed identically 3× per run; the page's own message ("Target URL needs to start with http://") never reached the planner |
| F4 | **Suite input is chrome** — the sidebar "New suite" control is classed site-wide chrome, so no page owns it | 1, 2, 3, 4, 5 | runs 9–11: zero suite-CRUD scenarios planned |

Also open (smaller): F5 — the planner re-plans judge-rejected scenarios every fill round (run 9
judged "Run an empty suite" three times); the a11y findings on Kaizen's own dashboard (placeholder-
named step input, "Needs a human 2 tap to filter" chip names) which belong to the product, not the
writer.

## 2. Fixes landed this round (2026-08-19, run 12 validates)

- **F1 Survivor scope** (`delta.ts isDeltaScoped`): a delta-scoped assertion whose description says
  *still / remains / unchanged / kept* is re-scoped to the whole page. The delta cannot hold a
  survivor; the whole page can.
- **F2 Failure feedback** (`worker.ts` + `validation-runner.ts`): when a delta assertion matches
  nothing, the delta still rides as `dom_candidates`; the validation verdict now reads them and the
  rejection reason becomes *"at step N the action produced only: «Target URL needs to start with
  http:// …» — none of it is what the check describes"*. That reason enters the fill-round ledger
  under ALREADY REJECTED, so the next plan sees what the app actually did.
- **F3 Row surface** (`playwright.dom-pruner.ts`): the survey now includes clickable containers —
  outermost elements with `cursor: pointer` (cursor inherits; the outermost is the row), no
  semantic role, no interactive ancestor, visible text, ≥40×12 px, capped at 40 per page. Named by
  their first text line; selector `text="<title>"` (the click bubbles from the title to the row's
  handler). Prior fixes hold for them: quoted-name gate, never-cache-fallback, delta self-exclusion.

Earlier rounds (already in): settle-and-retry on empty resolution; majority-of-words fidelity gate;
delta pick may not be the acted-on control; first-noun prose-vs-record rule; write-prompt rule 5b
(absence assertions must be paired); base64 inbox embeddings.

### 2.1 Run 12 findings → the judge-method round (run 13 validates)

Run 12 measured: F1 worked (paired filters delivered), F2's reasons are readable, but three plumbing
faults kept the lessons and the rows from mattering — found by auditing everything, fixed same day:

- **The planner never saw the rows.** The survey stored 86 clickable rows (F3 worked), but
  `listPageDossiers` fills its per-page cap kind-by-kind alphabetically: 70 buttons consumed the
  whole cap. Fix: kinds share the cap round-robin; clickable containers now carry role `row`
  end-to-end (never a `role=` selector — their AX role is generic).
- **buildLedger threw the lessons away.** "Bare pages first" RETURNED ONLY bare pages — run 12's
  ledger was just the empty Analyses page, so no fill prompt ever carried a rejection. Fix: pages
  with rejection lessons always ride, after the bare ones.
- **The retry write was a cache replay.** Same scenario → byte-identical write prompt → the answer
  cache returned the identical failing steps, three times. Fix: a validation lesson for a scenario
  name is injected into its retry's steering notes — the prompt differs, the writer is told what
  the app answered and to write it differently.

The founder's direction — apply the method that produced the §4 key to the writer itself — is what
these amount to: evidence reaches the writer (observed refusals steer the rewrite), and the key's
hygiene became write-prompt law (rule 9: only mutate what this run created; created names carry a
{{token}} fragment and are asserted literally, so a rerun can never pass against a leftover).

### 2.2 The reachability harness — iterate in seconds, burn runs only when green

Run 15 missed the ≥12 milestone and settled the argument: every pipeline stage has its own gate,
tuned on public sites, and discovering one per 40-minute run is the wrong loop. The founder's
mandate (2026-08-19): hit the §4 bar on Kaizen AND make every fix general — the next site must not
restart the grind.

`benchmarks/testwriter/reachability.ts --reference reference/kaizen30.json [--suite id]` answers,
against any STORED site model, with no browser and no LLM: could the pipeline even write each
reference test? Per entry it checks observed → plannable (chrome, caps) → writable (chrome-only
gate with its reach/behaviour exceptions) → oracle mechanism → fixtures, and names the blocking
gate. A per-site reference JSON is the only site-specific artifact — the harness itself is generic.

First boards (run-15 model): 23 → 26 of 30 after the round-16 fixes. Remaining: #22 (URL field
unobserved — the 'analyze ' opener prefix probes it next recon), #23/#24 (fixture: a finished
analyze job), #29 (settings sub-tabs are plain buttons — no general probe signal yet; harvest from
proving runs may close it).

Round-16 fixes, all general: chrome-only write gate learns the two legitimate chrome-only shapes
(the clicks ARE the target screen's reach path; behaviour-verb chrome like "Hide suites");
validation lessons attach to the PAGE as well as the scenario name (fill rounds rename scenarios —
run 15 repeated the Target URL mistake under three names); opener lexicon gains multi-step-flow
verbs (analyze/import/scan/generate/upload) and the "…" dialog convention; aria-pressed is captured
and is a safe-reveal probe signal.

### 2.3 Run 16 and the persistence round (run 17 validates)

Run 16 measured: the opener probe worked (the Analyze sheet opened — 2/2 on analyses, and a new
`settings` screen was discovered); suite-create was planned AND written for the first time — then
killed by the THIRD chrome computation (the grounding query's), now carrying the same creation
exception as the other two. The create-test flow exposed the deeper truth: every job starts a
fresh suite, so the in-memory lessons began empty and round 1 of every run repeated the previous
run's failure; and when the lesson finally arrived in round 2, the writer DODGED it by shrinking
the scenario to "open the form" — which the judge rightly rejected as plan infidelity. Fixes:
migration 042 `site_pages.writer_lessons` — validation lessons persist per page, tenant-wide,
loaded by the next job before anything is written; and the lesson steering now forbids the dodge
("fix the flow and complete it").

### 2.4 Run 18 and the probe-lottery round (run 19 validates)

Run 18 measured (first run with the persisted-lesson loader and the proven-baseline plan floor):
plan held at 20 (17 collapsed to 12), 14 proposed, 5 proven at 5/5 fidelity, zero false passes.
The judge's grade: 7 good + 6 acceptable-but-weak (aria-pressed-only oracles) + 1 flaky + 1
vacuous-binned. The ceiling was OBSERVATION, not writing: the crawl never opened the New Test
sheet, so #6/#7/#15 died before planning — after run 16 HAD the sheet. Reachability on run 18's
own model: 23/30.

Root causes, each with a general fix (this round):

1. **Probe lottery.** `probesPerPage` (8) slices the safe-reveal list in DOM order; whether the
   page's "New …" opener got probed was luck. Fix: `rankProbeCandidates` — creation/flow openers
   (opener lexicon + trailing-ellipsis convention) first, tabs second, rest in survey order;
   names differing only by a keyboard-shortcut suffix ("New Test ⌘N") collapse into one probe; an
   opener that revealed nothing retries once from the Escape-cleared state
   (`probe_opener_retry_rescued`).
2. **Lesson channel hole.** Step-level assertion failures produced "it failed at step 8 against
   the live site" — correctly refused by the actionable-lesson filter, so run 18 persisted ZERO
   lessons. Fix: the fallback reason quotes the failing step's own text ("at step 8 (\"verify …\")
   the page did not offer what this step needs"), and the filter accepts the new phrase.
3. **Contradictory asserts.** Shipped live: click "Needs review" → verify "ready, unused" visible
   → verify it NOT visible; nothing acts between, one check is guaranteed to fail. The judge
   passed it. Fix: `checkContradictoryAsserts` — a hard schema repair error naming the 5b order
   (presence BEFORE the removing action).
4. **Shared-state close oracle.** "Cancel closes the Analyze sheet" asserted the "No analyses yet"
   empty state — destroyed legitimately by a sibling test that had started a real analysis. Fix:
   write rule 12 — the oracle for closing a surface is that surface's OWN disappearance, never
   background text; 5b gains the explicit ordering sentence.

Also true of run 18: the validated "Analyze App Functionality" started a REAL analysis of
the-internet.herokuapp.com in the Bench tenant — once finished it IS the fixture #23/#24 need.

### 2.5 Run 19 — the learning run (run 20 validates)

Run 19 measured: probe ranking WORKED (New Test sheet harvested deterministically — Target URL,
Test name, Blank, Save, Save & Run all `revealed_by = "New Test"`; create-test flows planned and
attempted for the first time since run 16); the contradiction fix proved out ("Filter the Brain to
items needing review", run 18's contradictory reject, validated with the corrected order); rule 12
was obeyed (the Cancel test asserts the sheet's own field disappearing). 7 proposed / 3 proven —
thin because the proven-baseline floor was TENANT-scoped, not SITE-scoped: the fence told the
Kaizen planner to re-plan ~25 the-internet scenarios from old dogfood suites, and with alphabetical
LIMIT 40 the truncation also dropped the legitimate S–T names. Lessons persisted for the first time
(3 on /tests), but the cap of 3 evicted the app's own "Target URL needs to start with http://"
message. The engine left error_type NULL on assertion failures, so the possible app defect run 19
found — "Block saving a new test with no steps" SAVED the test and closed the sheet — was never
filed as a finding. New failure class observed: volatile names (suite rows carry live counts —
"Demo 0" went stale mid-run when a sibling test created one; filter tests paired with crawl-moment
rows that the filter removes).

Fixes (this round, all general): baseline scoped by `base_url LIKE origin%` and ordered newest-
first; lesson cap 3 → 6 (an SPA lands every failure on one page); app-defect filing falls back to
the failing step's own text (`verify…` = assertion) when error_type is NULL; write rule 6 names
count/age/status-bearing names volatile (quote only the stable words); the state-toggle rule picks
the paired row by its bracketed context matching the filter, or the empty state.

**Founder directive (2026-08-20), supersedes the cross-run defaults above:** every analyze runs
with NO previous data or knowledge — only the crawl, the startup brief, and what the run itself
collects. The proven-baseline floor and the cross-run lesson loader are now gated behind
`options.useCrossRunMemory` (default OFF; the bench never sets it). In-run lessons still feed the
fill rounds — that is the run's own learning — and lessons are still WRITTEN for a future opt-in
re-analyze, but nothing is read in. The writer must be intrinsically senior-QA on a first visit.

### 2.6 Run 20 — memoryless exposes the under-planner (run 21 validates)

Run 20 (first memoryless run) measured: planned 5, proposed 2, proven 2 at 2/2 fidelity — everything
that shipped was solid, and the judge correctly killed a pre-state assert. The collapse from 15–20
planned to 5 is the finding: with no floor carried in, NOTHING in the planner prompt counterweights
its anti-padding warning ("padding is the one failure that matters"), so a cautious planner plans 2–4
scenarios per batch and calls it a day. A senior QA's defining trait on a first visit is
exhaustiveness — the floor must come from the SITE, not from memory.

Fixes: the planner prompt gains the coverage duty (under-planning is the equal failure; every
distinct capability of a page gets a scenario up to the cap), a "declined" accounting field (a
capability left untested is a recorded decision, never a silent omission), and the user's overall
ask (`targetTotal`) so batches size themselves against it. Write rules: selection-dependent toolbar
actions (Run now / Delete / Edit) require clicking the record's row first and asserting about THAT
record (3rd repeat of the stale-row guess); after `select`, assert the selection's consequence,
never the dropdown's own value (2nd repeat; custom widgets do not expose it).

### 2.7 Run 21 — coverage duty proven; validation is the frontier (run 22 validates)

Run 21 (memoryless, coverage duty active) measured: planned 5 → 21, written 20, proposed 10,
proven 5 at 5/5 fidelity, 0 vacuous. Cold-start quality per test held; the funnel now loses at
VALIDATION (9 deaths). The audit sorted those into three classes and one real product bug:

1. **Wrong field** (2 deaths, repeat of run 19): the writer typed the URL into the "NAVIGATE"
   steps editor while "Target URL" sat beside it. Fix: typed-value rule — the value's type must
   match the field's NAME; never an action-named field when a value-named one exists.
2. **Stale feed rows** (2 deaths, 3rd repeat): presence-pairs chosen from crawl-time activity-feed
   rows that reorder before the run. Fix: 5b addendum — on a feed, pair with a row THIS test
   created or the empty state, never a crawl-time row.
3. **REAL BUG — Kaizen's own Analyze sheet** (2 deaths across runs 19+21): TWO buttons named
   "Cancel"; the `btn ghost` one does not close the sheet, the `btn lg` one does. Confirmed by
   hand with Playwright. Filed: docs/known-issues/analyze-sheet-duplicate-cancel.md. The
   generalizable half: recon now emits a `duplicate_control_name` finding whenever two same-kind
   controls share an exact name on one page — the ambiguity is a defect wherever it occurs.

The defect-filing fallback worked: 8 possible_app_defect findings filed (vs 0 silently dropped in
runs 18–19). Judge and schema gates each correctly killed one bad oracle pre-flight.

## 3. Next, in order

1. **F4** — reclass the sidebar suite-creation control to the Tests page (an explicit exception:
   a control that CREATES is never mere navigation), unlocking suite CRUD planning.
2. **F5** — the fill-round planner drops scenarios the judge rejected in any earlier round unless
   the ledger reason was transient.
3. Product a11y — **DEFERRED by founder (2026-08-20): do NOT fix Kaizen's labels to help the
   writer.** Real customer sites are exactly this messy; the dashboard's unlabeled controls are a
   standing test of how the writer copes with hostile DOMs. Handling strategy is a later chapter;
   for now the pipeline works around gaps (derived names, probe labels, context) and reports them
   as findings.
4. Multi-page journey scenarios (founder question, 2026-08-21; agreed: AFTER the 30-test bar and
   the-internet generalization). The ingredients exist — comprehension already synthesizes
   journeys with observed page paths, and screens' reachedBy is the path mechanism — but a journey
   test compounds every per-page failure class, so it waits until written→proven conversion is
   solved. Prime targets: checkout funnels, onboarding wizards on real sites.
5. Codebase connector — ABSORBED into spec-agentic-testwriter.md (2026-08-23): realized as the
   explorer's whitebox MODE (code claims verified live; disagreement channel), not a separate
   site-model feature. The principle stands: code facts are hypotheses, black-box must keep
   working everywhere.

## 4. The 32, written as tests — the judge's own answers

The reference plan (grading spec §2) says WHAT; this is HOW — each entry as the steps and oracle
this judge would write, so "would Kaizen write this?" is checkable line by line. Sign-in prefix
implied. `→` = the oracle.

**Suites**
1. Click "New suite" → type "QA Suite A <runId>" → Enter → the sidebar shows that literal name.
   *(Recount catch: the fixed name had the same rerun-collision flaw as #6's first draft.)*
2. Click "New suite" → Enter with empty name → the input is still shown AND still empty, and no
   sidebar entry with an empty label exists. *(Self-audit: "no new row appears" fails the pre-state
   test — it was already true. The empty-input-persists half is the observable refusal.)*
3. Click suite "Checkout smoke" → toolbar shows "Checkout smoke", a known member test's row still
   shown, and a known test of the Demo suite not visible. *(Self-audit: "only its tests" is a
   universal — unverifiable; assert one member present and one non-member absent.)*
4. Create "QA Rename Me" → its menu → Rename → "QA Renamed" → sidebar shows "QA Renamed" and no
   longer "QA Rename Me". *(Self-audit: the first draft renamed "Checkout smoke" — shared demo data
   every other test depends on. A test may only mutate what it created.)*
5. Create "QA Suite Temp" → its menu → Delete → confirm → "QA Suite Temp" gone from sidebar.

**Tests**
6. New Test → Blank → name "QA Created Test <runId>" → Target URL `http://localhost:3001` → one
   step → Save → assert_text of that literal name. *(Self-audit: a fixed name false-passes on
   rerun against the previous run's row; the name must be unique per run. Tests 9, 10, 13, 14
   each create their OWN fixture or use a seeded row — the first draft chained them off this
   test's state, and tests that only pass in sequence are not independent tests.)*
7. New Test → name only, no Target URL, no steps → Save → the sheet stays open and shows a
   validation message; the list does not contain the name. *(Run 11 taught: the app's first
   complaint is the Target URL — the oracle must assert what the app does, not what we assume.)*
8. New Test → steps but empty name → Save refused the same way.
9. Click a seeded row ("Checkout smoke 1") → its known step text is shown.
10. Create "QA Delete Me <runId>" (as #6) → its row menu → Delete → confirm → assert_not_text of
    the name, paired with: a seeded row still shown.
11. Type "Checkout" in "Search tests" → a "Checkout smoke" row still shown; a Demo-suite row not
    matching is gone. Then search "zzz…" → "No tests match".
12. Click "Passed" chip → a passed row still shown + a failing row not visible.
13. Create "QA Edit Me <runId>" → open it → change the step text → Save → reopen → the new step
    text shown, the old one not. *(Conditional: the edit surface is unobserved until F3 lands.)*

**Runs**
14. Run now on a seeded row ("Checkout smoke 1") → a queued/running indicator appears for it.
15. A test asserting text that is not on the page → Run now → the run ends failed.
16. Suite toolbar → Run suite → "Queued N tests" appears (N = active tests).
17. Runs page → the newest run's test name matches the test just run (newest first).
18. Runs "Failed" chip → a failed run row still shown + a passed run row not visible; "Healed" chip
    → "No runs match that filter".
19. Click the newest run row → a step timeline with per-step status and after-screenshots.
20. On the open run → Re-run → a new run appears above the old one.

**Analyze**
21. Analyses → "Analyze an app" → Start with empty URL → refused (message or disabled).
22. Enter a URL → Start → an analysis entry appears with a progress phase.
23. An existing finished job → its proposed tests are listed.
24. Accept one proposal the bench created → it joins the suite as active.

**The Brain**
25. Search "zzz…" → "Nothing matches"; search a known element name (Global scope) → its row still
    shown.
26. Click "Global" → a learned-element row now listed (workspace has 0; global has content).

**Usage & account**
27. Settings → Usage → "Tokens this month" stat visible with a numeric value.
28. Members tab → the members table (MEMBER / ROLE / JOINED) with "Demo user (you)".
29. Appearance tab → theme controls shown in place of Usage stats; click "Dark" →
    assert_attribute of the theme attribute on the document root. *(Self-audit: "background
    changes" is not an assertable capability, and "the Dark chip is selected" is the acted-on
    control proving itself — the rule this loop just built refuses it. The DOM attribute is the
    honest observable.)*
30. API keys page opens read-only → a key list or empty state; nothing created.
31. Signed out, navigate to /tests → the url ends at /login. *(Reclassified BENCH-LEVEL: every
    generated test runs signed in by harness rule, so the writer can never produce this — it runs
    as a bench assertion instead.)*
32. Sign out → back at /login; back-navigation does not restore /tests. *(Reclassified BENCH-LEVEL:
    sign-out is on the writer's session-ending safety list, by design.)*

### 4.1 Self-audit verdict (2026-08-19)

Applying the run-grading knife to the key itself found: one destructive test (#4 renamed shared
demo data), an independence failure (#6/9/10/13/14 chained on one test's state), two entries the
harness forbids by design (#31 sign-in prefix, #32 session-ending safety) — now bench-level, so
the writer-reachable set is **30**, not 32 — plus oracles that broke this loop's own rules (#2
pre-state, #3 universal, #29 self-proving chip). #8, #20, #21 assert behaviour never yet observed
(exploratory until a run shows the app's actual refusal); #22–24 need an Analyze fixture the demo
workspace lacks (its Analyses page is empty) and carry a real-job side effect — plan: #22 starts
against a throwaway localhost URL and #23/#24 run against the job #22 created, accepting the cost
of one real job per proving run.

Delivered-good today (run 11 basis): 14 ✓, 16 ✓; honest-half or weak: 11, 12, 18, 25, 26, 27–29
region; everything else blocked by §1. When F1–F4 hold, the writer should reach ≥20 of the 30
writer-reachable entries without new prompt work — that is the bar the next runs are graded
against.
