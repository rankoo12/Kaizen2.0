# Spec: Grading a run against a reference plan — the judge is a senior QA, not a counter

**Created:** 2026-08-18
**Updated:** 2026-08-19 — run 9 measured and audited; the self-referential delta pick is the open false-pass channel
**Status:** Approved in principle by the founder (2026-08-18: "you are the judge of that");
reference plan for Kaizen written here, grader in the bench next
**Owner:** test-writer / bench

---

## 0. The rule

The founder's words: if a senior QA engineer would say ten tests are enough, ten it is — but a
senior QA engineer writes many. So the target of a run is not a number; it is **the tests that
engineer would write for this app**, written down first, and the run is graded by how many of them
it delivered correctly and how good the rest are. "Requested 30" stays a budget, not a score.

## 1. What a reference plan is

Per target app, a list of the tests the judge would write, grouped by area, in priority order.
Each entry: a short name and the observable outcome. Written by the judge from the app itself, not
from a run — a run cannot grade its own homework.

The bench (`benchmarks/testwriter/run.ts --reference <file>`) matches delivered tests to entries by
name similarity plus a manual `matches:` list kept in the results file, and prints:

- **coverage** — entries delivered correctly / entries in the plan, by area;
- **quality** — every delivered test graded `good` (a QA would keep it as is), `weak` (real action,
  vague or misnamed check), `wrong` (does not test what it says);
- **missing** — the plan entries nothing covered, with the reason recon/plan/write gives (rows
  invisible, needs consent, excluded, not planned).

## 2. Reference plan — Kaizen dashboard (local, signed in as the demo owner)

**Suites**
1. Create a suite — its name appears in the sidebar and the list.
2. Create a suite with an empty name — refused (button disabled or error).
3. Open a suite — only its tests are listed; the toolbar shows the suite name.
4. Rename a suite from its menu — new name shows.
5. Delete a suite the test created (confirmation) — it disappears.

**Tests**
6. Create a test with one step — it appears in the suite.
7. Create a test with no steps — refused.
8. Create a test with no name — refused.
9. Edit a test's steps and Save — the test page shows the new step.
10. Delete a test from its row menu (confirmation) — it disappears.
11. Search filters the list by name — only matching rows remain.
12. Status filters (Failing / Healed / Passed / Needs a human) narrow the list.
13. Open a test — its steps are shown.

**Runs**
14. Run now on a test — a run appears queued/running, ends passed.
15. A test with a wrong assertion — the run ends failed.
16. Run suite — one run per active test appears.
17. Runs page lists runs newest first.
18. Runs filters (Active / Failed / Healed) narrow the list.
19. Open a run — step timeline with per-step status and after-screenshots.
20. Re-run — a new run appears for the same test.

**Analyze**
21. Open Analyze with an empty URL — refused.
22. Start an analysis with a URL — a job appears with progress phases.
23. A finished job lists proposed tests.
24. Accept a proposal the test created — it joins the suite as an active test.

**The Brain**
25. Search narrows what it knows.
26. Workspace / Global tabs switch the list.

**Usage & account**
27. Usage shows tokens and runs this month.
28. Members lists the owner.
29. Appearance toggle changes the theme.
30. API keys page opens (read-only; nothing created or revealed).
31. Visiting /tests signed out redirects to /login.
32. Sign out returns to /login.

## 3. Reference plan — the-internet (public)

To be written the same way (one line per page behaviour); the runs to date have already been graded
by hand against the judge's own criteria — spec-planner-per-page.md §5.

## 4. Scores so far (Kaizen)

| run | covered (of 32) | good / weak / wrong of delivered |
|---|---|---|
| 6 | 14, 16, 18 (+ partial 28, 27) ≈ 3–5 | 3 / 3 / 1 of 7 |
| 8 (Claude as the model) | ~~10 of 32~~ **VOID** — see below | ~~12 / 2 / 0 of 14~~ |
| 9 (Claude as the model, fidelity fixes live) | ≈ 5 of 32 good (11, 18, 25, 26w, 28, 29) | 5 / 4 / 3 of 12 |
| 10 (positional fixes pending) | 2 good (14, 16) | 2 / 11 halves / 1 false of 14 |
| 11 (first-noun + locator gate + rule 5b) | 2 good (14, 16); **0 false** | 2 / 6 weak / 0 wrong of 8 |
| 13 (rows + lesson loop + round-robin dossier) | ≈ 8 of 30 good | 7 / 3 / 1 of 11 |

**Run 13 audited:** first row-based tests ever — "Back button returns from test detail" clicked a
real row surface (`text=` selector), and the judge CORRECTLY demoted its oracle (the asserted row
was visible before the action too — vacuous, as were Refresh-survivor and the select-text oracle).
Genuinely good: both searches (row-specific, paired), Failed-runs filter (right status guesses),
Run now (the runs counter changed 65→66 — real evidence, though it does not name WHICH run),
Analyze, both settings tabs. **One false pass in the proven list:** "Run suite triggers runs for
the Demo suite" — the Demo suite is EMPTY; the screen-switch click made the whole runs page the
delta, and the assert matched an old run of "Demo Save And Run Test 2761", whose name merely
contains "Demo" and "Run". Root: association claims ("tied to X") plus whole-screen deltas.
Fix landed: write rule 10 — association claims must name the record literally (a run row named
"<exact test name>"), which rows now make resolvable; rule 9 rewords the unique-name variable
(one writer emitted a literal "{{token}}" and the schema gate rightly refused it). Open: grounding
rows should carry their status text (writers guessed row statuses and lost 4 filter tests);
whole-screen deltas as oracle evidence remain a known weak channel until then.

**Run 10 audited:** the settled retry recovered Run now (#14) and Run suite (#16) — both genuinely
proven ("Queued 8 tests"; the affected row). One false pass survived: "New Test inside an empty
suite" — the description's trailing "empty-state message" re-armed the prose hatch (fixed: the
FIRST noun decides). The 11 review drafts were absence-only oracles, all correctly flagged vacuous
(fixed: write rule 5b demands pairing). The cached placeholder pick skipped the gate because $eval
cannot read role= selectors (fixed: locator().evaluate).

**Run 11 audited:** zero false passes — both create variants fail honestly on the unfilled Target
URL; the paired filter assertions now exist and fail on the survivor-scope gap ("a failed run row
STILL shown" is not in the delta — it did not change); "Saving a test with no steps" asserts the
literal name is gone (rule 4 followed) and fails honestly because the sheet stays open. Every
rejection reason traced true. The machinery is honest; the remaining work is coverage —
spec-close-the-gap-32.md.

**Run 9, audited step by step** (28 planned → 12 proposed, 9 "proven"; 135k tokens; bench fidelity: 8/9).
Good, keep: Usage→Appearance and Usage→Members (delta matched the panel/member table), runs Healed
filter (matched "No runs match that filter"), Brain search-to-empty (matched "Nothing matches"; smart
Global-scope setup), Analyze opens the form (matched the sheet with the App URL input in the delta —
covers only the open, not entry 22's start-with-URL). Weak: the three chip filters the judge caught
(weak_oracle) plus two it MISSED — "Filter the Brain to items needing review" and "Switch scope to
Global" were validated although the delta pick was the clicked chip itself, and flaky "Run the whole
suite" passed once by matching the "Run suite" button for "a Running status". Wrong: "Create a blank
test…" was VALIDATED although no test was created — Target URL stayed empty, save was refused, and
the delta matched the refusal message against "the newly saved test's row" (the §5.1 hole); "Block
saving with no steps" passed by the same message for the wrong rule. The judge's 4 rejections (empty-suite
Run ×3 — replanned each fill round, a planner waste — and Refresh's loading indicator) were right.
The 12 validation rejections were NOT the app's fault and mostly not the tests' fault either —
step-level audit: 6 × `click the "Checkout smoke 8" button` died with an EMPTY resolution (the
suites sidebar had not rendered when the resolver snapshotted; the no-guess policy now correctly
refuses to substitute — but nothing waits and retries, so Run suite / Run now / needs-human filter
were wrongly killed); 3 × `click the "Demo 0" button` resolved to the account button "DU Demo
user" — the shared word "Demo" walks it through the fidelity gate; 1 × the Suite-dropdown value
assert re-resolved (assertions never read cache) to `button[name="New suite"]` — shared word
"suite"; 1 × the needs-human row assert found nothing — the genuine `div onClick` row-surface gap.
Net: four reference-plan criticals (6, 12, 14, 16) were lost to resolution timing and one-word
name overlap, not to bad test design — false negatives to fix before chasing new coverage.

### 5.1 The open false-pass channel: self-referential and off-topic delta picks

Two shapes, both live in run 9: (a) `wantsProse` — a description naming a row/list/message accepts
ANY non-interactive prose in the delta with zero word overlap ("Target URL needs to start with…"
satisfied "the newly saved test's row now listed"); (b) the clicked control itself sits in the delta
(state change) and shares a word with the description ("Needs review" chip for "a row flagged as
needing review", "Run suite" button for "a Running status on the suite's tests"). Fix next: a delta
pick may never be the step's own action target, and prose picks require word overlap with the
description's distinctive nouns.

**Run 8 is void.** The founder read a proving run and saw `click the "Checkout smoke 6" button` executed
as `role=button[name="File"]`. A step-by-step audit of every proving run (step text vs. locator used)
found the same for "Runs", "Demo 0", "Blank", "The Brain", "Global", "Run suite", "Failed", "Needs
review": all served from the selector cache. Cause: when the model answered "no candidate matches"
(the sidebar had not rendered), the resolver's fallback took the FIRST candidate in DOM order — the
menubar's File — and cached it; the click opened a menu; the delta oracle matched a vague description
against the menu; green. Three fixes: the fallback considers only candidates that share a word with the
target and is never cached; a delta pick must be *about* the description; and the worker refuses any
resolved element whose label shares no word with a quoted target, evicts it, and fails into healing.
The grader now audits step fidelity before it counts anything as proven (§5).

## 5. Step fidelity — a proof is only a proof if every step hit its named element

For every proving run, every step whose text quotes a name (`click the "Runs" button`) is checked
against the element actually used (selector name, or the resolved element's label/text). One
mismatch and the test is **not proven**, whatever the run status. The bench prints these; the worker
now refuses them at execution time (worker fidelity gate), so they should be zero — the audit is
the check on the check.

Run 8, graded: create a test (Blank → name → Target URL → Save → Save gone → row with the name)
is the flagship flow and it is proven; Save & Run in the empty suite, Run now, Run suite, the
runs/tests filters (chip selected + a wrong-status row absent), search-to-empty on tests and on the
Brain, Members tab (Tokens gone, members listed), Global scope — all tests I would keep. "Cancel a
draft" is labelled needs-review because its oracles are absences (correct label; keep the test).
"Needs review chip" was flaky on timing. Missing, and why: everything that opens a row (open test,
edit, delete, open run, timeline, re-run) — rows are `<div onClick>` with no role, invisible to
the survey; suite create/rename/delete and Analyze-with-URL — not planned this run (the planner
gives ≤3 per page and the sidebar's New-suite input is chrome); sign-out / redirect — the login
recipe's domain.
