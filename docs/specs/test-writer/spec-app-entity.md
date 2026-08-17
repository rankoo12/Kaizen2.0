# Spec: App-Entity Knowledge Model — knowledge per app, tests per suite

Created: 2026-08-12
Status: approved for implementation (founder accepted all five decisions
2026-08-12; won a 3-design competition, 2 judges unanimous, 10-attack
adversarial pass all resolved — `docs/assessments/2026-08-11-app-entity-architecture-plan.md`)
Owner: Test Writer workstream
Updated: 2026-08-17 — Decision 5 corrected (the runtime role is a superuser, not
merely the table owner; FORCE RLS alone closes nothing). Migration numbers shift
by one: 036 is now the standalone RLS enablement that shipped ahead of this spec.
Migrations: **037_app_entity.sql** + **038_app_entity_cutover.sql** (+039 optional
shadow purge). **Renumbered twice**: from the assessment doc's "035/036" because
validation-trust took 035, and again because `036_force_rls.sql` took 036 when
the RLS half was split out and shipped first. The FORCE statements listed in §1
are already applied by 036 for the five tables that existed then; 037 adds them
for `apps` and `app_origins` only.

## 0. Goal & keying principle

Site knowledge (`site_pages`, `page_elements`, `page_links`, `app_briefs`)
re-keys from `(tenant_id, suite_id)` to `(tenant_id, app_id)`, where an **app**
is a tenant-owned row whose identity is its set of origins (`app_origins` — the
same table that implements `resolveCanonicalOrigin()` and B11's owner-configured
aliases). Suites keep owning tests, jobs, drafts, `tenant_brief`, and
`allow_synthetic_data`, and gain a sticky nullable `app_id` set on first analyze.

Three outcomes, which are the whole point:

1. **Every analyze permanently enriches one durable per-app model** — knowledge
   accumulates across all a tenant's suites instead of being trapped in one.
2. **A second website can never silently mix into a suite** — an explicit 409
   replaces today's silent corruption (brief synthesized over two sites, PLAN
   targeting site-A pages that VALIDATE against site-B's baseUrl).
3. **A second suite pointed at the same app reuses the entire classification
   cache** — the `content_hash` cache, imprisoned by suite keying today, is
   freed; the two dominant LLM costs of a re-analyze vanish.

Tenant RLS remains the absolute confidentiality boundary — and this spec makes
it real by adding `FORCE ROW LEVEL SECURITY`, which the current table-owner
deployment silently lacks (verified live: `relforcerowsecurity = f` on every
tenant table; isolation currently rests solely on query-level `tenant_id`
predicates).

## 1. Schema — migration 037_app_entity.sql

One transaction, additive, safe with old suite-keyed code still deployed (legacy
`UNIQUE (tenant_id, suite_id, url_normalized)` retained until 037).

```sql
CREATE TABLE IF NOT EXISTS apps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,                       -- display; defaults to canonical host
  canonical_origin TEXT NOT NULL,           -- names the app; B11 alias target
  last_crawled_at TIMESTAMPTZ,              -- P5 scheduling cursor
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, canonical_origin),
  UNIQUE (tenant_id, id)                    -- composite-FK target: cross-tenant app_id refs structurally impossible
);

CREATE TABLE IF NOT EXISTS app_origins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  app_id UUID NOT NULL,
  origin TEXT NOT NULL,                     -- exact origin, or validated glob for 'alias_pattern'
  kind TEXT NOT NULL DEFAULT 'exact' CHECK (kind IN ('canonical','exact','alias_pattern')),
  added_by UUID REFERENCES users(id),       -- alias_pattern: owner-configured ONLY, never auto-detected
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, origin),
  FOREIGN KEY (tenant_id, app_id) REFERENCES apps(tenant_id, id) ON DELETE CASCADE
);

-- RLS: copy the 029 DO-block tenant_isolation pattern for apps + app_origins.
-- FORCE it — the runtime role OWNS these tables, so plain RLS is inert:
ALTER TABLE apps        FORCE ROW LEVEL SECURITY;
ALTER TABLE app_origins FORCE ROW LEVEL SECURITY;
ALTER TABLE site_pages      FORCE ROW LEVEL SECURITY;   -- retrofit existing tables
ALTER TABLE page_elements   FORCE ROW LEVEL SECURITY;
ALTER TABLE page_links      FORCE ROW LEVEL SECURITY;
ALTER TABLE app_briefs      FORCE ROW LEVEL SECURITY;
ALTER TABLE generation_jobs FORCE ROW LEVEL SECURITY;

ALTER TABLE site_pages
  ADD COLUMN IF NOT EXISTS app_id UUID,
  ADD COLUMN IF NOT EXISTS is_canonical BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS origin TEXT,                  -- scopes MAINTAIN removed-detection + hasPublicObservation
  ADD COLUMN IF NOT EXISTS captured_scope TEXT NOT NULL DEFAULT 'public'
    CHECK (captured_scope IN ('public','authenticated'));
ALTER TABLE app_briefs
  ADD COLUMN IF NOT EXISTS app_id UUID,
  ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'public' CHECK (scope IN ('public','authenticated'));
ALTER TABLE generation_jobs ADD COLUMN IF NOT EXISTS app_id UUID;
ALTER TABLE test_suites     ADD COLUMN IF NOT EXISTS app_id UUID REFERENCES apps(id);
-- Composite FKs (tenant_id, app_id) REFERENCES apps(tenant_id, id) on site_pages/app_briefs
-- via DO-block (ADD CONSTRAINT IF NOT EXISTS is not a thing for FKs). site_pages FK: ON DELETE CASCADE.
-- page_elements / page_links: NO new columns — they reach app scope through page_id FKs.

-- New canonical identity (partial unique on is_canonical only, so ON CONFLICT infers the arbiter):
CREATE UNIQUE INDEX IF NOT EXISTS site_pages_app_url_canonical_key
  ON site_pages (tenant_id, app_id, url_normalized) WHERE is_canonical;
CREATE INDEX IF NOT EXISTS site_pages_app_idx ON site_pages (tenant_id, app_id);
CREATE INDEX IF NOT EXISTS app_briefs_app_idx ON app_briefs (tenant_id, app_id, version DESC);

-- DURABILITY NOW (not deferred to 037): suite deletion must stop destroying the pool.
ALTER TABLE site_pages ALTER COLUMN suite_id DROP NOT NULL;
ALTER TABLE app_briefs ALTER COLUMN suite_id DROP NOT NULL;
-- Recreate both suite_id FKs as ON DELETE SET NULL. suite_id remains as provenance.

-- Deploy-window trigger: BEFORE INSERT ON site_pages WHEN NEW.app_id IS NULL — stamp
-- origin + app_id from an exact app_origins match, set is_canonical=false when a canonical
-- (tenant, app, url) already exists, so old-code inserts never trip the new partial unique.
-- Dropped in 037.
```

### Backfill (idempotent; also `scripts/backfill-apps.ts` for re-runs)

Origin extraction is pinned **byte-for-byte against `normalizeUrl`** by a unit
test (ports, IDN, schemes, `_` hosts). Ordered steps:

1. Stamp `site_pages.origin` via `substring(url_normalized FROM '^[a-z][a-z0-9+.-]*://[^/]+')` (no `LIKE`).
2. Create `apps` from **page origins** (not `target_url` — a redirect must not fork the app).
3. Stamp pages by **exact** origin equality (single AND chain, no OR-precedence trap).
4. `captured_scope = 'authenticated'` where `requires_auth = true` (conservative: over-marking only narrows public prompts).
5. **Non-destructive** duplicate fold: per `(tenant, app, url)` group, `is_canonical=true` on `MAX(last_crawled_at)`; shadows get `false`, persist, purged only by 038 after verification.
6. `generation_jobs.app_id` from the suite's page origins; divergent `target_url` origins fold in as **extra `exact` app_origins on the same app**.
7. `app_briefs.app_id` via `generation_job_id → generation_jobs.app_id`; `scope` from the job.
8. `test_suites.app_id` = most recent generation job's `app_id`; NULL for never-analyzed suites.

### 038_app_entity_cutover.sql (after live verification)

Drop legacy `site_pages_tenant_id_suite_id_url_normalized_key`; renumber
colliding backfilled `(tenant, app, version)` briefs by `created_at`, then
`CREATE UNIQUE INDEX app_briefs_app_version_key`; `NOT VALID` CHECK that new
site_pages carry `app_id`; drop the deploy-window trigger. **038** (optional):
purge `is_canonical=false` shadows. Deliberately NOT in 036: per-app brief UNIQUE
(backfilled chains can share ordinals; the `pg_advisory_xact_lock` in
`saveAppBrief` prevents new duplicates from day one). Untouched: `vector(1536)` +
HNSW columns, `template_of`, migration 034's consent CHECK.

## 2. Read/write path changes

| File | Change |
|---|---|
| `site-model.repository.ts` | Methods re-signed `suiteId → appId` (suiteId kept as provenance value). `upsertPage`: **(1) stub guard** — an auth-wall capture (empty survey + `auth-wall:` content_hash) updates ONLY `requires_auth` + `last_crawled_at`, never content/classification/elements (attack 1); (2) adoption of the newest `app_id IS NULL` row for (tenant, url); (3) `ON CONFLICT (tenant_id, app_id, url_normalized) WHERE is_canonical DO UPDATE` — the requires_auth mode-dependence and content_hash purpose-NULLing CASE carry over verbatim; writes `origin` + `captured_scope`; (4) legacy-conflict retry: catch `unique_violation` on the old key, adopt, retry (attack 4). Reads (`listPagesNeedingClassification`, `listClassifiedPages`, `getLinkGraph`, `getGroundingElements`, `getFormSummaries`) → `WHERE app_id = $ AND is_canonical` (+ `captured_scope='public'` param for public jobs — attack 6). `hasPublicObservation(tenantId, appId, origin)`. `saveAppBrief`: `pg_advisory_xact_lock`, `COALESCE(MAX(version),0)+1` per (tenant, app), writes `scope`. New `touchAppCrawled`. |
| `src/api/routes/test-writer.ts` | `resolveCanonicalOrigin` (line 70) → async `resolveApp(tenantId, rawUrl)`: exact `app_origins` match, then owner-configured `alias_pattern` via a **code-level validator** (single leftmost-subdomain wildcard, tenant-literal remainder; bare-TLD/platform-wide rejected — attack 8), always inside `withTenantTransaction` (attack 2; also converts `checkLoginCase`'s bare `getPool()`). Analyze route: SSRF guard first → `resolveApp` → miss = auto-create (human sessions; CI/API-key miss = configure-the-alias error, no auto-create) → suite `app_id` NULL = bind, equal = proceed, different = **409 APP_MISMATCH**; `confirmSwitchApp` human-sessions-only. `checkLoginCase` upgrades origin string-equality to same-app membership. New endpoints: `GET /apps`, `GET /apps/:appId/brief`, `POST /apps/:appId/origins` (owner-only), `POST /apps/:appId/purge-authenticated-knowledge` (owner, Phase 2). |
| `pipeline.ts` | Row-authoritative `app_id` (never the payload — the consent pattern). `hasPublicObservation` sampled pre-crawl per (app, origin). **PLAN persists a grounding snapshot** into `test_plan`; WRITE consumes it, live-read fallback for vanished elements reported as staleness (attack 3 — also fixes pre-existing same-suite staleness). Redirect: landed root origin ≠ resolved → auto-add as `exact` origin, log. `loadExistingCaseNames/Steps` UNCHANGED (dedup stays suite-scoped). |
| `comprehend/classifier.ts`, `synthesizer.ts` | Take `appId`; public jobs read only `captured_scope='public'`; synthesizer short-circuits when zero hashes changed + zero new pages + a same-scope brief exists. |
| `plan/test-planner.ts` | No logic change — its filters now operate on the app-scoped set; cross-site targeting becomes structurally impossible. |
| `recon/crawler.ts` | Unchanged — same-origin BFS in memory, writes literal landed URLs (never canonicalized; B11 "CI never writes the canonical brain"). |
| `scripts/backfill-apps.ts` | Re-runnable §1 backfill; post-deploy NULL-app sweep. |

## 3. The two flows

**Same-suite, two apps.** Analyze A into suite S → app A auto-created, S.app_id
bound to A, knowledge under (tenant, A). Analyze B into S → `resolveApp` finds/
creates B, but `S.app_id = A ≠ B` → **409 APP_MISMATCH** ("This suite tests
app-a.com; analyzing b.com would re-point it to a different app"). On
`confirmSwitchApp:true` (human only): S.app_id → B; A's knowledge stays fully
intact and re-attachable — nothing deleted. Suite-owned things never move.

**Cross-suite, same app.** Suite 2 analyzes x.com (already app X from suite 1):
binds to X. **Reused** — the whole site model; unchanged `content_hash`
preserves classifications so per-page LLM calls are skipped; synthesis
short-circuits or appends a version to X's single chain; link graph and
requires_auth verdicts shared. **Not reused** — the crawl always re-runs
(elements must reflect the page NOW); PLAN/WRITE/VALIDATE always run (their
outputs are suite-scoped); `tenant_brief` and `allow_synthetic_data` stay
per-suite. The job report surfaces `reusedFromCache`; the UI attributes brief
versions to their originating suite/job so near-zero-work reads as reuse.

## 4. Auth & consent under the new keying

- **Consent stays strictly per-job.** Migration 034's CHECK is untouched; **no
  app-level or suite-level standing consent** — app keying makes the temptation
  stronger, so this is stated explicitly: knowledge reuse never implies consent
  reuse; a new authenticated crawl from any suite requires its own consent click
  and its own audited job row.
- **requires_auth partition survives and improves** — a public crawl from any
  suite verifies the partition app-wide; `hasPublicObservation` is per
  (app, origin) so an unrelated origin can't falsely suppress the warning.
- **Public crawls can't vandalize consented knowledge** (attack 1) — auth-wall
  stubs are merge-only; regression test asserts classifications+elements survive
  an auth-then-public sequence.
- **RLS becomes real** (attack 2) — `FORCE ROW LEVEL SECURITY`; all apps/
  app_origins access inside `withTenantTransaction`; composite tenant-scoped FKs;
  a real-Postgres test proves cross-tenant access fails under the runtime role.
- **Behind-login sharing is disclosed and retractable** (attack 6, **Decision 3
  accepted**) — `captured_scope` partitions authenticated captures out of
  public-job prompts; **the Tier-B redactor extends to ALL authenticated
  captures: value-bearing text (headings, cell/list content) is scrubbed,
  structural element names (roles, control labels) are kept** so grounding
  survives; consent copy amended; owner-gated purge endpoint restores the
  retraction path suite-deletion used to provide.
- **The alias table is locked down** (attacks 2, 8) — `alias_pattern` rows are
  owner-configured only, code-validated, never CI-auto-created; every
  pattern-matched resolution is logged.

## 5. Decisions (all accepted 2026-08-12 — recorded as binding)

1. **Second website into a bound suite → hard 409 with human-only override.**
   Multi-app suites foreclosed; every knowledge surface assumes one app per
   suite; "make a new suite" is the honest answer.
2. **Ship v1 without `POST /apps/:appId/merge`.** Redirect auto-adoption +
   backfill folding cover the apex/www case; merge is the most dangerous admin
   op and waits for observed fragmentation, with its own test suite.
3. **Tier-B redactor extends to all authenticated captures** — scrub
   value-bearing text, keep structural names (see §4).
4. **No `options.reuseFreshCrawl` in v1.** Classification + synthesis reuse
   already removes the dominant cost; keep the honest "elements never trusted
   across crawls" default; revisit when P5 gives freshness a UI.
5. ~~**Runtime DB user stays table-owner for now; FORCE RLS closes the hole.**~~
   **CORRECTED 2026-08-17 — the premise was wrong, and the decision it produced
   does not hold.**

   This was written believing the runtime connects as the tables' *owner*, for
   which `FORCE ROW LEVEL SECURITY` is indeed the fix. It does not: on the dev
   stack it connects as **`kaizen`, a SUPERUSER** (`rolsuper = t`, verified
   live). Postgres exempts superusers and `BYPASSRLS` roles from row-level
   security **unconditionally — FORCE included**. So FORCE alone closes nothing.

   Measured, same query, no `WHERE` clause, on the dev database with FORCE
   already applied:

   | connected as | rows returned from `site_pages` |
   |---|---|
   | `kaizen` (superuser, the runtime role) | **59 — every tenant's** |
   | an unprivileged role | 30 — exactly the current tenant's |

   The mechanism is sound and now proven (`src/db/__tests__/tenant-isolation.integration.test.ts`
   passes every isolation assertion under an unprivileged role, including
   refusing a cross-tenant INSERT). What is missing is that the application does
   not use it.

   **Revised decision: a non-superuser, non-owner runtime role is REQUIRED, not
   a later hardening task.** It is the whole of the work, not the polish on it.
   Until it lands, "tenant isolation is enforced by the database" remains false
   and must not be said to anyone — an enterprise security review included.
   Migration 036 ships anyway because it is a genuine prerequisite and is inert
   rather than risky, but it must not be reported as the fix.

   Provisioning is the real cost, and it is why this needs a decision rather
   than a commit: a new role must exist in dev compose, in CI, and in the
   production database, with grants on every current and future table
   (`ALTER DEFAULT PRIVILEGES`), before the app's connection string can change —
   and a mistake in that order locks the product out of its own database.

## 6. B11 / P5 hooks

**B11**: `apps` is the stable canonical identity spanning origins and branches;
`app_origins.alias_pattern` is the owner-configured alias table at the
`resolveCanonicalOrigin` seam; CI authenticated jobs against preview deploys
pass the login-case gate via same-app membership; selector pre-seeding derives
`selector_cache.domain` from `apps.canonical_origin`; the repo↔app handshake
maps one repo → N apps.

**P5**: `content_hash` per `(tenant, app, url)` gives re-crawl diffing a durable
identity surviving suite deletion; MAINTAIN schedules per app off
`apps.last_crawled_at` (one re-crawl serves every suite); the coverage endpoint
(spec-findings-and-coverage.md §4) becomes `WHERE app_id = suite.app_id AND
is_canonical`, one FK hop.

## 7. Phasing

- **Phase 1 — 036 + code cutover** (independently shippable). Apply 036 to dev
  Postgres (migration-before-code), cross-note. Ship repository/pipeline/routes/
  types + `scripts/backfill-apps.ts` + tests. Mid-way states all safe: 036
  without code = legacy behavior (legacy UNIQUE intact, trigger pre-stamps, FORCE
  RLS invisible to correct code); code without 036 = forbidden by
  migration-before-code. Post-deploy: backfill sweep, then live dogfood on prod
  (incl. the YouTube rows): one app per origin; second suite → ~0 reclassify;
  different site → 409; auth-then-public → knowledge survives.
- **Phase 2 — retraction + cutover.** Ship the purge endpoint **first**, then
  apply 037. Ordering deliberate: purge must exist before suite-deletion stops
  being a retraction mechanism.
- **Phase 3 — cleanup (optional).** 038 shadow purge; retire the `is_canonical`
  filter audit to a plain invariant.
- **UX (parallel PRs):** 409 modal + `confirmSwitchApp`; AppBriefCard
  canonical_origin subtitle + per-version provenance + "last crawled N days ago";
  `reusedFromCache` copy; consent-modal amendment. Phase 1 ships without them
  (the 409 returns a clear body meanwhile), but the modal + provenance land
  before announcing cross-suite reuse.

## 8. Test list

Resolver exact/pattern/miss + validator rejections; adoption + legacy-conflict
retry; canonical upsert idempotence across two suites; 409 + confirmSwitchApp
human-only; **auth crawl → public crawl → classifications/elements survive**
(attack-1 regression); requires_auth merge under app key; backfill idempotence +
origin-regex pin; **real-Postgres cross-tenant app_origins SELECT/INSERT denial
under the runtime role**; seeded-shadow double-count. The module-graph isolation
test (no Test-Writer path to shared pool) is unchanged and still enforced.

## 9. Spec amendments this requires (done alongside)

- `spec-comprehension-knowledge-model.md`: `app_briefs` "suite-scoped" →
  "app-scoped, suite-linked"; the embeddings note (never populated — out of the
  hot path pending the archetype-fleet work).
- `spec-test-writer-service.md` §6 (data model + isolation): the app_id keying.
- `spec-recon-crawler.md`: idempotency key `(tenant, app, url)`.
- `spec-authenticated-scope.md`: §3.1 origin gate → app-membership gate; §11
  consent copy ("signed-in captures enrich this workspace's shared model of this
  app and are reusable from any suite").
