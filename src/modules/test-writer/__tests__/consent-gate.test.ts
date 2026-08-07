import { decideConsent } from '../pipeline';
import type { TestWriterJobPayload } from '../../../queue';

/**
 * The consent trust boundary — spec-authenticated-scope.md §10.1.
 *
 * The invariant: the DATABASE ROW decides whether a crawl may sign in. The
 * queue payload is unconstrained (anything with Redis access can write one),
 * so a check that reads the payload and validates it against itself proves
 * nothing. These tests exist because the obvious implementation is the wrong
 * one.
 */

function payload(over: Partial<TestWriterJobPayload> = {}): TestWriterJobPayload {
  return {
    jobId: 'j1', tenantId: 't1', suiteId: 's1',
    targetUrl: 'https://app.example.com/',
    scope: 'public', authConsent: false,
    options: {
      maxPages: 30, maxScenarios: 6, includeNegative: true,
      safeMode: true, validate: true, planApproval: 'review',
    },
    ...over,
  } as TestWriterJobPayload;
}

const publicRow = {
  scope: 'public', auth_consent: false, login_case_id: null, auth_consented_by: null,
};
const authRow = {
  scope: 'authenticated', auth_consent: true,
  login_case_id: 'case-1', auth_consented_by: 'user-1',
};

describe('decideConsent', () => {
  it('runs a public job publicly', () => {
    expect(decideConsent(payload(), publicRow)).toEqual({ mode: 'public' });
  });

  it('allows authenticated when the ROW carries consent, a consenter and a recipe', () => {
    const verdict = decideConsent(
      payload({ scope: 'authenticated', authConsent: true, loginCaseId: 'case-1' }),
      authRow,
    );
    expect(verdict).toEqual({ mode: 'authenticated', loginCaseId: 'case-1' });
  });

  // THE test. A forged payload against a public row must not sign in.
  it('refuses a forged authenticated payload against a public job row', () => {
    const verdict = decideConsent(
      payload({ scope: 'authenticated', authConsent: true, loginCaseId: 'any-case' }),
      publicRow,
    );
    expect(verdict.mode).toBe('mismatch');
    if (verdict.mode === 'mismatch') expect(verdict.detail).toMatch(/scope is "public"/);
  });

  it('takes the login case from the ROW, never from the payload', () => {
    const verdict = decideConsent(
      // The payload names a DIFFERENT case than the one consent was granted for.
      payload({ scope: 'authenticated', authConsent: true, loginCaseId: 'attacker-chosen-case' }),
      authRow,
    );
    expect(verdict).toEqual({ mode: 'authenticated', loginCaseId: 'case-1' });
  });

  it('refuses an authenticated row that records no consenter', () => {
    const verdict = decideConsent(
      payload({ scope: 'authenticated', authConsent: true, loginCaseId: 'case-1' }),
      { ...authRow, auth_consented_by: null },
    );
    expect(verdict.mode).toBe('mismatch');
  });

  it('refuses an authenticated row with consent false', () => {
    const verdict = decideConsent(
      payload({ scope: 'authenticated', authConsent: true, loginCaseId: 'case-1' }),
      { ...authRow, auth_consent: false },
    );
    expect(verdict.mode).toBe('mismatch');
  });

  it('refuses an authenticated row with no login case', () => {
    const verdict = decideConsent(
      payload({ scope: 'authenticated', authConsent: true, loginCaseId: 'case-1' }),
      { ...authRow, login_case_id: null },
    );
    expect(verdict.mode).toBe('mismatch');
  });

  it('refuses a public payload against an authenticated row', () => {
    // The reverse direction is also a disagreement worth stopping for: it means
    // something upstream is wrong, and silently degrading would produce a public
    // crawl on a job the user believes is signed in.
    const verdict = decideConsent(payload(), authRow);
    expect(verdict.mode).toBe('mismatch');
  });
});
