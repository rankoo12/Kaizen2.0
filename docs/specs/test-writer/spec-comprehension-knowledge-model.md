# Spec — Comprehension & Site Knowledge Model (Phase 2: data → understanding)

Created: 2026-07-29
Branch: `feat/test-writer/p0-specs`
Status: Draft — design agreed; implementation not started.

> Companion to `spec-test-writer-service.md`. Consumes RECON's `PageCapture`s
> (`spec-recon-crawler.md`); produces the Site Knowledge that PLAN/WRITE
> (`spec-generation-pipeline.md`) read. Migration: `029_site_model.sql`.

## 1. What "knowing the system" means

Raw crawl data is not knowledge. The comprehension phase turns captures into
the two representations a QA engineer actually uses:

1. **The structured graph** — pages, elements, navigation edges. Machine-
   queryable: coverage joins, re-crawl diffing, element grounding for step
   generation. Lives in Postgres + pgvector.
2. **The semantic layer** — what each page is *for*, what a user *can do*
   there, and what the app *is*: the **App Brief** with inferred user
   journeys. This is the onboarding document a QA engineer writes for
   themselves; it is the context handed to test planning.

Both are required. The graph alone can't reason ("which flows matter?"); the
brief alone can't be measured or diffed.

## 2. Per-page classification

`comprehend/classifier.ts`. One small LLM call per page (parallelizable,
batched), via a new gateway method:

```ts
// ILLMGateway
classifyPage(input: PageClassifyInput, tenantId: string): Promise<PageClassification>;

type PageClassifyInput = {
  urlNormalized: string; title: string; headings: string[];
  formSummaries: string[];        // "login form: email, password, [Sign in]"
  elementDigest: string[];        // top surveyed elements as "role: name" lines
  revealedDigest: string[];       // states found by probing
};

type PageClassification = {
  purpose: string;                // "login page" | "product listing" | "checkout step 2" | ...
  purposeTag:                     // coarse enum for querying
    | 'landing' | 'auth' | 'listing' | 'detail' | 'form' | 'checkout'
    | 'dashboard' | 'settings' | 'search' | 'content' | 'error' | 'other';
  capabilities: string[];         // "user can search products", "user can add item to cart"
  entities: string[];             // "product", "cart", "order"
};
```

Results are stored on `site_pages` (purpose, purpose_tag, capabilities JSONB)
plus a page-purpose embedding (`text-embedding-3-small` over
`title + purpose + capabilities`) for similarity queries ("find pages like the
checkout").

## 3. Whole-app synthesis — the App Brief

`comprehend/synthesizer.ts`. One larger LLM call over ALL classifications +
the nav graph (adjacency list of `purposeTag`-annotated pages):

```ts
// ILLMGateway
synthesizeAppBrief(input: AppBriefInput, tenantId: string): Promise<AppBrief>;

type AppBrief = {
  appType: string;                // "e-commerce storefront", "SaaS project tracker"
  summary: string;                // 2–4 sentences: what the app is and does
  coreEntities: string[];         // "product", "cart", "order", "account"
  journeys: Journey[];
};

type Journey = {
  name: string;                   // "Purchase", "Account signup"
  description: string;
  pagePath: string[];             // ordered urlNormalized values, verified against page_links
  requiresAuth: boolean;
  priority: 'critical' | 'high' | 'normal';
};
```

**Journey verification**: every `pagePath` returned by the LLM is checked
against the `page_links` graph — each consecutive pair must have an edge (or
both be reachable within one hop). Unverifiable journeys are dropped and
recorded in the job report; the LLM proposes, the graph disposes. This is the
false-pass firewall applied to knowledge: Kaizen never "knows" a journey the
crawler didn't actually observe.

Stored in `app_briefs` (suite-scoped, versioned — each recon produces a new
version; the latest is current, history kept for diffing).

## 4. Path templating (v1.5, noted now)

Concrete URLs like `/product/42` and `/product/43` produce near-identical
classifications. v1 keeps them as separate pages (crawl budget limits the
blowup). v1.5: post-classification clustering — pages sharing `purposeTag` +
high embedding similarity + a common path prefix collapse into a template page
(`/product/:id`) with exemplar links. The schema anticipates this
(`site_pages.template_of` self-reference, nullable, unused in v1).

## 5. Schema (migration `029_site_model.sql`)

```sql
CREATE TABLE site_pages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  suite_id        UUID NOT NULL REFERENCES test_suites(id) ON DELETE CASCADE,
  url_normalized  TEXT NOT NULL,
  title           TEXT,
  headings        TEXT[],
  purpose         TEXT,
  purpose_tag     TEXT CHECK (purpose_tag IN ('landing','auth','listing','detail','form',
                    'checkout','dashboard','settings','search','content','error','other')),
  capabilities    JSONB,
  entities        TEXT[],
  ax_outline      JSONB,              -- condensed survey snapshot
  content_hash    TEXT NOT NULL,      -- re-crawl diffing
  requires_auth   BOOLEAN NOT NULL DEFAULT false,
  screenshot_key  TEXT,
  embedding       vector(1536),
  template_of     UUID REFERENCES site_pages(id),   -- v1.5, NULL in v1
  first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_crawled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, suite_id, url_normalized)
);

CREATE TABLE page_elements (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id),
  page_id       UUID NOT NULL REFERENCES site_pages(id) ON DELETE CASCADE,
  role          TEXT NOT NULL,
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('link','button','input','select','form','other')),
  selector      TEXT,
  attributes    JSONB,
  revealed_by   TEXT,               -- NULL = visible on load; else the probe that revealed it
  content_hash  TEXT NOT NULL,
  embedding     vector(1536),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE page_links (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  from_page_id    UUID NOT NULL REFERENCES site_pages(id) ON DELETE CASCADE,
  to_page_id      UUID NOT NULL REFERENCES site_pages(id) ON DELETE CASCADE,
  via_element_id  UUID REFERENCES page_elements(id),
  UNIQUE (from_page_id, to_page_id, via_element_id)
);

CREATE TABLE app_briefs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id),
  suite_id    UUID NOT NULL REFERENCES test_suites(id) ON DELETE CASCADE,
  version     INT NOT NULL,
  app_type    TEXT,
  summary     TEXT,
  core_entities TEXT[],
  journeys    JSONB NOT NULL,
  generation_job_id UUID,           -- FK added in 028's table; nullable
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, suite_id, version)
);
```

All tables: RLS `tenant_isolation` policy (`app.current_tenant_id` pattern),
`(tenant_id, suite_id)` indexes, HNSW `vector_cosine_ops` indexes on the
embedding columns (matching migrations 003/004 style).

**Isolation invariant**: no code writes these tables without `tenant_id`; no
Test Writer code path writes `selector_cache` shared rows. See
spec-recon-crawler.md §7.

## 6. Re-crawl diffing (P5 consumer, designed now)

A re-crawl of the same suite:
- Page with changed `content_hash` → `changed`; new URL → `added`; previously
  known URL now 404/absent from graph → `removed` (soft: `last_crawled_at`
  goes stale; a page missing from 2 consecutive crawls is `removed`).
- Diff output feeds PLAN (new tests for added/changed pages) and the stale-test
  flagger (cases whose steps reference removed pages).
- Coverage map is a QUERY, not a table: `site_pages` LEFT JOIN pages touched by
  active cases (via validation/real runs' navigate + `assert_url` events in
  `run_events`), exposed as `GET /suites/:id/coverage`. Materialize only if slow.

## 7. Testing

- Classifier/synthesizer: golden-file tests with recorded `PageCapture`
  fixtures (mock gateway) — assert schema validity + journey verification
  drops a fabricated path.
- Journey verification: unit test — LLM returns a `pagePath` with a missing
  edge → journey dropped and reported.
- Live (P2 exit): recon + comprehend a real demo storefront → App Brief
  identifies app type and produces ≥ 2 graph-verified journeys.
