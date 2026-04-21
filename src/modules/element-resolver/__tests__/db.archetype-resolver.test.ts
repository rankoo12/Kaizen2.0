import { DBArchetypeResolver } from '../db.archetype-resolver';
import type { IObservability } from '../../observability/interfaces';
import type { CandidateNode } from '../../../types';

jest.mock('../../../db/pool', () => ({
  getPool: jest.fn().mockReturnValue({ query: jest.fn() }),
}));

import { getPool } from '../../../db/pool';

const makeObservability = (): jest.Mocked<IObservability> => ({
  startSpan: jest.fn().mockReturnValue({ end: jest.fn(), setAttribute: jest.fn() }),
  log: jest.fn(),
  increment: jest.fn(),
  histogram: jest.fn(),
});

const makeCandidate = (overrides: Partial<CandidateNode> = {}): CandidateNode => ({
  role: 'button',
  name: 'Log in',
  textContent: '',
  cssSelector: 'button',
  xpath: '//button',
  attributes: {},
  isVisible: true,
  similarityScore: 1,
  ...overrides,
});

const makeArchetypeRows = () => [
  { name: 'login_button', role: 'button', name_patterns: ['login', 'log in', 'sign in'], action_hint: 'click', confidence: 0.95 },
  { name: 'email_input', role: 'textbox', name_patterns: ['email', 'email address'], action_hint: 'type', confidence: 0.95 },
  { name: 'submit_button', role: 'button', name_patterns: ['submit', 'continue', 'next'], action_hint: null, confidence: 0.90 },
  { name: 'search_input', role: 'searchbox', name_patterns: ['search', 'search*'], action_hint: 'type', confidence: 0.95 },
  { name: 'search_input_combobox', role: 'combobox', name_patterns: ['search', 'search*'], action_hint: 'type', confidence: 0.92 },
];

describe('DBArchetypeResolver', () => {
  let resolver: DBArchetypeResolver;
  let obs: jest.Mocked<IObservability>;
  let mockQuery: jest.Mock;

  beforeEach(() => {
    obs = makeObservability();
    mockQuery = jest.fn().mockResolvedValue({ rows: makeArchetypeRows() });
    (getPool as jest.Mock).mockReturnValue({ query: mockQuery });
    resolver = new DBArchetypeResolver(obs);
  });

  afterEach(() => jest.clearAllMocks());

  // 1. Returns ArchetypeMatch when role + name matches and no action_hint
  it('matches when role + name match and archetype has no action_hint', async () => {
    const candidate = makeCandidate({ role: 'button', name: 'submit' });
    const result = await resolver.match(candidate, 'click');
    expect(result).not.toBeNull();
    expect(result!.archetypeName).toBe('submit_button');
    expect(result!.selector).toBe('role=button[name="submit"]');
    expect(result!.confidence).toBe(0.90);
  });

  // 2. Returns ArchetypeMatch when role + name match and action matches action_hint
  it('matches when action matches action_hint', async () => {
    const candidate = makeCandidate({ role: 'button', name: 'Log in' });
    const result = await resolver.match(candidate, 'click');
    expect(result).not.toBeNull();
    expect(result!.archetypeName).toBe('login_button');
    expect(result!.selector).toBe('role=button[name="Log in"]');
  });

  // 3. Returns null when action does not match action_hint
  it('returns null when action does not match action_hint', async () => {
    const candidate = makeCandidate({ role: 'button', name: 'Log in' });
    const result = await resolver.match(candidate, 'type'); // login_button requires 'click'
    expect(result).toBeNull();
  });

  // 4. Returns null when role matches but no name_pattern matches
  it('returns null when no name_pattern matches', async () => {
    const candidate = makeCandidate({ role: 'button', name: 'Purchase now' });
    const result = await resolver.match(candidate, 'click');
    expect(result).toBeNull();
  });

  // 5. Returns null when role does not match any archetype
  it('returns null when role has no archetypes', async () => {
    const candidate = makeCandidate({ role: 'link', name: 'Log in' });
    const result = await resolver.match(candidate, 'click');
    expect(result).toBeNull();
  });

  // 6. Name normalisation: "Log In" → "log in" matches pattern "log in"
  it('normalises candidate name before matching (mixed case)', async () => {
    const candidate = makeCandidate({ role: 'button', name: 'Log In' });
    const result = await resolver.match(candidate, 'click');
    expect(result).not.toBeNull();
    expect(result!.archetypeName).toBe('login_button');
  });

  // 7. Name normalisation: extra whitespace collapsed
  it('normalises candidate name before matching (extra whitespace)', async () => {
    const candidate = makeCandidate({ role: 'textbox', name: '  Email Address  ' });
    const result = await resolver.match(candidate, 'type');
    expect(result).not.toBeNull();
    expect(result!.archetypeName).toBe('email_input');
  });

  // 8. Returns null (does not throw) when DB raises an error
  it('returns null gracefully when DB raises an error', async () => {
    mockQuery.mockRejectedValueOnce(new Error('DB connection failed'));
    const candidate = makeCandidate({ role: 'button', name: 'Log in' });
    const result = await resolver.match(candidate, 'click');
    expect(result).toBeNull();
    expect(obs.log).toHaveBeenCalledWith('warn', 'archetype_resolver.fetch_failed', expect.any(Object));
  });

  // 9. Uses in-memory cache on second call (DB queried only once)
  it('uses in-memory cache on second call', async () => {
    const candidate = makeCandidate({ role: 'button', name: 'Log in' });
    await resolver.match(candidate, 'click');
    await resolver.match(candidate, 'click');
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  // 10. Refreshes cache after TTL expires
  it('refreshes cache after TTL expires', async () => {
    jest.spyOn(Date, 'now')
      .mockReturnValueOnce(0)         // first call: cache set, expires at 5min
      .mockReturnValueOnce(0)         // cache check for second call — still warm
      .mockReturnValueOnce(6 * 60 * 1000) // third call: TTL expired
      .mockReturnValueOnce(6 * 60 * 1000); // cache set again

    const candidate = makeCandidate({ role: 'button', name: 'Log in' });
    await resolver.match(candidate, 'click'); // populates cache
    await resolver.match(candidate, 'click'); // cache hit
    await resolver.match(candidate, 'click'); // TTL expired → re-fetch

    expect(mockQuery).toHaveBeenCalledTimes(2);
    jest.restoreAllMocks();
  });

  // ─── learn() ───────────────────────────────────────────────────────────────

  it('learn: adds new pattern when there is a clear keyword-overlap winner', async () => {
    // "sign in to account" → tokens ['sign', 'account']
    // login_button has 'sign in' → patternToken 'sign' overlaps → score 1
    // submit_button has no overlapping tokens → score 0 → login_button is clear winner
    // "sign in to account" is not in patterns and no wildcard covers it → UPDATE fired
    await resolver.learn('button', 'Sign in to account', 'click');
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('array_append'),
      ['sign in to account', 'login_button'],
    );
  });

  it('learn: busts in-memory cache after adding a pattern', async () => {
    const candidate = makeCandidate({ role: 'button', name: 'Log in' });
    await resolver.match(candidate, 'click'); // populates cache (1 query)
    expect(mockQuery).toHaveBeenCalledTimes(1);

    // "Sign in to account" has overlap with login_button but isn't in patterns
    mockQuery.mockResolvedValueOnce({}); // UPDATE returns nothing meaningful
    await resolver.learn('button', 'Sign in to account', 'click');

    // Cache was busted — next match re-fetches
    await resolver.match(candidate, 'click');
    expect(mockQuery).toHaveBeenCalledTimes(3); // initial SELECT + UPDATE + re-fetch SELECT
  });

  it('learn: does nothing when name is already covered by an exact pattern', async () => {
    const callsBefore = mockQuery.mock.calls.length;
    await resolver.learn('searchbox', 'Search', 'type'); // 'search' already in patterns
    // No UPDATE should be issued — only the getArchetypes() SELECT
    const updateCalls = mockQuery.mock.calls
      .slice(callsBefore)
      .filter((args: any[]) => String(args[0]).includes('array_append'));
    expect(updateCalls).toHaveLength(0);
  });

  it('learn: does nothing when name is covered by a wildcard pattern', async () => {
    const callsBefore = mockQuery.mock.calls.length;
    await resolver.learn('searchbox', 'Search GitHub', 'type'); // covered by 'search*'
    const updateCalls = mockQuery.mock.calls
      .slice(callsBefore)
      .filter((args: any[]) => String(args[0]).includes('array_append'));
    expect(updateCalls).toHaveLength(0);
  });

  it('learn: does nothing when role has no matching archetype', async () => {
    const callsBefore = mockQuery.mock.calls.length;
    await resolver.learn('link', 'Home Page', 'click');
    const updateCalls = mockQuery.mock.calls
      .slice(callsBefore)
      .filter((args: any[]) => String(args[0]).includes('array_append'));
    expect(updateCalls).toHaveLength(0);
  });

  it('learn: does nothing when classification is ambiguous (two archetypes tie)', async () => {
    // login_button and submit_button both have role=button + action_hint compatible
    // For name "click here", no tokens overlap either archetype → score 0 → skip
    const callsBefore = mockQuery.mock.calls.length;
    await resolver.learn('button', 'Click here', 'click');
    const updateCalls = mockQuery.mock.calls
      .slice(callsBefore)
      .filter((args: any[]) => String(args[0]).includes('array_append'));
    expect(updateCalls).toHaveLength(0);
  });

  it('learn: does not throw when DB update fails', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: makeArchetypeRows() }) // getArchetypes SELECT
      .mockRejectedValueOnce(new Error('DB write failed'));  // UPDATE fails
    // "Sign in to account" would be learned into login_button, but the UPDATE throws
    await expect(resolver.learn('button', 'Sign in to account', 'click')).resolves.toBeUndefined();
    expect(obs.log).toHaveBeenCalledWith('warn', 'archetype_learner.learn_failed', expect.any(Object));
  });

  // ─── Wildcard pattern matching ─────────────────────────────────────────────

  // Wildcard pattern: 'search*' matches 'search wikipedia', 'search google', etc.
  it('matches when name starts with prefix of a wildcard pattern (search*)', async () => {
    const candidate = makeCandidate({ role: 'searchbox', name: 'Search Wikipedia' });
    const result = await resolver.match(candidate, 'type');
    expect(result).not.toBeNull();
    expect(result!.archetypeName).toBe('search_input');
    expect(result!.selector).toBe('role=searchbox[name="Search Wikipedia"]');
  });

  it('wildcard pattern still matches the exact prefix alone (search)', async () => {
    const candidate = makeCandidate({ role: 'searchbox', name: 'Search' });
    const result = await resolver.match(candidate, 'type');
    expect(result).not.toBeNull();
    expect(result!.archetypeName).toBe('search_input');
  });

  it('does not match a name that only partially overlaps a non-wildcard pattern', async () => {
    const candidate = makeCandidate({ role: 'button', name: 'log into account' });
    // 'log into account' ≠ 'log in' (exact) and no wildcard pattern present
    const result = await resolver.match(candidate, 'click');
    expect(result).toBeNull();
  });

  // ─── Combobox role (e.g. Google search) ───────────────────────────────────

  // Google's search textarea: <textarea role="combobox" aria-label="Search">
  it('matches combobox role with exact "search" name', async () => {
    const candidate = makeCandidate({ role: 'combobox', name: 'Search' });
    const result = await resolver.match(candidate, 'type');
    expect(result).not.toBeNull();
    expect(result!.archetypeName).toBe('search_input_combobox');
    expect(result!.selector).toBe('role=combobox[name="Search"]');
  });

  it('matches combobox role with wildcard prefix (search wikipedia)', async () => {
    const candidate = makeCandidate({ role: 'combobox', name: 'Search Wikipedia' });
    const result = await resolver.match(candidate, 'type');
    expect(result).not.toBeNull();
    expect(result!.archetypeName).toBe('search_input_combobox');
  });

  it('returns null for combobox when action does not match (click instead of type)', async () => {
    const candidate = makeCandidate({ role: 'combobox', name: 'Search' });
    const result = await resolver.match(candidate, 'click');
    expect(result).toBeNull();
  });

  // ─── AT-2 / AT-3: ambiguity margin in match() ─────────────────────────────

  // AT-2: two archetypes within the margin → match() returns null and logs.
  it('AT-2: returns null and logs ambiguous when two archetypes tie within the margin', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        { name: 'generic_input_a', role: 'textbox', name_patterns: ['name'], action_hint: 'type', confidence: 0.80 },
        { name: 'generic_input_b', role: 'textbox', name_patterns: ['name'], action_hint: 'type', confidence: 0.78 },
      ],
    });
    resolver = new DBArchetypeResolver(obs);
    const candidate = makeCandidate({ role: 'textbox', name: 'name' });
    const result = await resolver.match(candidate, 'type');
    expect(result).toBeNull();
    expect(obs.increment).toHaveBeenCalledWith('archetype_resolver.ambiguous');
    expect(obs.log).toHaveBeenCalledWith('info', 'archetype_resolver.ambiguous', expect.objectContaining({
      matches: expect.arrayContaining(['generic_input_a', 'generic_input_b']),
    }));
  });

  // AT-3: clear winner beyond the 0.10 margin → best is returned.
  it('AT-3: returns best archetype when confidence margin exceeds threshold', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        { name: 'password_input', role: 'textbox', name_patterns: ['password'], action_hint: 'type', confidence: 0.95 },
        { name: 'generic_input',  role: 'textbox', name_patterns: ['password'], action_hint: 'type', confidence: 0.60 },
      ],
    });
    resolver = new DBArchetypeResolver(obs);
    const candidate = makeCandidate({ role: 'textbox', name: 'password' });
    const result = await resolver.match(candidate, 'type');
    expect(result).not.toBeNull();
    expect(result!.archetypeName).toBe('password_input');
  });

  // ─── Cooldown table ────────────────────────────────────────────────────────

  it('getCooldownArchetypes returns the set of archetype names on cooldown', async () => {
    // first call is getArchetypes (populates cache); we only care about the second
    mockQuery
      .mockResolvedValueOnce({ rows: makeArchetypeRows() })
      .mockResolvedValueOnce({ rows: [{ archetype_name: 'login_button' }, { archetype_name: 'submit_button' }] });
    // prime cache so the next call is the cooldown SELECT
    await resolver.match(makeCandidate({ role: 'button', name: 'Log in' }), 'click');

    const set = await resolver.getCooldownArchetypes({
      tenantId: 'tenant-A',
      domain: 'example.com',
      targetHash: 'th-1',
    });
    expect(set.has('login_button')).toBe(true);
    expect(set.has('submit_button')).toBe(true);
    expect(set.has('email_input')).toBe(false);
  });

  it('getCooldownArchetypes returns empty set when DB read fails', async () => {
    mockQuery.mockRejectedValueOnce(new Error('connection refused'));
    const set = await resolver.getCooldownArchetypes({
      tenantId: 'tenant-A',
      domain: 'example.com',
      targetHash: 'th-1',
    });
    expect(set.size).toBe(0);
    expect(obs.log).toHaveBeenCalledWith(
      'warn',
      'archetype_resolver.cooldown_read_failed',
      expect.any(Object),
    );
  });

  it('recordFailure inserts with ON CONFLICT DO UPDATE and increments success counter', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await resolver.recordFailure(
      { tenantId: 'tenant-A', domain: 'example.com', targetHash: 'th-1' },
      'login_button',
      'role=button[name="Log in"]',
    );
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('ON CONFLICT'),
      ['tenant-A', 'example.com', 'th-1', 'login_button', 'role=button[name="Log in"]'],
    );
    expect(obs.increment).toHaveBeenCalledWith('archetype_resolver.record_failure');
  });

  it('recordFailure swallows DB errors and increments the error counter', async () => {
    mockQuery.mockRejectedValueOnce(new Error('boom'));
    await expect(
      resolver.recordFailure(
        { tenantId: 'tenant-A', domain: 'example.com', targetHash: 'th-1' },
        'login_button',
        'role=button[name="Log in"]',
      ),
    ).resolves.toBeUndefined();
    expect(obs.increment).toHaveBeenCalledWith('archetype_resolver.record_failure_error');
  });

  // AT-5: tenant isolation — the cooldown query includes tenant_id, so different
  // tenants passing the same (domain, targetHash) get independent result sets.
  it('AT-5: cooldown read scopes to tenant_id (different tenants, independent sets)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: makeArchetypeRows() }) // warm cache
      .mockResolvedValueOnce({ rows: [{ archetype_name: 'login_button' }] })
      .mockResolvedValueOnce({ rows: [] });
    await resolver.match(makeCandidate({ role: 'button', name: 'Log in' }), 'click');

    const setA = await resolver.getCooldownArchetypes({
      tenantId: 'tenant-A',
      domain: 'example.com',
      targetHash: 'th-1',
    });
    const setB = await resolver.getCooldownArchetypes({
      tenantId: 'tenant-B',
      domain: 'example.com',
      targetHash: 'th-1',
    });
    expect(setA.has('login_button')).toBe(true);
    expect(setB.size).toBe(0);
    // Both cooldown calls must pass tenant_id in the query params (param $1)
    const [, paramsA] = mockQuery.mock.calls[1];
    const [, paramsB] = mockQuery.mock.calls[2];
    expect(paramsA[0]).toBe('tenant-A');
    expect(paramsB[0]).toBe('tenant-B');
  });

  // Selector escaping: double quotes in accessible name are escaped
  it('escapes double quotes in accessible name in the ARIA selector', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        { name: 'submit_button', role: 'button', name_patterns: ['say "hello"'], action_hint: null, confidence: 0.90 },
      ],
    });
    resolver = new DBArchetypeResolver(obs);
    const candidate = makeCandidate({ role: 'button', name: 'Say "Hello"' });
    const result = await resolver.match(candidate, 'click');
    expect(result).not.toBeNull();
    expect(result!.selector).toBe('role=button[name="Say \\"Hello\\""]');
  });
});
