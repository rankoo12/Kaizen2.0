import type { PageDossier, TenantBrief } from '../../../types/test-writer';

/**
 * Page dossiers on the way into the planner: which pages the brief excludes,
 * which are only navigation, and how they are batched.
 * Spec: docs/specs/test-writer/spec-planner-per-page.md §1.1, §1.4
 */

/**
 * A caution that names a path names a page. "Skip /basic_auth and /digest_auth"
 * marks both. Deterministic on purpose: the tenant's own words decide, and the
 * report says "excluded by your brief" rather than silently planning a test
 * against a page they asked Kaizen to leave alone — the baseline planned four.
 */
export function applyBriefExclusions(pages: PageDossier[], brief: TenantBrief | null): PageDossier[] {
  const cautions = brief?.cautions ?? [];
  const explicit = brief?.excludedPaths ?? [];
  if (cautions.length === 0 && explicit.length === 0) return pages;

  const excluded = new Map<string, string>();
  // A caution that names a path and reads as ADVICE ("needs an explicit wait",
  // "takes several seconds", "assert X instead") describes how to test the page,
  // not whether to. The distiller listed two such pages in run 5 and cost three
  // delivered tests; advice wins over the list.
  const advised = new Set<string>();
  for (const caution of cautions) {
    if (!/\b(needs?|takes?|instead|wait|slow|allow|expect|use)\b/i.test(caution)) continue;
    if (/\b(skip|avoid|do not|don't|never|exclude|leave|not touch|no test)\b/i.test(caution)) continue;
    for (const m of caution.matchAll(/(?:^|[\s,(])(\/[a-z0-9_\-]+(?:\/[a-z0-9_\-]+)*)/gi)) {
      advised.add(m[1].replace(/\/$/, '').toLowerCase());
    }
  }
  // The distiller's own list — it read the original wording.
  for (const raw of explicit) {
    const path = String(raw).trim().replace(/\/$/, '').toLowerCase();
    if (path.startsWith('/') && !advised.has(path)) excluded.set(path, 'listed as a page to skip in your brief');
  }
  for (const caution of cautions) {
    // Only cautions that read as "avoid / skip / do not" exclude; a caution that
    // merely describes a page ("/slow takes several seconds") is advice for
    // WRITE, not a ban.
    if (!/\b(skip|avoid|do not|don't|never|exclude|leave|not touch|no test)\b/i.test(caution)) continue;
    for (const m of caution.matchAll(/(?:^|[\s,(])(\/[a-z0-9_\-]+(?:\/[a-z0-9_\-]+)*)/gi)) {
      excluded.set(m[1].replace(/\/$/, '').toLowerCase(), caution.slice(0, 160));
    }
  }
  if (excluded.size === 0) return pages;

  return pages.map((p) => {
    let path = '';
    try { path = new URL(p.urlNormalized).pathname.replace(/\/$/, '').toLowerCase(); } catch { /* keep '' */ }
    const reason = excluded.get(path);
    return reason ? { ...p, excludedBy: reason } : p;
  });
}

/**
 * Accounts the brief names, as lines the writer can type from. Anything that
 * reads like `username "x" … password "y"` (or user/login/email in place of
 * username) across roles, flows and rules. Deterministic; nothing is invented,
 * and a brief with no credentials yields nothing.
 * Spec: docs/specs/test-writer/spec-planner-per-page.md §1.7
 */
export function knownAccounts(brief: TenantBrief | null): string[] {
  if (!brief) return [];
  const text = [...brief.roles, ...brief.criticalFlows, ...brief.businessRules].join('\n');
  const out: string[] = [];
  const re = /(?:username|user name|user|login|email)\s*[:=]?\s*["“']([^"”']{1,80})["”'][^"”'\n]{0,60}?password\s*[:=]?\s*["“']([^"”']{1,80})["”']/gi;
  for (const m of text.matchAll(re)) out.push(`username "${m[1]}", password "${m[2]}"`);
  return [...new Set(out)].slice(0, 5);
}

/**
 * The home page and any page that is only a list of links to other pages is
 * navigation, not a subject — the founder's rule, and the reason the baseline
 * spent four of its slots on "/". Kept in the batch as CONTEXT (the model must
 * know the site's shape) but flagged so it plans nothing there.
 */
export function isIndexPage(page: PageDossier): boolean {
  const links = page.elements.filter((e) => e.role === 'link');
  const others = page.elements.length - links.length;
  // Many DISTINCT link names is a table of contents; many identical ones
  // ("delete", "delete", "edit") is a data table, which is very much a subject.
  const distinct = new Set(links.map((l) => l.name.trim().toLowerCase())).size;
  return links.length >= 8 && others === 0 && distinct >= 8;
}

/**
 * Batches of dossiers for the planner. Small enough that every page's elements
 * are in front of the model in full; large enough that a 50-page site is a
 * handful of calls. Excluded and index pages are batched too, as context, but
 * the prompt marks them.
 */
export function batchDossiers(pages: PageDossier[], size = 6): PageDossier[][] {
  const out: PageDossier[][] = [];
  for (let i = 0; i < pages.length; i += size) out.push(pages.slice(i, i + size));
  return out;
}
