import { tenantQuery } from '../../db/transaction';
import type { Finding } from '../../types/test-writer';

/**
 * Findings — what Kaizen noticed that is not a test.
 * Spec: docs/specs/test-writer/spec-findings-and-coverage.md
 *
 * Everything here is read-only over data the pipeline already produced. No new
 * crawling, no LLM calls. The point is not to discover anything new; it is to
 * stop throwing away what was already discovered.
 */

/** Hard cap per kind, so one pathological page cannot bury the report. */
const MAX_PER_KIND = 10;

/**
 * Crawled text is untrusted input. It is already fenced on the way INTO prompts;
 * this is the same discipline on the way OUT to the customer's screen. Control
 * characters go, length is capped, and nothing that could be read as markup
 * survives — a page titled `<img onerror=...>` becomes inert text, not a
 * stored-XSS in Kaizen's own dashboard.
 * Spec §2.
 */
export function sanitizeForDisplay(raw: string, max = 200): string {
  // Char-code filtering rather than a regex: control characters in a source
  // literal are invisible and survive copy-paste badly, and this is the one
  // function where being unambiguous matters more than being terse.
  const printable = Array.from(raw)
    .map((ch) => {
      const code = ch.charCodeAt(0);
      return code < 0x20 || code === 0x7f ? ' ' : ch;
    })
    .join('');
  return printable
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** Pages the crawl could not read, and controls a human could not name. */
export async function reconFindings(
  tenantId: string,
  suiteId: string,
  crawlErrors: Array<{ url: string; status: number | null; reason: string; linkedFrom?: string | null }>,
  publicPartitionUnverified: boolean,
): Promise<Finding[]> {
  const findings: Finding[] = [];
  const errors = crawlErrors.slice(0, MAX_PER_KIND);

  // A 4xx that nevertheless rendered a real page. Single-page apps routinely
  // answer every deep link with HTTP 404 and let the client router draw the
  // page — saucedemo does — so "inventory.html responded 404" sat at the top
  // of a report whose next line listed that page's controls. The status is
  // still worth knowing (link checkers and search engines see the 404 too),
  // but it is not "could not be opened", and it is not the headline.
  // Spec: docs/specs/test-writer/spec-judge-repair-loop.md §2.6
  const rendered = new Map<string, number>();
  const clientErrorUrls = errors
    .filter((e) => e.status !== null && e.status >= 400 && e.status < 500)
    .map((e) => e.url);
  if (clientErrorUrls.length > 0) {
    const { rows } = await tenantQuery<{ url_normalized: string; n: string }>(
      tenantId,
      `SELECT sp.url_normalized, count(pe.id)::text AS n
         FROM site_pages sp
         LEFT JOIN page_elements pe ON pe.page_id = sp.id AND pe.tenant_id = sp.tenant_id
        WHERE sp.tenant_id = $1 AND sp.suite_id = $2 AND sp.url_normalized = ANY($3)
        GROUP BY sp.url_normalized`,
      [tenantId, suiteId, clientErrorUrls],
    ).catch(() => ({ rows: [] as Array<{ url_normalized: string; n: string }> }));
    for (const row of rows) rendered.set(row.url_normalized, Number(row.n));
  }

  for (const err of errors) {
    // 401/407 is not a broken page: the site is asking for HTTP credentials,
    // which is a setting Kaizen does not have yet — and calling it a broken
    // link sends the customer looking for a bug that is not there.
    // Spec: docs/specs/test-writer/spec-oracle-delta-and-fidelity.md §4
    if (err.status === 401 || err.status === 407) {
      const realm = /realm="([^"]{1,60})"/i.exec(err.reason)?.[1];
      findings.push({
        kind: 'requires_http_auth',
        severity: 'low',
        title: 'A page is behind HTTP authentication',
        detail:
          `${sanitizeForDisplay(err.url, 300)} answered ${err.status} and asked the browser for `
          + `credentials${realm ? ` (realm "${sanitizeForDisplay(realm, 60)}")` : ''}. This is the `
          + 'browser\'s own sign-in box, not a form Kaizen can fill in, so the page was not '
          + 'explored. Add the username and password in the suite settings to include it.',
        evidence: { url: sanitizeForDisplay(err.url, 300) },
        source: 'recon',
      });
      continue;
    }
    const isServer = err.status !== null && err.status >= 500;
    // A page reached by following a link from another page is a BROKEN LINK —
    // a defect in the linking page, and the version of this a person can act on.
    const isBrokenLink = !!err.linkedFrom;
    const where = sanitizeForDisplay(err.url, 300);
    const elementCount = rendered.get(err.url);
    if (!isServer && elementCount !== undefined && elementCount > 0) {
      findings.push({
        kind: isBrokenLink ? 'broken_link' : 'crawl_error_page',
        severity: 'low',
        title: `A page answers ${err.status} but still renders`,
        detail:
          `${where} responded ${err.status}, yet a real page came back with ${elementCount} interactive `
          + `${elementCount === 1 ? 'control' : 'controls'} — usually a single-page app whose server returns `
          + `${err.status} for deep links and lets the browser draw the page. Users won't notice; link `
          + 'checkers, search engines and monitoring will treat it as broken.',
        evidence: { url: where, elementRef: err.linkedFrom ? sanitizeForDisplay(err.linkedFrom, 300) : undefined },
        source: 'recon',
      });
      continue;
    }
    findings.push({
      kind: isBrokenLink ? 'broken_link' : 'crawl_error_page',
      severity: isServer ? 'high' : 'medium',
      title: isBrokenLink
        ? (isServer ? 'A link on your site leads to a server error' : 'A link on your site is broken')
        : (isServer ? 'A page on your site returned a server error' : 'A page on your site could not be opened'),
      detail: [
        err.linkedFrom ? `${sanitizeForDisplay(err.linkedFrom, 300)} links to ${where}, which` : `${where}`,
        err.status ? ` responded ${err.status}.` : ` did not load: ${sanitizeForDisplay(err.reason, 160)}`,
      ].join(''),
      evidence: { url: where, elementRef: err.linkedFrom ? sanitizeForDisplay(err.linkedFrom, 300) : undefined },
      source: 'recon',
    });
  }

  // Interactive controls with no accessible name. Two problems in one row: a
  // screen reader announces nothing, and Kaizen cannot write a test that refers
  // to it — which is why these were sitting in the grounding set as noise.
  const { rows: unnamed } = await tenantQuery<{ url_normalized: string; role: string; n: string }>(
    tenantId,
    `SELECT sp.url_normalized, pe.role, count(*)::text AS n
     FROM page_elements pe
     JOIN site_pages sp ON sp.id = pe.page_id
     WHERE pe.tenant_id = $1 AND sp.suite_id = $2
       AND pe.kind IN ('button', 'link', 'input', 'select')
       AND (pe.name IS NULL OR btrim(pe.name) = '' OR pe.attributes->>'nameSource' = 'derived')
     GROUP BY sp.url_normalized, pe.role
     ORDER BY count(*) DESC
     LIMIT $3`,
    [tenantId, suiteId, MAX_PER_KIND],
  );
  for (const row of unnamed) {
    const count = Number(row.n);
    findings.push({
      kind: 'empty_accessible_name',
      severity: 'medium',
      title: `${count} ${row.role}${count === 1 ? '' : 's'} on this page have no readable label`,
      detail:
        `On ${sanitizeForDisplay(row.url_normalized, 300)}, ${count} ${row.role}`
        + `${count === 1 ? ' has' : 's have'} no accessible name. A screen reader announces nothing `
        + 'for these, and Kaizen cannot write a test that refers to them.',
      evidence: { url: sanitizeForDisplay(row.url_normalized, 300), elementRef: row.role },
      source: 'recon',
    });
  }

  if (publicPartitionUnverified) {
    findings.push({
      kind: 'unverified_auth_partition',
      severity: 'low',
      title: 'Kaizen has not confirmed which pages are actually private',
      detail:
        'Every page here was seen while signed in, so "requires sign-in" is a cautious '
        + 'assumption rather than something observed. One public analyze of this app settles '
        + 'it in both directions.',
      evidence: {},
      source: 'recon',
    });
  }

  return findings;
}

/**
 * A red run on a test the judge approved.
 *
 * This is the finding that changes an outcome rather than adding a line to a
 * report. Until now every red validation meant "the generated test is wrong", so
 * a scenario that probed for an injection and went red BECAUSE THE APP IS
 * VULNERABLE was filed as our failure and deleted — Kaizen finding a real defect
 * and reporting the opposite. A sound test failing is evidence about the app.
 * Spec §1.
 */
export function appDefectFinding(params: {
  scenarioName: string;
  runId: string;
  caseId: string;
  steps: string[];
  reason: string;
}): Finding {
  return {
    kind: 'possible_app_defect',
    severity: 'high',
    title: `A test Kaizen judged sound failed against your app: "${sanitizeForDisplay(params.scenarioName, 120)}"`,
    detail:
      'This scenario passed Kaizen\'s own quality review, then failed on its assertion when run. '
      + 'That is the shape of an application defect rather than a bad test — worth reproducing by hand. '
      + sanitizeForDisplay(params.reason, 200),
    evidence: {
      runId: params.runId,
      caseId: params.caseId,
      repro: params.steps.slice(0, 12).map((s) => sanitizeForDisplay(s, 160)),
    },
    source: 'validate',
  };
}

/** A page that works, over a console and a network that do not. */
export function sideChannelFinding(params: {
  scenarioName: string;
  runId: string;
  caseId: string;
  finalUrl: string;
  consoleErrorCount: number;
  httpErrorCount: number;
}): Finding | null {
  const { consoleErrorCount: console, httpErrorCount: http } = params;
  if (console === 0 && http === 0) return null;

  const parts: string[] = [];
  if (http > 0) parts.push(`${http} failed request${http === 1 ? '' : 's'} (4xx/5xx)`);
  if (console > 0) parts.push(`${console} console error${console === 1 ? '' : 's'}`);

  return {
    kind: 'console_or_network_errors',
    severity: http > 0 ? 'medium' : 'low',
    title: `A test passed, but the page underneath it was erroring`,
    detail:
      `While running "${sanitizeForDisplay(params.scenarioName, 120)}" the browser recorded `
      + `${parts.join(' and ')} on ${sanitizeForDisplay(params.finalUrl, 300)}. `
      + 'The test still passed, so nothing here is failing yet — but a user is hitting these.',
    evidence: { runId: params.runId, caseId: params.caseId, url: sanitizeForDisplay(params.finalUrl, 300) },
    source: 'validate',
  };
}

/**
 * Order findings the way a person reads them: worst first, and within a
 * severity, the kinds that describe the app before the ones that describe
 * Kaizen's own uncertainty.
 */
const SEVERITY_RANK: Record<Finding['severity'], number> = { high: 0, medium: 1, low: 2, info: 3 };

/**
 * One site-wide problem should read as one line, not as ten.
 *
 * A console error in a shared bundle fires on every page, so a job that proved
 * ten tests reported ten near-identical "the page underneath was erroring"
 * rows — burying the findings that were actually about one place. Three or more
 * of them are collapsed into a single finding that names the count and lists
 * the pages as evidence.
 * Spec: docs/specs/test-writer/spec-oracle-delta-and-fidelity.md §4
 */
export function collapseFindings(findings: Finding[]): Finding[] {
  const noisy = findings.filter((f) => f.kind === 'console_or_network_errors');
  if (noisy.length < 3) return findings;

  const urls = [...new Set(noisy.map((f) => f.evidence.url).filter(Boolean) as string[])];
  const worst: Finding['severity'] = noisy.some((f) => f.severity === 'medium') ? 'medium' : 'low';
  const collapsed: Finding = {
    kind: 'console_or_network_errors',
    severity: worst,
    title: `Your pages are erroring underneath — on ${urls.length || noisy.length} of them`,
    detail:
      `${noisy.length} of the tests Kaizen ran passed while the browser was recording console or `
      + 'network errors on the page. Errors this widespread usually come from one shared script or '
      + 'one failing request rather than from any single page. Nothing here failed a test — but '
      + 'every user is hitting it.',
    evidence: { url: urls[0], repro: urls.slice(0, 12), runId: noisy[0].evidence.runId, caseId: noisy[0].evidence.caseId },
    source: 'validate',
  };
  return [...findings.filter((f) => f.kind !== 'console_or_network_errors'), collapsed];
}

export function rankFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}
