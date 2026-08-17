jest.mock("../../../db/transaction", () => ({ tenantQuery: jest.fn(async () => ({ rows: [] })) }));
import {
  sanitizeForDisplay, appDefectFinding, sideChannelFinding, rankFindings,
} from '../findings';
import type { Finding } from '../../../types/test-writer';

/**
 * Findings are what a QA engineer hands you on a day that produced no tests.
 * Spec: docs/specs/test-writer/spec-findings-and-coverage.md
 */

describe('sanitizeForDisplay — crawled text is untrusted', () => {
  it('renders a hostile page title inert rather than as markup', () => {
    // The page under test controls this string. It reaches the customer's
    // dashboard, so it gets the same treatment on the way OUT as on the way
    // into a prompt.
    const hostile = '<img src=x onerror="alert(1)">Checkout';
    const safe = sanitizeForDisplay(hostile);

    expect(safe).not.toContain('<');
    expect(safe).not.toContain('>');
    expect(safe).toContain('Checkout');
  });

  it('strips control characters that would corrupt the display', () => {
    // Written as escapes, not literals: control characters are invisible in a
    // source file and do not survive a copy-paste, which is exactly how this
    // test failed the first time it was written.
    const withControls = 'Order\u0000 page\u001B[31m\u007F';
    const safe = sanitizeForDisplay(withControls);

    expect(safe).toBe('Order page [31m');
    expect(/[\u0000-\u001F\u007F]/.test(safe)).toBe(false);
  });

  it('caps length so one enormous title cannot bury the report', () => {
    expect(sanitizeForDisplay('x'.repeat(5000), 200)).toHaveLength(200);
  });
});

describe('appDefectFinding — the inversion this exists to fix', () => {
  const finding = appDefectFinding({
    scenarioName: 'Search rejects a script payload',
    runId: 'run-1',
    caseId: 'case-1',
    steps: ['navigate to /search', 'type "<script>" in the search field', 'verify the error is shown'],
    reason: 'It failed at step 3.',
  });

  it('reports a sound test failing as evidence about the APP, at high severity', () => {
    // Before this, every red validation meant "our test is wrong" — so a
    // scenario that went red BECAUSE THE APP IS VULNERABLE was filed as our
    // mistake and deleted. Kaizen finding a defect and reporting the opposite.
    expect(finding.kind).toBe('possible_app_defect');
    expect(finding.severity).toBe('high');
    expect(finding.source).toBe('validate');
  });

  it('carries repro steps and the run, so it can be reproduced by hand', () => {
    expect(finding.evidence.repro).toHaveLength(3);
    expect(finding.evidence.runId).toBe('run-1');
    expect(finding.evidence.caseId).toBe('case-1');
  });

  it('sanitizes the scenario name and steps, which came from crawled content', () => {
    const nasty = appDefectFinding({
      scenarioName: '<b>x</b>', runId: 'r', caseId: 'c',
      steps: ['<script>alert(1)</script>'], reason: 'r',
    });
    expect(nasty.title).not.toContain('<');
    expect(nasty.evidence.repro?.[0]).not.toContain('<');
  });
});

describe('sideChannelFinding — a green test over a broken page', () => {
  it('says nothing when the page was clean', () => {
    expect(sideChannelFinding({
      scenarioName: 's', runId: 'r', caseId: 'c',
      finalUrl: 'https://app.test/x', consoleErrorCount: 0, httpErrorCount: 0,
    })).toBeNull();
  });

  it('reports failed requests at medium — a user is hitting these', () => {
    const f = sideChannelFinding({
      scenarioName: 'Search returns results', runId: 'r', caseId: 'c',
      finalUrl: 'https://app.test/search', consoleErrorCount: 8, httpErrorCount: 4,
    });
    expect(f?.severity).toBe('medium');
    expect(f?.detail).toContain('4 failed requests');
    expect(f?.detail).toContain('8 console errors');
  });

  it('treats console-only noise as low — real, but not yet anyone’s outage', () => {
    const f = sideChannelFinding({
      scenarioName: 's', runId: 'r', caseId: 'c',
      finalUrl: 'https://app.test/x', consoleErrorCount: 2, httpErrorCount: 0,
    });
    expect(f?.severity).toBe('low');
  });
});

describe('rankFindings', () => {
  it('puts what is broken above what is merely uncertain', () => {
    const findings = [
      { severity: 'low' }, { severity: 'high' }, { severity: 'info' }, { severity: 'medium' },
    ] as Finding[];
    expect(rankFindings(findings).map((f) => f.severity)).toEqual(['high', 'medium', 'low', 'info']);
  });

  it('does not mutate the caller’s array', () => {
    const findings = [{ severity: 'low' }, { severity: 'high' }] as Finding[];
    rankFindings(findings);
    expect(findings[0].severity).toBe('low');
  });
});

// Spec: docs/specs/test-writer/spec-judge-repair-loop.md §2.6
describe('reconFindings — a 404 that still rendered is not a broken page', () => {
  const tx = jest.requireMock('../../../db/transaction') as { tenantQuery: jest.Mock };

  it('downgrades a client-error page that came back with real controls, keeps a bare 404 as is', async () => {
    tx.tenantQuery.mockImplementation(async (_t: string, sql: string) => {
      if (/FROM site_pages sp/.test(sql)) {
        return { rows: [{ url_normalized: 'https://shop.test/inventory.html', n: '12' }] };
      }
      return { rows: [] }; // unnamed-controls query
    });
    const { reconFindings } = await import('../findings');
    const out = await reconFindings('t1', 's1', [
      { url: 'https://shop.test/inventory.html', status: 404, reason: 'HTTP 404' },
      { url: 'https://shop.test/gone', status: 404, reason: 'HTTP 404', linkedFrom: 'https://shop.test/' },
    ], false);

    const spa = out.find((f) => f.evidence.url === 'https://shop.test/inventory.html');
    const broken = out.find((f) => f.evidence.url === 'https://shop.test/gone');
    expect(spa?.severity).toBe('low');
    expect(spa?.title).toMatch(/still renders/);
    expect(spa?.detail).toMatch(/12 interactive controls/);
    expect(broken?.severity).toBe('medium');
    expect(broken?.title).toBe('A link on your site is broken');
  });
});
