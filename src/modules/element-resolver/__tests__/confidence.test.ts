import {
  computeConfidence,
  appendOutcome,
  classifyConfidence,
  OUTCOME_WINDOW_SIZE,
} from '../confidence';

describe('computeConfidence', () => {
  it('returns 1.0 for an empty window (no history = assume healthy)', () => {
    expect(computeConfidence([])).toBe(1.0);
  });

  it('returns 1.0 when all outcomes are successes', () => {
    const window = Array(10).fill(true);
    expect(computeConfidence(window)).toBeCloseTo(1.0, 5);
  });

  it('returns 0.0 when all outcomes are failures', () => {
    const window = Array(10).fill(false);
    expect(computeConfidence(window)).toBeCloseTo(0.0, 5);
  });

  it('weights recent failures more heavily than old ones', () => {
    // Window A: old failure then many successes → higher score
    const windowA = [false, ...Array(9).fill(true)]; // failure is oldest
    // Window B: many successes then recent failure → lower score
    const windowB = [...Array(9).fill(true), false]; // failure is most recent

    const scoreA = computeConfidence(windowA);
    const scoreB = computeConfidence(windowB);

    expect(scoreA).toBeGreaterThan(scoreB);
  });

  it('two recent failures score lower than one recent failure', () => {
    const oneFailure  = [...Array(9).fill(true), false];
    const twoFailures = [...Array(8).fill(true), false, false];

    expect(computeConfidence(oneFailure)).toBeGreaterThan(computeConfidence(twoFailures));
  });

  it('does not mutate the input array', () => {
    const window = [true, false, true];
    const copy = [...window];
    computeConfidence(window);
    expect(window).toEqual(copy);
  });
});

describe('appendOutcome', () => {
  it('appends a success to the window', () => {
    const result = appendOutcome([true, false], true);
    expect(result).toEqual([true, false, true]);
  });

  it('drops the oldest entry when window exceeds max size', () => {
    const full = Array(OUTCOME_WINDOW_SIZE).fill(true);
    const result = appendOutcome(full, false);
    expect(result).toHaveLength(OUTCOME_WINDOW_SIZE);
    expect(result[result.length - 1]).toBe(false);
    expect(result[0]).toBe(true); // oldest true was dropped, next true remains
  });

  it('does not mutate the input array', () => {
    const window = [true, true];
    appendOutcome(window, false);
    expect(window).toEqual([true, true]);
  });
});

describe('classifyConfidence', () => {
  it('classifies >= 0.7 as healthy', () => {
    expect(classifyConfidence(1.0)).toBe('healthy');
    expect(classifyConfidence(0.7)).toBe('healthy');
  });

  it('classifies 0.4–0.69 as degraded', () => {
    expect(classifyConfidence(0.69)).toBe('degraded');
    expect(classifyConfidence(0.4)).toBe('degraded');
  });

  it('classifies < 0.4 as stale', () => {
    expect(classifyConfidence(0.39)).toBe('stale');
    expect(classifyConfidence(0.0)).toBe('stale');
  });
});
