# Goal & keying principle

Site knowledge (site_pages, page_elements, page_links, app_briefs) re-keys from `(tenant_id, suite_id)` to `(tenant_id, app_id)`, where an **app** is a tenant-owned row whose identity is its set of origins (`app_origins` â€” the same table that implements `resolveCanonicalOrigin()` and B11 Â§5.1's owner-configured aliases). Suites keep owning tests, jobs, drafts, `tenant_brief`, and `allow_synthetic_data`, and gain a sticky nullable `app_id` set on first analyze â€” so every analyze permanently enriches one durable per-app model, a second website can never silently mix into a suite (explicit 409), and a second suite pointed at the same app reuses the entire content_hash classification cache. Tenant RLS remains the absolute confidentiality boundary â€” and this plan makes it real by adding `FORCE ROW LEVEL SECURITY`, which the current owner-role deployment silently lacks.

# Schema â€” migration 035 (complete DDL sketch)

One transaction, additive, safe with old suite-keyed code still deployed (legacy `UNIQUE (tenant_id, suite_id, url_normalized)` retained until 036). Claim `035_app_entity.sql` + reserve `036_app_entity_cutover.sql` in COORDINATION.md cross-notes first (B11 queues for the next number; 028/032 collisions set the protocol).

```sql
-- 035_app_entity.sql
CREATE TABLE IF NOT EXISTS apps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,                       -- display; defaults to canonical host
  canonical_origin TEXT NOT NULL,           -- names the app; B11 alias target; selector_cache.domain derives from this
  last_crawled_at TIMESTAMPTZ,              -- P5 scheduling cursor (touchAppCrawled)
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, canonical_origin),
  UNIQUE (tenant_id, id)                    -- composite-FK target: makes cross-tenant app_id refs structurally impossible
);

CREATE TABLE IF NOT EXISTS app_origins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  app_id UUID NOT NULL,
  origin TEXT NOT NULL,                     -- exact origin for kind IN ('canonical','exact'); validated glob for 'alias_pattern'
  kind TEXT NOT NULL DEFAULT 'exact' CHECK (kind IN ('canonical','exact','alias_pattern')),
  added_by UUID REFERENCES users(id),       -- alias_pattern rows: owner-configured ONLY, never auto-detected (feeds an auth gate)
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, origin),
  FOREIGN KEY (tenant_id, app_id) REFERENCES apps(tenant_id, id) ON DELETE CASCADE
);

-- RLS: copy the 029 DO-block pg_policies pattern for tenant_isolation on apps + app_origins,
-- USING (tenant_id = current_setting('app.current_tenant_id')::uuid).
-- CRITICAL FIX (attack 2): the runtime role OWNS these tables, so plain RLS is inert. FORCE it â€”
ALTER TABLE apps        FORCE ROW LEVEL SECURITY;
ALTER TABLE app_origins FORCE ROW LEVEL SECURITY;
ALTER TABLE site_pages      FORCE ROW LEVEL SECURITY;   -- retrofit the 029/028 tables in the same file
ALTER TABLE page_elements   FORCE ROW LEVEL SECURITY;
ALTER TABLE page_links      FORCE ROW LEVEL SECURITY;
ALTER TABLE app_briefs      FORCE ROW LEVEL SECURITY;
ALTER TABLE generation_jobs FORCE ROW LEVEL SECURITY;

ALTER TABLE site_pages
  ADD COLUMN IF NOT EXISTS app_id UUID,
  ADD COLUMN IF NOT EXISTS is_canonical BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS origin TEXT,                                   -- graft: scopes MAINTAIN removed-detection + hasPublicObservation
  ADD COLUMN IF NOT EXISTS captured_scope TEXT NOT NULL DEFAULT 'public'
    CHECK (captured_scope IN ('public','authenticated'));                 -- attack-6 partition
ALTER TABLE app_briefs
  ADD COLUMN IF NOT EXISTS app_id UUID,
  ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'public' CHECK (scope IN ('public','authenticated'));
ALTER TABLE generation_jobs ADD COLUMN IF NOT EXISTS app_id UUID;
ALTER TABLE test_suites     ADD COLUMN IF NOT EXISTS app_id UUID REFERENCES apps(id);
-- Composite FKs (tenant_id, app_id) REFERENCES apps(tenant_id, id) on site_pages/app_briefs via DO-block
-- (ADD CONSTRAINT IF NOT EXISTS is not a thing for FKs). site_pages FK: ON DELETE CASCADE.
-- page_elements / page_links: NO new columns â€” they reach app scope through page_id FKs, as they reach suite scope today.

-- BACKFILL (idempotent; also extracted to scripts/backfill-apps.ts for re-runs).
-- Origin extraction pinned by a unit test byte-for-byte against normalizeUrl (ports, IDN, schemes, '_' hosts):
-- 1. Stamp page origins (no LIKE â€” attack 10):
UPDATE site_pages SET origin = substring(url_normalized FROM '^[a-z][a-z0-9+.-]*://[^/]+') WHERE origin IS NULL;
-- 2. Apps from PAGE origins (not target_url â€” attack 4):
INSERT INTO apps (tenant_id, name, canonical_origin)
  SELECT DISTINCT tenant_id, split_part(origin,'://',2), origin FROM site_pages WHERE origin IS NOT NULL
  ON CONFLICT (tenant_id, canonical_origin) DO NOTHING;
INSERT INTO app_origins (tenant_id, app_id, origin, kind)
  SELECT tenant_id, id, canonical_origin, 'canonical' FROM apps ON CONFLICT (tenant_id, origin) DO NOTHING;
-- 3. Stamp pages by exact origin equality (both guards in one AND chain â€” no OR-precedence trap):
UPDATE site_pages sp SET app_id = ao.app_id FROM app_origins ao
  WHERE sp.app_id IS NULL AND ao.tenant_id = sp.tenant_id AND ao.origin = sp.origin;
-- 4. captured_scope approximation (errs conservative â€” over-marks as authenticated, which only narrows public prompts):
UPDATE site_pages SET captured_scope = 'authenticated' WHERE requires_auth = true;
-- 5. Duplicate fold, NON-destructive: per (tenant_id, app_id, url_normalized) group with >1 row,
--    keep is_canonical=true on MAX(last_crawled_at) (tie: max id); shadows get is_canonical=false.
--    Shadow rows + their elements/links persist; purged only by 037 after verification.
-- 6. Jobs: stamp generation_jobs.app_id from the SUITE'S page origins where unambiguous; where a job's
--    target_url origin differs from its suite's page origin (apexâ†’www / httpâ†’https redirects â€” attack 4),
--    ADD the target origin as an 'exact' app_origins row on the SAME app; create new apps only for jobs
--    with zero pages whose origin matches no app.
-- 7. app_briefs.app_id via generation_job_id -> generation_jobs.app_id (precise even in mixed suites);
--    app_briefs.scope from the job's scope; fallback: the suite's sole distinct page-origin, else NULL.
-- 8. test_suites.app_id = its most recent generation_job's app_id; NULL for never-analyzed suites.

-- DURABILITY NOW, not in 036 (attack 5): suite deletion must stop destroying the pool immediately.
ALTER TABLE site_pages ALTER COLUMN suite_id DROP NOT NULL;
ALTER TABLE app_briefs ALTER COLUMN suite_id DROP NOT NULL;
-- Recreate both suite_id FKs as ON DELETE SET NULL (drop + re-add). suite_id remains as provenance.

-- NEW IDENTITY (arbiter): predicate is is_canonical ONLY â€” the 'app_id IS NOT NULL' clause is dropped so
-- ON CONFLICT infers the arbiter (judges' fix); NULL app_id rows are exempt via NULL-distinctness anyway.
CREATE UNIQUE INDEX IF NOT EXISTS site_pages_app_url_canonical_key
  ON site_pages (tenant_id, app_id, url_normalized) WHERE is_canonical;
CREATE INDEX IF NOT EXISTS site_pages_app_idx ON site_pages (tenant_id, app_id);
CREATE INDEX IF NOT EXISTS app_briefs_app_idx ON app_briefs (tenant_id, app_id, version DESC);

-- Deploy-window trigger (graft): BEFORE INSERT ON site_pages WHEN NEW.app_id IS NULL â€” stamp origin +
-- app_id from an exact app_origins match, and set is_canonical=false when a canonical (tenant, app, url)
-- row already exists (so old-code inserts never trip the new partial unique). Dropped in 036.
```

**036_app_entity_cutover.sql** (after live verification): drop legacy `site_pages_tenant_id_suite_id_url_normalized_key`; renumber colliding backfilled `(tenant, app, version)` briefs by `created_at` then `CREATE UNIQUE INDEX app_briefs_app_version_key (tenant_id, app_id, version)`; `NOT VALID` CHECK that new site_pages rows carry app_id; drop the deploy-window trigger. **037** (optional): purge `is_canonical=false` shadows. Deliberately NOT in 035: per-app brief UNIQUE (backfilled chains from two suites can share ordinals; the `pg_advisory_xact_lock` in `saveAppBrief` prevents new duplicates from day one). Untouched: embedding vector(1536)+HNSW columns, `template_of`, the page_links NULL-via quirk, migration 034's consent CHECK.

# Read/write path changes

| File | Change |
|---|---|
| `src/modules/test-writer/site-model.repository.ts` | All methods re-signed `suiteId` â†’ `appId` (suiteId kept as provenance column value on writes). `upsertPage`: (1) **stub guard** â€” a capture with empty survey and `content_hash LIKE 'auth-wall:%'` updates ONLY `requires_auth` (per mode rules) + `last_crawled_at`, never content_hash/ax_outline/classification/elements (attack 1); (2) adoption step claiming the newest `app_id IS NULL` row for (tenant, url) into the app; (3) `INSERT ... ON CONFLICT (tenant_id, app_id, url_normalized) WHERE is_canonical DO UPDATE` â€” `requiresAuthSql` mode-dependence (lines 67-71) and the content_hash purpose-NULLing CASE (90-95) carry over verbatim; writes `origin` + `captured_scope` (job scope); (4) legacy-conflict retry: catch `unique_violation` on the old (tenant,suite,url) key, adopt that row (SET app_id, fold is_canonical), retry (attack 4). `insertLinks` endpoint join â†’ `(tenant, app, url_normalized, is_canonical)`. `listPagesNeedingClassification`, `listClassifiedPages`, `getLinkGraph`, `getGroundingElements`, `getFormSummaries` â†’ `WHERE app_id = $2 AND is_canonical` (+ `captured_scope='public'` filter param for public-scope jobs â€” attack 6). `hasPublicObservation(tenantId, appId, origin)` (attack 9). `saveAppBrief`: `pg_advisory_xact_lock(hashtext(tenant||app))`, `COALESCE(MAX(version),0)+1` per (tenant, app), writes `scope`; `getLatestAppBrief` orders `version DESC, created_at DESC`. New `touchAppCrawled`. Repository-level audit: every site-knowledge query asserted to carry `is_canonical`. |
| `src/api/routes/test-writer.ts` | `resolveCanonicalOrigin` (line 70) â†’ async `resolveApp(tenantId, rawUrl)`: app_origins exact match, then owner-configured `alias_pattern` via a **code-level validator** (single wildcard, leftmost subdomain label only, remainder byte-matches a tenant-verified literal; bare-TLD/platform-wide rejected â€” attack 8) â€” always inside `withTenantTransaction` (attack 2; also converts `checkLoginCase`'s bare `getPool()` query at line 89). Analyze route: SSRF guard first (unchanged, 183-189) â†’ `resolveApp` â†’ miss = auto-create (human sessions; CI/API-key miss = specific error telling the owner to configure the alias, no auto-create) â†’ suite `app_id` NULL = bind; equal = proceed; different = **409 APP_MISMATCH**; `confirmSwitchApp` accepted from human sessions only (attack 8). Job INSERT (287-297) gains `app_id`. `checkLoginCase` (117-133) upgrades origin string-equality to same-app membership. `GET /suites/:suiteId/app-brief` resolves `suite.app_id` (404 `APP_NOT_ANALYZED` when NULL); history annotated with each version's suite/job/scope. New: `GET /apps`, `GET /apps/:appId/brief` (briefs addressable by immutable id; ordinal display-only), `POST /apps/:appId/origins` (owner-only, appId resolved inside the tenant tx), `POST /apps/:appId/purge-authenticated-knowledge` (owner-gated; Phase 2). |
| `src/modules/test-writer/pipeline.ts` | Row-authoritative job read (117-140) SELECTs `app_id`; every repository call passes the ROW's app_id, never the payload (consent pattern). `hasPublicObservation` sampled pre-crawl per (app, crawl-root origin) (319-322). **PLAN persists a grounding snapshot** (cited element ids + role/name/revealed_by/url, selectors along for cache pre-seed only) into `generation_jobs.test_plan`; post-approval WRITE consumes the snapshot, live-read fallback only for vanished elements, reported as staleness (attack 3). Report gains `reusedFromCache` counts and a log of pattern-matched resolutions. `loadExistingCaseNames/Steps` (573-598) UNCHANGED â€” dedup stays suite-scoped. VALIDATE `baseUrl` stays `job.target_url`, now guaranteed same-app. If the crawl's landed root origin differs from the resolved origin (redirect), auto-add it as an `exact` origin of the same app and log it (attack 4). |
| `comprehend/classifier.ts` | Takes appId; public-scope jobs classify only `captured_scope='public'` rows; `skipped` count documented as app-wide (suite-2 jobs may classify suite-1 pages â€” enrichment, not a bug). |
| `comprehend/synthesizer.ts` | Takes appId; pages + link graph in ONE keyed scope (journey verification intact); public jobs synthesize over the public projection; short-circuit: zero changed hashes + zero new pages + latest same-scope brief exists â†’ reuse, skip the LLM call. |
| `plan/test-planner.ts` | No logic change: `knownUrls` (55), public-scope requires_auth drop (80-83), requiresSignedOut drop (90-96) now operate on the app-scoped set â€” cross-site targeting structurally impossible. |
| `recon/crawler.ts` | Unchanged: `rootOrigin` same-origin BFS (line 92) stays in-memory; crawls write literal landed URLs â€” never canonicalized (B11 line 118: CI runs never write the canonical brain). |
| `src/types/test-writer.ts` | Payload gains `appId` (informational; row stays authoritative). |
| `scripts/backfill-apps.ts` | Re-runnable extraction of the 035 backfill; batched fallback if site_pages has grown; post-deploy sweep of interim NULL-app rows. |
| `src/modules/test-writer/__tests__` | Module-graph isolation test unchanged. New: resolver exact/pattern/miss + validator rejections; adoption + legacy-conflict retry; canonical upsert idempotence across two suites; 409 + confirmSwitchApp human-only; **auth crawl â†’ public crawl â†’ classifications/elements survive** (attack-1 regression); requires_auth merge under app key; backfill idempotence + origin-regex pin; real-Postgres test proving cross-tenant app_origins SELECT/INSERT fails under the runtime connection; seeded-shadow double-count test. |
| `packages/web` (UX phase) | AppBriefCard: canonical_origin subtitle, per-version suite/job/scope provenance, "last crawled N days ago"; 409 modal; `reusedFromCache` copy ("reusing this workspace's existing knowledge of app X"); PlanFace Â§15.5 copy; consent-modal amendment. |
| `docs/specs/test-writer/` | New `spec-app-entity.md`; amend spec-comprehension-knowledge-model.md Â§5 + line 90 ("suite-scoped" â†’ "app-scoped, suite-linked"), spec-test-writer-service.md Â§6, spec-recon-crawler.md:54 idempotency key, spec-authenticated-scope.md Â§3.1 (origin gate â†’ app-membership gate) + Â§11 consent copy; COORDINATION.md claims 035/036. |

# Same-suite, two apps â€” the flow after this change

User analyzes site A into suite S: `resolveApp` misses â†’ app A auto-created (name = host, canonical_origin = origin) + exact app_origins row; S.app_id bound to A; the job row carries app_id=A; RECON writes canonical pages under (tenant, A); COMPREHEND classifies and synthesizes over (tenant, A); brief v1 lands on A's chain; PLAN/WRITE/VALIDATE unchanged, drafts land in suite S. User then analyzes site B into the SAME suite: SSRF guard passes, `resolveApp` finds/creates app B, but S.app_id = A â‰  B â†’ **409 APP_MISMATCH** ("This suite tests app-a.com; analyzing b.com would re-point it to a different app"). Today's silent corruption â€” brief synthesized over both sites, PLAN legally targeting site-A pages that VALIDATE against B's baseUrl, hasPublicObservation cross-suppression â€” becomes an explicit choice. On `confirmSwitchApp:true` (human sessions only): S.app_id â†’ B; every phase thereafter reads only (tenant, B); site A's pages, elements, links, and briefs remain fully intact under app A, re-attachable by any suite later â€” nothing is deleted. Suite-owned things never move: existing cases/drafts (name dedup stays suite-wide, correct since names are unique per suite), tenant_brief, allow_synthetic_data. WriterScreen/HistoryStrip stay suite+job addressed.

# Cross-suite, same app â€” what is reused and what it costs

Suite 1 analyzed x.com â†’ app X with classified pages and brief v3. Suite 2 analyzes x.com: `resolveApp` finds X, suite 2 binds.

**Reused:** the entire site model. RECON's upsertPage hits X's canonical rows; unchanged `content_hash` preserves purpose/purpose_tag/capabilities (repository 90-95), so `listPagesNeedingClassification` returns ~0 and per-page classification LLM calls are skipped â€” the cache that was imprisoned by suite keying, freed. Synthesis short-circuits too when zero hashes changed and zero pages were added; otherwise it appends a new version to X's single chain. `hasPublicObservation`, requires_auth verdicts, and the link graph are shared. The two dominant LLM costs of a re-analyze vanish.

**Deliberately not reused:** the crawl always re-runs â€” page_elements are replace-all per page because grounding must reflect the page NOW (stale elements poison WRITE); PLAN/WRITE/VALIDATE always run because their outputs are suite-scoped (plans, drafts, proving runs, dedup against suite 2's own case names); tenant_brief and allow_synthetic_data stay per-suite.

**Staleness contract:** classification trusted exactly as long as content_hash is unchanged (same contract as same-suite re-crawl today); elements never trusted across crawls; briefs append-only per app with history for P5 diffing; `apps.last_crawled_at` is the freshness signal. The job report surfaces `reusedFromCache` and the UI attributes brief versions to their originating suite/job, so a near-zero-work analyze reads as reuse, not a bug.

# Auth & consent under the new keying

- **Consent stays strictly per-job.** Migration 034's CHECK (`auth_consent AND login_case_id AND auth_consented_by AND auth_consented_at`) is untouched; no app-level or suite-level standing consent is introduced â€” app keying makes the temptation stronger, so `spec-app-entity.md` restates Â§8.1: knowledge reuse never implies consent reuse; a new authenticated crawl of app X from any suite requires its own consent click and its own audited job row. `decideConsent` stays row-authoritative; `app_id` is read from the generation_jobs row like scope/consent.
- **The requires_auth partition survives verbatim and improves.** The mode-dependent upsert (public authoritative both directions; authenticated AND-preserves prior false; blocked keeps stored) rides the app-keyed rows. A public crawl from any suite verifies the partition for the whole app, and hasPublicObservation is now per (app, origin) so an unrelated origin can never falsely suppress the "unverified partition" warning. test-planner's public-scope drop (80-83) operates on the app-scoped set â€” Â§5.3's private-mislabeled-public failure is guarded by the same AND-preserve direction.
- **Public crawls can no longer vandalize consented knowledge** (attack 1): auth-wall stub captures are merge-only in upsertPage â€” they may tighten `requires_auth`, never erase classifications, ax_outlines, or elements. "The most privileged consented crawl wins" now holds cross-suite by construction, with a regression test.
- **RLS becomes real where it matters most** (attack 2): `FORCE ROW LEVEL SECURITY` on apps, app_origins, and all site-knowledge tables in 035; every apps/app_origins access â€” including checkLoginCase's membership query and the POST origins appId resolution â€” runs inside `withTenantTransaction`; composite FKs `(tenant_id, app_id) REFERENCES apps(tenant_id, id)` make a cross-tenant app reference structurally impossible; an integration test against real Postgres proves cross-tenant access fails under the runtime role.
- **Behind-login content sharing is disclosed and retractable** (attack 6): `captured_scope` partitions authenticated captures out of public-scope jobs' classification/synthesis prompts (so PII from a consented signed-in crawl is never re-sent to the LLM under a job whose audit row records no consent), the Â§11 consent copy gains "signed-in captures enrich this workspace's shared model of this app and are reusable from any suite," and the owner-gated purge endpoint restores the retraction path that suite deletion used to provide. Tier A/B sanitization stays at capture time; sensitiveTier WRITE filtering (pipeline 386-395) works identically.
- **The alias table feeds an auth gate, so it is locked down** (attacks 2, 8): alias_patterns are owner-configured only, validated in code (single leftmost-subdomain wildcard, tenant-literal remainder), never auto-created from CI, and every pattern-matched resolution is logged to the job report. checkLoginCase's upgrade to same-app membership is strictly tighter than string equality for unrelated origins while finally admitting the preview-deploy case.

# Attack resolutions

1. **Public analyze erases authenticated knowledge (fatal)** â€” *Mitigated*: auth-wall stub captures (empty survey + `auth-wall:` hash) become merge-only in upsertPage (requires_auth + last_crawled_at only); `captured_scope` additionally partitions variants; regression test asserts classifications and elements survive an auth-then-public crawl sequence.
2. **RLS inert under table-owner role; alias table feeds auth gate (fatal)** â€” *Mitigated*: `FORCE ROW LEVEL SECURITY` on new AND existing knowledge tables in 035; all apps/app_origins access via `withTenantTransaction` (checkLoginCase's bare `getPool()` converted); POST origins owner-only with in-transaction appId resolution; composite tenant-scoped FKs; real-Postgres cross-tenant denial test. Moving the runtime app to a non-owner role is filed as follow-up hardening; FORCE closes the hole either way.
3. **Cross-suite grounding clobber across plan-approval pause (serious)** â€” *Mitigated*: grounding snapshot persisted into `generation_jobs.test_plan` at PLAN time; WRITE consumes the snapshot with live-read fallback reported as staleness. Also fixes same-suite staleness that existed before this redesign.
4. **Redirect-normalized backfill mis-grouping + legacy-UNIQUE crash (serious)** â€” *Mitigated*: backfill derives apps from PAGE origins and folds divergent target_url origins into the SAME app as extra exact origins; new code auto-adds the landed root origin to the app when a crawl redirects; upsertPage catches legacy-key `unique_violation`, adopts the row, and retries.
5. **Suite deletion cascades canonical rows during the 035â†’036 window (serious)** â€” *Mitigated*: the suite_id nullable + `ON DELETE SET NULL` swap moves INTO 035 (additive-safe â€” old code never depends on the CASCADE for correctness); only the legacy UNIQUE drop waits for 036. Durability lands on day one.
6. **Tier-neither behind-login PII becomes permanent tenant-wide substrate (serious)** â€” *Mitigated*: `captured_scope` in 035; public-scope jobs' prompts exclude authenticated-captured rows; owner-gated `POST /apps/:appId/purge-authenticated-knowledge` (rows + screenshots) ships before 036 removes the suite-deletion retraction path; consent copy amended. Extending the Tier B redactor to all authenticated captures is an open founder decision (below) because it trades knowledge richness for scrubbing.
7. **Brief chain lies three ways (serious)** â€” *Mitigated*: `pg_advisory_xact_lock` in saveAppBrief from 035 (no duplicate versions ever minted); briefs addressed by immutable id, ordinals display-only with suite/job/scope/date provenance on every row (nothing a user cited is renumbered out from under them â€” 036 renumbers only colliding backfilled rows, and the UI keys on id); `scope` on app_briefs so P5 diffs within-scope and privilege changes are never reported as app changes.
8. **CI preview deploys â†’ app fragmentation + suite-pointer thrash (serious)** â€” *Mitigated*: `confirmSwitchApp` rejected for API-key/CI auth (rebinding is a human decision); CI alias miss fails with a configure-the-alias error instead of auto-creating; auto-creates rate-limited and reported per tenant; alias_pattern validator implemented in code with tenant-literal requirement; pattern-matched resolutions logged.
9. **App-wide hasPublicObservation overclaims on multi-origin apps (minor)** â€” *Mitigated*: `origin` column on site_pages in 035; hasPublicObservation computed per (app, crawl-root origin); MAINTAIN removed-detection scoped `WHERE origin = <crawled origin>`.
10. **Backfill SQL precedence/LIKE traps (minor)** â€” *Mitigated*: backfill stamps an `origin` column first and joins on exact equality (no LIKE, no OR branch); origin-extraction regex pinned byte-for-byte against `normalizeUrl` by unit test; composite tenant-scoped FK makes any residual mis-stamp fail at write time instead of surfacing as a cross-tenant cascade delete.

# B11 / P5 hooks

**B11 (CI integration):** `apps` is the stable canonical app identity spanning origins and branches; `app_origins.alias_pattern` is Â§5.1's owner-configured alias table, wired into the exact `resolveCanonicalOrigin` seam reserved at `test-writer.ts:70`. CI-triggered authenticated jobs against preview deploys pass the login-case gate via same-app membership â€” the case the auth spec calls "exactly the case that matters most." Crawls write literal landed URLs, respecting B11's "CI runs never write the canonical brain"; the Â§5.2 branch overlay later hangs off the app (an environment dimension beside a stable identity, not built now). Selector pre-seeding derives `selector_cache.domain` from `apps.canonical_origin`, so seeded selectors and CI alias reads converge on one warm cache row. The Â§9 repoâ†”app handshake maps repo â†’ apps rows, answering the monorepo open question: one repo, N apps, each owning its origins and future `route_pattern` manifest; suites follow via `test_suites.app_id`.

**P5 (MAINTAIN):** re-crawl diffing gets durable identity â€” `content_hash` per `(tenant_id, app_id, url_normalized)` â€” surviving suite deletion and merging observations from all suites. MAINTAIN schedules per app off `apps.last_crawled_at` (one re-crawl serves every suite of the app); removed-detection is origin-scoped; brief diffing uses the per-app, per-scope chain; login-prefix staleness flagging (Â§6.4) is untouched (job-side). The coverage map stays suite-answerable: `GET /suites/:id/coverage` = site_pages `WHERE app_id = suite.app_id AND is_canonical` LEFT JOIN pages touched by that suite's active cases via run_events â€” the suiteâ†’knowledge join is one FK hop.

# Phasing

**Phase 0 â€” spec + coordination (half day).** Claim 035/036 in COORDINATION.md cross-notes; write `spec-app-entity.md`; amend the four existing specs. SDD-complete before any code.

**Phase 1 â€” migration 035 + code cutover (the core; independently shippable).** Apply 035 to shared dev Postgres, cross-note (migration-before-code). Ship repository/pipeline/routes/types changes + `scripts/backfill-apps.ts` + the full test list. Mid-way states all safe by construction: 035-without-code = fully functional legacy behavior (legacy UNIQUE intact, trigger pre-stamps rows, FORCE RLS is invisible to correct code); code-without-035 = forbidden by the migration-before-code rule; rollback after 035 = legacy behavior resumes, new columns inert. Post-deploy: run the backfill sweep once, then live dogfood on Railway prod (incl. the YouTube rows): (a) one app per analyzed origin, every page stamped; (b) same site from a second suite â†’ `listPagesNeedingClassification` ~0; (c) different site into a bound suite â†’ 409; (d) auth-then-public crawl â†’ knowledge survives.

**Phase 2 â€” retraction + cutover (independently shippable).** Ship `POST /apps/:appId/purge-authenticated-knowledge` FIRST, then apply 036 (drop legacy UNIQUE, brief renumber + per-app UNIQUE, NOT VALID app_id check, drop trigger), cross-note. Ordering is deliberate: the purge path must exist before suite deletion stops being a retraction mechanism.

**Phase 3 â€” cleanup (optional, anytime after verification).** 037 purge of `is_canonical=false` shadows; retire the is_canonical filter audit to a plain invariant.

**UX work (parallel track, separate PRs):** 409 APP_MISMATCH modal with confirmSwitchApp; AppBriefCard canonical_origin subtitle + per-version suite/job/scope provenance + "last crawled N days ago"; `reusedFromCache` copy in the job report view; consent-modal Â§11 amendment; the already-pending PlanFace Â§15.5 copy fix rides along. Phase 1 is shippable without any of it (the 409 returns a clear error body meanwhile), but the modal and provenance copy should land before announcing cross-suite reuse to users.

# Open decisions for the founder

1. **Second website into a bound suite: hard 409 with human-only override, or allow multi-app suites?** The 409 forecloses multi-app suites permanently â€” a real behavior change. **Recommendation: keep the 409.** Every knowledge surface (AppBriefCard, coverage, planner) assumes one app per suite, and "make a new suite" is the honest answer; revisit only if users demonstrably want mixed suites.
2. **Ship v1 without `POST /apps/:appId/merge`?** Auto-create fragmentation (staging.x.com vs x.com) divides knowledge until an owner can merge, but merge is the most dangerous admin operation in the design. **Recommendation: cut it from v1** â€” the redirect auto-adoption and backfill folding cover the common apex/www case; add merge only when real fragmentation is observed, with its own test suite.
3. **Extend the Tier B redactor to ALL authenticated captures (not just lexicon paths)?** Closes the Tier-neither PII gap (attack 6) at the cost of leaner knowledge on data-rich signed-in pages (scrubbed titles/headings/element names weaken classification and briefs). **Recommendation: yes, scrub value-bearing text (headings, cell/list content) but keep structural element names** â€” grounding cites roles and control labels, not data values, so WRITE quality survives while PII exposure drops; pair with the purge endpoint as defense-in-depth.
4. **Expose `options.reuseFreshCrawl` (skip RECON when the app was crawled < N hours ago)?** Saves crawl time on a second suite's analyze but weakens the "elements are never trusted across crawls" doctrine. **Recommendation: not in v1** â€” classification + synthesis reuse already removes the dominant cost; keep the honest default and revisit when P5 gives freshness a UI.
5. **Move the runtime DB user to a non-owner role now or later?** FORCE RLS in 035 closes the practical hole; a non-owner role is strictly stronger (survives a future `NO FORCE` regression) but touches Railway/docker provisioning for both workstreams. **Recommendation: later, as a scheduled hardening task with its own cross-note** â€” don't couple infra role surgery to this migration window.
