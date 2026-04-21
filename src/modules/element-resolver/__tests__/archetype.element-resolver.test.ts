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
    archetypeResolver = {
      match: jest.fn().mockResolvedValue(makeMatch()),
      getCooldownArchetypes: jest.fn().mockResolvedValue(new Set()),
      recordFailure: jest.fn().mockResolvedValue(undefined),
    };
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

  // Tied-score fallthrough: when two candidates score equally on target overlap,
  // the resolver is allowed to skip a non-matching tied candidate and try the
  // next tied one (e.g. "Sign in with a passkey" vs. "Sign in" both score on
  // "sign in button"). Score-lower candidates are NOT tried (see lower-score-skip test).
  it('tries subsequent tied-score candidates when top one has no archetype match', async () => {
    const noMatch = makeCandidate({ role: 'button', name: 'Sign in with a passkey' });
    const matchCandidate = makeCandidate({ role: 'button', name: 'Sign in' });
    // Both score 1 on target "sign in button" ('sign' in haystack of both;
    // 'button' is a stopword).  Ranked by name-length tiebreak → matchCandidate first.
    domPruner.prune.mockResolvedValue([noMatch, matchCandidate]);

    archetypeResolver.match.mockImplementation(async (candidate) => {
      if (candidate.name === 'Sign in') return makeMatch({ selector: 'role=button[name="Sign in"]' });
      return null;
    });

    const pageMock = { $: jest.fn().mockResolvedValue({}) };
    const step = makeStep({ targetDescription: 'sign in button' });
    const result = await resolver.resolve(step, makeContext(pageMock));

    expect(result.resolutionSource).toBe('archetype');
    expect(result.selectors[0].selector).toBe('role=button[name="Sign in"]');
  });

  // Top-score lock: an archetype match on a lower-scoring candidate MUST NOT
  // win over a higher-scoring candidate that has no archetype. Regression
  // guard for the saucedemo "username" → "Password" leak.
  it('does not fall through to a lower-scoring candidate even if it has an archetype match', async () => {
    const username = makeCandidate({
      role: 'textbox',
      name: 'Username',
      attributes: { name: 'user-name', id: 'user-name', placeholder: 'Username', 'data-test': 'username' },
    });
    const password = makeCandidate({
      role: 'textbox',
      name: 'Password',
      attributes: { name: 'password', id: 'password', placeholder: 'Password' },
    });
    domPruner.prune.mockResolvedValue([password, username]);

    // Library has password_input but no username_input at this point.
    archetypeResolver.match.mockImplementation(async (candidate) => {
      if (candidate.name === 'Password') {
        return makeMatch({ archetypeName: 'password_input', selector: 'role=textbox[name="Password"]' });
      }
      return null;
    });

    const pageMock = { $: jest.fn().mockResolvedValue({}) };
    const step = makeStep({ action: 'type', targetDescription: 'username field' });
    const result = await resolver.resolve(step, makeContext(pageMock));

    // Username wins ranking (score 1 vs 0). It has no archetype → MISS.
    // Password MUST NOT be returned just because it happens to have an archetype.
    expect(result.resolutionSource).toBeNull();
    expect(result.selectors).toHaveLength(0);
    expect(obs.increment).toHaveBeenCalledWith('archetype_resolver.lower_score_skip');
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

  // Extra: recordSuccess is a no-op
  it('recordSuccess is a no-op', async () => {
    await expect(resolver.recordSuccess('hash', 'example.com', 'button')).resolves.toBeUndefined();
  });

  // AT-1 (S2 ranking): when step says "username" but the accessible name is
  // "Email Address", DOM-attribute tokens (name="username") must win the ranking
  // over the tiebreak that would otherwise prefer the shorter "Password" name.
  it('AT-1: DOM-attribute signal outranks name-length tiebreak (username vs password)', async () => {
    const usernameField = makeCandidate({
      role: 'textbox',
      name: 'Email Address',
      attributes: { name: 'username', placeholder: 'Email Address' },
    });
    const passwordField = makeCandidate({
      role: 'textbox',
      name: 'Password',
      attributes: { name: 'password', placeholder: 'Password' },
    });
    domPruner.prune.mockResolvedValue([passwordField, usernameField]);

    archetypeResolver.match.mockImplementation(async (cand) => {
      if (cand.attributes?.name === 'username') {
        return makeMatch({
          archetypeName: 'email_input',
          selector: 'role=textbox[name="Email Address"]',
        });
      }
      return null;
    });

    const pageMock = { $: jest.fn().mockResolvedValue({}) };
    const step = makeStep({
      action: 'type',
      targetDescription: 'type rankoo in the username field',
    });
    const result = await resolver.resolve(step, makeContext(pageMock));

    expect(result.resolutionSource).toBe('archetype');
    expect(result.selectors[0].selector).toBe('role=textbox[name="Email Address"]');
  });

  // AT-4: user marks the step failed → next run skips the cooldowned archetype.
  it('AT-4: cooldown skip — archetype on cooldown is bypassed', async () => {
    archetypeResolver.getCooldownArchetypes.mockResolvedValue(new Set(['login_button']));
    const pageMock = { $: jest.fn().mockResolvedValue({}) };
    const result = await resolver.resolve(makeStep(), makeContext(pageMock));

    expect(result.resolutionSource).toBeNull();
    expect(result.selectors).toHaveLength(0);
    expect(obs.increment).toHaveBeenCalledWith(
      'archetype_resolver.cooldown_skip',
      { archetype: 'login_button' },
    );
  });

  // recordFailure routes through to the archetype resolver when it matches the
  // last resolved archetype.
  it('recordFailure forwards (tenantId, domain, targetHash, archetypeName, selector) to archetypeResolver.recordFailure', async () => {
    const pageMock = { $: jest.fn().mockResolvedValue({}) };
    const step = makeStep();
    const ctx = makeContext(pageMock);
    await resolver.resolve(step, ctx);

    await resolver.recordFailure(step.targetHash, ctx.domain, 'role=button[name="Log in"]');

    expect(archetypeResolver.recordFailure).toHaveBeenCalledWith(
      { tenantId: ctx.tenantId, domain: ctx.domain, targetHash: step.targetHash },
      'login_button',
      'role=button[name="Log in"]',
    );
  });

  // AT-5 proxy: ArchetypeElementResolver forwards tenantId — which implies
  // the DB resolver scopes cooldowns per tenant. Integration-level assertion
  // of tenant isolation lives in the db.archetype-resolver.test.ts suite.
  it('AT-5 proxy: recordFailure preserves tenantId from the resolve() call', async () => {
    const pageMock = { $: jest.fn().mockResolvedValue({}) };
    const step = makeStep();
    const ctx: ResolutionContext = {
      tenantId: 'tenant-A',
      domain: 'example.com',
      page: pageMock,
    };
    await resolver.resolve(step, ctx);
    await resolver.recordFailure(step.targetHash, ctx.domain, 'role=button[name="Log in"]');

    expect(archetypeResolver.recordFailure).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-A' }),
      'login_button',
      expect.any(String),
    );
  });

  // recordFailure is a no-op when it doesn't match the last resolve()
  it('recordFailure is a no-op when targetHash/selector do not match the last resolve', async () => {
    await resolver.recordFailure('different-hash', 'example.com', 'role=button[name="Log in"]');
    expect(archetypeResolver.recordFailure).not.toHaveBeenCalled();
  });

  it('recordSuccess clears the pending lastMatch', async () => {
    const pageMock = { $: jest.fn().mockResolvedValue({}) };
    const step = makeStep();
    const ctx = makeContext(pageMock);
    await resolver.resolve(step, ctx);
    await resolver.recordSuccess(step.contentHash, ctx.domain, 'role=button[name="Log in"]');
    await resolver.recordFailure(step.targetHash, ctx.domain, 'role=button[name="Log in"]');
    expect(archetypeResolver.recordFailure).not.toHaveBeenCalled();
  });
});
