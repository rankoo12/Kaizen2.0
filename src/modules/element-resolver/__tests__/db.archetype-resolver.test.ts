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
