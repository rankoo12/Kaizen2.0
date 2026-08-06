import { dedupeScenarios } from '../write/dedup';

/**
 * The subtlety worth a test: a happy path and its negative twin share most of
 * their steps. Comparing across kinds would silently collapse the pair and drop
 * the negative — the more valuable of the two.
 */

const happy = {
  planRef: 'login works', kind: 'positive' as const, name: 'Login works',
  steps: [
    'navigate to https://shop.test/login',
    'type "{{email}}" in the "Email" field',
    'type "{{password}}" in the "Password" field',
    'click the "Sign in" button',
    'verify the url contains "/dashboard"',
  ],
};

const negative = {
  planRef: 'login rejects bad password', kind: 'negative' as const, name: 'Login rejects bad password',
  steps: [
    'navigate to https://shop.test/login',
    'type "{{email}}" in the "Email" field',
    'type "wrong-{{password}}" in the "Password" field',
    'click the "Sign in" button',
    'verify the error message is visible',
  ],
};

describe('dedupeScenarios', () => {
  it('keeps a happy path and its negative twin', () => {
    const result = dedupeScenarios([happy, negative]);
    expect(result.kept).toHaveLength(2);
    expect(result.dropped).toHaveLength(0);
  });

  it('drops an exact repeat within the batch', () => {
    const result = dedupeScenarios([happy, { ...happy, planRef: 'copy', name: 'Login works again' }]);
    expect(result.kept).toHaveLength(1);
    expect(result.dropped[0].duplicateOf).toBe('Login works');
  });

  it('drops a scenario the suite already owns', () => {
    const result = dedupeScenarios([happy], [
      { kind: 'positive', name: 'Existing login test', steps: happy.steps },
    ]);
    expect(result.kept).toHaveLength(0);
    expect(result.dropped[0].duplicateOf).toBe('Existing login test');
  });

  it('drops a near-duplicate that differs only in its assertion wording', () => {
    const twin = {
      ...happy, planRef: 'near', name: 'Sign in succeeds',
      steps: [...happy.steps.slice(0, 4), 'verify the url contains "/home"'],
    };
    const result = dedupeScenarios([happy, twin]);
    expect(result.kept).toHaveLength(1);
  });

  it('keeps scenarios that share a prefix but genuinely differ', () => {
    const other = {
      planRef: 'search', kind: 'positive' as const, name: 'Search finds a product',
      steps: [
        'navigate to https://shop.test/login',
        'type "shoes" in the "Search" field',
        'press Enter',
        'verify the text "shoes" is shown',
      ],
    };
    const result = dedupeScenarios([happy, other]);
    expect(result.kept).toHaveLength(2);
  });
});
