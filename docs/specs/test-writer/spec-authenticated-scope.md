# Spec — Authenticated Scope (Phase 3: signed-in exploration + generation)

Created: 2026-08-06
Branch: `feat/test-writer/authenticated-scope` (off main, after P2 merged as #65)
Status: **Backend implemented** (2026-08-07) — §3 through §10 and §12 are built
and unit-tested; migration 034 applied to the shared dev DB. Design was
adversarially reviewed (security, groundedness, product) with all findings
applied before implementation.

Not yet done: the §11 consent UX (analyze-sheet card, login-test picker and its
empty state, progress/blocked/report faces) and the §14 live dogfood run against
Kaizen's own app. Three decisions still await the product owner — §16.

Deviations found while building, each recorded at its section: the L5 resolver
prompt is redacted for credential steps but `compileStep` deliberately is not
(§12.2 item 3); the origin guard resolves absolute URLs without depending on the
page's current location (§3.1); and auth-session reuses `capturePageMeta`'s
password probe rather than duplicating it (§4.3).

> Companion to `spec-test-writer-service.md` (umbrella), `spec-recon-crawler.md`
> (whose §5 sketched this phase in P0 — this spec supersedes that sketch),
> `spec-comprehension-knowledge-model.md`, and `spec-generation-pipeline.md`.
> Read the recon spec first: everything here is an extension of its crawl loop
> and safety machinery, not a second crawler. UI affordances follow
> `../tests-ux/spec-testwriter-ux.md` (which supersedes the UI portions of
> `spec-draft-review-ux.md`, including its §2.1 scope-selector dialog).

## 1. Why this phase exists

The highest-value tests live behind the login wall. Public-scope recon sees a
marketing site: home, pricing, docs, a login form it may not pass. The system
flows a customer actually pays QA to protect — dashboards, settings, checkout,
the CRUD that IS the product — are invisible to it. The market anchor from the
plan file makes the point concretely: a real 300-test Playwright suite,
mostly behind auth, mostly system flows. P3's product purpose is **test
quality**: give COMPREHEND a real app instead of a brochure, give PLAN the
journeys that matter, and generate proven tests for them.

P3 delivers exactly what the umbrella spec §10 promised: login-recipe
execution, consent flow, logout blocklist, session verification, and
authenticated generation. Almost all of the plumbing already exists and was
deliberately gated off in P1:

- `generation_jobs` carries `scope`, `auth_consent`, `login_case_id`, with a DB
  CHECK (`generation_jobs_auth_consent`, migration 028) enforcing
  `scope='public' OR (auth_consent AND login_case_id IS NOT NULL)`.
- `TestWriterJobPayload` (src/queue/index.ts) already rides `scope`,
  `loginCaseId`, `authConsent` to the worker.
- The analyze route accepts and persists all three, then 400s with
  `AUTH_SCOPE_NOT_SUPPORTED` (src/api/routes/test-writer.ts:74-79); the
  pipeline independently blocks (`src/modules/test-writer/pipeline.ts:69-73`).
  These two gates are what P3 removes — nothing else about the job contract
  changes.
- `site_pages.requires_auth` (migration 029) is already populated by the
  public crawler's auth-wall detection, and PLAN already drops (and reports)
  scenarios touching such pages absent authenticated scope + consent.

## 2. Product decisions (locked)

1. **Credential handover = a login recipe.** The tenant points at an existing
   Kaizen test case (`loginCaseId`) that signs in; Kaizen executes it to obtain
   the session. **Kaizen stores no new secrets** — credentials live only where
   they already live, in the login test's steps. Alternatives considered:
   (b) a per-suite encrypted credential store — DEFERRED to the enterprise/BYO-
   key phase, where a tenant-scoped encrypted credentials table is being built
   anyway (plan file §10); (c) a pasted session cookie/token — REJECTED: it
   expires unpredictably, the UX is awkward, and it is opaque to the user in a
   way a reviewable test case is not. A login recipe is self-documenting,
   independently provable (it's a test), and its selectors are already warm in
   the tenant's cache from its own runs.
2. **Public scope stays the default.** `scope='authenticated'` requires BOTH a
   `loginCaseId` AND `authConsent === true` — enforced at the API (400), by the
   DB CHECK, and re-checked in the pipeline. New in P3: consent is **recorded
   with the consenting user id + timestamp** on the job row (§8.2).
3. **Confidentiality first** (umbrella §13 priority order). Everything learned
   behind auth is tenant-scoped under RLS and the shared-pool prohibition is
   absolute — enforced by construction and proven by a **behavioural**
   isolation test, because review of this spec found two live cross-tenant
   write paths inside code P3 reuses that the existing grep-based guard cannot
   see (§4.1). Session material (cookies/localStorage/storageState) lives **in
   memory, in the crawl's own BrowserContext, for the duration of the job
   only** — never persisted, never logged, never exported, never in reports.
   P3 also closes three pre-existing credential-exposure paths (§3.2) that
   affect every customer's login tests today.
4. **P3 is about test quality, not just crawling.** The spec states how
   authenticated knowledge upgrades COMPREHEND/PLAN/WRITE (§6), not merely how
   the crawler logs in.
5. **The plan-approval checkpoint applies unchanged** to authenticated jobs
   (generation spec §2.1). Signed-in exploration raises the stakes of what
   gets written; it does not change who approves it.
6. **Dogfood acceptance target: Kaizen itself**, using the just-merged demo
   login. The demo sign-in button posts an empty body to `/api/auth/demo` and
   the server supplies credentials — so the reference login recipe contains
   **zero secrets in step text**, which is also the pattern the UX copy
   recommends to customers (§11).

## 3. The login recipe

### 3.1 Eligibility gates (API-time, before any job is created)

`POST /suites/:suiteId/analyze` with `scope='authenticated'` validates the
login case up front — a job that cannot log in should never be enqueued:

| Check | Failure | Rationale |
|---|---|---|
| Case exists in the tenant | 400 `LOGIN_CASE_NOT_FOUND` | tenant isolation; also catches typos |
| `status = 'active'` | 400 `LOGIN_CASE_NOT_ACTIVE` | drafts/validating/rejected/archived cases are unproven or retired — a login recipe must be a case the tenant trusts |
| Case `base_url` origin === `targetUrl` origin (**via `resolveCanonicalOrigin()`**, see below) | 400 `LOGIN_CASE_ORIGIN_MISMATCH` | a login flow for another site cannot authenticate this one; the crawler is same-origin by invariant, and cookies wouldn't apply |
| **No `navigate` step in the recipe points off-origin** | 400 `LOGIN_CASE_NAVIGATES_OFF_ORIGIN` | see below — `base_url` is metadata, the steps are what execute |
| No step's `raw_text` contains a `{{token}}` colliding with the seed-variable names (`firstName`, `lastName`, `email`, `password`, `phone`, `company`, `username` — `generateFormData()`, src/modules/test-data/generate.ts) | 400 `LOGIN_CASE_USES_SEED_TOKENS` | validation runs inject random per-run values for exactly these tokens (`RunJobPayload.seedVariables`); a login recipe typing `{{password}}` would silently sign in with a random string and fail every proving run |

**Recorded decision — validate the recipe's steps, not just its `base_url`.**
The origin check on `base_url` is metadata; what actually runs is the step
list, and a `navigate` step can point anywhere. Without the step-level check,
an admin-role user gains an arbitrary-navigation primitive **inside Kaizen's
infrastructure** — `navigate to http://169.254.169.254/`, `http://localhost:6379`,
or any service reachable from the Test Writer container — with credentials
subsequently typed into whatever loads. Two gates, because the API check is
advisory once the job is running:

1. **API-time**: reject a login case containing a `navigate` step whose URL
   origin differs from the target origin (400 above).
2. **Execution-time** (auth-session, immediately before each `navigate`):
   re-enforce the origin match AND refuse private/link-local/loopback
   destinations regardless of origin — RFC1918, `127.0.0.0/8`, `169.254.0.0/16`,
   `::1`, `*.internal`, `*.local`. Refusal ends the job `blocked: login_failed`
   with the destination named.

The run worker has the same property today for any user-authored case; this
spec fixes it at the seam P3 introduces rather than assuming it away, and
§15 flags the worker-side generalisation as follow-up.

**Recorded decision — the origin comparison goes through a resolver, not `===`.**
The check is written as
`resolveCanonicalOrigin(caseBaseUrl) === resolveCanonicalOrigin(targetUrl)`,
where v1's implementation is the identity function (raw origin). The
indirection exists for a collision that is already visible: B11 (CI
integration) runs against **preview deploys** — `app-pr-123.vercel.app` — while
the tenant's login case lives on `app.example.com`, so a literal `===` would
`400` every CI-triggered authenticated job, which is exactly the case that
matters most (authenticated system flows behind a preview). B11 §5.1 defines a
tenant-owner-configured alias table (`app-pr-*.vercel.app → app.example.com`);
when it exists, `resolveCanonicalOrigin` consults it and the integration point
is one function rather than a change to this gate. Recorded in COORDINATION.md
(2026-08-07). The check itself is **not** weakened: it remains a real safety
boundary — what stops a login flow being executed against a site it doesn't
belong to — and aliases must stay owner-configured, because auto-detected
wildcards feeding an auth check is not an acceptable combination.

**Recorded decision — tenant-wide picker, not suite-scoped.** Any active case
in the tenant is eligible (subject to the origin check), not only cases in the
target suite. Login cases naturally live once, in a base suite; restricting to
the same suite forces duplication of the one test whose staleness matters most
(§6.4). The origin check is the real boundary.

### 3.2 What "no new secrets" honestly means today

Credentials in a conventional login case are literal strings in
`test_steps.raw_text` — stored in Postgres under tenant RLS, serialized into
run-job payloads, and (until P3) leaking out of the tenant boundary by three
routes the review of this spec found in existing code:

| # | Path | Where the credential lands | Fixed by |
|---|---|---|---|
| a | Worker resolve log writes `step.value` post-interpolation, and the log MESSAGE embeds `step.rawText` verbatim (worker.ts:465-468) | `run_events.data` + `run_events.message`, queryable in the runs UI by any tenant member | §12.2 |
| b | `LearnedCompiler` L3 fallback persists `ast_json` **including `value`** into `compiled_ast_cache` — a table with `content_hash` as its ONLY key, no `tenant_id`, no RLS (002_seed_compiled_ast_cache.sql:23-27) | a **global, cross-tenant** table, permanently, outside any tenant-offboarding purge | §12.3 |
| c | The L5 resolver prompt includes `Full step: ${step.rawText}` and `compileStep` sends the raw sentence as its user message (openai.gateway.ts:202,291) | the LLM provider | §12.2 |

Route (b) is the serious one and it is **pre-existing**: any customer whose
login test misses the compile cache has already published that password to a
shared table. P3 does not create the bug but it does industrialise it —
auth-session compiles login steps (§4.1) and every authenticated draft carries
a copied prefix (§6.2), turning incidental misses into guaranteed ones. So P3
fixes it rather than inheriting it.

The posture, restated honestly: (a) Kaizen adds **no additional copy** of any
credential anywhere; (b) P3 **closes all three existing exposures above**,
which is a net confidentiality improvement for every customer, not only
Test Writer users; (c) the recommended pattern remains a **credential-free
button recipe** (the demo login) or a dedicated test account on staging —
stated verbatim in the consent copy (§11). The encrypted vault that removes
literals entirely is the BYO-key phase's job, not P3's.

## 4. Session acquisition — `recon/auth-session.ts`

### 4.1 Mechanism: in-process execution inside the crawler's own context

The single most convenient fact in the P1 codebase: the crawler uses **one
BrowserContext and one Page for the entire BFS** (crawler.ts:76,87), so
cookies and localStorage set before the loop persist across the whole crawl
with zero refactoring. `auth-session.ts` therefore executes the login case's
steps **on the crawler's own page, before the BFS starts**:

1. Load steps via `loadActiveSteps(tenantId, loginCaseId)`
   (src/db/case-writer.ts:120) — raw text + stored `compiled_ast` where
   present. Steps without a stored AST (typical for user-authored cases) are
   compiled through `LearnedCompiler` — content-hash cache first, so a login
   case that has ever run compiles at ~0 tokens. Two corrections to what P2
   left behind, both P3 deltas (§10.5), not existing facts:
   - **Billing tenant**: `LearnedCompiler` still hardcodes
     `SYSTEM_TENANT_ID = 'system_global'` and its constructor takes no tenant
     (learned.compiler.ts:21,62-65,103). The P2 spec promised this
     parameterization (spec-generation-pipeline.md:164-166) and the
     implementation never shipped it — no test-writer module imports
     `LearnedCompiler` at all today. P3 threads a billing `tenantId` through
     (defaulting to `system_global` so existing callers are untouched) and
     passes the job's tenant.
   - **No global cache write for secret steps**: see §12.3. Login compiles run
     in no-persist mode.
2. Execute each AST with `PlaywrightExecutionEngine.executeStep(step,
   selectorSet, page)` — a plain in-process call (interfaces.ts:20-24); the
   engine has no queue/DB/worker dependency. The Test Writer service wires the
   composite resolver chain (`ArchetypeElementResolver` →
   `CachedElementResolver` → `LLMElementResolver`) — but **deliberately not
   the worker's wiring verbatim**, see the isolation decision below. The
   tenant's `selector_cache` is warm from the login case's own prior runs, so
   resolution is normally cache-hits; the LLM resolver is the metered rare
   fallback. `interpolateStep` runs with an empty run context for parity
   (non-seed `{{tokens}}` pass through literally, exactly as in the worker).

**Recorded decision — the auth-session resolver chain is constructed WITHOUT
the shared pool, and archetype learning is off.** Copying worker.ts:87-159
verbatim would silently violate the absolute shared-pool prohibition (master
plan decision 4, §2.3, §12 threat 3), by two paths that live in reused code
rather than in anything Test Writer writes:

- `LLMElementResolver.persistToCache` calls `sharedPool.contribute({...})`
  whenever the resolver was constructed with a `SharedPoolService`
  (llm.element-resolver.ts:737-748) — publishing selectors and element/step
  embeddings of a **behind-login page** to `selector_cache` rows with
  `is_shared = true, tenant_id NULL`, which every other tenant on that domain
  reads. The `sharedPool` constructor argument is optional; auth-session omits
  it.
- The worker calls `archetypeResolver.learn(picked.role, picked.name,
  step.action)` after any LLM resolution (worker.ts:781-787), appending
  behind-login accessible names into `element_archetypes` — a table that is
  global, tenant-free AND domain-free (015_element_archetypes.sql:16-25).
  Suppressed for behind-auth execution.

This is a **worker change too**, not only an auth-session one: proving runs of
authenticated drafts (§7) execute the same code as a signed-in user. P3 carries
`behindAuth: true` on `RunJobPayload` for testwriter runs whose case belongs to
a `scope='authenticated'` job, and the worker suppresses BOTH
`sharedPool.contribute` and `archetypeResolver.learn` when it is set. The
tenant's OWN `selector_cache` writes continue — that is the tenant's own
memory of its own app, and it is what makes the login prefix free (§6.3).

**The isolation test must change shape.** Today's guard is a text grep over
`src/modules/test-writer/**` (safety.test.ts:173-197) and would catch neither
path: the resolver wiring lives in `src/services/test-writer/index.ts` and the
leak itself is inside `src/modules/element-resolver/`. P3 replaces it with a
**behavioural** test (§14): run auth-session and an authenticated proving run
against a stub DB, assert zero INSERTs carrying `is_shared = true` or
`tenant_id NULL` and zero `element_archetypes` writes. The grep stays as a
cheap second line, extended to assert `src/services/test-writer/**` never
imports `SharedPoolService`.

**Recorded decision — no healing during login.** If a login step fails, the
job ends `blocked: login_failed` naming the failing step; the HealingEngine is
not wired into auth-session. Rationale: healing would silently paper over a
broken login case that the customer's real suite depends on. A login case that
needs healing needs *fixing* — and the blocked message says exactly that,
with a link to the case. (The same case, run through the normal worker, still
heals as ever — this is a recon-context decision only.)

**Alternative considered — storageState export from a worker run**: run the
login case as a normal `kaizen-runs` job, export
`context.storageState()`, inject via `browser.newContext({ storageState })`.
REJECTED for P3: no storageState code exists anywhere in the repo, the worker
closes its context unconditionally with no export hook (worker.ts:294-301),
the run-worker and test-writer are separate containers so only *serialized*
session material could cross — and serialized session material at rest is a
new secret class, violating decision 2.1. In-process execution keeps the
session where it was born and dies: one context, one process, one job.

### 4.2 Execution environment during login

- **Dialog policy**: the run-worker ACCEPTS dialogs; the crawler DISMISSES
  them (crawler.ts:93 vs worker.ts:249-251). During login-step execution the
  page temporarily uses the worker's accept policy — the login case was proven
  under it, and a confirm-dialog login flow must not pass in the worker and
  fail in recon. The crawler's dismiss handler is registered only after
  session verification succeeds. **Narrowed** (the exemption is a hole in
  §5.2's "the crawler never confirms anything", carved into the least-observed
  part of the job — no screenshots are taken then, by design): accept applies
  only for the duration of a single step's execution and only when that step's
  action can legitimately raise a dialog (`click`, `press_key`), reverting to
  dismiss between steps. Post-login landing pages that prompt ("Resume your
  draft?", "Discard unsaved changes?") therefore cannot be auto-confirmed by a
  window left open across the whole recipe. auth-session logs `dialog.type()`
  only — never `dialog.message()`, which is behind-login text.
- **Popups stay auto-closed** (context-level, crawler.ts:90-92) — which is why
  OAuth/SSO popup logins are out of scope (§13), stated rather than
  discovered.
- **No screenshots during login execution.** The crawler's per-page screenshot
  starts with the first BFS page, after verification. Never a frame of a
  credential being typed.
- **No step values in logs.** auth-session's own logging records action +
  target only — never `step.value` (see §12.2 for the worker-side analog).
- **Rate limiting**: the login navigation respects the same ≥1s pacing as
  crawl navigations. **robots.txt does NOT gate login execution** — executing
  the customer's own scripted flow is a test run, not crawling; the BFS itself
  honors robots for every crawled page exactly as in P1.
- **Challenge gate**: `challengeDetector.detect(page)` runs after the login
  case's initial navigation and again after its final step. A detection ends
  the job `blocked` with the new reason `login_challenge` — distinct from the
  per-page `challenge` block so the UI can say what actually happened ("your
  sign-in flow is protected by a bot check; Kaizen never bypasses these").

### 4.3 Session verification

Two independent signals, because the login case's own assertion (if any)
proves what its author chose to assert, not necessarily that a session exists:

1. **The login case's steps all passed**, including its terminal assertion if
   it has one (free — it just executed).
2. **Independent heuristic**, run by auth-session after the final step:
   - The landed page has **no visible password input** (the
     `hasVisiblePasswordInput` capture from `page-capture.ts` — the same
     signal the public crawler already trusts for auth-wall detection), AND
   - the landed URL differs from `loginPageUrl`, **OR** the login case ended
     with a passing terminal assertion.

**`loginPageUrl` — defined for passwordless recipes too.** The obvious
definition ("the URL where the password was typed") is undefined for the
recipe class this spec recommends to every customer and dogfoods against: the
demo sign-in posts an empty body and types nothing
(packages/web/src/app/api/auth/demo/route.ts:26-31). Leaving it undefined
would strand both this heuristic and §5.1's session-loss clause exactly where
they are most likely to be used. Fallback chain, in order:

1. the normalized URL of the page where a `type` step targeted a
   secret-lexicon field (§12.2), if any such step exists;
2. else the normalized **landed** URL after the recipe's first `navigate`
   (post-redirect — `/` redirecting to `/login` yields `/login`, which is the
   useful value);
3. else the login case's `base_url`.

Decision table (rows keyed on the resolved `loginPageUrl`):

| Password input visible | Landed URL ≠ loginPageUrl | Case has terminal assertion | Verdict |
|---|---|---|---|
| yes | — | — | `blocked: login_failed` (still on the form) |
| no | yes | yes | verified — `sessionVerification: 'assertion+heuristic'` |
| no | yes | no | verified — `sessionVerification: 'heuristic'` |
| no | no (SPA swapped content in place) | yes (passed) | verified — `'assertion+heuristic'` |
| no | no | no | `blocked: login_failed` — message: "your login test never leaves the sign-in URL and has no final assertion; add an assertion that proves you're signed in (e.g. verify the dashboard is visible) so Kaizen can confirm the session" |

The credential-free button recipe lands in row 2 or 4 depending on whether the
app redirects — both verified, neither depending on a password ever existing.

**Recorded decision**: a login case with no terminal assertion is accepted
(the heuristic covers the common redirect-style login), but the SPA corner
where neither signal exists fails *closed* with an actionable message rather
than crawling on hope. A false "verified" would burn the whole crawl budget
producing a public crawl mislabeled authenticated — the one outcome worse
than a blocked job.

**Known limitation (accepted, named)**: an MFA one-time-code interstitial can
defeat the heuristic (URL changed, no password input → false verify). The
crawl then immediately trips session-loss on its first navigation, re-logs-in
once, fails again, and ends early with an honest report (§5.1) — degraded but
safe. Reliable MFA detection is out of scope (§13); the consent copy
recommends a non-MFA test account.

`loginPageUrl` and the landed URL are recorded in memory for the crawl
(§5.1); the landed URL becomes the BFS seed alongside `targetUrl` if they
differ (visiting both costs one page of budget and loses nothing).

## 5. The authenticated crawl

The BFS itself is unchanged: same single context/page, same budgets
(`CrawlBudgets` defaults: 30 pages hard-cap 50, depth 5, 8 probes/page,
30s/page, 20min/job, ≥1s between navigations), same robots handling, same
challenge gate per page, same incremental `PageSink` persistence. What changes
is detection, safety posture, and marking.

### 5.1 Session-loss detection and re-login policy

The public crawler's auth-wall predicate (crawler.ts:142 — `landed !== url &&
meta.hasVisiblePasswordInput`) is, unchanged, the mid-crawl session-loss
detector: it fires on any redirect-to-login, per navigation, with no new
instrumentation. In authenticated mode it is extended with one clause: a
navigation that lands on the recorded `loginPageUrl` is also a loss, password
input detected or not (some apps render the login form lazily).

Policy (per recon spec §5, elaborated):

- **First loss**: re-execute the login recipe **once** (full §4 flow including
  verification), then re-`goto` the URL that tripped the detector and
  continue. `report.auth.reloginCount` increments.
- **Second loss (or re-login failure)**: stop the crawl. Everything captured
  so far is kept — the sink already persisted it page-by-page — and the
  pipeline **continues into COMPREHEND/PLAN/WRITE with the partial model**,
  with `report.auth.endedEarly: 'session_lost'`. Partial knowledge of the
  signed-in app is still knowledge; the report says honestly how far it got.
- **Loss before any page was captured**: indistinguishable from a login that
  never worked — job ends `blocked: login_failed`.

**Sign-in budget — stated, capped, and paced.** The design's sign-in count is
not one; it is one crawl login + up to one re-login + **one per proving run**
(§7), and `ValidationRunner` runs two at a time
(validate/validation-runner.ts:24). A 6-scenario authenticated job therefore
signs into the customer's app roughly 8 times in ~20 minutes, twice
concurrently with identical credentials. Against a real system that is the
shape that trips rate limiting, fraud/anomaly detection and account lockout —
locking the customer out of the very account they consented with, and then
cascading into `login_failed` drafts that look like "the generated test
failed". Three rules:

1. **Authenticated jobs force validation concurrency to 1** (overriding the
   default 2). Sequential proving runs cost wall-clock, not correctness.
2. **Per-job sign-in cap** (default 12, `report.auth.signInCount`). Exceeding
   it ends the job `blocked: login_budget_exhausted` rather than continuing to
   hammer the app.
3. **Minimum interval between sign-ins** mirroring the crawl's ≥1s pacing.

And a classification rule: a proving run that fails **on a prefix step** is
not evidence about the generated test. Such drafts are recorded
`draft (unvalidated)` with reason `sign-in unavailable`, never `rejected` —
misattributing an app-side lockout to the scenario would teach the customer to
distrust correct tests. §11's consent copy states the expected number of
sign-ins, because an admin approving this deserves to know it is ~N and not
one.

### 5.2 Auth-specific safety posture

**Blast-radius framing**: a public crawler that misbehaves annoys a marketing
site. An authenticated crawler **acts as a real signed-in user** — every probe
touches an account that may own data, billing, and other humans' work. The
posture is therefore strictly MORE conservative than public scope, on top of
an envelope that already never submits forms, never accepts dialogs, and
resolves every ambiguous element down to `mutating` (safety.ts:115).

Three additions, all in code, all hard gates:

1. **Session-ending stays absolute — and learns to read hrefs.** The
   classifier already checks the `session-ending` lexicon (logout / log out /
   sign out / signout / log off / logoff / end session) FIRST, before
   everything (safety.ts:66). But it matches **accessible names only** — and
   the classic real-world logout is an icon button with an empty name and
   `href="/logout"`, which today classifies as `navigation` and would be
   *followed via the BFS queue*, killing the session by GET. That queue is the
   actual suicide vector, not the click path.

   P3 adds URL-based suppression in TWO places: in `classifyInteraction` (an
   href whose URL matches → `session-ending`) and at frontier-enqueue time in
   the crawler (a matching URL is never enqueued, in any scope — a public-scope
   GET /logout is harmless only by luck).

   **Matching is token-normalized, not a literal path list.** A list like
   `['/logout', '/sign-out', …]` misses the most common real-world logout URLs:
   Devise/Rails defaults to `/users/sign_out` (underscore), Django admin uses
   `/admin/logout/` (nested + trailing slash), and a large class of apps put it
   in the query string (`?action=logout`, `?do=logout`, `/index.php?logout=1`)
   where a path-only rule never looks. Every miss ends the session by GET,
   burns the crawl, and consumes the one permitted re-login. The rule instead:
   lowercase the **path AND query**, strip `[-_/.]` and file extensions, then
   test for membership of `{logout, logoff, signout, endsession,
   destroysession, deauth}`. The same normalization applies to the
   accessible-name lexicon so `Sign_Out` and `sign out` collapse together.

   Every suppressed element and URL joins the per-job blocklist, reported as
   `report.auth.sessionEndingBlocked` (count + first few paths) — the audit
   trail that proves the crawler saw logout and refused.
2. **Sensitive areas — two tiers, because for some of them reading IS the
   exposure.** The tempting rule ("capture as normal, just don't probe") is
   wrong for the most sensitive half of the lexicon. On a signed-in account,
   `/api-keys`, `/tokens` and `/billing` *render live secrets and PII*, and
   normal capture means: accessible names and text into `survey` → persisted
   as `page_elements`; headings + element names into `ax_outline`; a full-page
   screenshot uploaded; and the outline then **sent to the LLM provider** for
   per-page classification and App Brief synthesis (crawler.ts:152-198,
   site-model.repository.ts:82-110). A rule that congratulates itself for not
   clicking, while shipping the tenant's live API keys to a prompt and a PNG,
   fails the first question of any enterprise security review. The product
   already owns the right primitive — `scrubSecrets` (brief-intake.ts:17-49)
   — and applies it only to the Init Brief; P3 extends it to crawled content.

   **Tier A — capture suppressed** (`/api-keys`, `/api_keys`, `/tokens`,
   `/secrets`, `/credentials`, `/billing`, `/payment`, `/invoices`,
   `/subscription`): record URL + title only. No survey, no forms, no
   screenshot, no `ax_outline`, **no classification call**. The page is stored
   as a stub with `blocked: 'capture-suppressed'` (a new value alongside
   `challenge`/`robots`) so the site model is honest about the gap rather than
   silently missing pages, and the report surfaces it — the user sees "3 pages
   skipped to avoid capturing secrets", which is a feature, not an apology.
   Links are still read for frontier expansion (a URL is not a secret).

   **Tier B — scrubbed passive capture** (`/settings`, `/admin`, `/account`,
   `/profile`, `/organization`, `/members`, `/team`, `/users`, `/danger`):
   captured but **never probed** (`probesPerPage = 0` for the page), and
   `scrubSecrets` plus an email / phone / long-digit-sequence redactor runs
   over titles, headings, element names, and form placeholders **before
   persistence and before any prompt**. Screenshots for Tier B pages are off
   by default under authenticated scope (they are the most PII-dense artifact
   in the system), re-enabled only by the P6 per-suite screenshot control.

   Both tiers are page-level decisions in the crawler where `safeReveals` is
   filtered (crawler.ts:157), not per-element in the classifier — one
   auditable decision per page, counted in `report.auth.probesSuppressed` and
   `report.auth.captureSuppressed`. Over-suppression costs revealed states and
   some coverage; under-suppression costs a customer's secrets. Both tiers are
   active in authenticated scope only (public-scope settings pages are behind
   auth walls by construction). Rationale for not probing Tier B at all: on a
   settings page a misclassified toggle IS the user's configuration.
3. **Everything else already holds**: forms read never submitted, checkboxes/
   switches/radios always `mutating` (safety.ts:100-102), probes restore
   state deterministically (probe.ts Escape → goBack → goto), downloads
   aborted, dialogs dismissed (post-login), external origins recorded never
   followed. Probe budget stays 8 — the probes that survive classification
   plus rule 2 are reveal-class by construction, and starving discovery
   behind auth would defeat the point of the phase.

### 5.3 `requires_auth` marking

Every page captured while authenticated **carries `requiresAuth: true` on the
capture** — the P1 code hardcodes `false` on regular captures
(crawler.ts:193), so this is an explicit crawler change, not a default.

But the upsert must not vandalize public knowledge:
`SiteModelRepository.upsertPage` overwrites `requires_auth` with the incoming
value on conflict, and an authenticated re-crawl visits genuinely public pages
(home, pricing) through the same BFS. **Recorded decision — the upsert becomes
mode-dependent**:

- **Public-scope jobs**: unchanged — the fresh public observation is
  authoritative (`requires_auth = EXCLUDED.requires_auth`; a formerly-walled
  page now public flips to false, a newly-walled page flips to true).
- **Authenticated-scope jobs**: preserve a prior `false`; default new rows to
  `true` (`requires_auth = site_pages.requires_auth AND
  EXCLUDED.requires_auth`).

**Correction — `EXCLUDED.requires_auth` is not always true.** The AND formula
above reads as "keeps existing verdicts, inserts true" only while every
authenticated capture carries `true`. Blocked captures do not:
`blockedCapture()` hardcodes `requiresAuth: false` (crawler.ts:221-235) and is
returned before any auth marking could apply. So a page previously and
correctly marked `requires_auth = true` that later hits a bot challenge or a
robots disallow during an authenticated re-crawl would flip **true → false** —
mislabeling a private page as public, the exact failure this section declares
unacceptable. Rule: in authenticated scope, **blocked captures do not
participate in `requires_auth` updating at all** (the column is omitted from
the upsert for rows where `blocked !== null`). A page nobody could read is
evidence about the crawl, not about the page's privacy.

Cost/accuracy trade-off, recorded: pages that ARE public but were never
publicly crawled get over-marked `true`. That errs in the only acceptable
direction — a private page is never mislabeled public (which would leak it
into public-scope plans, a confidentiality failure); a public page mislabeled
private merely narrows public-scope planning. The precise partition is
available cheaply to any tenant who runs a public analyze first, and the job
report suggests exactly that when no prior public crawl exists. Alternatives
considered: an unauthenticated probe pass re-requesting each discovered URL
without cookies (accurate, but doubles navigation count against the rate
limit and budget) — DEFERRED; crawling public-then-authenticated in one job —
REJECTED for v1 (doubles wall clock inside one 20-minute envelope).

### 5.4 Mixed-capture semantics

Pages that render differently signed-in vs signed-out share one
`(tenant, suite, url_normalized)` row; an authenticated crawl **overwrites**
the public capture with the signed-in variant. Accepted for v1: the signed-in
view is the richer one, it is what authenticated tests must ground against,
and MAINTAIN's `content_hash` diffing (P5) is the designed place to reason
about drift. One site model per suite, describing the app as the most
privileged consented crawl saw it. `CrawlReport.authScope` becomes dynamic
(today hardcoded `'public'`, crawler.ts:63).

## 6. Generation with authenticated knowledge

### 6.1 What the session buys each phase

- **COMPREHEND**: page classification and the App Brief now see the actual
  product. Journey synthesis can finally emit the system flows —
  `Journey.requiresAuth` (comprehension spec, App Brief type) stops being a
  guess derived from auth-wall stubs and starts being observed structure. No
  contract changes; the same prompts simply receive real pages. (Amendment:
  the classifier's purpose vocabulary gains signed-in examples — "dashboard",
  "settings", "admin console" — §15.)
- **PLAN**: the existing rule inverts from a filter into capability —
  scenarios touching `requires_auth` pages are plannable because the job has
  scope + consent (`PlanInput.scope` already exists). **New rule, recorded**:
  in authenticated jobs, archetypes whose premise is being **signed out** are
  not planned — the login prefix (§6.2) makes them structurally unpassable.

  **Exclude by precondition, not by name prefix.** A name-family rule
  (`auth.login.*`, `auth.signup.*`) misses three real catalog entries whose
  oracles assert the anonymous experience: `permissions.
  protected-page-requires-login` ("url contains the login path" after
  navigating to a protected page — kind `negative`, priority `critical`, and
  called out in catalog-v1 as the exemplar class),
  `permissions.negative.direct-admin-url` (same oracle), and
  `auth.password-reset.request` (a signed-in user is typically redirected away
  from the forgot-password page) — catalog.ts:85-116. Under a universal login
  prefix each of those would be planned, written, consume a validation run,
  and be rejected red: wasted browser-minutes plus a confusing rejection for
  precisely the archetype class P3 should showcase. P3 therefore adds a
  `requiresSignedOut: true` attribute to `ScenarioArchetype`, tags those five
  entries (`auth.login.*`, `auth.signup.*`, both `permissions.*` redirect
  archetypes, `auth.password-reset.request`), and PLAN drops any tagged
  archetype in authenticated jobs — reporting them as **"covered by public
  scope"** rather than dropping silently, since a public analyze of the same
  suite is exactly where they belong.
- **WRITE**: grounded as ever in `page_elements`, which now include
  behind-auth elements — but the graduated write-safety filter does **not**
  apply as-is. It was calibrated for anonymous/throwaway scope, and under
  authenticated scope the same filter governs an actor with real blast radius:
  the proving run executes as a real, possibly admin, user. Three changes
  (§6.5), because the filter as written would allow "click the 'Revoke'
  button" on an API-keys page.

### 6.2 The login prefix (draft creation)

**Recorded decision — every scenario in an authenticated job is prepended
with the login recipe.** Not just scenarios touching `requires_auth` pages:
the entire site model now describes the signed-in app, so any generated test
must run signed-in to ground against what was observed. The cost is ~zero
(§6.3); the alternative — per-scenario prefix decisions keyed on
`requires_auth` — buys nothing but a new way to be wrong on over-marked pages
(§5.3).

Mechanics, at draft-creation time (`validate/`, via `createCase`):

- The login case's active steps are **copied** into the draft, before the
  generated body: `raw_text` verbatim; `compiled_ast` copied where stored,
  else compiled once via `LearnedCompiler` (content-hash cache → the same
  sentence compiled for the crawl's own login in §4.1 is already cached).
- The **≤10-step cap applies to the generated body**; the prefix rides on
  top. The schema gate, lints, judge, and dedup all operate on the **body
  only** — dedup especially, or every authenticated draft would collide on
  its shared prefix.
- Provenance: the draft's `generation_job_id` → `generation_jobs.
  login_case_id`. No new column on `test_cases`.

### 6.3 Why the prefix is ~free

The prefix is free because its ASTs travel **with the draft** — copied into
`test_steps.compiled_ast` at creation, and preferred over recompilation by the
run-trigger path (the P2 mechanism, generation spec §3) — and because
`selector_cache` is keyed tenant+domain+targetHash and is warm from the login
case's own runs. The proving run replays login through stored ASTs and cached
selectors; assertions re-resolve fresh by design (assertion resolver has
`cacheWrites: false`), so a "verify signed in" oracle can never false-pass off
a stale cache.

**Explicitly NOT via `compiled_ast_cache`.** An earlier draft of this section
justified the global cache on authorship grounds ("the customer's own
sentences moving within their tenant"). That reasoning is wrong, and the
question is not who wrote the sentence but which table the secret lands in:
`compiled_ast_cache` is keyed on `content_hash` alone, has no `tenant_id`, no
RLS, and its `ast_json` stores `value` — the literal typed string
(learned.compiler.ts:143-156, 002_seed_compiled_ast_cache.sql:23-27). A login
recipe containing `type "Hunter2!" into the password field` that misses the
cache writes that password into a cross-tenant table, permanently, outside any
offboarding purge. See §12.3 for the fix; the prefix's economics do not depend
on that cache and never needed to.

### 6.4 Staleness — named and deferred

Copy-on-create means **edits to the source login case do not propagate to
existing drafts or approved tests**. When the customer's login flow changes,
every authenticated generated test carries a fossilized prefix. This is the
`login-case-changed ⇒ dependent-tests-stale` problem; it is real, it is
accepted for P3, and it is **deferred to MAINTAIN (P5)** with a pointer:
re-crawl diffing should flag cases whose `generation_job_id` links to a
`login_case_id` whose active step-set hash changed since draft creation. A
by-reference prefix (join login steps at run-enqueue) was considered and
rejected for v1: it makes drafts non-self-contained, threads Test Writer
state into the run-trigger path, and breaks "a test is just steps".

### 6.5 Write-safety under authenticated scope

The recon hardening in §5.2 protects the *crawler*, which only ever reads. The
actor with real blast radius is the **proving run**: it executes generated
steps as a signed-in, possibly admin, user. The P2 filter
(write/write-safety.ts) was calibrated for anonymous scope and has two gaps
that only appear behind auth:

1. **`HARD_BLOCK` is too narrow for a real account.** It contains `delete` and
   `remove account`, but not bare `remove`, `revoke`, `disable`, `reset`,
   `rotate`, `invite`, `archive`, `leave`, or `transfer ownership`
   (write-safety.ts:23-28). So a step grounded on `/members` — *click the
   "Remove" button* next to a teammate — or on `/api-keys` — *click "Revoke"* —
   classifies `allowed`, not even consent-gated, and is then executed for real
   (validation-runner.ts:118-134). P3 adds an **authenticated-scope extension**
   to the lexicon (`remove`, `revoke`, `disable`, `reset`, `rotate`, `invite`,
   `archive`, `leave`, `change password`, `change email`, `transfer
   ownership`), applied whenever the job scope is authenticated. Public scope
   keeps today's list — a throwaway signup flow should still be able to say
   "remove from cart".
2. **`SYNTHETIC` silently changes meaning.** It is defined as "creates
   throwaway records with per-run unique seed data" and contains `submit`,
   `save`, `apply`, `send` (write-safety.ts:31-35). Behind auth those verbs
   *overwrite the signed-in account's real settings* — the per-suite
   `allow_synthetic_data` flag would then be authorizing something the tenant
   never agreed to, since its consent copy promises disposable records. For
   v1, the conservative cut: **in authenticated jobs, SYNTHETIC-matched
   scenarios are written but held as unvalidated drafts** regardless of the
   synthetic flag, with the existing `consent`-stage rejection entry
   explaining why. Raising them to validated requires a distinct grant, which
   §7's matrix does not currently offer and P3 does not invent.

Plus a grounding rule, which is the cheapest of the three because it removes
the possibility rather than filtering it: **in authenticated jobs, pages
matching the §5.2 sensitive lexicon (both tiers) are excluded from PLAN's
target pages and from `getGroundingElements`** (pipeline.ts:268-289). Nothing
can be written against elements that are never handed to WRITE. Tier A pages
have no elements to hand over anyway; Tier B pages are readable knowledge for
COMPREHEND but not writable targets for tests.

## 7. VALIDATE — unchanged, deliberately

Drafts are **self-contained** (login prefix included) and run through the
normal worker on the `kaizen-runs` queue exactly as P2 built it
(`triggered_by='testwriter'`, seed variables, 2s poll, 5-min timeout, selector
pre-seeding for body steps). **No session sharing between pipeline phases**:
the crawl's session dies with the crawl context; each proving run signs in
itself. This costs one login replay per run — cached end-to-end per §6.3, a
few seconds of browser time — and buys architectural isolation: no session
material ever crosses a process boundary, and a draft that passes validation
is proven to work from a cold browser, which is exactly the claim "proven"
must make.

Two deliberate qualifications to "unchanged", both from §5.1 and §4.1:
**concurrency drops to 1** for authenticated jobs (concurrent sign-ins with
one credential is a lockout pattern), and the worker is **not** untouched — it
gains the `behindAuth` payload flag that suppresses shared-pool contribution
and archetype learning. That is a small, well-fenced worker change and it is
the price of the isolation invariant; the alternative (leaking a customer's
private selectors to every tenant on the domain) is not a trade.

The 5-minute run timeout absorbs the prefix comfortably (login ≈ 3–6 steps).

**Consent matrix** — auth consent and synthetic-data consent are separate
axes and never merge:

| `auth_consent` (per job) | `allow_synthetic_data` (per suite) | Behavior |
|---|---|---|
| off | off | P2 status quo: public crawl; `requires_auth` scenarios dropped + reported; record-creating scenarios written but unvalidated |
| off | on | public crawl; synthetic scenarios validated (P2) |
| on | off | signed-in crawl + generation; record-creating scenarios written but **validation-blocked** (`draft (unvalidated)` + `consent` rejection entry, exactly as P2) |
| on | on | signed-in crawl + generation; **record-creating scenarios still held unvalidated** — see below |

Auth consent answers "may Kaizen sign in and explore as this user"; synthetic
consent answers "may proving runs create throwaway records". The bottom-right
cell is deliberately not "full validation": per §6.5, the verbs that
`allow_synthetic_data` authorizes (`submit`, `save`, `apply`) mean *disposable
record* when anonymous and *overwrite this user's live configuration* when
signed in. The suite flag was consented to under the first meaning, so P3 does
not silently reinterpret it. Lifting this needs an explicit third grant
("proving runs may save changes as the signed-in user"), which is named here
and deferred to P3.5 rather than smuggled in.

## 8. Consent, audit & access control

### 8.1 Consent shape — per job, re-asserted every analyze

**Recorded decision**: auth consent stays strictly per-job (unlike the
per-suite `allow_synthetic_data`). Signing into a customer's system is the
largest grant in the product; a standing flag would let one long-ago click
authorize indefinite future exploration. Re-asserting per analyze keeps the
audit trail one-row-one-grant and the UX honest. (A per-suite "remember my
login case" that only pre-fills the picker — without pre-granting consent —
is a UX nicety left to the web layer.)

### 8.2 Audit columns (migration 034)

Migration 028's header promised an "audit trail for scope + auth consent" but
shipped only the boolean. P3 completes it:

```sql
-- 034_authenticated_scope.sql
ALTER TABLE generation_jobs
  ADD COLUMN auth_consented_by UUID REFERENCES users(id),
  ADD COLUMN auth_consented_at TIMESTAMPTZ;

-- Consent attributed to nobody is not consent. Replaces the 028 constraint.
ALTER TABLE generation_jobs DROP CONSTRAINT generation_jobs_auth_consent;
ALTER TABLE generation_jobs ADD CONSTRAINT generation_jobs_auth_consent CHECK (
  scope = 'public' OR (
    auth_consent AND login_case_id IS NOT NULL
    AND auth_consented_by IS NOT NULL AND auth_consented_at IS NOT NULL
  )
);
```

Stamped by the analyze route from the authenticated request's user when
`scope='authenticated'`; NULL on public jobs. Adding the columns as plain
nullables would leave the database willing to store an authenticated job whose
largest grant is attributed to no one — so the CHECK is widened in the same
migration, making the audit trail a schema guarantee rather than a convention.
(034 is the next free number. I keep 032 (`032_test_writer_p2.sql`); the B9
branch renumbered its frame_url migration to 033 to clear our collision, and
B11 also starts at 034 — per the 2026-08-07 cross-notes in COORDINATION.md,
coordinate before claiming it. The historical duplicate 028 pair is a known
branch collision the runner tolerates.)

### 8.3 Role gating — admin or owner

**Recorded decision** (closes the follow-up flagged in the master plan's P2
security-posture section, recorded into umbrella §13.4 via §15):
`scope='authenticated'` requires membership role **admin or owner**. The
machinery exists — `requireRole` (src/api/middleware/auth.ts:177-190) ranks
viewer < member < admin < owner from the JWT claim — but it is route-level and
the analyze route serves both scopes, so the check is **inline**. Rationale:
consenting to Kaizen acting as a signed-in user on the tenant's systems is an
administrative grant, the same class as member management; members can still
run public analyzes and approve plans. The UI mirrors the gate (§11).

Two implementation rules, because the obvious version of this check is weaker
than it reads:

1. **Write it fail-closed, not as a rank comparison.** `requireRole`'s
   `order[request.role] < order[minimum]` evaluates to `false` when
   `request.role` is `undefined` — `undefined < 2` is false — so the guard
   passes. `request.role` is always set on the JWT path the analyze route uses
   today (auth.ts:119-122), but the sibling runs routes have already moved to
   `requireTenant` (runs.ts:204,290), under which an API key authenticates
   with a `tenantId` and **no role at all**. A future migration of this route
   would silently open the gate. The check is therefore written positively:
   `if (request.role !== 'admin' && request.role !== 'owner') → 403
   AUTH_SCOPE_REQUIRES_ADMIN`.
2. **Impersonation may not grant it.** Platform-admin impersonation tokens
   carry the target user's `tenantId` and `role`, and `requireAuth` sets
   `request.userId` to the impersonated user while flagging
   `request.isImpersonation` (auth.ts:119-122). Without a check, a Kaizen
   employee in a support session could enable signed-in exploration of a
   customer's system, and the audit row would attribute the product's largest
   grant to a customer employee who never clicked it — an audit trail that
   actively lies. `scope='authenticated'` with `request.isImpersonation` →
   403 `AUTH_SCOPE_NOT_VIA_IMPERSONATION`. (If the founder later wants support
   staff to be able to do this, the correct shape is a separate
   `auth_consented_by_platform_admin` column rendered visibly in the UI — not
   a silent pass.)

## 9. Failure modes

| Failure | When | Job outcome | User-facing message (honest, actionable) |
|---|---|---|---|
| Login case missing / other tenant | API | 400 `LOGIN_CASE_NOT_FOUND` | "That sign-in test wasn't found." |
| Login case not `active` | API | 400 `LOGIN_CASE_NOT_ACTIVE` | "The sign-in test must be an approved, active test — this one is a draft/archived." |
| Origin mismatch | API | 400 `LOGIN_CASE_ORIGIN_MISMATCH` | "The sign-in test runs against a different site than the one you're analyzing." |
| Seed-token collision | API | 400 `LOGIN_CASE_USES_SEED_TOKENS` | "This sign-in test uses {{email}}/{{password}} placeholders — Kaizen fills those with random data on proving runs. Use a test with fixed credentials or a sign-in button." |
| Recipe navigates off-origin or to a private/loopback address | API / auth-session | 400 `LOGIN_CASE_NAVIGATES_OFF_ORIGIN` / `blocked: login_failed` | "That sign-in test navigates to <url>, which isn't part of the site being analyzed." |
| Missing consent / login case | API + DB CHECK + pipeline row check | 400 `AUTH_CONSENT_REQUIRED` (pipeline: `blocked`) | "Signed-in analysis needs a sign-in test and your explicit consent." |
| Payload claims authenticated but the job row does not | pipeline | `blocked`, reason `consent_mismatch` + security counter | "This analysis was stopped because its recorded permissions didn't match what was requested." |
| Insufficient role | API | 403 `AUTH_SCOPE_REQUIRES_ADMIN` | "Signed-in exploration can only be enabled by a workspace admin or owner." |
| Impersonated session | API | 403 `AUTH_SCOPE_NOT_VIA_IMPERSONATION` | "Signed-in exploration can't be enabled from a support session." |
| Sign-in budget exhausted | crawl / validate | `blocked`, reason `login_budget_exhausted` | "Kaizen stopped after N sign-ins to avoid tripping your app's rate limits." |
| Proving run fails on a prefix step | validate | draft kept as `draft (unvalidated)`, reason `sign-in unavailable` | "Couldn't prove this test — signing in failed during validation, so the test itself is unproven rather than wrong." |
| Login step fails | auth-session | `blocked`, reason `login_failed` | "Couldn't sign in — step N of '<case name>' failed: <step text>. Fix or re-run that test, then try again." |
| Challenge during login | auth-session | `blocked`, reason `login_challenge` | "Your sign-in flow is protected by a bot check (CAPTCHA/MFA). Kaizen never bypasses these — use a test account without them." |
| Verification fails (form still visible / SPA no-assertion) | auth-session | `blocked`, reason `login_failed` | Per §4.3, including the add-an-assertion guidance |
| Session lost once mid-crawl | crawl | continue; `reloginCount: 1` | Report line only |
| Session lost twice / re-login fails | crawl | crawl ends early; **pipeline continues** on partial model; `report.auth.endedEarly: 'session_lost'` | "The session expired during exploration and couldn't be restored; Kaizen worked with the N pages it saw." |
| Session lost before first capture | crawl | `blocked`, reason `login_failed` | As login-failure |

`blocked` remains the status for all of these (never `failed` — the pipeline
did nothing wrong; the environment declined), consistent with the existing
challenge/robots/zero-pages semantics.

## 10. Contract deltas

### 10.1 Code gates removed

- `src/api/routes/test-writer.ts:74-79` — delete `AUTH_SCOPE_NOT_SUPPORTED`;
  add §3.1 eligibility gates, §8.3 role + impersonation checks, §8.2 consent
  stamping.
- `src/modules/test-writer/pipeline.ts:56-73` — replace the hard block with a
  **row-authoritative** consent check.

**Recorded decision — the job row is the trust boundary, not the payload.**
The natural way to write this gate is "payload says authenticated, so verify
`payload.authConsent === true` and `payload.loginCaseId` is set" — which
validates the payload against itself and proves nothing. The DB CHECK
constrains the `generation_jobs` **row**; the BullMQ payload is unconstrained,
and the pipeline's existing SELECT (pipeline.ts:56-60) fetches `status,
target_url, suite_id, options, test_plan, plan_notes, report` — none of the
auth columns. Anything that can enqueue (Redis access, a bug in the
`resumeFromPlan` path, a future internal caller) could therefore send
`{scope:'authenticated', authConsent:true, loginCaseId:<any active case>}`
against a row recorded as `scope='public'`, and the pipeline would sign in and
crawl a customer's system with no recorded consent, no consenting user, and no
role check — the exact scenario §12 threat 6 claims four layers prevent.

So: extend the SELECT to include `scope, auth_consent, login_case_id,
auth_consented_by`, and require **`row.scope === 'authenticated' &&
row.auth_consent && row.login_case_id && row.auth_consented_by`** before any
auth path runs. The recipe is loaded from `row.login_case_id`, never
`payload.loginCaseId`. A payload/row disagreement ends the job `blocked:
consent_mismatch` and increments a security counter — it means something is
wrong upstream, and it should be loud. The same row check guards the
plan-approval resume path, which re-enters the pipeline with its own payload.

### 10.2 Crawler contract

```ts
// CrawlParams (crawler.ts) gains:
auth?: {
  loginCaseId: string;
  // loaded by the pipeline, executed by auth-session:
  steps: Array<{ rawText: string; ast: StepAST }>;
};

// CrawlReport: authScope becomes dynamic; new auth block mirrored into report.auth.
```

`TestWriterJobPayload` and the queue contract are **unchanged** — everything
needed already rides in it.

### 10.3 Report shape (`generation_jobs.report` — JSONB, no migration)

```jsonc
"recon": { /* unchanged */ "authScope": "authenticated" },
"auth": {
  "sessionVerification": "assertion+heuristic",   // | "heuristic" | null
  "loginSteps": { "total": 4, "passed": 4 },
  "reloginCount": 0,
  "signInCount": 8,               // crawl + re-logins + one per proving run (§5.1)
  "pagesBehindAuth": 17,          // captures persisted with requiresAuth: true
  "probesSuppressed": 12,         // Tier B passive rule (§5.2)
  "captureSuppressed": 3,         // Tier A pages recorded as URL + title only
  "sessionEndingBlocked": 3,      // blocklist hits (elements + URLs)
  "endedEarly": null,             // | "session_lost"
  "blockedReason": null           // | "login_failed" | "login_challenge"
                                  // | "login_budget_exhausted" | "consent_mismatch"
}
```

Mirrored in the server types and `packages/web/src/types/api.ts`
(`GenerationReport.auth`; `GenerationJob.scope` already exists). No new
`ScenarioRejection.stage` is needed — but note the mechanism, because the
obvious assumption is wrong: PLAN-time auth drops are **not** `consent`-stage
rejections. They are recorded in `report.plan.dropped` as `{name, reason}`
with no `stage` field at all (plan/test-planner.ts:79-82,
pipeline.ts:135-140); the `consent` stage is produced only by VALIDATE for
synthetic-data blocks (validation-runner.ts:103-109). Authenticated jobs reuse
`report.plan.dropped` for the `requiresSignedOut` exclusions (§6.1) with
reason "covered by public scope".

### 10.4 New module

`src/modules/test-writer/recon/auth-session.ts` — exactly the file the
service layout reserved since P0 (umbrella §3). The isolation guard is
replaced by a behavioural test per §4.1, not merely extended.

### 10.5 Changes outside the Test Writer module

P3 is the first phase that must reach outside `src/modules/test-writer/`.
Each of these is small, fenced, and independently justified; listing them
here so the implementer meets none of them by surprise:

| Where | Change | Why |
|---|---|---|
| `src/queue/index.ts` | `RunJobPayload` gains `behindAuth?: boolean` | carries the isolation flag to the worker (§4.1) |
| `src/workers/worker.ts:781-787` + resolver construction | suppress `sharedPool.contribute` and `archetypeResolver.learn` when `behindAuth` | shared-pool prohibition (§4.1) |
| `src/workers/worker.ts:465-468` | secret redaction in resolve-log `data.value` **and** `message` | §12.2 |
| `src/modules/test-compiler/learned.compiler.ts` | billing-tenant parameter (default `system_global`); `persist: false` mode | §4.1, §12.3 |
| `src/modules/llm-gateway/openai.gateway.ts:202,291` | omit `Full step:` raw text for secret steps | §12.2 |
| `src/modules/test-writer/plan/catalog.ts` | `requiresSignedOut` attribute on 5 archetypes | §6.1 |
| `src/modules/test-writer/write/write-safety.ts` | authenticated-scope `HARD_BLOCK` extension | §6.5 |
| `src/modules/test-writer/validate/validation-runner.ts:24` | concurrency 1 under authenticated scope | §5.1 |
| `src/api/routes/test-cases.ts` | tenant-wide `GET /cases?status=active` | §11 picker — see below |

**The picker needs an endpoint that does not exist.** §11 specifies a
tenant-wide login-test picker, but the only case listing today is per-suite
(`GET /suites/:suiteId/cases`, test-cases.ts:235). Rather than have the web
client fan out across every suite, P3 adds a narrow tenant-wide read
returning `{id, name, suiteId, suiteName, baseUrl, status}` — enough for
grouping and origin filtering, no steps, no stats.

## 11. Consent UX (analyze sheet + report)

Follows `spec-testwriter-ux.md` (supersedes draft-review-ux §2.1's dialog).
The disabled "Signed-in exploration — soon" row
(writer-analyze-sheet.tsx:226-229) is removed; in its place, a second card in
the **main form**, directly beneath "What Kaizen may do on your site" — the
two consent grants live together, and burying the larger grant in Advanced
would misrepresent its weight:

- **"Signed-in exploration"** card: a Switch; when on, it reveals
  - a **login-test picker**: active cases across the tenant, grouped by
    suite, filtered client-side to the target URL's origin where determinable
    (the API gates authoritatively either way);
  - **an empty state that is not a dead end.** The eligibility rules (§3.1)
    require an *active* same-origin login case — and the tenant most likely to
    flip this switch for the first time is precisely the one that has none,
    because a login case must be authored, run, and approved before it
    qualifies. A picker that renders zero options at the flagship upgrade
    moment is the "would a real user get through it" failure. So: *"No
    sign-in test for this site yet"* + a CTA to the new-test screen
    pre-filled with a three-step sign-in template (navigate → click sign in →
    verify a signed-in element is visible) and the credential-free nudge
    inline. The analyze sheet's state is preserved so the user returns to it
    rather than starting over.
  - consent copy, stating plainly: *"Kaizen will run '<case name>' to sign
    in, then explore and read pages as that user — following links, opening
    menus and dialogs, never submitting forms, never signing out, and never
    touching settings or billing actions. It will sign in about N times
    during this analysis (once to explore, once per test it proves).
    Recorded on the job with your name and the time. Use a dedicated test
    account on a staging environment — not a personal or production
    account."* Plus the §3.2 nudge: a sign-in button flow or test account
    keeps passwords out of test text.
  - **and who sees the result**, because the copy otherwise describes only
    what Kaizen does to the customer's system, never what happens to what it
    sees. The admin is consenting on behalf of everyone whose data lives in
    that account: *"Everyone in this workspace — including viewers and API
    keys — will be able to see the screenshots and page content Kaizen
    captured while signed in. Page text and structure are sent to Kaizen's
    LLM provider under a no-training agreement."* Both statements are true
    today (`GET /runs/:id/report` and `/media` sit behind `requireTenant`,
    which admits viewer-role users and `read_only` API keys —
    runs.ts:290,757, auth.ts:136-145). If that audience is judged too wide,
    the alternative is to gate report/media access for runs whose case links
    to a `scope='authenticated'` job at `member`+ — a decision recorded here
    as **open**, with disclosure as the v1 answer.
  - For non-admin members the card renders disabled with "Only a workspace
    admin can enable signed-in exploration."
- The sheet's submit body gains `scope`, `loginCaseId`, `authConsent` (it
  currently sends none of them).
- **Progress face** (screen-writer.tsx ProgressFace detail line): recon phase
  shows "signing in…" until verification, then "signed in · exploring".
- **Blocked face**: `login_failed` / `login_challenge` render the §9 messages
  with a link to the login case.
- **Delivered report face**: the Stat row gains "N pages behind sign-in";
  `endedEarly: 'session_lost'` renders as a warning line, and
  `reloginCount > 0` as a footnote ("session renewed once during
  exploration").
- One additional caveat line whenever a job runs authenticated, because some
  apps invalidate other sessions on new sign-ins: *"Signing in may log the
  same account out elsewhere — another reason for a dedicated test account."*

## 12. Security posture

Priority order per umbrella §13: confidentiality → safe action → injection →
access control.

### 12.1 Threat model

One-to-one mitigations. Threats 1, 3 and 3b were found by adversarial review
of this spec's first draft and describe **existing** code paths — P3 is where
they get closed, not where they were introduced.

| # | Threat | Exposure path | Mitigation |
|---|---|---|---|
| 1 | Credential exposure in telemetry | Three paths, all pre-existing: `run_events.data.value` AND the log message embedding `rawText` (worker.ts:465-468); the global `compiled_ast_cache` storing `value` (§3.2b); the resolver/compile prompts carrying `Full step: <rawText>` to the provider | §12.2 (logs + prompts + screenshots) and §12.3 (global cache); auth-session never logs values (§4.2); consent copy pushes credential-free recipes |
| 2 | Session-material exfiltration | cookies/storageState persisted, logged, or crossing process boundaries | Session lives only in the crawl's in-memory context, closed in `finally`; no storageState code path exists and none is added; nothing session-shaped in `report`, logs, or DB (unit-tested) |
| 3 | Cross-tenant leakage of behind-login knowledge | site model, screenshots, selector caches — **and two live write paths inside reused code**: `sharedPool.contribute` in `LLMElementResolver.persistToCache` (llm.element-resolver.ts:737-748) and `archetypeResolver.learn` in the worker (worker.ts:781-787), neither visible to the current grep-based guard | RLS via `withTenantTransaction` on every write (P1 machinery); shared-pool prohibition enforced by **construction** (no `SharedPoolService` passed) and by the `behindAuth` suppression in the worker (§4.1); behavioural isolation test replaces the grep (§14); behind-login screenshots use tenant-scoped keys and inherit the P6 retention / `no screenshots` controls |
| 3b | **Secret/PII egress from captured content** | A signed-in `/api-keys`, `/billing` or `/members` page renders live secrets and personal data, which normal capture writes into `page_elements` + `ax_outline` + a screenshot, then sends to the LLM provider for classification | §5.2's two-tier rule: Tier A captures URL + title only (no survey, no screenshot, no classification call); Tier B is scrubbed with `scrubSecrets` + email/phone/digit redaction before persistence and before any prompt, screenshots off by default |
| 4 | Prompt injection from authenticated page content | crawled text now includes PRIVATE pages feeding COMPREHEND/PLAN prompts; an injected instruction could try to steer generation toward destructive actions executed by a SIGNED-IN proving run | Same delimit-as-untrusted + ignore-embedded-instructions posture (umbrella §13.3) — and the hard backstops are code, not prompts: the write-phase graduated safety filter and the recon classifier cannot be talked out of their lexicons; the hostile-page fixture suite gains a behind-login variant |
| 5 | Unsafe action as a signed-in user — **by the crawler** | probes/navigation on a live account | §5.2 in full: token-normalized logout suppression with audit counts, two-tier sensitive-path rule, forms never submitted, ambiguity resolves to `mutating`, dialogs dismissed and narrowed during login |
| 5b | Unsafe action as a signed-in user — **by the proving run** | the validation run executes generated steps as a real, possibly admin, user; the P2 write-safety lexicon was calibrated for anonymous scope and allows "Revoke" / "Remove" | §6.5: authenticated-scope `HARD_BLOCK` extension, SYNTHETIC held unvalidated, sensitive pages excluded from grounding so the step cannot be written at all |
| 5c | Account lockout / rate-limit trip | ~N sign-ins per job, two concurrent, one credential | §5.1 sign-in budget: concurrency 1, per-job cap, minimum interval, and prefix-step failures classified `unvalidated` rather than `rejected` |
| 6 | Consent bypass | a job crawls signed-in without a valid grant | Four independent layers, one of which had to be rebuilt: Zod + role + impersonation checks at the API, the widened DB CHECK (consent must name a consenter), the **row-authoritative** pipeline gate (§10.1 — the payload is not a trust boundary), and the crawler only receiving `auth` params the pipeline constructed from the row |
| 6b | Arbitrary navigation via the login recipe | a `navigate` step in the recipe points at cloud metadata, loopback, or an internal service reachable from the container | §3.1: API-time off-origin rejection plus execution-time re-enforcement and private/link-local blocking |
| 7 | Credential exposure via screenshots | login-page screenshots in the crawl; **and per-step screenshots in every proving run** that replays the prefix | None taken during login execution (§4.2); crawl screenshots begin post-verification; worker suppresses capture for secret steps and the prefix range (§12.2) |

### 12.2 Secret redaction across logs, prompts and screenshots

P3 computes a per-step `isSecret` boolean **once** — action is `type` AND the
`targetDescription` matches a secret lexicon (`password`, `passcode`, `pin`,
`secret`, `token`, `api key`), or the step carries a literal (non-`{{token}}`)
value into a password-typed field — and threads it through four places.
Redacting only `data.value`, as an earlier draft specified, would leave the
same credential sitting in three adjacent columns:

1. **`run_events.data.value`** → `'[redacted]'`, and **`run_events.message`**
   too — the message is built as ``step ${n} · ${action} · "${step.rawText}"``
   (worker.ts:465-468), so the raw sentence carries the literal password into
   the column right next to the one being redacted.
2. **`step_results.captured_value`** for that step → `'[redacted]'`.
3. **LLM prompts** — two callers, only one of which can be fixed. The L5
   resolver prompt includes `Full step: ${step.rawText}` purely for
   disambiguation (openai.gateway.ts:291); **resolution never needs the
   value**, so for secret steps it passes action + target only. That costs
   nothing and closes a provider-egress path the threat table previously
   omitted. `compileStep` (openai.gateway.ts:202) is different and is
   **deliberately left alone**: it exists to parse the sentence into an AST,
   and the value is what it is extracting — redacting its input would produce
   a compiled step that types `[redacted]` into the password field. So a
   literal credential in a login case is seen by the provider at compile time,
   once, under the no-training/DPA terms in umbrella §13.1. The mitigations
   that do apply: the result never reaches the global cache (§12.3), the
   compile is normally avoided entirely because login steps arrive with a
   stored `compiled_ast`, and the credential-free button recipe (§3.2) has no
   value to leak. The complete fix is the vault (§13), not a redaction.
4. **Screenshots**: the worker captures before and after every step
   (worker.ts:482-484,728-731) and those PNGs are downloadable by any tenant
   member via `/media` (runs.ts:757-768). §4.2's "never a frame of a
   credential being typed" holds only for the crawl; §7 sends the login prefix
   through the normal worker N times per job. Suppress before/after capture
   for secret steps and for the login-prefix step range of testwriter runs.

This is a worker-side change benefiting ALL runs — customers' own login tests
currently log their real passwords on every run — but P3 is what makes it
non-negotiable: validation runs of authenticated drafts replay the prefix
through this exact code path N times per job. Heuristic, not perfect (a
custom-labeled secret field escapes it); the perfect fix is the vault (§13).
Unit-tested; normative here until the workers' logging spec absorbs it (§15).

### 12.3 No global compile-cache writes for secret steps

`compiled_ast_cache` has `content_hash` as its only key — no `tenant_id`, no
RLS — and `LearnedCompiler.persistToDB` writes `ast_json` including `value`
(learned.compiler.ts:143-156, 002_seed_compiled_ast_cache.sql:23-27). A login
step typing a literal password, on a cache miss, publishes that password to a
cross-tenant table permanently, outside every purge path.

P3 adds a **no-persist mode** to `LearnedCompiler` (a `compile(text, {persist:
false})` overload or constructor flag) and applies it:

- unconditionally for auth-session compiles (§4.1) and login-prefix compiles
  (§6.2) — the two paths P3 introduces;
- generally whenever the compiled AST's `action === 'type'` and either the
  `targetDescription` matches the secret lexicon or `value` is a non-`{{token}}`
  literal. That general rule fixes the pre-existing leak for every customer,
  not only Test Writer users.

The cost is a repeated compile for those specific steps — a handful of
sentences per tenant, and login steps normally arrive with a stored
`compiled_ast` anyway (§6.3). Unit-tested by asserting the INSERT is skipped.

## 13. Out of scope (explicit, with reasons)

- **MFA / OTP logins** — cannot be executed without a second factor Kaizen
  must never hold; detected only insofar as §4.3's limitation notes; blocked
  honestly, never bypassed.
- **SSO / OAuth popup logins** — the crawl context auto-closes all popups
  (correct for crawling); granting a popup exemption window during login is
  real design work for a flow whose credentials live on a third-party origin
  anyway. Named, deferred.
- **Cross-origin auth domains** (`auth.example.com` → `app.example.com`) —
  violates the same-origin invariant; the origin check (§3.1) rejects it
  up-front with a clear message.
- **Raw-credential intake / encrypted credential vault** — the plan file's
  "case id OR credentials" seam is CLOSED for P3: case-id only. The vault
  belongs to the enterprise/BYO-key phase, which already sketches the
  tenant-scoped encrypted credentials table it needs.
- **Session persistence or reuse across jobs/phases** — session material at
  rest is a new secret class; every consumer signs in itself (§7).
- **Multi-role matrix testing** (crawl as admin AND viewer; generate
  permission-boundary tests from the diff) — the obvious P3.5, explicitly
  named as such; needs multiple login recipes per job and a diff model.
- **Authenticated-scope catalog archetypes** — deferred again, judged
  premature: P3's win is unlocking the EXISTING catalog + LLM gap-fill on
  signed-in pages; `auth.login.happy` via recipe would mostly re-propose the
  customer's own login case (dedup and judge-D4 fodder). Revisit with P3.5
  role archetypes.
- **Precise public/private page partition** (unauthenticated probing) —
  §5.3's conservative marking + "run a public analyze first" covers v1.
- **Per-suite standing auth consent** — rejected (§8.1).
- **"Proving runs may save changes as the signed-in user"** — the third
  consent grant §7 identifies. Until it exists, SYNTHETIC-matched scenarios in
  authenticated jobs ship unvalidated (§6.5). P3.5.
- **Restricting report/media visibility for authenticated runs** — v1
  discloses the audience in the consent copy (§11) rather than changing
  access control mid-phase; flagged there as an open decision.

## 14. Testing

Unit (`__tests__`, mock page / engine / repository):

- **Consent-absent ⇒ zero authenticated navigation**: payload with
  `scope='authenticated'`, `authConsent=false` reaches the pipeline → job
  `blocked`; the crawler is never constructed (spy asserts zero navigations).
- **auth-session**: step failure → `login_failed` naming the step; §4.3
  decision table in full (password-still-visible; SPA-no-assertion fails with
  the guidance message; SPA-with-assertion verifies; redirect verifies);
  challenge during login → `login_challenge`; no healing invoked; dialog
  handler accepts during login and dismisses after.
- **Adversarial logout table**: "Sign out" button → `session-ending`
  (existing); icon link with empty name + `href="/logout"` → classified
  `session-ending` AND never enqueued; `/auth/logout` discovered via a
  probe-revealed link → never enqueued; and the real-world variants the
  token normalization exists for: **`/users/sign_out`** (Devise),
  **`/admin/logout/`** (Django, nested + trailing slash),
  **`/index.php?action=logout`** (query-string only) — each never enqueued;
  blocklist counts land in the report.
- **Session-loss policy**: first loss → exactly one re-login then continue;
  second loss → crawl ends, captures retained, `endedEarly: 'session_lost'`,
  pipeline proceeds; loss before first capture → `blocked: login_failed`;
  landing on `loginPageUrl` without password input → treated as loss.
- **requires_auth upsert**: authenticated upsert preserves prior `false`,
  inserts `true` for new rows; public upsert still overwrites both ways.
- **Sensitive-path tiers**: `/settings` (Tier B) → zero probes, capture +
  links intact, scrubber applied to names/headings, `probesSuppressed`
  incremented; `/api-keys` (Tier A) → URL + title only, no survey, no
  screenshot, **no classification call**, `captureSuppressed` incremented;
  `/products` probes and captures normally.
- **Consent trust boundary**: a payload claiming `scope='authenticated'`
  against a job row recorded `scope='public'` → `blocked: consent_mismatch`,
  zero navigations; a row missing `auth_consented_by` → blocked likewise.
- **API gates**: each §3.1 rejection including the off-origin `navigate`
  step; role check (member 403, admin 202, **undefined role 403** — the
  fail-closed case); impersonated session 403; `auth_consented_by/at` stamped
  on the job row; the 034 CHECK rejects a consented row with a null consenter.
- **Prefix mechanics**: drafts carry login steps first with copied/compiled
  ASTs; body-only dedup (two drafts sharing the prefix don't collide);
  ≤10-step cap ignores the prefix; PLAN excludes every `requiresSignedOut`
  archetype in authenticated jobs (all five, asserted by key) and reports them
  as "covered by public scope".
- **Write-safety under auth**: "click the 'Revoke' button" and "click
  'Remove'" → blocked in an authenticated job, allowed-as-today in a public
  one; a SYNTHETIC-matched step in an authenticated job is held unvalidated
  even with `allow_synthetic_data` on; sensitive-lexicon pages never appear
  in `getGroundingElements` output.
- **Isolation (behavioural, not grep)**: run auth-session and an authenticated
  proving run against a stub DB; assert **zero** INSERTs carrying
  `is_shared = true` or `tenant_id NULL`, and **zero** `element_archetypes`
  writes. Retain cheap grep guards as a second line: no `storageState` usage
  under `src/modules/test-writer/`, and `src/services/test-writer/**` never
  imports `SharedPoolService`.
- **Redaction**: for a `type` step targeting "the password field" — resolve
  event records `value: '[redacted]'` AND a message with no literal;
  `LearnedCompiler` skips the `compiled_ast_cache` INSERT; the resolver prompt
  contains no `Full step:` line; no before/after screenshot is captured. A
  non-secret field logs, caches, prompts and screenshots normally.
- **Sign-in budget**: authenticated job forces validation concurrency 1;
  exceeding the cap ends `blocked: login_budget_exhausted`; a run failing on a
  prefix step yields `draft (unvalidated)`, never `rejected`.

Live acceptance (P3 exit criteria — dogfood on Kaizen's own web app, demo
login):

1. Login case = "Demo sign-in": navigate to the app, click the demo sign-in
   button, assert the tests screen is visible. **Zero credentials in step
   text** — the password stays server-side in `/api/auth/demo`.
2. Authenticated analyze with consent: `report.auth.sessionVerification` set;
   crawler explores behind auth (`pagesBehindAuth > 0`, `/tests` pages in the
   site model with `requires_auth = true`); the TopBar "Sign out" control is
   classified session-ending and appears in the blocklist count; the session
   survives the crawl (`reloginCount: 0`, no `endedEarly`).
3. Zero mutating interactions performed (the P1 spy-page assertion, re-run
   signed-in). **Not** the sensitive-path clause: Kaizen's own web app has no
   `/settings`, `/admin`, `/billing` or `/account` route — its authenticated
   surface is `/tests/**` — so that proof is unit-only (above), and this
   checklist does not carry a box nobody can tick. Re-verify live against a
   secondary target with a settings page when one is available.
4. All knowledge rows tenant-scoped: snapshot `selector_cache WHERE is_shared`
   and `element_archetypes` before and after the job and assert **both are
   byte-identical** — the live proof that the §4.1 suppression works end to
   end, through the crawl AND the proving runs.
5. Without consent: the same target yields only auth-wall stubs — no
   behind-login URL is ever visited (assert against the site model AND the
   crawl's navigation log).
6. Plan pauses at `awaiting_plan_approval` and resumes normally
   (checkpoint unchanged); generated drafts each start with the demo-login
   prefix; validation runs green through the normal worker.
7. `grep` of `run_events` for the demo password finds nothing (trivially true
   for a button recipe — the assertion documents the pattern); a control run
   with a literal-credential login case shows `[redacted]` in resolve events.

## 15. Amendments to existing specs (cross-references only — do not edit here)

1. `spec-recon-crawler.md` §5 — replace the P0 auth sketch with a pointer to
   this spec; §4.1 — note the href-path lexicon for `session-ending` and that
   frontier enqueue also enforces it; §4.3 — note the sensitive-path probe
   suppression (authenticated scope).
2. `spec-test-writer-service.md` §13.4 — record the admin-role consent
   decision (§8.3) as taken; §8 — report gains the `auth` block; §10 — P3 row
   points here.
3. `spec-generation-pipeline.md` §2 — PLAN rules under authenticated scope
   (`requiresSignedOut` archetype exclusion; `requires_auth` drop-rule now
   scope-conditional as designed); §4.2 — the authenticated-scope `HARD_BLOCK`
   extension and the SYNTHETIC-under-auth rule (§6.5); §5 — login-prefix at
   draft creation, body-only dedup/caps; §3 — record that the
   `LearnedCompiler` billing-tenant parameterization promised at :164-166 was
   never implemented and ships in P3 (§10.5).
4. `spec-comprehension-knowledge-model.md` — `requires_auth` preserve-false
   upsert semantics (§5.3); classifier purpose vocabulary gains signed-in
   page examples.
5. `../tests-ux/spec-testwriter-ux.md` — replace the Advanced "Signed-in
   exploration — soon" row with the §11 card; blocked-face variants for
   `login_failed` / `login_challenge`; delivered-face auth stats; coverage-gap
   copy stops promising "coming".
6. `../tests-ux/spec-draft-review-ux.md` §2.1 — mark the scope-selector
   dialog superseded by the testwriter-ux AnalyzeSheet card (§11).
7. Workers specs (`docs/specs/workers/`) — absorb §12.2 (resolve-log message +
   data, captured_value, prompt omission, screenshot suppression) and §12.3
   (no global compile-cache writes for secret steps) wherever run_events
   logging and compilation are next specified; this spec is normative for both
   until then. Note that §12.2/§12.3 fix **pre-existing** exposures affecting
   every customer's login tests, not only Test Writer users — worth a
   changelog line rather than a silent ship, since redacted values will start
   appearing in run reports that previously showed literals.
8. `docs/known-issues/` — until §12.3 ships, record the `compiled_ast_cache`
   plaintext-credential leak (§3.2b) as a known issue, so it is not
   rediscovered as new.
9. The recipe-level origin/private-address validation (§3.1) generalises: any
   user-authored case can navigate a worker anywhere. P3 fixes the seam it
   introduces; a follow-up should apply the same guard to the run worker.

## 16. Open questions for the product owner

Three decisions this spec takes a defensible default on, flagged rather than
buried:

1. **Admin-or-owner gate vs the dogfood setup** (§8.3) — if the demo tenant's
   users are plain members, the acceptance run needs a role bump or the gate
   needs a documented dev-mode exception. Default taken: keep the gate.
2. **Report/media audience for authenticated runs** (§11) — v1 discloses that
   viewers and read-only API keys can see behind-login screenshots and page
   content. The alternative is restricting access for those runs. Default
   taken: disclose.
3. **Public-first recommendation vs an unauthenticated probe pass** (§5.3) —
   the crisp public/private partition currently costs a second analyze job.
   Default taken: recommend a public analyze first; revisit in P3.5 if users
   find the over-marking noticeable.
