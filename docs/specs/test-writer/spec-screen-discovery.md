# Spec: Screen discovery — pages that are reached by clicking, not by URL

**Created:** 2026-08-18
**Updated:** 2026-08-18 — §1.3 newness rule from run 2; §4 runs 1–5
**Status:** Approved by the founder (2026-08-18, "go"); building in PR #101
**Owner:** test-writer
**Amends:** `spec-recon-crawler.md` §2 (BFS), §4.1 (classifier); `spec-planner-per-page.md` §1.1 (dossiers)
**Found by:** the first Kaizen-on-Kaizen analysis (2026-08-18) — 50 pages requested, **1 crawled**

---

## 0. The finding

The Kaizen dashboard is a state-machine SPA: `kaizen-app.tsx` switches a `screen` state on
`onClick`, the URL stays `/tests`, and there is not one `<a>` in the design components. RECON
discovers pages by following hrefs (BFS) and only *clicks* controls the safety classifier calls
`safe-reveal` — and even then it harvests **links** the click revealed, not the screen. The sidebar
buttons "Runs", "Analyses", "Settings" are hrefless buttons with ordinary names → `mutating` →
never clicked. Runs, Analyses, Settings, Usage, suite pages, run timelines: all invisible. The
planner got one dossier and produced three tests, none worth keeping.

the-internet never needed this; every real app does. A senior QA engineer finds "Runs" by
clicking the sidebar. So must Kaizen.

## 1. What changes

### 1.1 The DOM pruner records where a control lives

Every surveyed element gains `attributes['nav-context']` when an ancestor is a navigation
container: `nav`, `aside`, `header`, `[role=navigation|menubar|tablist|toolbar]`, or a container
whose class/id reads as one (`sidebar`, `side-nav`, `nav`, `navbar`, `menu`, `tabs`, `tab-bar`).
`aria-current` joins the captured attributes — WAI-ARIA's own marker for "an item in a set of
navigation". Zero cost; the survey already walks the ancestors.

### 1.2 A view-switch candidate

`recon/screens.ts` — `viewSwitchCandidates(survey, ctx)`: elements that are

- `button`, `menuitem`, or an `<a>` with **no href**, with a name of 1–40 characters,
- and either carry `aria-current` or sit in a `nav-context`,
- and are **not** session-ending, not in the destructive lexicon, not `type=submit`, not a
  menu/dialog opener (`aria-haspopup`), and not a creation-form opener (those are probes already).

Deterministic and conservative: unknown resolves to *not a screen*. Capped at 12 per page.

### 1.3 A screen is a page

For each candidate on page P the crawler enqueues a **virtual page**:

- identity `url_normalized = P#screen=<slug>` (slugs chain for nested screens: `#screen=runs/run`),
- `url_observed = P` — where a test must navigate,
- `reached_by = [{ role, name }, …]` — the clicks that get there from P.

When dequeued: `goto(P)`, perform the clicks by role+name (exact, then contains), settle, then the
ordinary capture path (challenge, session-loss, sensitive tier, survey, forms, probes, screenshot).
The screen is **kept only if it is materially different** from the page it came from — any one of:
≥ 2 named controls the parent did not have, or 1 new and ≥ 2 gone (a view swaps its toolbar); a
different first heading; or visible text that is mostly different (word Jaccard < 0.6). Unnamed
controls (icon buttons) do not count — they are indistinguishable. And its content hash must not be
one already captured (clicking "Tests" from Runs goes back; it is not a new screen). Kept screens
count against the page budget like any page; discarded ones cost a click.

*As built (run 2):* the first rule was "≥ 3 new controls or a new heading". Kaizen's Runs view has
two new named controls, five gone and no heading anywhere in the app — a screen by any reading, and
it was discarded until the rule learned to count what disappeared and to read the text.

Screens are explored to `maxDepth` like links; their own view-switch candidates chain.

### 1.4 Sensitive tiers see screens

`sensitiveTier()` treats `#screen=` slugs as path segments: a "Settings → API keys" screen is Tier
A even though its URL is `/tests`. Same rule, same lexicon.

### 1.5 The planner and the writer know how to get there

`PageDossier.reachedBy` and `PlannedScenario.reachedBy` (copied from the first target page at
normalise time). The WRITE prompt says how the page is reached and that Kaizen adds those steps;
`prependNavigate` becomes `prependReach`: `navigate to <url_observed>` then one `click the "<name>"
<role>` per hop, inserted after any navigate the model wrote itself. `failStepIndex` shifts by the
number of steps inserted. Dedup, judge and the proving run see ordinary steps.

### 1.6 The report

`recon.screensDiscovered`, `recon.screensDiscarded` on the crawl report; the bench prints screens
as pages (they are).

## 2. What does not change

- The safety classifier's verdicts and the probe protocol. View-switch is a *separate* gate with
  its own lexicon checks; nothing that was `mutating` becomes clickable except through §1.2.
- Page identity elsewhere: `url_normalized` stays the key; a screen simply has one that carries a
  fragment.
- Public-scope behaviour on link-shaped sites: no `nav-context` candidates → no screens.

## 3. Files

- `db/migrations/041_site_pages_reached_by.sql` — `reached_by jsonb`
- `src/modules/dom-pruner/playwright.dom-pruner.ts` — `nav-context`, `aria-current`
- `src/modules/test-writer/recon/screens.ts` (new) — candidates, slug, newness
- `src/modules/test-writer/recon/crawler.ts` — enqueue, reach, keep-or-discard
- `src/modules/test-writer/recon/safety.ts` — `sensitiveTier` reads screen slugs
- `src/modules/test-writer/interfaces.ts`, `src/types/test-writer.ts` — `reachedBy`
- `src/modules/test-writer/site-model.repository.ts` — store/read `reached_by`
- `src/modules/test-writer/plan/test-planner.ts` — `reachedBy` onto scenarios
- `src/modules/test-writer/write/scenario-writer.ts` — `prependReach`
- `src/modules/llm-gateway/testwriter.gateway.ts` — reach note in WRITE

## 4. Measured

| run | pages crawled | screens | planned | proposed | proven | tokens | time |
|---|---|---|---|---|---|---|---|
| kaizen 1 (before) | 1 | — | 3 | 3 | 0 | 35k | 2.5 min |
| kaizen 2 — §1.1–1.5 as first built | 6 | 5 | 4 (+2 fill) | *(orphaned: a source edit reloaded the container mid-run)* | | | recon 5 min |
| kaizen 3 — looser newness, one try per nav slug, seeded demo workspace | 12 | 11 | 7 (+5) | 6 | 0 | 184k | 25 min |
| kaizen 4 — actions/toggles are not views, nav is chrome, DOM settle | 10 | 9 | 15 | 4 | 0 | 185k | 11 min |
| kaizen 5 — delta sees state + removals, aria-expanded not a screen | 7 | 6 | 11 | 7 | 0 | 136k | 7 min |

Run 5 read: the screen set is exactly the app (tests, both suites, runs, analyses, the-brain, usage);
the filter tests now pass validation; and all seven proposed are `vacuous_oracle` because the
probe's page-wide fallback for a description target passes trivially — fixed as `AssertionNoAction`
(spec-oracle-delta-and-fidelity §1.2); run 6 measures it.

Run 3 read: the plans reached the real screens (Runs filters, Run suite, The Brain search,
Analyses start), and every one that reached the browser died on the delta oracle with "nothing on
the page changed" — because `walk()` only recorded *added* elements, so a filter that hides rows and
a button whose `aria-pressed` flips were "nothing". Also: "Run now" was clicked as a screen (a real
run started) — the destructive lexicon knows "delete" but not "run"; the sidebar's items were not
chrome (their names carry live counts, "Tests 0" → "Tests 6", so no name reached 60 %); recon
captured the dashboard while it still read "Signing in…". Each is fixed in commits `81c0658` and
`51e2387`; run 5 measures them.

Every proposed test in runs 3–4 was `vacuous_oracle`, and correctly so: "type 'Happy Test Name' →
Save → verify the new test in the list is visible" holds without the actions. The writer now asserts
the literal it typed (rule 4).

Kaizen's own UI, as findings for the design tool: the new-test name field is named by its
placeholder ("Sign in with valid credentials"); the "Needs a human" filter's accessible name carries
its hint ("Needs a human 2 tap to filter"); five icon buttons have no name; console errors on
every screen.
