# Spec: The planner plans pages, states outcomes, and fills to the number asked

**Created:** 2026-08-18
**Status:** Approved in principle by the founder (2026-08-18); built through five measured runs — see §5
**Updated:** 2026-08-18 — §1.7 and §5 from the bench runs
**Owner:** test-writer
**Amends:** `spec-generation-pipeline.md` §2 (PLAN), `spec-oracle-delta-and-fidelity.md` §2.2
**Bench:** `benchmarks/testwriter/run.ts` — the same job the UI starts, against the local stack,
with a per-page ledger. Baseline 2026-08-18: **requested 30 → planned 29 → proposed 9 (proven 1)**,
50 pages crawled, 25 planned for, 134k tokens, 584 s.

---

## 0. The founder's bar

> If a senior QA engineer came to the-internet they would write at least 40 tests (40 demo pages).
> If I ask for 50 pages / 30 tests, I should get **at least 30**. If I asked Claude to write 100
> Playwright tests on the-internet, most of them would be relevant. That is how smart the test
> writer should be — for the-internet or any site.

Two runs on prod and one on the bench say the same thing: the pipeline plans the wrong unit and
then only subtracts.

### 0.1 Why Kaizen is not as good as the engineer

The engineer reads each page, understands what it demonstrates, matches it against a repertoire of
patterns they already carry (checkbox → toggle both ways; select → choose and read back; new window
→ switch and verify), and writes two or three tests for it. If one idea does not survive contact
with the page, they write another, until they have the number they were asked for.

Kaizen's PLAN is **one LLM call for the whole app**, fed a compressed brief and a list of one-line
capabilities per page. It never sees a page's elements or its text. So it falls back on the
catalog's *e-commerce* shapes — the baseline planned "File download works", "Handle infinite
scroll", "Geolocation prompt handling" and "Handle pop-up behaviors" (all four named in the brief's
cautions), spent 4 of 29 slots on the home page, and gave 25 of the 50 pages **one** scenario each.
Then every later stage subtracts — schema, safety, dedup, judge, validation — and nothing ever tops
the count back up. Ask for 30, lose 21, get 9.

## 1. What changes

### 1.1 The planner sees pages, not a summary of them

For each crawled page a **dossier**: navigable URL, title, headings, the opening page text, the
page-specific elements (`role "name"`, chrome excluded, capped at 30), form summaries, and
COMPREHEND's purpose/capabilities. Pages are planned in **batches of ~6 dossiers per call**, frontier
tier; the tenant brief rides with every batch. 50 pages ≈ 8–9 calls, each smaller than today's one
call — the baseline spent 134k tokens delivering 9 tests, so cost is not the constraint.

The prompt asks for **1–3 scenarios per page** that exercise *that page's* behaviour, and states
the rule the founder gave: the home page and any nav/footer are navigation, not subjects.

### 1.2 Every scenario states its expected outcome

`PlannedScenario` gains **`expectedOutcome`**: the observable change the test must see —
*"a Delete button appears that was not there before"*, *"the flash reads 'Your username is
invalid!'"*, *"a new tab opens whose title is 'New Window'"*. It is the missing half of a plan:
today PLAN says *"verify the content is dynamic"* and WRITE invents *"verify the ever-evolving
nature of content is visible"*, and no stage can tell that is meaningless.

It pays three times: WRITE renders it as the oracle instruction (*"the final assertion must
observe exactly this"*); the judge's D5 becomes *"do the steps prove THIS outcome?"*; and the delta
oracle gets something to check against — the pick is scored by overlap with the stated outcome,
not only with the assertion's own words.

### 1.3 A deterministic shape repertoire, applied before the model

`plan/repertoire.ts`: patterns that fire on **element shape alone**, zero tokens, each with a fixed
outline and expected outcome. Applied to every dossier before the LLM sees it; the LLM is told
which repertoire scenarios already exist for the page so it adds the page-specific ones.

| shape on the page | scenario | expected outcome |
|---|---|---|
| a checkbox | toggle it: check → assert checked; uncheck → assert not checked | the box's checked state follows the action |
| a `<select>` / combobox | choose an option, read it back | the displayed selection is the chosen option |
| a link with `target=_blank` | click, switch to the new tab | the new tab's title/url is the destination |
| a table with column headers | click a header | the first row changes |
| a form with a password field | valid sign-in (from the brief), wrong username, wrong password | the flash / landing page the brief names |
| a form with a text field and a submit | fill and submit | a message or state the page did not have before |

Small on purpose. The catalog stays as the LLM-visible menu; this is the half of the engineer's
repertoire that needs no reading at all.

### 1.4 The brief's cautions gate the plan

Today cautions reach WRITE as prose and never gate PLAN. A caution that names a path
(`/basic_auth`, `/download`, `/geolocation`) marks that page **excluded**; the planner never
plans it and the report records *"excluded by your brief"* per page. Deterministic; the tenant's
own words decide.

### 1.5 The fill loop

After VALIDATE, a **ledger**: delivered per page, rejected per page with reasons. If
`delivered < requested` and pages remain with **unspent material** (page-specific elements, and
fewer than 2 delivered), plan **one more round** for those pages only — the batch prompt now
carries *"already delivered: …"* and *"already rejected, and why: …"* — and run it through
WRITE → JUDGE → VALIDATE. At most **two** fill rounds. Then report honestly:
*"30 requested, 26 delivered; these pages had nothing more to test: …"*.

### 1.6 The report

`report.plan` gains `rounds`, `pagesPlannedFor`, `pagesExcludedByBrief`, `pagesWithDelivery`,
`shortfallReason`. The bench prints them.

### 1.7 What the runs added

- **"delete" for an anonymous visitor with consent.** Safe mode is on in the UI with no knob, and
  three of the-internet's pages exist to demonstrate Delete. The rule: an anonymous visitor on a
  public page, with synthetic-data consent granted, has no account and no session — whatever a
  Delete control touches is demo data or something this test created. It becomes *needs-consent*
  (satisfied by the suite's grant). Behind auth it stays blocked. Only "delete"; the rest of the
  hard-block lexicon is untouched.
- **The delta oracle sees reorders.** A sort leaves the multiset of keys identical; run 3 said
  "nothing changed" on a sort that worked. When nothing was added, the ordered sequence is compared
  position by position and the elements that moved are the delta.
- **Exclusions come from the distiller, not a regex.** The mini model rewrote "skip them" into
  "which Kaizen cannot open", so a verb-based regex found one page in eight. `TenantBrief` gains
  `excludedPaths`, extracted with the instruction to copy paths verbatim; the regex remains as a
  fallback.
- **Known accounts.** The seed-token rule ("identity data must use tokens") made a sign-in test type
  `{{username}}` for an account the brief named. `knownAccounts(brief)` extracts `username "x",
  password "y"` pairs deterministically; the writer types them literally.
- **Quote a fragment, or describe.** "Quote the message text" produced `"Your username is invalid."`
  against a page that says `invalid!`. The writer now quotes a three-to-five-word fragment with no
  punctuation when the outcome quotes text, and uses a description target when it only describes it —
  letting the delta oracle find the element rather than guessing its wording.
- Figure images (`figure > img`, `.figure > img`) are surveyed, named by alt + caption — `/hovers`
  had nothing citable without them.
- Fill rounds drop any scenario whose name was already delivered, before it costs a write.

## 2. What does not change

- WRITE, the schema gate, safety, dedup, the judge, the proving run, the delta oracle. The plan
  gets better; the gates stay.
- The catalog. It is still offered to the model as a menu of shapes; it is no longer *imposed* as
  70 % of the budget.
- Scoped Suggest (one page) — it becomes the degenerate case: a batch of one dossier.

## 3. Bench protocol

Five end-to-end runs were approved. Each run: same brief (`brief.the-internet.txt`), 50 pages, 30
tests, local stack, real model. Recorded in `benchmarks/testwriter/results/` and in §5 below.

- Run 1 — baseline (done): 9 / 1.
- Run 2 — §1.1–§1.4 (dossiers, expected outcomes, repertoire, caution gating).
- Run 3 — §1.5 (fill loop).
- Runs 4–5 — whatever the ledger says next.

The bar: **≥ 30 proposed, ≥ 20 proven, ≥ 25 pages with a delivered test**, and no proposed test
whose final assertion resolved to something the action did not create.

## 4. Files

- `src/modules/test-writer/plan/dossier.ts` (new) — page dossiers from the site model
- `src/modules/test-writer/plan/repertoire.ts` (new) — shape patterns
- `src/modules/test-writer/plan/test-planner.ts` — batching, exclusions, ledger-aware replanning
- `src/modules/llm-gateway/testwriter.gateway.ts` — `planPageBatch`, `expectedOutcome` in WRITE and JUDGE
- `src/modules/test-writer/pipeline.ts` — fill loop
- `src/types/test-writer.ts` — `PlannedScenario.expectedOutcome`, `PageDossier`
- `benchmarks/testwriter/` — the bench (in repo; results ignored)

## 5. Measured

| run | change | planned | proposed | proven | pages w/ delivery | tokens |
|---|---|---|---|---|---|---|
| 1 | baseline | 29 | 9 | 1 | 11 | 134k |
| 2 | *(void — the container had not reloaded; the report showed the old planner)* | | | | | |
| 3 | §1.1–§1.5 together: dossiers, repertoire, exclusions, expected outcomes, fill loop | 53 | 25 | 7 | 17 | 290k |
| 4 | + delete rule, reorder delta, repertoire fix, fill dedup, figure images | 56 | 24 | 5 | **25** | 274k |
| 5 | + distiller exclusions, known accounts, fragment quoting | 58 | 22 | 5 | 19 | 300k |

**Graded by hand** (real interaction on the planned page; oracle observes what the action produced;
not an excluded page; not a duplicate of another delivered test in the run): run 3 **23** good of
30, run 4 **21** of 36, run 5 **22** of 34. Distinct good tests across the three runs ≈ 31 — the
material for 30 is on the site; no single run collects it because the fill rounds re-cover pages
that already have a test.

Run 5 read: the distiller over-excluded `/dynamic_loading` and `/slow` (advice, not a ban — now
advice wins over the list); and **14 of the 17 "needs review" were the vacuity probe**, which kept
only the terminal assertion and so called every round-trip test vacuous (check → verify → uncheck →
verify ends where it started). The probe now keeps every assertion — unmeasured; the reading of run
5's tests says ~18 of 22 good tests would flip to proven.

After run 5, unmeasured: fill rounds visit pages with **zero** delivered tests before pages with
one, and a differently-worded twin of a delivered test (`sameTest`: same verb, same subject) is
dropped at plan time instead of after a write, a judge and a proving run — seven per job in run 5.

Run 4 read: coverage reached the bar; proposed flat, proven down; **19 of 32 rejections were
validation** — tests reaching the browser and failing there — of which 7 were the writer inventing
literal text, 1 a seed token where the brief named credentials, 4 on pages the brief said to skip
(exclusion did not fire), 3 correct rejections, 4 page realities.
