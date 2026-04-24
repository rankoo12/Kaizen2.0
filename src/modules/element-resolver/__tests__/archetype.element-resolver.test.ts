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

  // S5 supersedes the prior "shorter name wins tiebreak" behavior. When two
  // candidates tie at top overlap score, the resolver now bails L0 instead of
  // guessing via name-length tiebreak — the LLM (L5) has parent context the
  // ranker doesn't. This is the intended fix for the automationexercise.com
  // signup-vs-login email ambiguity.
  it('bails L0 when two candidates tie at top score (supersedes shorter-name tiebreak)', async () => {
    const passkey = makeCandidate({ role: 'button', name: 'Sign in with a passkey' });
    const signIn  = makeCandidate({ role: 'button', name: 'Sign in' });
    domPruner.prune.mockResolvedValue([passkey, signIn]);

    const pageMock = { $: jest.fn().mockResolvedValue({}) };
    const result = await resolver.resolve(makeStep({ targetDescription: 'sign in button' }), makeContext(pageMock));

    expect(result.resolutionSource).toBeNull();
    expect(obs.increment).toHaveBeenCalledWith('archetype_resolver.top_tie_skip');
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

  // DOM miss on the top-scoring candidate → falls through to subsequent tied
  // candidates only when they share the top score exactly (no S5 bail because
  // the match is returned only from the top-scoring bucket).
  // Fixture: one candidate scores top (unique), DOM misses on first attempt
  // via a retry mock to cover the validation-failure code path.
  it('returns MISS and increments dom_miss when the top-scoring candidate fails DOM validation', async () => {
    const sole = makeCandidate({ role: 'button', name: 'Log in' });
    domPruner.prune.mockResolvedValue([sole]);

    archetypeResolver.match.mockResolvedValue(makeMatch());

    const pageMock = {
      $: jest.fn().mockResolvedValue(null), // DOM miss
    };

    const result = await resolver.resolve(makeStep(), makeContext(pageMock));

    expect(result.resolutionSource).toBeNull();
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

  // Surface archetypeName on the SelectorSet so the worker can persist it on
  // step_results.archetype_name — the verdict route reads that column to
  // write the archetype_failures cooldown row (cross-process fix, S4).
  it('surfaces archetypeName on the SelectorSet for persistence by the worker', async () => {
    const pageMock = { $: jest.fn().mockResolvedValue({}) };
    const result = await resolver.resolve(makeStep(), makeContext(pageMock));
    expect(result.archetypeName).toBe('login_button');
  });

  // recordFailure is now a no-op on the element resolver — the verdict route
  // owns the archetype_failures write path because it runs in the API process
  // while this resolver lives in the worker process.
  it('recordFailure is a no-op (verdict route owns the cooldown write path)', async () => {
    const pageMock = { $: jest.fn().mockResolvedValue({}) };
    const step = makeStep();
    const ctx = makeContext(pageMock);
    await resolver.resolve(step, ctx);

    await resolver.recordFailure(step.targetHash, ctx.domain, 'role=button[name="Log in"]');

    expect(archetypeResolver.recordFailure).not.toHaveBeenCalled();
  });

  // AT-7: tied top-score bail. When ≥ 2 candidates share the highest overlap
  // score (e.g. signup vs. login email inputs both exposing the same AX name),
  // L0 has no basis to pick one and must fall through to L1..L5.
  it('AT-7: bails L0 when ≥ 2 candidates tie at top overlap score', async () => {
    const signupEmail = makeCandidate({
      role: 'textbox',
      name: 'Email Address',
      attributes: { name: 'email', 'data-qa': 'signup-email', placeholder: 'Email Address' },
    });
    const loginEmail = makeCandidate({
      role: 'textbox',
      name: 'Email Address',
      attributes: { name: 'email', 'data-qa': 'login-email', placeholder: 'Email Address' },
    });
    domPruner.prune.mockResolvedValue([signupEmail, loginEmail]);
    archetypeResolver.match.mockResolvedValue(
      makeMatch({ archetypeName: 'email_input', selector: 'role=textbox[name="Email Address"]' }),
    );

    const pageMock = { $: jest.fn().mockResolvedValue({}) };
    const step = makeStep({ action: 'type', targetDescription: 'type x in email' });
    const result = await resolver.resolve(step, makeContext(pageMock));

    expect(result.resolutionSource).toBeNull();
    expect(result.selectors).toHaveLength(0);
    expect(obs.increment).toHaveBeenCalledWith('archetype_resolver.top_tie_skip');
    // Must not have even attempted an archetype match — the bail short-circuits.
    expect(archetypeResolver.match).not.toHaveBeenCalled();
  });

  // Counterpart to AT-7: when the top score is unique, L0 proceeds normally.
  it('AT-7 counterpart: proceeds with L0 when only one candidate holds the top score', async () => {
    const winner = makeCandidate({
      role: 'textbox',
      name: 'Login',
      attributes: { name: 'username' },
    });
    const loser = makeCandidate({
      role: 'textbox',
      name: 'Unrelated',
      attributes: { name: 'unrelated' },
    });
    domPruner.prune.mockResolvedValue([winner, loser]);

    const pageMock = { $: jest.fn().mockResolvedValue({}) };
    const step = makeStep({ action: 'type', targetDescription: 'type x in the login username field' });
    const result = await resolver.resolve(step, makeContext(pageMock));

    expect(result.resolutionSource).toBe('archetype');
    expect(obs.increment).not.toHaveBeenCalledWith('archetype_resolver.top_tie_skip');
  });
});
