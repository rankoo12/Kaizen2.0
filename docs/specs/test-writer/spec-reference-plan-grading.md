# Spec: Grading a run against a reference plan — the judge is a senior QA, not a counter

**Created:** 2026-08-18
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
| 8 (Claude as the model) | 6, 11, 12, 14, 16, 18, 25, 26, 28 + cancel-draft, Save & Run ≈ 10 of 32 | 12 / 2 / 0 of 14 |

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
