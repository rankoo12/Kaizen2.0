-- =============================================================================
-- Kaizen — Site Knowledge model (Test Writer RECON/COMPREHEND output)
-- Migration: 029_site_model
-- Spec ref: docs/specs/test-writer/spec-comprehension-knowledge-model.md §5
--
-- Per-tenant, per-suite model of the application under test: pages, elements,
-- navigation edges, and the synthesized App Brief. Strictly tenant-isolated —
-- no relationship to the shared/global selector pool by design.
-- =============================================================================

CREATE TABLE IF NOT EXISTS site_pages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  suite_id        UUID NOT NULL REFERENCES test_suites(id) ON DELETE CASCADE,
  url_normalized  TEXT NOT NULL,          -- origin + path; query/fragment stripped
  title           TEXT,
  headings        TEXT[],
  purpose         TEXT,                   -- LLM-classified: "login page", "checkout step 2"
  purpose_tag     TEXT
                    CHECK (purpose_tag IN ('landing', 'auth', 'listing', 'detail', 'form',
                      'checkout', 'dashboard', 'settings', 'search', 'content', 'error', 'other')),
  capabilities    JSONB,                  -- ["user can search products", ...]
  entities        TEXT[],
  ax_outline      JSONB,                  -- condensed element survey snapshot
  content_hash    TEXT NOT NULL,          -- SHA-256 of ax_outline — re-crawl diffing
  requires_auth   BOOLEAN NOT NULL DEFAULT false,
  screenshot_key  TEXT,
  embedding       vector(1536),           -- page-purpose embedding
  template_of     UUID REFERENCES site_pages(id),  -- v1.5 path templating; NULL in v1
  first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_crawled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, suite_id, url_normalized)
);

CREATE INDEX IF NOT EXISTS site_pages_suite_idx
  ON site_pages (tenant_id, suite_id);
CREATE INDEX IF NOT EXISTS site_pages_embedding_idx
  ON site_pages USING hnsw (embedding vector_cosine_ops);

CREATE TABLE IF NOT EXISTS page_elements (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES tenants(id),
  page_id      UUID NOT NULL REFERENCES site_pages(id) ON DELETE CASCADE,
  role         TEXT NOT NULL,
  name         TEXT NOT NULL,
  kind         TEXT NOT NULL
                 CHECK (kind IN ('link', 'button', 'input', 'select', 'form', 'other')),
  selector     TEXT,
  attributes   JSONB,
  revealed_by  TEXT,                      -- NULL = visible on load; else the probe description
  content_hash TEXT NOT NULL,
  embedding    vector(1536),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS page_elements_page_idx
  ON page_elements (tenant_id, page_id);
CREATE INDEX IF NOT EXISTS page_elements_embedding_idx
  ON page_elements USING hnsw (embedding vector_cosine_ops);

CREATE TABLE IF NOT EXISTS page_links (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL REFERENCES tenants(id),
  from_page_id   UUID NOT NULL REFERENCES site_pages(id) ON DELETE CASCADE,
  to_page_id     UUID NOT NULL REFERENCES site_pages(id) ON DELETE CASCADE,
  via_element_id UUID REFERENCES page_elements(id) ON DELETE SET NULL,
  UNIQUE (from_page_id, to_page_id, via_element_id)
);

CREATE INDEX IF NOT EXISTS page_links_from_idx ON page_links (tenant_id, from_page_id);

CREATE TABLE IF NOT EXISTS app_briefs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id),
  suite_id          UUID NOT NULL REFERENCES test_suites(id) ON DELETE CASCADE,
  version           INT NOT NULL,
  app_type          TEXT,
  summary           TEXT,
  core_entities     TEXT[],
  journeys          JSONB NOT NULL,       -- Journey[] — graph-verified page paths
  generation_job_id UUID REFERENCES generation_jobs(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, suite_id, version)
);

CREATE INDEX IF NOT EXISTS app_briefs_suite_idx
  ON app_briefs (tenant_id, suite_id, version DESC);

-- Row-level security: tenant isolation on all four tables.
ALTER TABLE site_pages    ENABLE ROW LEVEL SECURITY;
ALTER TABLE page_elements ENABLE ROW LEVEL SECURITY;
ALTER TABLE page_links    ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_briefs    ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['site_pages', 'page_elements', 'page_links', 'app_briefs']
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies WHERE tablename = t AND policyname = 'tenant_isolation'
    ) THEN
      EXECUTE format(
        'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_setting(''app.current_tenant_id'')::uuid)',
        t
      );
    END IF;
  END LOOP;
END$$;
