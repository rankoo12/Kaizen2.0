import { FallbackSelectorStrategy } from '../strategies/fallback-selector.strategy';
import { AdaptiveWaitStrategy } from '../strategies/adaptive-wait.strategy';
import { EscalationStrategy } from '../strategies/escalation.strategy';
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
