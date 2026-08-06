import { createHash } from 'crypto';
import type { PoolClient } from 'pg';
import { withTenantTransaction } from '../../db/transaction';
import type { PageCapture } from './interfaces';
import type { AppBrief, GroundingElement, Journey } from '../../types/test-writer';

/**
 * Site-model persistence — tenant-isolated writes to site_pages /
 * page_elements / page_links (migration 029).
 * Spec refs: docs/specs/test-writer/spec-comprehension-knowledge-model.md §5,
 *            docs/specs/test-writer/spec-recon-crawler.md §7
 *
 * ISOLATION INVARIANT: every write goes through withTenantTransaction (RLS)
 * with tenant_id set explicitly. This module — and the whole test-writer
 * module graph — must never import the shared-pool seeding path or write
 * selector_cache rows. Enforced by a unit test on the module graph.
 */

const KIND_BY_ROLE: Record<string, 'link' | 'button' | 'input' | 'select'> = {
  link: 'link',
  button: 'button',
  textbox: 'input',
  searchbox: 'input',
  spinbutton: 'input',
  checkbox: 'input',
  radio: 'input',
  switch: 'input',
  combobox: 'select',
  listbox: 'select',
};

function kindOf(role: string): 'link' | 'button' | 'input' | 'select' | 'other' {
  return KIND_BY_ROLE[role] ?? 'other';
}

function elementHash(role: string, name: string, selector: string): string {
  return createHash('sha256').update(`${role}|${name}|${selector}`).digest('hex');
}

export class SiteModelRepository {
  /**
   * Upsert one crawled page and replace its element rows. Idempotent per
   * (tenant, suite, url) — a re-crawl refreshes content_hash/last_crawled_at.
   * Returns the page id.
   */
  async upsertPage(
    tenantId: string,
    suiteId: string,
    capture: PageCapture & { axOutline?: Record<string, unknown> },
  ): Promise<string> {
    return withTenantTransaction(tenantId, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO site_pages (
           tenant_id, suite_id, url_normalized, title, headings, ax_outline,
           content_hash, requires_auth, screenshot_key, last_crawled_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
         ON CONFLICT (tenant_id, suite_id, url_normalized) DO UPDATE SET
           title = EXCLUDED.title,
           headings = EXCLUDED.headings,
           ax_outline = EXCLUDED.ax_outline,
           content_hash = EXCLUDED.content_hash,
           requires_auth = EXCLUDED.requires_auth,
           screenshot_key = COALESCE(EXCLUDED.screenshot_key, site_pages.screenshot_key),
           last_crawled_at = now(),
           -- content_hash-keyed classification cache: a re-crawl only invalidates
           -- the LLM classification of pages whose AX outline actually changed.
           -- Unchanged pages keep their purpose and are skipped by COMPREHEND.
           purpose = CASE WHEN EXCLUDED.content_hash IS DISTINCT FROM site_pages.content_hash
                          THEN NULL ELSE site_pages.purpose END,
           purpose_tag = CASE WHEN EXCLUDED.content_hash IS DISTINCT FROM site_pages.content_hash
                          THEN NULL ELSE site_pages.purpose_tag END,
           capabilities = CASE WHEN EXCLUDED.content_hash IS DISTINCT FROM site_pages.content_hash
                          THEN NULL ELSE site_pages.capabilities END
         RETURNING id`,
        [
          tenantId, suiteId, capture.urlNormalized, capture.title || null,
          capture.headings, capture.axOutline ?? null, capture.contentHash,
          capture.requiresAuth, capture.screenshotKey,
        ],
      );
      const pageId = rows[0].id;

      // Replace-all element rows: the crawl is the source of truth for what is
      // on the page NOW; stale elements would poison grounding in WRITE.
      await client.query(`DELETE FROM page_elements WHERE page_id = $1 AND tenant_id = $2`,
        [pageId, tenantId]);

      for (const c of capture.survey) {
        await insertElement(client, tenantId, pageId, {
          role: c.role, name: c.name, kind: kindOf(c.role),
          selector: c.cssSelector, attributes: c.attributes, revealedBy: null,
        });
      }
      for (const reveal of capture.revealedStates) {
        for (const el of reveal.revealedElements) {
          await insertElement(client, tenantId, pageId, {
            role: el.role, name: el.name, kind: kindOf(el.role),
            selector: null, attributes: null, revealedBy: reveal.trigger.name || reveal.trigger.role,
          });
        }
      }
      for (const form of capture.forms) {
        await insertElement(client, tenantId, pageId, {
          role: 'form', name: form.label || form.submitLabel || 'form', kind: 'form',
          selector: null,
          attributes: {
            submitLabel: form.submitLabel,
            fields: JSON.stringify(form.fields),
          },
          revealedBy: null,
        });
      }

      return pageId;
    });
  }

  /**
   * Insert navigation edges for every (from → to) pair where BOTH pages were
   * captured this crawl. via_element_id links the from-page anchor element by
   * accessible name when one matches; NULL otherwise.
   */
  async insertLinks(
    tenantId: string,
    suiteId: string,
    edges: Array<{ fromUrl: string; toUrl: string; viaElementName: string }>,
  ): Promise<number> {
    if (edges.length === 0) return 0;
    return withTenantTransaction(tenantId, async (client) => {
      let inserted = 0;
      for (const edge of edges) {
        const { rowCount } = await client.query(
          `INSERT INTO page_links (tenant_id, from_page_id, to_page_id, via_element_id)
           SELECT $1, f.id, t.id,
                  (SELECT pe.id FROM page_elements pe
                   WHERE pe.page_id = f.id AND pe.tenant_id = $1
                     AND pe.kind = 'link' AND pe.name = $5
                   LIMIT 1)
           FROM site_pages f, site_pages t
           WHERE f.tenant_id = $1 AND f.suite_id = $2 AND f.url_normalized = $3
             AND t.tenant_id = $1 AND t.suite_id = $2 AND t.url_normalized = $4
           ON CONFLICT (from_page_id, to_page_id, via_element_id) DO NOTHING`,
          [tenantId, suiteId, edge.fromUrl, edge.toUrl, edge.viaElementName],
        );
        inserted += rowCount ?? 0;
      }
      return inserted;
    });
  }

  // ─── COMPREHEND ───────────────────────────────────────────────────────────

  /**
   * Pages that still need LLM classification: never classified, or re-crawled
   * with a changed content_hash (upsertPage nulls purpose in that case — the
   * content_hash-keyed classification cache). Blocked pages are excluded.
   */
  async listPagesNeedingClassification(
    tenantId: string, suiteId: string,
  ): Promise<UnclassifiedPage[]> {
    return withTenantTransaction(tenantId, async (client) => {
      const { rows } = await client.query<{
        id: string; url_normalized: string; title: string | null;
        headings: string[] | null; ax_outline: UnclassifiedPage['axOutline'];
        requires_auth: boolean;
      }>(
        `SELECT id, url_normalized, title, headings, ax_outline, requires_auth
         FROM site_pages
         WHERE tenant_id = $1 AND suite_id = $2 AND purpose IS NULL
           AND ax_outline IS NOT NULL
         ORDER BY first_seen_at`,
        [tenantId, suiteId],
      );
      return rows.map((r) => ({
        id: r.id,
        urlNormalized: r.url_normalized,
        title: r.title ?? '',
        headings: r.headings ?? [],
        axOutline: r.ax_outline,
        requiresAuth: r.requires_auth,
        blocked: false,
      }));
    });
  }

  async saveClassification(
    tenantId: string,
    pageId: string,
    classification: { purpose: string; purposeTag: string; capabilities: string[]; entities: string[] },
  ): Promise<void> {
    await withTenantTransaction(tenantId, async (client) => {
      await client.query(
        `UPDATE site_pages
         SET purpose = $3, purpose_tag = $4, capabilities = $5, entities = $6
         WHERE id = $1 AND tenant_id = $2`,
        [pageId, tenantId, classification.purpose, classification.purposeTag,
          JSON.stringify(classification.capabilities), classification.entities],
      );
    });
  }

  async listClassifiedPages(tenantId: string, suiteId: string): Promise<ClassifiedPage[]> {
    return withTenantTransaction(tenantId, async (client) => {
      const { rows } = await client.query<{
        id: string; url_normalized: string; title: string | null; purpose: string;
        purpose_tag: string | null; capabilities: string[] | null; requires_auth: boolean;
      }>(
        `SELECT id, url_normalized, title, purpose, purpose_tag, capabilities, requires_auth
         FROM site_pages
         WHERE tenant_id = $1 AND suite_id = $2 AND purpose IS NOT NULL
         ORDER BY first_seen_at`,
        [tenantId, suiteId],
      );
      return rows.map((r) => ({
        id: r.id,
        urlNormalized: r.url_normalized,
        title: r.title ?? '',
        purpose: r.purpose,
        purposeTag: r.purpose_tag ?? 'other',
        capabilities: Array.isArray(r.capabilities) ? r.capabilities : [],
        requiresAuth: r.requires_auth,
      }));
    });
  }

  /** Navigation adjacency for the suite: urlNormalized → urlNormalized[]. */
  async getLinkGraph(tenantId: string, suiteId: string): Promise<Record<string, string[]>> {
    return withTenantTransaction(tenantId, async (client) => {
      const { rows } = await client.query<{ from_url: string; to_url: string }>(
        `SELECT f.url_normalized AS from_url, t.url_normalized AS to_url
         FROM page_links pl
         JOIN site_pages f ON f.id = pl.from_page_id
         JOIN site_pages t ON t.id = pl.to_page_id
         WHERE pl.tenant_id = $1 AND f.suite_id = $2 AND t.suite_id = $2`,
        [tenantId, suiteId],
      );
      const graph: Record<string, string[]> = {};
      for (const r of rows) {
        (graph[r.from_url] ??= []).push(r.to_url);
      }
      return graph;
    });
  }

  /** Insert a new App Brief version (versions are kept for re-crawl diffing). */
  async saveAppBrief(
    tenantId: string, suiteId: string, brief: AppBrief, generationJobId: string,
  ): Promise<number> {
    return withTenantTransaction(tenantId, async (client) => {
      const { rows } = await client.query<{ version: number }>(
        `INSERT INTO app_briefs (
           tenant_id, suite_id, version, app_type, summary, core_entities, journeys, generation_job_id
         )
         SELECT $1, $2,
                COALESCE(MAX(version), 0) + 1,
                $3, $4, $5, $6, $7
         FROM app_briefs WHERE tenant_id = $1 AND suite_id = $2
         RETURNING version`,
        [tenantId, suiteId, brief.appType, brief.summary, brief.coreEntities,
          JSON.stringify(brief.journeys), generationJobId],
      );
      return rows[0].version;
    });
  }

  async getLatestAppBrief(tenantId: string, suiteId: string): Promise<AppBrief | null> {
    return withTenantTransaction(tenantId, async (client) => {
      const { rows } = await client.query<{
        app_type: string | null; summary: string | null;
        core_entities: string[] | null; journeys: Journey[] | null;
      }>(
        `SELECT app_type, summary, core_entities, journeys
         FROM app_briefs WHERE tenant_id = $1 AND suite_id = $2
         ORDER BY version DESC LIMIT 1`,
        [tenantId, suiteId],
      );
      if (rows.length === 0) return null;
      return {
        appType: rows[0].app_type ?? '',
        summary: rows[0].summary ?? '',
        coreEntities: rows[0].core_entities ?? [],
        journeys: Array.isArray(rows[0].journeys) ? rows[0].journeys : [],
      };
    });
  }

  // ─── WRITE grounding ──────────────────────────────────────────────────────

  /**
   * Citable elements for a set of pages — the ONLY elements a generated step
   * may reference. The selector rides along but never reaches a prompt: it
   * exists to pre-seed the tenant's selector cache so the proving run doesn't
   * pay the model to rediscover what the crawl already found (§5.2).
   */
  async getGroundingElements(
    tenantId: string, suiteId: string, urls: string[], perPageCap = 40,
  ): Promise<GroundingElement[]> {
    if (urls.length === 0) return [];
    return withTenantTransaction(tenantId, async (client) => {
      const { rows } = await client.query<{
        id: string; page_url: string; role: string; name: string;
        kind: string; revealed_by: string | null; selector: string | null; rn: string;
      }>(
        `SELECT id, page_url, role, name, kind, revealed_by, selector, rn FROM (
           SELECT pe.id, sp.url_normalized AS page_url, pe.role, pe.name, pe.kind,
                  pe.revealed_by, pe.selector,
                  ROW_NUMBER() OVER (PARTITION BY pe.page_id ORDER BY pe.kind, pe.name) AS rn
           FROM page_elements pe
           JOIN site_pages sp ON sp.id = pe.page_id
           WHERE pe.tenant_id = $1 AND sp.suite_id = $2
             AND sp.url_normalized = ANY($3::text[])
             AND pe.name <> ''
         ) ranked
         WHERE rn <= $4`,
        [tenantId, suiteId, urls, perPageCap],
      );
      return rows.map((r) => ({
        id: r.id,
        pageUrl: r.page_url,
        role: r.role,
        name: r.name,
        kind: r.kind,
        revealedBy: r.revealed_by,
        selector: r.selector,
      }));
    });
  }

  /** Raw form outlines for the given pages, as prompt-ready summary lines. */
  async getFormSummaries(tenantId: string, suiteId: string, urls: string[]): Promise<string[]> {
    if (urls.length === 0) return [];
    return withTenantTransaction(tenantId, async (client) => {
      const { rows } = await client.query<{ ax_outline: UnclassifiedPage['axOutline'] }>(
        `SELECT ax_outline FROM site_pages
         WHERE tenant_id = $1 AND suite_id = $2 AND url_normalized = ANY($3::text[])`,
        [tenantId, suiteId, urls],
      );
      return rows.flatMap((r) => formSummaryLines(r.ax_outline));
    });
  }
}

// ─── COMPREHEND / PLAN / WRITE read paths ───────────────────────────────────

export type UnclassifiedPage = {
  id: string;
  urlNormalized: string;
  title: string;
  headings: string[];
  axOutline: { elements?: Array<{ role: string; name: string }>; forms?: FormOutline[] } | null;
  requiresAuth: boolean;
  blocked: boolean;
};

type FormOutline = {
  label: string;
  submitLabel: string;
  fields: Array<{ label: string; type: string; required: boolean }>;
};

export type ClassifiedPage = {
  id: string;
  urlNormalized: string;
  title: string;
  purpose: string;
  purposeTag: string;
  capabilities: string[];
  requiresAuth: boolean;
};

/** Formats a page's captured forms as prompt lines: `login form: email, password, [Sign in]`. */
export function formSummaryLines(outline: UnclassifiedPage['axOutline']): string[] {
  return (outline?.forms ?? []).map((f) => {
    const fields = f.fields.map((fd) => fd.label || fd.type).filter(Boolean).join(', ');
    const submit = f.submitLabel ? ` [${f.submitLabel}]` : '';
    return `${f.label || 'form'}: ${fields}${submit}`;
  });
}

/** Formats a page's surveyed elements as prompt lines: `button: "Sign in"`. */
export function elementDigestLines(outline: UnclassifiedPage['axOutline']): string[] {
  return (outline?.elements ?? [])
    .filter((e) => e.name)
    .map((e) => `${e.role}: "${e.name}"`);
}

async function insertElement(
  client: PoolClient,
  tenantId: string,
  pageId: string,
  el: {
    role: string; name: string; kind: string;
    selector: string | null;
    attributes: Record<string, string> | null;
    revealedBy: string | null;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO page_elements (
       tenant_id, page_id, role, name, kind, selector, attributes, revealed_by, content_hash, last_seen_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())`,
    [
      tenantId, pageId, el.role, el.name, el.kind, el.selector,
      el.attributes ? JSON.stringify(el.attributes) : null, el.revealedBy,
      elementHash(el.role, el.name, el.selector ?? ''),
    ],
  );
}
