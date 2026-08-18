# Spec — RECON Crawler (Phase 1: smart exploration + interaction safety)

Created: 2026-07-29
Updated: 2026-08-18 — §4.0a derived names + new-tab links
Branch: `feat/test-writer/p0-specs`
Status: Draft — design agreed; implementation not started.

> Companion to `spec-test-writer-service.md` (§3 layout). Consumes
> `TestWriterJobPayload`; produces the raw inputs for
> `spec-comprehension-knowledge-model.md`.

## 1. Job of the crawler

Explore the target application like a QA engineer on day one: visit every
reachable page (within budget), *interact carefully* to reveal hidden states,
and gather as much structured data as possible for the comprehension phase —
while **understanding where it is and what it's touching, and never performing
an action with side effects**. The crawler gathers; it does not judge or
generate. Output per page: a `PageCapture`.

```ts
type PageCapture = {
  urlNormalized: string;        // origin + path; query/fragment stripped (see §6)
  title: string;
  headings: string[];           // h1–h3 innerText
  survey: CandidateNode[];      // pruned element survey (§3)
  forms: FormCapture[];         // read-only form structure (§3)
  outgoingLinks: LinkCapture[]; // same-origin anchors found (incl. revealed ones)
  revealedStates: RevealCapture[]; // states discovered via safe probes (§4)
  contentHash: string;          // SHA-256 of the condensed AX outline — re-crawl diffing
  screenshotKey: string | null; // {tenantId}/recon/{jobId}/{pageIndex}.png via ScreenshotService
  requiresAuth: boolean;        // discovered under authenticated scope only
  blocked: 'challenge' | 'robots' | null;
};
```

## 2. Crawl algorithm

BFS from `targetUrl`, one Playwright `BrowserContext` per job from the Test
Writer's own `BrowserPool`:

1. Dequeue URL → `page.goto(url, waitUntil: 'domcontentloaded')` + quiet-network
   settle (reuse the worker's settle behavior).
2. **Challenge gate**: run `challengeDetector.detect(page)`
   (`src/modules/execution-engine/challenge-detector.ts`). Anti-bot page →
   record `blocked: 'challenge'`, never attempt bypass, continue with the queue.
3. **Capture** (§3).
4. **Probe** interactively within the safety envelope (§4); re-capture any
   newly revealed elements/links into the same `PageCapture`.
5. Enqueue newly discovered same-origin links not yet visited (subject to
   normalization §6 and budgets §5).
6. Persist the `PageCapture` incrementally (site-model tables, migration 029)
   so a crashed job loses at most one page.

The crawl is resumable and idempotent per `(tenant_id, suite_id,
url_normalized)` — re-crawling upserts and refreshes `content_hash`.

> **Amended 2026-08-12**: after migration 036 (`spec-app-entity.md`) the
> idempotency key is `(tenant_id, app_id, url_normalized) WHERE is_canonical` —
> the suite no longer partitions knowledge, so two suites crawling the same app
> upsert the same rows. The crawler itself is unchanged (same-origin BFS, writes
> literal landed URLs); only the repository's conflict target moves.

## 3. Per-page capture

- **Element survey**: new `survey(page): Promise<CandidateNode[]>` method on
  `PlaywrightDOMPruner`, exposed as a new small interface `IPageSurveyor` in
  `src/modules/dom-pruner/interfaces.ts`. It is Pass-1 AX extraction WITHOUT
  the per-step similarity filter (there is no target description during recon),
  capped at ~60 nodes, same visibility gating and `selectorCandidates` ranking
  as `prune()`. `IDOMPruner.prune()`'s contract is untouched.
- **Forms**: for each `<form>` (and ARIA form landmark): fields with label /
  name / type / required / placeholder, the submit control's accessible name.
  **Forms are read, never submitted** — no exception, not even "search" forms.
- **Screenshots**: reuse `ScreenshotService` with recon-scoped keys
  (`{tenantId}/recon/{jobId}/{n}.png`). Same GCS/local fallback.

## 4. Interaction safety classifier — the hard gate

`recon/safety.ts`. Interactive exploration is allowed from day one **only**
because every candidate interaction passes this classifier first. It is a hard
gate in code, not prompt guidance.

### 4.0a Element names and new-tab links (amended 2026-08-18)

Two capture rules added after the saucedemo runs:

- **Derived names.** A surveyed control with no accessible name gets one derived
  from the developer's own handle — `aria-label` › `data-test` › `data-testid` ›
  `data-qa` › `id` › `name` › `placeholder` › `title`, humanised
  (`product_sort_container` → "product sort container"), never from hashes or
  one-letter ids. Stored in `page_elements.name` with `attributes.nameSource =
  'derived'`, so it becomes citable by WRITE (the grounding query drops
  nameless rows) while the accessibility finding still counts it as unlabelled.
  `recon/derived-name.ts`.
- **`target` is captured.** The pruner records `target="_blank"`; grounding
  exposes it as `opensNewTab`; the writer prompt marks the line "opens a NEW
  TAB" and rule 8 requires `switch_tab "new"` right after the click; the schema
  gate enforces it deterministically.

### 4.1 Classification

Input: the candidate `CandidateNode` (role, accessible name, tag, attributes),
its ancestor context (inside a `<form>`? inside a dialog?), and the page's
provisional purpose. Output: one of

| Class | Examples | Crawler action |
|---|---|---|
| `safe-reveal` | tab, accordion toggle, menu/dropdown opener, modal opener, "show more", carousel next, `aria-expanded` toggles | MAY perform, within probe budget |
| `navigation` | same-origin `<a href>` | followed via BFS queue (GET only), never clicked mid-page |
| `mutating` | any submit control, buttons whose name matches the destructive lexicon (delete, remove, pay, buy, purchase, checkout, publish, send, post, save, update, confirm, deactivate, unsubscribe, transfer…), settings toggles (`role=switch/checkbox` outside pure-display widgets), file uploads | NEVER performed |
| `session-ending` | logout / sign out / log off / end session | NEVER performed; the element is additionally added to a per-job blocklist (classic authenticated-crawler suicide) |
| `external` | cross-origin links, `mailto:`, `tel:`, downloads | recorded, never followed |

Ambiguity resolves DOWNWARD: anything not confidently `safe-reveal` is treated
as `mutating`. The lexicon is word-boundary matched on the accessible name in
lowercase; matching is deliberately over-broad — a missed reveal costs
coverage, a false "safe" costs a customer's production data.

### 4.2 Probe protocol

For each `safe-reveal` element (up to the per-page probe budget):

1. Snapshot the AX outline.
2. Perform the reveal (click/hover per role).
3. Diff: capture newly visible elements/links/forms into `revealedStates`.
4. **Restore**: `Escape` → close-button click → `page.goBack()` if URL changed
   → full `page.reload()` as last resort. The BFS must always continue from a
   known state.
5. If the probe triggered navigation to a same-origin URL, record it as a
   discovered link and restore — do not continue crawling from the surprise
   location.

### 4.3 Environment envelope

- Same-origin only (after normalization §6). `target=_blank` popups are
  auto-closed; `page.on('dialog')` → dismiss (NOT accept — the run-worker
  auto-accepts, the crawler must not confirm anything).
- Downloads aborted. `robots.txt` fetched once per job and honored
  (`blocked: 'robots'` for disallowed paths).
- Rate limit ≤ 1 page/s; per-page probe budget default 8; page cap
  `options.maxPages` (default 30, hard 50); depth cap 5.
- Per-page wall clock cap 30s; job wall clock cap 20min.

## 5. Auth scope (P3, designed now)

- `scope: 'public'` (default): the crawler never enters URLs that redirect to
  a login page; such URLs are recorded with `requiresAuth: true` and skipped.
- `scope: 'authenticated'`: requires `loginCaseId` + `authConsent === true`
  (enforced at the API, re-checked in the pipeline). Flow:
  1. `recon/auth-session.ts` executes the login case's compiled steps through
     the existing execution engine on the crawler's own page.
  2. **Session verification**: the post-login URL must differ from the login
     page and the login form must no longer be present; otherwise the job ends
     `blocked` with reason `login_failed`.
  3. Crawl proceeds; `session-ending` blocklist is strictly enforced; if an
     auth loss is detected mid-crawl (redirect back to login), re-run the login
     recipe once, then abort the authenticated portion if it fails again.
- Credentials: referenced by case id wherever possible. Raw credentials, when
  provided, are encrypted at rest, never logged, never included in
  `generation_jobs.report`, and never persisted in site-model rows.

## 6. URL normalization

`urlNormalized = origin + pathname` with: trailing slash stripped (except
root), query string dropped, fragment dropped, path params NOT templated in v1
(each concrete URL is its own page; templating like `/product/:id` is a
comprehension-phase concern — see companion spec §4). Rationale: normalization
bugs silently merge or explode the page graph; keep v1 rules trivial and
observable.

## 7. Tenant isolation (hard requirement)

All crawler writes go to the site-model tables (migration 029) with
`tenant_id` set and RLS enforced via `withTenantTransaction`. The crawler
imports NOTHING from the shared-pool seeding path and has no code path that
writes `selector_cache` rows with `is_shared: true` or `tenant_id: NULL`.
Add a unit test asserting the module graph of `src/modules/test-writer/recon/`
never imports the seeding script or writes `selector_cache`.

## 8. Testing

Unit (`__tests__`, mock page):
- Safety classifier adversarial table: "Delete account" button → `mutating`;
  "Log out" link → `session-ending`; search-form submit → `mutating`; tab with
  `aria-expanded` → `safe-reveal`; ambiguous unnamed button → `mutating`.
- Probe protocol restores state after: modal open, URL-changing click, dialog.
- Normalization: query/fragment stripping, trailing slash, cross-origin
  rejection.

Live acceptance (P1 exit criteria):
- Crawl a known multi-page public site → `site_pages`/`page_links` match the
  real sitemap within budget.
- Interactive probing discovers at least one state (modal/tab content) that a
  passive link crawl misses.
- Zero mutating interactions performed (assert via a spy page recording every
  click target against the classifier's verdicts).
