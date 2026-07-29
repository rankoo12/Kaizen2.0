import { createHash } from 'crypto';
import type { PoolClient } from 'pg';
import { withTenantTransaction } from '../../db/transaction';
import type { PageCapture } from './interfaces';

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
           last_crawled_at = now()
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
