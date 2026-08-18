import { createHash } from 'crypto';
import type { PoolClient } from 'pg';
import { withTenantTransaction } from '../../db/transaction';
import type { PageCapture } from './interfaces';
import type { AppBrief, GroundingElement, Journey, PageDossier } from '../../types/test-writer';
import { deriveName } from './recon/derived-name';

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
    // requires_auth semantics are mode-dependent (spec-authenticated-scope.md §5.3).
    //
    // Public scope: the fresh public observation is authoritative in both
    // directions — a formerly-walled page that is now public flips to false.
    //
    // Authenticated scope: an authenticated crawl visits genuinely public pages
    // (home, pricing) through the same BFS, so overwriting with `true` would
    // mislabel them. Preserve any prior verdict and default only NEW rows to
    // true. Erring toward private is the only acceptable direction: a private
    // page mislabeled public would leak into public-scope plans, while a public
    // page mislabeled private merely narrows planning.
    //
    // Blocked captures are excluded entirely. blockedCapture() hardcodes
    // requiresAuth:false, so a challenge or robots block during an authenticated
    // re-crawl would otherwise flip a correctly-private page to public — a page
    // nobody could read is evidence about the crawl, not about the page.
    const requiresAuthSql = capture.blocked
      ? 'site_pages.requires_auth'
      : capture.requiresAuth
        ? 'site_pages.requires_auth AND EXCLUDED.requires_auth'
        : 'EXCLUDED.requires_auth';

    return withTenantTransaction(tenantId, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO site_pages (
           tenant_id, suite_id, url_normalized, title, headings, ax_outline,
           content_hash, requires_auth, screenshot_key, page_text, url_observed, last_crawled_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())
         ON CONFLICT (tenant_id, suite_id, url_normalized) DO UPDATE SET
           title = EXCLUDED.title,
           headings = EXCLUDED.headings,
           ax_outline = EXCLUDED.ax_outline,
           content_hash = EXCLUDED.content_hash,
           requires_auth = ${requiresAuthSql},
           screenshot_key = COALESCE(EXCLUDED.screenshot_key, site_pages.screenshot_key),
           page_text = COALESCE(EXCLUDED.page_text, site_pages.page_text),
           url_observed = COALESCE(EXCLUDED.url_observed, site_pages.url_observed),
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
          capture.requiresAuth, capture.screenshotKey, capture.pageText || null,
          capture.urlObserved || null,
        ],
      );
      const pageId = rows[0].id;

      // Replace-all element rows: the crawl is the source of truth for what is
      // on the page NOW; stale elements would poison grounding in WRITE.
      await client.query(`DELETE FROM page_elements WHERE page_id = $1 AND tenant_id = $2`,
        [pageId, tenantId]);

      for (const c of capture.survey) {
        // No accessible name → the developer's own handle for it (id, data-test,
        // …), marked as derived so the a11y finding still counts it (spec-recon
        // §4.1 amendment). Without this the control is uncitable and any
        // scenario that needs it is written around it.
        const derived = c.name ? null : deriveName(c.attributes);
        await insertElement(client, tenantId, pageId, {
          role: c.role, name: c.name || derived || '', kind: kindOf(c.role),
          selector: c.cssSelector,
          attributes: derived ? { ...(c.attributes ?? {}), nameSource: 'derived' } : c.attributes,
          revealedBy: null,
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

  /**
   * True when this suite has never observed a page as PUBLIC.
   * Spec: docs/specs/test-writer/spec-authenticated-scope.md §5.3
   *
   * An authenticated crawl defaults new pages to `requires_auth = true`, which
   * errs in the only acceptable direction but cannot distinguish "we watched
   * this page redirect to login" from "we never checked". When no public crawl
   * has ever run for the suite, EVERY mark is the conservative default — so the
   * report says so rather than presenting a guess as a finding. The user's fix
   * is one public analyze, which is authoritative in both directions and
   * corrects the whole partition.
   */
  async hasPublicObservation(tenantId: string, suiteId: string): Promise<boolean> {
    return withTenantTransaction(tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT 1 FROM site_pages
         WHERE tenant_id = $1 AND suite_id = $2 AND requires_auth = false
         LIMIT 1`,
        [tenantId, suiteId],
      );
      return rows.length > 0;
    });
  }

  /**
   * Does an element with this accessible name exist ONLY behind the login wall?
   *
   * This is what makes a sign-in assertion load-bearing. "verify the text
   * 'Tests' is visible" proves nothing if 'Tests' is also on the marketing page
   * — and in the live failure it resolved to the search box while the run was
   * still sitting on the login screen. An element the crawl saw on a
   * requires_auth page and nowhere public is evidence that a session exists.
   * Spec: docs/specs/test-writer/spec-validation-trust.md §5
   */
  async hasSignedInOnlyElement(tenantId: string, suiteId: string, name: string): Promise<boolean> {
    const needle = name.trim().toLowerCase();
    if (!needle) return false;
    return withTenantTransaction(tenantId, async (client) => {
      const { rows } = await client.query<{ private_only: boolean }>(
        `SELECT bool_and(sp.requires_auth) AS private_only
         FROM page_elements pe
         JOIN site_pages sp ON sp.id = pe.page_id
         WHERE pe.tenant_id = $1 AND sp.suite_id = $2 AND lower(trim(pe.name)) = $3`,
        [tenantId, suiteId, needle],
      );
      return rows[0]?.private_only === true;
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
  /**
   * Elements WRITE may cite, capped per page.
   *
   * The cap is a prompt-budget control: every element costs roughly 15 tokens
   * in the WRITE prompt, so 80 is ~1.2k tokens per page against a measured
   * ~6k-token generateScenario call. 40 was arbitrary and too low for a dense
   * app — Kaizen's own tests page carries 56 interactive elements, and a B2B
   * table with per-row actions runs well past 100, so the cap was silently
   * deciding which flows were writable.
   *
   * Note for multi-page scenarios: this is PER PAGE, so a 3-page scenario now
   * admits up to 240 elements. If that proves expensive, taper by page count
   * rather than dropping the cap back — losing the only text field on a page is
   * far more costly than a few hundred tokens.
   */
  async getGroundingElements(
    tenantId: string, suiteId: string, urls: string[], perPageCap = 80,
  ): Promise<GroundingElement[]> {
    if (urls.length === 0) return [];
    return withTenantTransaction(tenantId, async (client) => {
      const { rows } = await client.query<{
        id: string; page_url: string; role: string; name: string;
        kind: string; revealed_by: string | null; selector: string | null; rn: string;
        target: string | null; chrome: boolean | null;
      }>(
        // The per-page cap is ROUND-ROBIN ACROSS KINDS, not a flat alphabetical
        // slice. Ordering by (kind, name) and cutting at 40 sorted 'button'
        // ahead of 'input' and 'other', so on a button-heavy page every text
        // field fell off the end: the P3 dogfood handed WRITE 40 buttons and
        // ZERO inputs, then asked it to type a search query. It cited a button,
        // the schema gate rejected it, and the job proposed nothing — four runs
        // in a row, with the real field sitting at row 47.
        //
        // Ranking within each kind first and interleaving guarantees the scarce
        // kinds survive: you cannot write a form test without an input, and the
        // 41st button is worth far less than the 1st text field.
        // SITE CHROME is computed here rather than stored: an element whose
        // role+name appears on 60% or more of the crawled pages is the nav or
        // the footer, and it is context for every page rather than the subject
        // of any. Read-side, so it is always consistent with the current crawl
        // and needs no migration or second write pass.
        // Spec: docs/specs/test-writer/spec-oracle-delta-and-fidelity.md §2
        `WITH crawled AS (
           SELECT count(*)::numeric AS n FROM site_pages
           WHERE tenant_id = $1 AND suite_id = $2
         ),
         site_wide AS (
           SELECT pe.role, pe.name
           FROM page_elements pe
           JOIN site_pages sp ON sp.id = pe.page_id
           WHERE pe.tenant_id = $1 AND sp.suite_id = $2 AND pe.name <> ''
           GROUP BY pe.role, pe.name
           HAVING (SELECT n FROM crawled) >= 5
              AND count(DISTINCT pe.page_id) >= 0.6 * (SELECT n FROM crawled)
         )
         SELECT id, page_url, role, name, kind, revealed_by, selector, target, chrome, rn FROM (
           SELECT id, page_url, role, name, kind, revealed_by, selector, target, chrome,
                  ROW_NUMBER() OVER (PARTITION BY page_id ORDER BY kind_rank, kind, name) AS rn
           FROM (
             SELECT pe.id, sp.url_normalized AS page_url, pe.role, pe.name, pe.kind,
                    pe.revealed_by, pe.selector, pe.page_id,
                    pe.attributes->>'target' AS target,
                    (sw.name IS NOT NULL) AS chrome,
                    -- Site-wide chrome ranks LAST within its kind: when the cap
                    -- bites, the page's own controls are the ones worth keeping.
                    ROW_NUMBER() OVER (
                      PARTITION BY pe.page_id, pe.kind
                      ORDER BY (sw.name IS NOT NULL), pe.name
                    ) AS kind_rank
             FROM page_elements pe
             JOIN site_pages sp ON sp.id = pe.page_id
             LEFT JOIN site_wide sw ON sw.role = pe.role AND sw.name = pe.name
             WHERE pe.tenant_id = $1 AND sp.suite_id = $2
               AND sp.url_normalized = ANY($3::text[])
               AND pe.name <> ''
               -- Form rows are CONTEXT, not targets: they are stored so the model
               -- can see a page's form shapes (passed separately as summaries),
               -- but a <form> is not something you can type into. Leaving them
               -- citable had the writer typing into forms whenever the real field
               -- was hidden behind a modal.
               AND pe.kind <> 'form'
           ) by_kind
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
        opensNewTab: r.target === '_blank',
        chrome: r.chrome === true,
      }));
    });
  }

  /**
   * What a visitor reads on the given pages. Handed to WRITE so a page with no
   * controls of its own is still testable: "navigate there, verify the text is
   * shown" needs to know what text is there.
   * Spec: docs/specs/test-writer/spec-oracle-delta-and-fidelity.md §2
   */
  async getPageTexts(tenantId: string, suiteId: string, urls: string[]): Promise<string[]> {
    if (urls.length === 0) return [];
    return withTenantTransaction(tenantId, async (client) => {
      const { rows } = await client.query<{ url_normalized: string; title: string | null; page_text: string | null }>(
        `SELECT url_normalized, title, page_text FROM site_pages
         WHERE tenant_id = $1 AND suite_id = $2 AND url_normalized = ANY($3::text[])
           AND page_text IS NOT NULL AND btrim(page_text) <> ''`,
        [tenantId, suiteId, urls],
      );
      return rows.map((r) => `${r.url_normalized}${r.title ? ` (${r.title})` : ''}: ${r.page_text}`);
    });
  }

  /**
   * normalized URL → the URL a test must actually navigate to. They differ by a
   * trailing slash often enough to cost a page: /add_remove_elements/ is 200,
   * /add_remove_elements is 404. Identity stays normalized everywhere; only
   * navigation uses this.
   * Spec: docs/specs/test-writer/spec-oracle-delta-and-fidelity.md §4
   */
  async getNavigableUrls(tenantId: string, suiteId: string): Promise<Map<string, string>> {
    return withTenantTransaction(tenantId, async (client) => {
      const { rows } = await client.query<{ url_normalized: string; url_observed: string | null }>(
        `SELECT url_normalized, url_observed FROM site_pages
         WHERE tenant_id = $1 AND suite_id = $2 AND url_observed IS NOT NULL
           AND url_observed <> url_normalized`,
        [tenantId, suiteId],
      );
      return new Map(rows.map((r) => [r.url_normalized, r.url_observed as string]));
    });
  }

  /**
   * The pages as an engineer would read them, for the planner. One query per
   * suite: elements come with the chrome flag so nav/footer can be dropped
   * (chrome is context, never a subject), forms and text ride from ax_outline
   * and page_text, and the URL is the NAVIGABLE one.
   * Spec: docs/specs/test-writer/spec-planner-per-page.md §1.1
   */
  async listPageDossiers(
    tenantId: string, suiteId: string, perPageElementCap = 30,
  ): Promise<PageDossier[]> {
    return withTenantTransaction(tenantId, async (client) => {
      const { rows: pages } = await client.query<{
        id: string; url_normalized: string; url_observed: string | null; title: string | null;
        headings: string[] | null; page_text: string | null; purpose: string | null;
        capabilities: string[] | null; requires_auth: boolean;
        ax_outline: UnclassifiedPage['axOutline'];
      }>(
        `SELECT id, url_normalized, url_observed, title, headings, page_text, purpose,
                capabilities, requires_auth, ax_outline
         FROM site_pages
         WHERE tenant_id = $1 AND suite_id = $2
         ORDER BY first_seen_at`,
        [tenantId, suiteId],
      );
      if (pages.length === 0) return [];

      // Same chrome rule as getGroundingElements: role+name on >= 60% of pages.
      const { rows: elements } = await client.query<{
        page_id: string; role: string; name: string; kind: string; target: string | null; chrome: boolean;
      }>(
        `WITH crawled AS (
           SELECT count(*)::numeric AS n FROM site_pages WHERE tenant_id = $1 AND suite_id = $2
         ),
         site_wide AS (
           SELECT pe.role, pe.name
           FROM page_elements pe JOIN site_pages sp ON sp.id = pe.page_id
           WHERE pe.tenant_id = $1 AND sp.suite_id = $2 AND pe.name <> ''
           GROUP BY pe.role, pe.name
           HAVING (SELECT n FROM crawled) >= 5
              AND count(DISTINCT pe.page_id) >= 0.6 * (SELECT n FROM crawled)
         )
         SELECT pe.page_id, pe.role, pe.name, pe.kind, pe.attributes->>'target' AS target,
                (sw.name IS NOT NULL) AS chrome
         FROM page_elements pe
         JOIN site_pages sp ON sp.id = pe.page_id
         LEFT JOIN site_wide sw ON sw.role = pe.role AND sw.name = pe.name
         WHERE pe.tenant_id = $1 AND sp.suite_id = $2 AND pe.name <> '' AND pe.kind <> 'form'
         ORDER BY pe.page_id, pe.kind, pe.name`,
        [tenantId, suiteId],
      );
      const byPage = new Map<string, PageDossier['elements']>();
      for (const el of elements) {
        if (el.chrome) continue;
        const list = byPage.get(el.page_id) ?? [];
        if (list.length >= perPageElementCap) continue;
        list.push({
          role: el.role, name: el.name, kind: el.kind,
          ...(el.target === '_blank' ? { opensNewTab: true } : {}),
        });
        byPage.set(el.page_id, list);
      }

      // Blocked captures are never stored (see upsertPage), so every row here is
      // a page the crawl actually read.
      return pages
        .map((p) => ({
          url: p.url_observed ?? p.url_normalized,
          urlNormalized: p.url_normalized,
          title: p.title ?? '',
          headings: Array.isArray(p.headings) ? p.headings.slice(0, 6) : [],
          pageText: (p.page_text ?? '').slice(0, 300),
          purpose: p.purpose ?? '',
          capabilities: Array.isArray(p.capabilities) ? p.capabilities : [],
          elements: byPage.get(p.id) ?? [],
          forms: formSummaryLines(p.ax_outline),
          requiresAuth: p.requires_auth,
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
