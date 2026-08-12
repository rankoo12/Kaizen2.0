import {
  auditRunOracles, parseSelectorIdentity, resolvesToInput, tokenize,
  type AuditObservation, type AuditStep,
} from '../validate/oracle-audit';

/**
 * Fixtures are lifted verbatim from the four false-green runs on the dogfood
 * tenant (spec-validation-trust.md §0). If these stop failing the audit, the
 * audit has regressed — these tests are the acceptance fixture in unit form.
 */

const obs = (
  stepIndex: number,
  selectorUsed: string | null,
  resolutionSource: string | null = 'redis',
  healed = false,
): AuditObservation => ({ stepIndex, selectorUsed, resolutionSource, healed });

/** Runs 6a03cac7 / 7c5463f9: the "no-results message" that was the File button. */
function noResultsScenario(): { steps: AuditStep[]; observations: AuditObservation[] } {
  return {
    steps: [
      { action: 'navigate', targetDescription: null, value: null },
      { action: 'click', targetDescription: '"Demo user" button', value: null },
      { action: 'assert_visible', targetDescription: "the text 'Tests'", value: null },
      { action: 'navigate', targetDescription: null, value: null },
      { action: 'type', targetDescription: 'the "Search tests" field', value: 'zzqx-kaizen-no-such-item' },
      { action: 'press_key', targetDescription: null, value: 'Enter' },
      { action: 'assert_visible', targetDescription: 'the no-results message', value: null },
    ],
    observations: [
      obs(0, null, null),
      obs(1, 'role=button[name="Demo user"]'),
      obs(2, 'role=textbox[name="Search tests"]'),
      obs(3, null, null),
      obs(4, 'role=textbox[name="Search tests"]'),
      obs(5, null, null),
      obs(6, 'role=button[name="File"]'),
    ],
  };
}

describe('auditRunOracles — the live false-greens', () => {
  it('rejects an assertion that resolved to an element it does not name', () => {
    const { steps, observations } = noResultsScenario();
    const verdict = auditRunOracles(steps, observations, 3);

    expect(verdict.ok).toBe(false);
    expect(verdict.rule).toBe('oracle_unfaithful');
    expect(verdict.reason).toContain('the no-results message');
    expect(verdict.reason).toContain('role=button[name="File"]');
  });

  it('rejects an assertion that reads back the value the run typed (run f235e94f)', () => {
    // The selectors differ (input.field vs role=textbox[…]) — the same field
    // reached two ways — so only the value clause can catch this one.
    const steps: AuditStep[] = [
      { action: 'navigate', targetDescription: null, value: null },
      { action: 'type', targetDescription: 'the "Search tests" field', value: '{{firstName}}' },
      { action: 'press_key', targetDescription: null, value: 'Enter' },
      { action: 'assert_text', targetDescription: null, value: '{{firstName}}' },
    ];
    const observations = [
      obs(0, null, null),
      obs(1, 'role=textbox[name="Search tests"]'),
      obs(2, null, null),
      obs(3, 'input.field', null),
    ];

    const verdict = auditRunOracles(steps, observations);
    expect(verdict.ok).toBe(false);
    expect(verdict.rule).toBe('oracle_self_echo');
    expect(verdict.reason).toContain('{{firstName}}');
  });

  it('rejects an assertion resolving to the very element that was typed into', () => {
    const steps: AuditStep[] = [
      { action: 'type', targetDescription: 'the "Search" field', value: 'widget' },
      { action: 'assert_visible', targetDescription: 'the search results', value: null },
    ];
    const observations = [
      obs(0, 'role=textbox[name="Search"]'),
      obs(1, 'role=textbox[name="Search"]'),
    ];

    const verdict = auditRunOracles(steps, observations);
    expect(verdict.ok).toBe(false);
    expect(verdict.rule).toBe('oracle_self_echo');
  });
});

describe('auditRunOracles — what it must NOT reject', () => {
  it('passes an assertion whose resolved element matches its description', () => {
    const steps: AuditStep[] = [
      { action: 'type', targetDescription: 'the "Search" field', value: 'widget' },
      { action: 'press_key', targetDescription: null, value: 'Enter' },
      { action: 'assert_visible', targetDescription: 'the results list', value: null },
    ];
    const observations = [
      obs(0, 'role=textbox[name="Search"]'),
      obs(1, null, null),
      obs(2, 'role=list[name="Results"]'),
    ];

    expect(auditRunOracles(steps, observations).ok).toBe(true);
  });

  it('does not judge faithfulness against an opaque CSS selector', () => {
    // A real "Sign in" button legitimately resolves to #login-submit, which
    // shares no words with its description. Rejecting that would be a false
    // positive, so opaque selectors are skipped until §8 records role+name.
    const steps: AuditStep[] = [
      { action: 'click', targetDescription: 'the "Open" button', value: null },
      { action: 'assert_visible', targetDescription: 'the confirmation banner', value: null },
    ];
    const observations = [obs(0, 'button.open'), obs(1, '#flash')];

    expect(auditRunOracles(steps, observations).ok).toBe(true);
  });

  it('allows asserting a typed value when it is read from a different element', () => {
    // Typing a name into a form and then verifying it appears in the saved
    // record is a legitimate, falsifiable oracle.
    const steps: AuditStep[] = [
      { action: 'type', targetDescription: 'the "Name" field', value: 'Ada' },
      { action: 'click', targetDescription: 'the "Save" button', value: null },
      { action: 'assert_text', targetDescription: null, value: 'Ada' },
    ];
    const observations = [
      obs(0, 'role=textbox[name="Name"]'),
      obs(1, 'role=button[name="Save"]'),
      obs(2, 'td.record-name'),   // not a field — read from rendered output
    ];

    expect(auditRunOracles(steps, observations).ok).toBe(true);
  });
});

describe('auditRunOracles — grading rather than rejecting', () => {
  it('flags a terminal oracle whose anchor the LLM resolver picked', () => {
    const steps: AuditStep[] = [
      { action: 'click', targetDescription: 'the "Go" button', value: null },
      { action: 'assert_visible', targetDescription: 'the results list', value: null },
    ];
    const observations = [obs(0, 'role=button[name="Go"]'), obs(1, 'role=list[name="Results"]', 'llm')];

    const verdict = auditRunOracles(steps, observations);
    expect(verdict.ok).toBe(true);
    expect(verdict.weakOracle).toBe(true);
  });

  it('marks the sign-in unproven when a prefix step healed, without failing the scenario', () => {
    const { steps, observations } = noResultsScenario();
    steps[6] = { action: 'assert_visible', targetDescription: 'the no-results message', value: null };
    observations[6] = obs(6, 'role=status[name="No results message"]');
    observations[1] = obs(1, 'role=button[name="Demo user"]', 'redis', true);

    const verdict = auditRunOracles(steps, observations, 3);
    expect(verdict.ok).toBe(true);
    expect(verdict.unprovenSignin).toBe(true);
    expect(verdict.findings.join(' ')).toContain('healed');
  });

  it('treats an unfaithful PREFIX assertion as a sign-in doubt, not a scenario defect', () => {
    const steps: AuditStep[] = [
      { action: 'click', targetDescription: 'the "Sign in" button', value: null },
      { action: 'assert_visible', targetDescription: 'the account menu', value: null },
      { action: 'click', targetDescription: 'the "Reports" link', value: null },
      { action: 'assert_visible', targetDescription: 'the reports table', value: null },
    ];
    const observations = [
      obs(0, 'role=button[name="Sign in"]'),
      obs(1, 'role=textbox[name="Email"]'),      // wrong element, in the prefix
      obs(2, 'role=link[name="Reports"]'),
      obs(3, 'role=table[name="Reports"]'),
    ];

    const verdict = auditRunOracles(steps, observations, 2);
    expect(verdict.ok).toBe(true);
    expect(verdict.unprovenSignin).toBe(true);
  });
});

describe('selector helpers', () => {
  it('parses role selectors and rejects opaque ones', () => {
    expect(parseSelectorIdentity('role=button[name="File"]')).toEqual({ role: 'button', name: 'File' });
    expect(parseSelectorIdentity('role=button[name=" Login"]')).toEqual({ role: 'button', name: 'Login' });
    expect(parseSelectorIdentity('input.field')).toBeNull();
    expect(parseSelectorIdentity('[data-test="cart"]')).toBeNull();
  });

  it('recognises value-bearing fields across both selector families', () => {
    expect(resolvesToInput('role=textbox[name="Search"]')).toBe(true);
    expect(resolvesToInput('role=searchbox[name="q"]')).toBe(true);
    expect(resolvesToInput('input.field')).toBe(true);
    expect(resolvesToInput('input:nth-of-type(2)')).toBe(true);
    expect(resolvesToInput('role=button[name="File"]')).toBe(false);
    // "input" inside a class name is not an input.
    expect(resolvesToInput('div.user-input-summary')).toBe(false);
  });

  it('drops stopwords and short words so overlap means something', () => {
    expect([...tokenize('the no-results message')].sort()).toEqual(['message', 'results']);
    expect([...tokenize('button File')].sort()).toEqual(['button', 'file']);
  });
});
