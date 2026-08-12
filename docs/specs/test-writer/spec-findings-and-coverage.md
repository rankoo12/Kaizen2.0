# Spec: Findings & Coverage — the QA-engineer deliverable

Created: 2026-08-12
Status: approved for implementation (founder accepted 2026-08-12)
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
