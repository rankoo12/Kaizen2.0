import { FallbackSelectorStrategy } from '../strategies/fallback-selector.strategy';
import { AdaptiveWaitStrategy } from '../strategies/adaptive-wait.strategy';
import { EscalationStrategy } from '../strategies/escalation.strategy';
import { ResolveAndRetryStrategy } from '../strategies/resolve-and-retry.strategy';
import type { ClassifiedFailure, HealingContext } from '../../../types';

const makeFailure = (failureClass: ClassifiedFailure['failureClass'], selectors: Array<{ selector: string }> = []): ClassifiedFailure => ({
  stepResult: { status: 'failed', selectorUsed: null, errorType: null, errorMessage: null, durationMs: 0, screenshotKey: null, domSnapshotKey: null, selectors } as any,
  failureClass,
  step: { action: 'click', rawText: 'click button', contentHash: 'abc', targetDescription: 'button' } as any,
  previousSelector: '#old',
});

const makeContext = (page: object = {}): HealingContext => ({ tenantId: 't1', runId: 'r1', page });

const mockObs = { log: jest.fn(), increment: jest.fn(), startSpan: jest.fn(), histogram: jest.fn() };

// ─── FallbackSelectorStrategy ─────────────────────────────────────────────────

describe('FallbackSelectorStrategy', () => {
  const strategy = new FallbackSelectorStrategy();

  it('handles ELEMENT_MUTATED and ELEMENT_REMOVED', () => {
    expect(strategy.canHandle(makeFailure('ELEMENT_MUTATED'))).toBe(true);
    expect(strategy.canHandle(makeFailure('ELEMENT_REMOVED'))).toBe(true);
    expect(strategy.canHandle(makeFailure('TIMING'))).toBe(false);
  });

  it('returns success when a fallback selector resolves', async () => {
    // #old is skipped (it's previousSelector), so the first actual $ call is for #fallback
    const page = { $: jest.fn().mockResolvedValueOnce({}) };
    const failure = makeFailure('ELEMENT_MUTATED', [
      { selector: '#old' },
      { selector: '#fallback' },
    ]);
    const result = await strategy.heal(failure, makeContext(page));
    expect(result.succeeded).toBe(true);
    expect(result.newSelector).toBe('#fallback');
  });

  it('skips the previously-failed selector', async () => {
    const page = { $: jest.fn().mockResolvedValue({}) };
    const failure = makeFailure('ELEMENT_MUTATED', [
      { selector: '#old' },
      { selector: '#second' },
    ]);
    await strategy.heal(failure, makeContext(page));
    // #old is previousSelector — should NOT be tried
    expect(page.$).not.toHaveBeenCalledWith('#old');
  });

  it('returns failure when no fallback selector resolves', async () => {
    const page = { $: jest.fn().mockResolvedValue(null) };
    const failure = makeFailure('ELEMENT_MUTATED', [{ selector: '#old' }, { selector: '#also-gone' }]);
    const result = await strategy.heal(failure, makeContext(page));
    expect(result.succeeded).toBe(false);
  });
});

// ─── AdaptiveWaitStrategy ─────────────────────────────────────────────────────

describe('AdaptiveWaitStrategy', () => {
  const strategy = new AdaptiveWaitStrategy();

  it('handles TIMING and PAGE_NOT_LOADED', () => {
    expect(strategy.canHandle(makeFailure('TIMING'))).toBe(true);
    expect(strategy.canHandle(makeFailure('PAGE_NOT_LOADED'))).toBe(true);
    expect(strategy.canHandle(makeFailure('ELEMENT_MUTATED'))).toBe(false);
  });

  it('succeeds when element appears after wait', async () => {
    const page = {
      $: jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({}),
      waitForTimeout: jest.fn().mockResolvedValue(undefined),
    };
    const result = await strategy.heal(makeFailure('TIMING'), makeContext(page));
    expect(result.succeeded).toBe(true);
    expect(result.newSelector).toBe('#old');
  });

  it('returns failure when element never appears within budget', async () => {
    const page = {
      $: jest.fn().mockResolvedValue(null),
      waitForTimeout: jest.fn().mockResolvedValue(undefined),
    };
    // Make MAX_WAIT_MS effectively 0 by resolving immediately always null
    const result = await strategy.heal(makeFailure('TIMING'), makeContext(page));
    expect(result.succeeded).toBe(false);
  }, 15000);

  it('deadline-aware: waits past the classic 10s when the watchdog budget allows (finding #10b)', async () => {
    // Fixed cap waits 500+1000+2000+4000+2500 = 10s across 5 polls. With a
    // 40s budget (deadline − reserve) the doubling keeps going — a 20s-late
    // element (7th poll at 31.5s+) is only reachable deadline-aware.
    const waits: number[] = [];
    const page = {
      $: jest.fn()
        .mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValueOnce(null)
        .mockResolvedValueOnce({}), // appears on the 7th poll — past the fixed cap
      waitForTimeout: jest.fn().mockImplementation(async (ms: number) => { waits.push(ms); }),
    };
    const context = { ...makeContext(page), deadlineAt: Date.now() + 55_000 }; // 55s left − 15s reserve = 40s budget

    const result = await strategy.heal(makeFailure('TIMING'), context);

    expect(result.succeeded).toBe(true);
    expect(waits.length).toBe(7);
    expect(waits.reduce((a, b) => a + b, 0)).toBeGreaterThan(10_000); // genuinely waited past the old cap
  });

  it('deadline-aware: a short remaining budget still gets the classic 10s floor', async () => {
    const waits: number[] = [];
    const page = {
      $: jest.fn().mockResolvedValue(null),
      waitForTimeout: jest.fn().mockImplementation(async (ms: number) => { waits.push(ms); }),
    };
    // Deadline nearly spent: floor keeps the classic budget, never less.
    const context = { ...makeContext(page), deadlineAt: Date.now() + 12_000 };

    const result = await strategy.heal(makeFailure('TIMING'), context);

    expect(result.succeeded).toBe(false);
    expect(waits.reduce((a, b) => a + b, 0)).toBe(10_000);
  });
});

// ─── EscalationStrategy ───────────────────────────────────────────────────────

describe('EscalationStrategy', () => {
  it('canHandle always returns true', () => {
    const strategy = new EscalationStrategy({ notifyEscalation: jest.fn().mockResolvedValue(undefined) }, mockObs as any);
    expect(strategy.canHandle(makeFailure('LOGIC_FAILURE'))).toBe(true);
    expect(strategy.canHandle(makeFailure('TIMING'))).toBe(true);
  });

  it('calls notifier and returns succeeded: false', async () => {
    const notifier = { notifyEscalation: jest.fn().mockResolvedValue(undefined) };
    const strategy = new EscalationStrategy(notifier, mockObs as any);
    const result = await strategy.heal(makeFailure('LOGIC_FAILURE'), makeContext());
    expect(notifier.notifyEscalation).toHaveBeenCalledTimes(1);
    expect(result.succeeded).toBe(false);
    expect(result.newSelector).toBeNull();
  });
});

// ─── ResolveAndRetryStrategy ──────────────────────────────────────────────────

describe('ResolveAndRetryStrategy', () => {
  const strategy = new ResolveAndRetryStrategy({} as any, {} as any, {} as any, mockObs as any);

  // The #15 retry loop sleeps between attempts; tests run it at zero wait so
  // the budget cases (which exercise several heal() calls) stay fast.
  beforeAll(() => { process.env.HEAL_RESOLVE_RETRY_WAIT_MS = '0'; });
  afterAll(() => { delete process.env.HEAL_RESOLVE_RETRY_WAIT_MS; });

  it('re-resolves for element-gone AND stale-selector timeouts', () => {
    // Regression: a STALE cached selector times out and classifies as TIMING (the
    // classifier can't prove SelectorGone for role/CSS-id selectors). TIMING used
    // to be excluded here, so the one strategy that can fix a stale cache never
    // ran — a stale selector could not self-heal. It must handle TIMING now.
    expect(strategy.canHandle(makeFailure('ELEMENT_REMOVED'))).toBe(true);
    expect(strategy.canHandle(makeFailure('ELEMENT_MUTATED'))).toBe(true);
    expect(strategy.canHandle(makeFailure('TIMING'))).toBe(true);
    expect(strategy.canHandle(makeFailure('ELEMENT_OBSCURED'))).toBe(true);
    // Genuinely-unrelated classes still opt out.
    expect(strategy.canHandle(makeFailure('LOGIC_FAILURE'))).toBe(false);
    expect(strategy.canHandle(makeFailure('PAGE_NOT_LOADED'))).toBe(false);
  });

  // ── Hourly budget (HEAL_RESOLVE_RETRY_PER_HOUR) ────────────────────────────
  // The cap is read per call: a mutated site needs many re-resolutions in one
  // suite run, so the changing-sites bench (and a tenant mid-redesign) raises
  // it via env without a worker restart.

  describe('hourly budget', () => {
    const makeRedis = () => {
      const counts = new Map<string, number>();
      return {
        incr: jest.fn(async (key: string) => {
          const next = (counts.get(key) ?? 0) + 1;
          counts.set(key, next);
          return next;
        }),
        expire: jest.fn(async () => 1),
      };
    };
    // Empty pruner candidates: a within-budget call returns {succeeded:false}
    // AFTER consulting the pruner; an over-budget call never reaches it.
    const pruner = { prune: jest.fn(async () => []) };
    const obs = { log: jest.fn(), increment: jest.fn(), startSpan: jest.fn(), histogram: jest.fn() };

    afterEach(() => {
      delete process.env.HEAL_RESOLVE_RETRY_PER_HOUR;
      jest.clearAllMocks();
    });

    // NOTE: one within-budget heal() now consults the pruner up to 3 times —
    // the #15 retry loop re-prunes on each attempt when nothing matched
    // (empty candidates here), so prune-call counts are heals × 3.
    it('defaults to 2 per hour — third call is rejected before any LLM work', async () => {
      const s = new ResolveAndRetryStrategy(pruner as any, {} as any, makeRedis() as any, obs as any);
      await s.heal(makeFailure('ELEMENT_MUTATED'), makeContext({}));
      await s.heal(makeFailure('ELEMENT_MUTATED'), makeContext({}));
      expect(pruner.prune).toHaveBeenCalledTimes(6); // 2 heals × 3 retry attempts

      const third = await s.heal(makeFailure('ELEMENT_MUTATED'), makeContext({}));
      expect(third.succeeded).toBe(false);
      expect(pruner.prune).toHaveBeenCalledTimes(6); // not consulted
      expect(obs.increment).toHaveBeenCalledWith('healing.resolve_retry_budget_exceeded', { tenantId: 't1' });
    });

    it('honors HEAL_RESOLVE_RETRY_PER_HOUR without a new instance', async () => {
      const s = new ResolveAndRetryStrategy(pruner as any, {} as any, makeRedis() as any, obs as any);
      process.env.HEAL_RESOLVE_RETRY_PER_HOUR = '5';
      for (let i = 0; i < 5; i++) await s.heal(makeFailure('ELEMENT_MUTATED'), makeContext({}));
      expect(pruner.prune).toHaveBeenCalledTimes(15); // 5 heals × 3 retry attempts
      expect(obs.increment).not.toHaveBeenCalledWith('healing.resolve_retry_budget_exceeded', { tenantId: 't1' });

      const sixth = await s.heal(makeFailure('ELEMENT_MUTATED'), makeContext({}));
      expect(sixth.succeeded).toBe(false);
      expect(pruner.prune).toHaveBeenCalledTimes(15);
    });

    it('rejects nonsense overrides and keeps the default', async () => {
      for (const bad of ['0', '-3', 'many', '2.5']) {
        process.env.HEAL_RESOLVE_RETRY_PER_HOUR = bad;
        const s = new ResolveAndRetryStrategy(pruner as any, {} as any, makeRedis() as any, obs as any);
        await s.heal(makeFailure('ELEMENT_MUTATED'), makeContext({}));
        await s.heal(makeFailure('ELEMENT_MUTATED'), makeContext({}));
        const third = await s.heal(makeFailure('ELEMENT_MUTATED'), makeContext({}));
        expect(third.succeeded).toBe(false);
        expect(obs.increment).toHaveBeenCalledWith('healing.resolve_retry_budget_exceeded', { tenantId: 't1' });
        jest.clearAllMocks();
      }
    });
  });
});
