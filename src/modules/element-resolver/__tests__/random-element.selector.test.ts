import {
  seededIndex,
  eligibleCandidates,
  pickRandomCandidate,
} from '../random-element.selector';
import type { CandidateNode } from '../../../types';

function makeCandidate(over: Partial<CandidateNode> = {}): CandidateNode {
  return {
    role: 'link',
    name: over.name ?? 'Product',
    cssSelector: over.cssSelector ?? 'a.product',
    xpath: '//a',
    attributes: {},
    textContent: '',
    isVisible: true,
    similarityScore: 1,
    ...over,
  };
}

describe('seededIndex', () => {
  it('returns an index within [0, length)', () => {
    for (let len = 1; len <= 10; len++) {
      const i = seededIndex('run-1:0', len);
      expect(i).toBeGreaterThanOrEqual(0);
      expect(i).toBeLessThan(len);
    }
  });

  it('is deterministic for the same seed and length', () => {
    expect(seededIndex('run-1:3', 5)).toBe(seededIndex('run-1:3', 5));
  });

  it('varies across different seeds', () => {
    const seeds = ['run-1:0', 'run-2:0', 'run-3:0', 'run-4:0', 'run-5:0'];
    const results = new Set(seeds.map((s) => seededIndex(s, 7)));
    // Not all five seeds should collapse to the same index.
    expect(results.size).toBeGreaterThan(1);
  });

  it('throws when length is not positive', () => {
    expect(() => seededIndex('x', 0)).toThrow(/length > 0/);
  });
});

describe('eligibleCandidates', () => {
  it('prefers visible candidates', () => {
    const pool = [
      makeCandidate({ name: 'visible', isVisible: true }),
      makeCandidate({ name: 'hidden', isVisible: false }),
    ];
    const result = eligibleCandidates(pool);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('visible');
  });

  it('prefers candidates the pruner scored as relevant', () => {
    const pool = [
      makeCandidate({ name: 'match', similarityScore: 2 }),
      makeCandidate({ name: 'noise', similarityScore: 0 }),
    ];
    const result = eligibleCandidates(pool);
    expect(result.map((c) => c.name)).toEqual(['match']);
  });

  it('falls back to the full pool when nothing scored', () => {
    const pool = [
      makeCandidate({ name: 'a', similarityScore: 0 }),
      makeCandidate({ name: 'b', similarityScore: 0 }),
    ];
    expect(eligibleCandidates(pool)).toHaveLength(2);
  });
});

describe('pickRandomCandidate', () => {
  const products = ['Alpha', 'Bravo', 'Charlie', 'Delta'].map((name) =>
    makeCandidate({ name, cssSelector: `a[data-name="${name}"]` }),
  );

  it('returns null for an empty candidate list', () => {
    expect(pickRandomCandidate([], 'seed')).toBeNull();
  });

  it('picks a candidate from the eligible pool', () => {
    const pick = pickRandomCandidate(products, 'run-1:8');
    expect(pick).not.toBeNull();
    expect(products).toContainEqual(pick!.candidate);
    expect(pick!.poolSize).toBe(products.length);
  });

  it('is deterministic for a fixed seed (replayable runs)', () => {
    const a = pickRandomCandidate(products, 'run-1:8');
    const b = pickRandomCandidate(products, 'run-1:8');
    expect(a!.candidate.name).toBe(b!.candidate.name);
    expect(a!.index).toBe(b!.index);
  });

  it('can pick different candidates across different steps of a run', () => {
    const names = new Set(
      Array.from({ length: 8 }, (_, i) => pickRandomCandidate(products, `run-1:${i}`)!.candidate.name),
    );
    expect(names.size).toBeGreaterThan(1);
  });
});
