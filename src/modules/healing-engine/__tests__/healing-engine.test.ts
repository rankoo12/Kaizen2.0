import { HealingEngine } from '../healing-engine';
import type { IHealingStrategy } from '../interfaces';
import type { ClassifiedFailure, HealingContext, HealingAttempt } from '../../../types';

jest.mock('../../../db/pool', () => ({
  getPool: jest.fn().mockReturnValue({ query: jest.fn().mockResolvedValue({ rows: [] }) }),
}));

const makeFailure = (overrides: Partial<ClassifiedFailure> = {}): ClassifiedFailure => ({
  stepResult: { status: 'failed', selectorUsed: null, errorType: null, errorMessage: null, durationMs: 0, screenshotKey: null, domSnapshotKey: null },
  failureClass: 'ELEMENT_MUTATED',
  step: { action: 'click', rawText: 'click submit', contentHash: 'abc', targetDescription: 'submit' } as any,
  previousSelector: '#submit',
  ...overrides,
});

const makeContext = (): HealingContext => ({ tenantId: 't1', runId: 'r1', page: {} });

const makeStrategy = (name: string, canHandle: boolean, attempt: HealingAttempt): IHealingStrategy => ({
  name,
  canHandle: jest.fn().mockReturnValue(canHandle),
  heal: jest.fn().mockResolvedValue(attempt),
});

const mockObs = {
  startSpan: jest.fn().mockReturnValue({ end: jest.fn() }),
  log: jest.fn(),
  increment: jest.fn(),
  histogram: jest.fn(),
};

describe('HealingEngine', () => {
  afterEach(() => jest.clearAllMocks());

  it('returns success from the first matching strategy', async () => {
    const s1 = makeStrategy('S1', true, { succeeded: true, newSelector: '#new', durationMs: 10 });
    const s2 = makeStrategy('S2', true, { succeeded: true, newSelector: '#other', durationMs: 5 });
    const engine = new HealingEngine([s1, s2], mockObs as any);

    const result = await engine.heal(makeFailure(), makeContext());

    expect(result.succeeded).toBe(true);
    expect(result.strategyUsed).toBe('S1');
    expect(s2.heal).not.toHaveBeenCalled();
  });

  it('skips strategies where canHandle returns false', async () => {
    const s1 = makeStrategy('S1', false, { succeeded: true, newSelector: '#x', durationMs: 1 });
    const s2 = makeStrategy('S2', true, { succeeded: true, newSelector: '#y', durationMs: 1 });
    const engine = new HealingEngine([s1, s2], mockObs as any);

    const result = await engine.heal(makeFailure(), makeContext());

    expect(s1.heal).not.toHaveBeenCalled();
    expect(result.strategyUsed).toBe('S2');
  });

  it('continues to next strategy when one fails', async () => {
    const s1 = makeStrategy('S1', true, { succeeded: false, newSelector: null, durationMs: 5 });
    const s2 = makeStrategy('S2', true, { succeeded: true, newSelector: '#healed', durationMs: 5 });
    const engine = new HealingEngine([s1, s2], mockObs as any);

    const result = await engine.heal(makeFailure(), makeContext());

    expect(result.succeeded).toBe(true);
    expect(result.strategyUsed).toBe('S2');
    expect(result.attempts).toBe(2);
  });

  it('returns failed result when all strategies fail', async () => {
    const s1 = makeStrategy('S1', true, { succeeded: false, newSelector: null, durationMs: 5 });
    const s2 = makeStrategy('S2', true, { succeeded: false, newSelector: null, durationMs: 5 });
    const engine = new HealingEngine([s1, s2], mockObs as any);

    const result = await engine.heal(makeFailure(), makeContext());

    expect(result.succeeded).toBe(false);
    expect(result.newSelector).toBeNull();
  });

  it('enforces max 3 attempts budget', async () => {
    const strategies = Array.from({ length: 5 }, (_, i) =>
      makeStrategy(`S${i}`, true, { succeeded: false, newSelector: null, durationMs: 1 }),
    );
    const engine = new HealingEngine(strategies, mockObs as any);

    const result = await engine.heal(makeFailure(), makeContext());

    expect(result.attempts).toBe(3);
    expect(strategies[3].heal).not.toHaveBeenCalled();
    expect(strategies[4].heal).not.toHaveBeenCalled();
  });
});
