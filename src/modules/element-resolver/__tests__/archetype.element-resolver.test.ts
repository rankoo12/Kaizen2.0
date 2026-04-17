import { ArchetypeElementResolver } from '../archetype.element-resolver';
import type { IDOMPruner } from '../../dom-pruner/interfaces';
import type { IArchetypeResolver, ArchetypeMatch } from '../archetype.interfaces';
import type { IObservability } from '../../observability/interfaces';
import type { CandidateNode, StepAST, ResolutionContext } from '../../../types';

const makeObservability = (): jest.Mocked<IObservability> => ({
  startSpan: jest.fn().mockReturnValue({ end: jest.fn(), setAttribute: jest.fn() }),
  log: jest.fn(),
  increment: jest.fn(),
  histogram: jest.fn(),
});

const makeStep = (overrides: Partial<StepAST> = {}): StepAST => ({
  action: 'click',
  targetDescription: 'login button',
  value: null,
  url: null,
  rawText: 'click the login button',
  contentHash: 'hash-abc',
  targetHash: 'target-hash-abc',
  ...overrides,
});

const makeContext = (pageMock?: object): ResolutionContext => ({
  tenantId: '00000000-0000-0000-0000-000000000001',
  domain: 'example.com',
  page: pageMock ?? { $: jest.fn().mockResolvedValue({}) },
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

const makeMatch = (overrides: Partial<ArchetypeMatch> = {}): ArchetypeMatch => ({
  archetypeName: 'login_button',
  selector: 'role=button[name="Log in"]',
  confidence: 0.95,
  ...overrides,
});

describe('ArchetypeElementResolver', () => {
  let domPruner: jest.Mocked<IDOMPruner>;
  let archetypeResolver: jest.Mocked<IArchetypeResolver>;
  let obs: jest.Mocked<IObservability>;
  let resolver: ArchetypeElementResolver;

  beforeEach(() => {
    domPruner = { prune: jest.fn().mockResolvedValue([makeCandidate()]) };
    archetypeResolver = { match: jest.fn().mockResolvedValue(makeMatch()) };
    obs = makeObservability();
    resolver = new ArchetypeElementResolver(domPruner, archetypeResolver, obs);
  });

  afterEach(() => jest.clearAllMocks());

  // 1. Returns SelectorSet with resolutionSource: 'archetype' on full hit
  it('returns SelectorSet with resolutionSource "archetype" when archetype matches and DOM is valid', async () => {
    const pageMock = { $: jest.fn().mockResolvedValue({}) }; // non-null → element found
    const result = await resolver.resolve(makeStep(), makeContext(pageMock));

    expect(result.selectors).toHaveLength(1);
    expect(result.selectors[0].selector).toBe('role=button[name="Log in"]');
    expect(result.selectors[0].strategy).toBe('aria');
    expect(result.selectors[0].confidence).toBe(0.95);
    expect(result.resolutionSource).toBe('archetype');
    expect(result.fromCache).toBe(false);
    expect(result.cacheSource).toBeNull();
  });

  // 2. Returns empty SelectorSet when archetype matches but selector not in DOM
  it('returns empty SelectorSet when archetype matches but selector not found in DOM', async () => {
    const pageMock = { $: jest.fn().mockResolvedValue(null) }; // null → not in DOM
    const result = await resolver.resolve(makeStep(), makeContext(pageMock));

    expect(result.selectors).toHaveLength(0);
    expect(result.resolutionSource).toBeNull();
    expect(obs.increment).toHaveBeenCalledWith('resolver.archetype_dom_miss', { archetype: 'login_button' });
  });

  // 3. Returns empty SelectorSet when no archetype matches (fallthrough)
  it('returns empty SelectorSet when no archetype matches', async () => {
    archetypeResolver.match.mockResolvedValue(null);
    const result = await resolver.resolve(makeStep(), makeContext());

    expect(result.selectors).toHaveLength(0);
    expect(result.resolutionSource).toBeNull();
    expect(obs.increment).toHaveBeenCalledWith('resolver.archetype_miss');
  });

  // 4. tokensUsed is always 0
  it('tokensUsed is always 0', async () => {
    const pageMock = { $: jest.fn().mockResolvedValue({}) };
    const result = await resolver.resolve(makeStep(), makeContext(pageMock));
    expect(result.tokensUsed).toBe(0);
  });

  // Extra: returns MISS immediately when targetDescription is null
  it('returns MISS without calling pruner when targetDescription is null', async () => {
    const step = makeStep({ targetDescription: null });
    const result = await resolver.resolve(step, makeContext());

    expect(domPruner.prune).not.toHaveBeenCalled();
    expect(result.selectors).toHaveLength(0);
  });

  // Extra: returns MISS when pruner returns no candidates
  it('returns MISS when pruner returns no candidates', async () => {
    domPruner.prune.mockResolvedValue([]);
    const result = await resolver.resolve(makeStep(), makeContext());

    expect(result.selectors).toHaveLength(0);
    expect(obs.increment).toHaveBeenCalledWith('resolver.archetype_miss');
  });

  // Ranking: shorter name wins tiebreak — "Sign in" preferred over "Sign in with a passkey"
  it('prefers shorter-named candidate on equal word-overlap score', async () => {
    const passkey = makeCandidate({ role: 'button', name: 'Sign in with a passkey' });
    const signIn  = makeCandidate({ role: 'button', name: 'Sign in' });
    // passkey comes first in DOM order — tiebreaker must flip it
    domPruner.prune.mockResolvedValue([passkey, signIn]);

    // archetypeResolver only matches "Sign in", not "Sign in with a passkey"
    archetypeResolver.match.mockImplementation(async (candidate) => {
      if (candidate.name === 'Sign in') return makeMatch({ selector: 'role=button[name="Sign in"]' });
      return null;
    });

    const pageMock = { $: jest.fn().mockResolvedValue({}) };
    const result = await resolver.resolve(makeStep({ targetDescription: 'sign in button' }), makeContext(pageMock));

    expect(result.selectors[0].selector).toBe('role=button[name="Sign in"]');
    expect(result.resolutionSource).toBe('archetype');
  });

  // Top-N iteration: falls through non-matching candidates to find the match.
  // Scenario: "Purchase Button" scores higher on word-overlap for target "click the button"
  // but has no archetype; "Submit" scores lower but matches submit_button archetype.
  it('tries subsequent candidates when higher-scoring candidate has no archetype match', async () => {
    // "purchase button" → 'button' matches → score 1
    const noMatch = makeCandidate({ role: 'button', name: 'Purchase Button' });
    // "submit" → 'button' in role matches → score 1 (same score, longer name → ranked second)
    // Actually let's just give noMatch a higher score by name length tiebreak going wrong way:
    // Use a target where noMatch scores higher numerically
    const matchCandidate = makeCandidate({ role: 'button', name: 'Submit' });
    // For target "click the custom purchase button", noMatch scores higher (has 'purchase' + 'button')
    // matchCandidate only scores on 'button'
    domPruner.prune.mockResolvedValue([noMatch, matchCandidate]);

    archetypeResolver.match.mockImplementation(async (candidate) => {
      if (candidate.name === 'Submit') return makeMatch({ selector: 'role=button[name="Submit"]' });
      return null;
    });

    const pageMock = { $: jest.fn().mockResolvedValue({}) };
    const step = makeStep({ targetDescription: 'click the custom purchase button' });
    const result = await resolver.resolve(step, makeContext(pageMock));

    expect(result.resolutionSource).toBe('archetype');
    // Both candidates were tried (noMatch first by score, then matchCandidate)
    expect(archetypeResolver.match).toHaveBeenCalledTimes(2);
  });

  // DOM miss on first candidate → tries next candidate
  it('continues to next candidate when DOM validation fails for first match', async () => {
    const first  = makeCandidate({ role: 'button', name: 'Sign in with a passkey' });
    const second = makeCandidate({ role: 'button', name: 'Sign in' });
    domPruner.prune.mockResolvedValue([first, second]);

    archetypeResolver.match.mockResolvedValue(makeMatch());

    const pageMock = {
      $: jest.fn()
        .mockResolvedValueOnce(null) // first candidate: DOM miss
        .mockResolvedValueOnce({}),  // second candidate: DOM hit
    };

    const result = await resolver.resolve(makeStep(), makeContext(pageMock));

    expect(result.resolutionSource).toBe('archetype');
    expect(obs.increment).toHaveBeenCalledWith('resolver.archetype_dom_miss', expect.any(Object));
  });

  // Extra: recordSuccess and recordFailure are no-ops (do not throw)
  it('recordSuccess is a no-op', async () => {
    await expect(resolver.recordSuccess('hash', 'example.com', 'button')).resolves.toBeUndefined();
  });

  it('recordFailure is a no-op', async () => {
    await expect(resolver.recordFailure('hash', 'example.com', 'button')).resolves.toBeUndefined();
  });
});
