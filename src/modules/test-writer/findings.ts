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

  for (const err of crawlErrors.slice(0, MAX_PER_KIND)) {
    const isServer = err.status !== null && err.status >= 500;
    // A page reached by following a link from another page is a BROKEN LINK —
    // a defect in the linking page, and the version of this a person can act on.
    const isBrokenLink = !!err.linkedFrom;
    const where = sanitizeForDisplay(err.url, 300);
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
       AND (pe.name IS NULL OR btrim(pe.name) = '')
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

export function rankFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}
