# Spec: Findings & Coverage — the QA-engineer deliverable

Created: 2026-08-12
Updated: 2026-08-17 — §3.1 records what phase 1 shipped and the three delivery
gaps left; §3.2 decides where coverage lives (Mission 1 deliverable 3).
Status: phase 1 implemented (`3e56294`); phase 2 (coverage UI) specified in §3.2
Owner: Test Writer workstream
Depends on: worker final-state capture (spec-validation-trust.md §8)

## 0. Why this spec exists

The assessment's highest-impact product gap: **the pipeline observes real
defects and structurally says nothing.** Verified:

- Job `4b4a34e7` spent **11,020 tokens, proposed 0 tests**, and the customer
  received literally nothing — while the pipeline internally held judge
  rejection reasons, auth statistics, `publicPartitionUnverified: true`, and a
  site model containing **5 icon-only buttons with empty accessible names** (a
  real a11y defect in the app under test, stored as junk grounding rows).
- Broken pages during the crawl are a warn-log + `continue` (`crawler.ts:228-236`)
  — no counter, no report.
- Worst case: if the XSS-probe test goes **red because the app is actually
  vulnerable**, the red run is read as "the generated test is wrong," rejected,
  and nothing is filed. **Kaizen would find an XSS and report the opposite.**

A senior QA engineer with the identical zero-test day delivers a **findings
memo**. This spec builds that memo, and the coverage map that frames it. Both
are read-only over data the pipeline already produces (plus the §8 capture) —
no new crawling, no new LLM calls in the base tier.

Guiding rule: **a job must never return nothing.** If it proposed no tests, it
returns findings and coverage. If it has neither, it returns an honest "here is
what blocked me" (challenge/robots/thin-crawl).

## 1. The findings model

A new `findings` array on `generation_jobs.report` (no new table — findings are
job-scoped and die/regenerate with re-analysis, same lifecycle as the rest of
the report). Each finding:

```ts
type Finding = {
  kind: FindingKind;
  severity: 'info' | 'low' | 'medium' | 'high';
  title: string;              // customer-facing, specific ("5 buttons have no accessible name")
  detail: string;             // what + where
  evidence: {                 // reconstructable, never hand-wavy
    url?: string;
    elementRef?: string;      // page_elements id or role+name
    runId?: string;
    repro?: string[];         // ordered steps when applicable
  };
  source: 'recon' | 'comprehend' | 'validate';
};
```

`FindingKind` v1 (each groundable from existing data + the §8 capture):

| kind | Trigger | Severity | Source |
|---|---|---|---|
| `crawl_error_page` | a page returned 4xx/5xx or failed to load during BFS (needs the report-counter hook replacing `crawler.ts` silent `continue`) | high (5xx) / medium (4xx) | recon |
| `empty_accessible_name` | interactive `page_elements` with empty/whitespace accessible name (icon-only buttons) — an a11y defect and a grounding hazard | medium | recon |
| `possible_app_defect` | a judge-**approved** scenario whose validation run went red on an **assertion-class** failure (the test was sound; the app behaved wrong) — the XSS-inversion fix | high | validate |
| `unverified_auth_partition` | `report.auth.publicPartitionUnverified === true` — requires_auth marks are conservative defaults, not observations | low | recon |
| `console_or_network_errors` | the §8 capture recorded `consoleErrorCount > 0` or `httpErrorCount > 0` on a run that otherwise passed (a page that works but errors underneath) | low/medium | validate |
| `broken_link` | a `page_links` edge whose target resolved to an error page | medium | recon |

**The `possible_app_defect` reclassification is the load-bearing one.** In
`ValidationRunner`, a rejection of a scenario that (a) passed the judge and (b)
failed on an assertion-class error is *dual-recorded*: rejected as a draft AND
emitted as a `possible_app_defect` finding with the run link and repro steps.
This is the exit the XSS case needed — a red run is no longer only ever "our bad
test."

## 2. Prompt-injection & untrusted-content discipline

Findings surface crawled strings (titles, element names, error text) into the
customer UI. All such text is already `untrusted()`-fenced on the way into
prompts; findings must apply the same sanitization on the way into
`title`/`detail` (strip control chars, cap length, never interpret as markup in
the UI). A hostile page cannot turn a finding into an injection vector or a
stored-XSS in Kaizen's own dashboard. An injection fixture (hostile page →
finding rendered inert) joins the test plan.

## 3. Delivery UX

`screen-writer.tsx` DeliveryFace gains a **Findings** section, shown whenever
`report.findings` is non-empty — including (especially) when `drafts.length === 0`.
The zero-survivor day now renders: "Kaizen proposed no tests this run, but found
N things worth your attention," then the list. Severity drives a chip
(high=fail-tone, medium=warn, low/info=idle). Each finding shows its evidence;
`possible_app_defect` links to the run ("see what happened").

Copy principle (per house style): name things by what the user recognizes — "5
buttons have no readable label" not "empty accessible name on 5 nodes." The
`detail` carries the technical precision.

### 3.1 Build status and the remainder (added 2026-08-17)

Phase 1 shipped in `3e56294`: the six kinds, the `possible_app_defect`
reclassification, ranking, sanitization, and `FindingsSection` on the delivery
face. Three gaps remain, all small, all in the delivery half:

**a. Findings are dropped exactly where they matter most.** They render on the
DELIVERY face only. A job that ends `blocked` — sign-in failed, robots refused,
every page challenged — renders `HaltedFace`, which shows the error and nothing
else, even though the pipeline deliberately computed and stored findings before
stopping. §0's rule is *a job must never return nothing*, and the blocked job is
the job that currently returns nothing. `HaltedFace` renders the same
`FindingsSection`.

**b. Two of the four evidence fields are never shown.** `evidence.repro` and
`evidence.runId` render; `evidence.url` and `evidence.elementRef` do not. For
`crawl_error_page`, `broken_link` and `empty_accessible_name` — half the kinds,
and the ones with no run to link to — the URL *is* the finding's actionability.
Render `url` as the row's secondary line (plain text, never a link that a
hostile crawled page chose the target of; the same untrusted-content discipline
as §2) and `elementRef` beside it when present.

**c. Severity is shown but does not order the eye.** Findings arrive ranked;
the list renders flat. Group under `high` / `medium` / `low & info` headings so
a 12-finding job reads as a triage list rather than a wall.

## 3.2 The coverage face

§6 phase 2 left the choice open — "a simple coverage face (or a strip on the
delivery screen)". **Decision: a strip, on the tests screen, not a screen of its
own, and not on the delivery face.**

Reasoning. The endpoint (`GET /suites/:suiteId/coverage`) is built, complete and
honest — pages ⋈ active cases, with the thin-crawl `coverageConfidence` guard —
and has no UI at all. Where it belongs follows from what the number is *for*:
coverage answers "what does my suite not cover", which is a question about the
**suite**, asked while looking at the suite, repeatedly over weeks. The delivery
face is a per-job story that is over once the drafts are accepted; putting a
durable answer inside a disposable narrative buries it. A dedicated screen is
Mission 6's job (the roadmap explicitly holds "coverage map as a durable screen"
there) and would be over-built for one endpoint today.

So: a collapsed strip on `screen-tests.tsx`, beside the App Brief card, reading
`{tested} of {total} pages have a test` with an expander listing the untested
ones by URL and `purposeTag`. It is the same information a QA lead would ask for
in a standup, in the place they already stand.

**The honesty guard is the load-bearing part, not the number.** When
`coverageConfidence === 'unknown'`, the strip must not render a ratio at all —
not greyed, not caveated, not "3 of 3 (limited)". It renders
`confidenceReason` alone: *"Coverage can't be assessed — only N pages were
reachable."* A 1-page crawl showing "1 of 1 covered" is the single most
dishonest thing this feature could put on screen, and a percentage that a user
half-reads will be remembered as a percentage.

Pages marked `requiresAuth` are labelled *"behind sign-in"* in the untested
list — that is the coverage gap most worth converting, and it points straight at
signed-in exploration.

## 4. Coverage map

Spec'd in the master plan verbatim as `GET /suites/:id/coverage`, never built
(zero routes). The substitute (`findCoverageGaps`) depends on a tenant brief
that **0 of 24 suites have ever had**, and its word-matcher is suppressed by any
common word — so coverage is effectively unavailable today.

**Endpoint**: `GET /suites/:suiteId/coverage` → the pages Kaizen knows about,
each marked tested/untested by whether any **active** case in the suite touches
it. A read-only LEFT JOIN:

```
site_pages (the suite's app — see note)              [what exists]
  LEFT JOIN pages touched by active cases via run_events   [what's covered]
```

Returns `{ pages: [{ url, purposeTag, tested: bool, caseCount }], summary }`.

**Post-036 note**: once knowledge is app-keyed (spec-app-entity.md), the left
side is `WHERE app_id = suite.app_id AND is_canonical` — one FK hop from the
suite. Until 036, it is `WHERE suite_id = :suiteId`. The endpoint ships against
suite keying and switches its WHERE clause when 036 lands; the response shape is
identical, so the UI is unaffected.

**Thin-crawl honesty (mandatory guard)**: if the crawl that built the model saw
≤2 pages, or challenge/robots blocked it, the response is flagged
`coverageConfidence: 'unknown'` and the UI reads "Coverage can't be assessed —
only N pages were reachable (robots/anti-bot/SPA)." A 1-page YouTube crawl must
never render "you've covered 100%." This is the same honesty gap that let PLAN
fill full budgets from a 1-page model; it is closed here at the reporting layer.

## 5. What this reframes

- **Every job becomes a deliverable.** Draft count stops being the sole measure
  of a job's worth; a zero-draft job that surfaces a 500ing page and 5 a11y
  defects is a good day's QA work.
- **Coverage is the honest denominator.** "4 tests, 9 untested pages, here they
  are" is the customer's only view of what the suite doesn't cover, and it
  reframes a low draft count as a starting map rather than a failure.

## 6. Phasing

1. **Findings channel** — the `findings` array, the six kinds, the
   `possible_app_defect` reclassification, the DeliveryFace section. The
   report-counter hook for `crawl_error_page` is the only new plumbing; the rest
   is queryable today (with `console_or_network_errors` waiting on
   spec-validation-trust.md §8).
2. **Coverage endpoint** — the JOIN, the thin-crawl guard, a simple coverage
   face (or a strip on the delivery screen).

Both are read-only and independent of the oracle-integrity work — they can be
built in parallel with spec-validation-trust.md by a different pair of hands
(different files, different risk surface).

## 7. Out of scope (deferred, with reasons)

- A standalone security/risk **scanner** — risk *detection* is partly designed
  already (spec-authenticated-scope.md drafts partition-risk copy); the gap was
  a delivery channel, which this spec provides. Ride 2-3 risk finding kinds on
  the channel; a separate scanner is scope creep.
- Requirement **traceability** — no brief corpus exists to trace against (0/24
  suites). A `coveredFlow` column can ride the coverage endpoint later; the rest
  waits until briefs are actually used.
- Pushing findings out via **webhooks/Slack** — that is Pillar B (notifications,
  unstarted). When Pillar B lands, findings are a natural producer; the channel
  here is the in-product surface it will later also push.
