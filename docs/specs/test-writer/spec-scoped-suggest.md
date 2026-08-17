# Spec — Scoped Suggest (`POST /suites/:suiteId/suggest`)

Created: 2026-08-17
Updated: 2026-08-17 — implemented.
Status: **Implemented.** Route, pipeline focus and UI entry point are built and
unit-tested; the §7 live check was run against a seeded model, not yet against a
real site. §2.1's single-page re-capture is delivered as `maxPages: 1` on the
existing crawler rather than a new code path — the BFS already terminates on
budget, so it is a parameter, not a branch.
Owner: Test Writer workstream · Mission 1 deliverable 4
Depends on: `spec-test-writer-service.md` (umbrella §145 declares this route in one
line and nothing else specifies it), `spec-generation-pipeline.md` (the phases
being reused), `spec-authenticated-scope.md` (the auth grant it reuses verbatim).

> Companion to `../tests-ux/spec-testwriter-ux.md`, which owns the UI surfaces.
> This spec owns the API contract and the pipeline mode.

---

## 0. The honest starting position

The umbrella spec has carried this row since P0:

> `POST /suites/:suiteId/suggest` — Scoped generation: body `{ pageUrl, options? }`.
> If Site Knowledge exists for the suite, runs PLAN/WRITE/VALIDATE scoped to that
> page. If none exists, behaves as `analyze` (recon-first is non-negotiable).

**None of it is built.** `grep -rn "suggest" src/` returns two comments. The
route does not exist, the pipeline has no scoped mode, and the only "Suggest"
button in the repo (`components/organisms/new-test-screen.tsx:275`) is
permanently `disabled` inside the dormant component tree that
`spec-testwriter-ux.md` §0.1 declares dead code. So this is not a wiring job: it
is a small backend feature plus a new entry point on the live authoring screen.

Correcting the record because the product roadmap says otherwise: the roadmap's
Mission 1 describes Suggest as "the button has been dead UI since April",
implying the backend is waiting behind it. It is not.

## 1. What Suggest is for

Analyze answers *"what should this app be testing?"* — a whole-app question the
user asks a few times.

Suggest answers *"what am I missing on **this page**?"* — asked while the user is
already looking at a page, typically in the middle of authoring a test against
it. It is the cheap, repeatable, in-the-flow half of the product, and it is the
only way the accumulated site model pays off between full analyses.

The distinction is scope, not quality: a Suggest job runs the **same** WRITE
gate stack, the **same** judge, the **same** dedup, and the **same** validation
runs. A test proposed by Suggest carries identical evidence to one proposed by
Analyze. There is no "quick mode" that lowers the bar — that would poison the
one thing Kaizen sells.

## 2. Product decisions (locked)

1. **Recon-first stays non-negotiable, but "recon" for a scoped job is one
   page.** When the suite already has site knowledge, Suggest re-captures the
   single target page before planning, and reuses the stored model for
   everything else. Rejected alternative: plan directly off the stored capture
   with no fetch. It is cheaper by one page-load and strictly worse — a page
   that changed since the last crawl would ground WRITE on elements that no
   longer exist, and the failure would surface as a rejected scenario with a
   misleading reason ("referenced an element the crawl never saw") rather than
   as the truth ("your page changed"). One page-load buys correctness and costs
   ~1 second and zero tokens.
2. **No knowledge → it is an analyze.** If the suite has no `site_pages` row for
   the target page's origin, Suggest runs the full analyze pipeline and says so
   in the response (`mode: 'analyze'`). The UI must tell the user before they
   commit, not after: a "suggest" that silently becomes a 3-minute 30-page crawl
   is a broken promise about time and spend.
3. **Suggest is not a second pipeline.** It is `runTestWriterJob` with a
   `focusUrl` and a page-scoped recon. Any divergence in the gate stack is a
   defect, not a feature. This is the single most important constraint in this
   spec: two code paths that both write tests will drift, and the one used more
   often will drift further from the one that was audited.
4. **The same auth grant, not a weaker one.** A Suggest against a page behind
   sign-in requires exactly what Analyze requires — `scope='authenticated'`, an
   eligible `loginCaseId`, `authConsent`, admin/owner role, no impersonation —
   enforced by the same `checkLoginCase()` and the same row-authoritative
   pipeline check. Suggest gets no shortcut into a customer's signed-in system.
5. **Default `planApproval: 'auto'`, and this is a deliberate departure.** The
   plan checkpoint exists to gate blast radius and spend before irreversible
   work. A Suggest job is bounded to one page and ≤3 scenarios, and the user
   just chose the page — the checkpoint's question ("is this the right thing to
   attempt?") is most of the way answered by the act of asking. Synthetic-data
   consent is unchanged and still governs anything that creates data, and the
   delivery still gates what joins the suite. The option is exposed, so a tenant
   that wants the checkpoint keeps it.

## 3. API contract

### 3.1 Request

```
POST /suites/:suiteId/suggest        (JWT; requireAuth)
{
  pageUrl: string,                   // http(s), required
  scope?: 'public' | 'authenticated',      // default 'public'
  loginCaseId?: string,              // required when scope='authenticated'
  authConsent?: boolean,             // required true when scope='authenticated'
  options?: {
    maxScenarios?: number,           // 1..5, default 3
    includeNegative?: boolean,       // default true
    validate?: boolean,              // default true
    planApproval?: 'review' | 'auto' // default 'auto' (§2.5)
  }
}
```

`maxPages` is **not accepted** — a scoped job's page budget is 1 by definition,
and accepting the field would invite a "suggest" that crawls. In the
`mode: 'analyze'` fallback the server applies the analyze default (30).

### 3.2 Validation, reusing what exists

Every gate `POST /suites/:suiteId/analyze` applies, applied identically and by
the same helpers — SSRF/destination guard on `pageUrl`, suite existence, token
budget, secret scrubbing of any free text, and the §3.1/§8.3 authenticated-scope
gates. Two additions specific to Suggest:

| Check | Failure | Why |
|---|---|---|
| An unfinished job already exists for this suite | 409 `JOB_ALREADY_RUNNING` | One at a time keeps the site model coherent — the same rule the UI already enforces for analyze, now enforced by the API because Suggest is easy to double-click |
| `pageUrl` origin matches the suite's known model origin, when one exists | 400 `PAGE_OFF_MODEL` | Suggesting against a different app inside a suite that models this one produces grounded-looking nonsense; the honest answer is "run an analyze on that app" |

### 3.3 Response

```
202 {
  jobId: string,
  mode: 'scoped' | 'analyze',        // 'analyze' = no knowledge existed (§2.2)
  warnings: string[]                 // secret-scrub notices, as analyze
}
```

`mode` is what lets the UI set honest expectations after the fact if the
pre-flight check raced. The job itself is an ordinary `generation_jobs` row —
same table, same statuses, same report, same history strip.

### 3.4 Job row

No migration. `generation_jobs.target_url` is the page URL, and
`options.focusUrl` records the scoped intent. `options.mode = 'suggest'` marks
the row so the Analyses screen can label it and so per-mode telemetry is
possible later without a schema change.

## 4. Pipeline changes

All in `src/modules/test-writer/pipeline.ts`, gated on `payload.options.focusUrl`.

1. **RECON becomes single-page when focused.** `runRecon` passes
   `budgets.maxPages = 1` and seeds the frontier with `focusUrl` only. The crawl
   loop, safety classification, capture tiers, robots handling and auth session
   are all unchanged — the crawler already terminates on budget, so this is a
   parameter, not a branch. Link edges discovered on the page are still inserted;
   the model deepens even on a scoped job.
2. **COMPREHEND is incremental, which it already is.** `classifySuite` skips
   pages whose `content_hash` is unchanged, so a scoped job re-classifies at most
   the one page it re-captured. The App Brief synthesis runs and bumps a version
   only when the classification actually changed something — otherwise the
   existing brief is reused as-is. (If synthesis is currently unconditional,
   making it conditional on `classification.classified > 0` is part of this
   work; re-synthesising an unchanged model is pure token waste.)
3. **PLAN gains a focus.** `plan()` receives `focusUrl` and restricts candidate
   scenarios to those whose `targetPages` include it. Catalog archetypes bind to
   the focused page; the LLM gap-fill prompt states the page in question and is
   told the rest of the model is context, not target. `existingCaseNames` is
   loaded as today — dedup against what the suite already covers is the whole
   point of the feature, and it is where a scoped job earns its keep.
4. **WRITE / JUDGE / DEDUP / VALIDATE are untouched.** Per §2.3.

Progress writes: the scoped job emits the same `report.progress` phases, so the
existing PROGRESS face works with no change beyond copy that says "this page"
rather than "your app".

## 5. Zero-result honesty

A Suggest that finds nothing worth adding is the **expected outcome on a
well-tested page**, and it must read as success, not as failure. The delivery
face for a scoped job with zero drafts says so plainly — "Nothing here is
untested that Kaizen would trust itself to write" — and lists what it considered
and why it dropped it (the existing rejection disclosure, where `dedup` will
usually dominate). Findings still render per `spec-findings-and-coverage.md`.

This is the case a naive implementation gets wrong by lowering the bar to
produce *something*, and it is worth stating in the spec so no future prompt
tuning quietly does it.

## 6. UI (contract only — surfaces owned by `../tests-ux/spec-testwriter-ux.md`)

- Entry point: `components/design/screen-author.tsx`, a ghost
  `✦ Suggest tests for this page` action, enabled once the case being authored
  has a valid base URL. This is the live authoring surface; the dead
  `new-test-screen.tsx` button is deleted rather than wired (§0).
- Dialog: **`writer-analyze-sheet.tsx` in `mode='suggest'`**, not a second
  component. The consent copy — synthetic data and signed-in exploration — is
  the most carefully-worded text in the product and must exist in exactly one
  place. Suggest mode locks the URL to the page, hides depth, caps scenarios at
  5, retitles to "Suggest tests for this page", and shows the pre-flight verdict:
  *"Kaizen already knows this app — this takes about a minute"* or *"Kaizen
  hasn't explored this app yet, so this first run is a full analysis (a few
  minutes)."*
- Result: `go('writer', {suiteId, jobId})` — the same WriterScreen, same faces.
  A scoped job needs no screen of its own.

## 7. Testing

- **API**: body validation; `maxPages` rejected; 409 on a second concurrent job;
  400 `PAGE_OFF_MODEL`; the authenticated-scope gate matrix re-asserted through
  this route (admin required, impersonation refused, ineligible login case
  refused) — not assumed from analyze's tests, because a copied route is exactly
  where a gate goes missing.
- **Pipeline**: `focusUrl` ⇒ `maxPages: 1` and a single-URL frontier; PLAN
  receives only scenarios targeting the focused page; dedup against existing
  case names drops a scenario the suite already covers.
- **Fallback**: a suite with no `site_pages` returns `mode: 'analyze'` and runs
  the full crawl.
- **Web**: suggest-mode sheet renders the locked URL and the correct pre-flight
  verdict for both knowledge states; zero-draft delivery renders the
  "nothing untested here" copy rather than an empty shrug.
- **Live**: a Suggest against a page of Kaizen's own app that already has one
  test proposes something non-duplicative, or honestly proposes nothing.

## 8. Out of scope

- **Multi-page suggest** ("suggest for these 4 pages") — analyze already covers
  breadth; a middle mode adds a third budget conversation for little gain.
- **Suggest from a run failure** ("this broke, write a test for it") — that is
  Mission 4's triage loop, and it needs findings-with-lifecycle to hang off.
- **Re-crawl staleness policy** — a scoped job refreshes its own page and nothing
  else. Model-wide staleness is Mission 6 (MAINTAIN).
