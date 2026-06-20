import {
  seededIndex,
  eligibleCandidates,
  pickRandomCandidate,
  resolveCardTitle,
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

  it('never picks site-chrome (e.g. footer Twitter) when nothing scored', () => {
    // No candidate lexically matches → falls back to non-chrome pool.
    const pool = [
      makeCandidate({ name: 'Twitter', similarityScore: 0 }),
      makeCandidate({ name: 'Facebook', similarityScore: 0 }),
      makeCandidate({ name: 'Search', similarityScore: 0, role: 'button' }),
      makeCandidate({ name: '3rd Album', similarityScore: 0 }),
      makeCandidate({ name: 'Health Book', similarityScore: 0 }),
    ];
    const names = new Set(
      Array.from({ length: 16 }, (_, i) => pickRandomCandidate(pool, `r:${i}`)!.candidate.name),
    );
    expect(names.has('Twitter')).toBe(false);
    expect(names.has('Facebook')).toBe(false);
    expect(names.has('Search')).toBe(false);
  });
});

describe('eligibleCandidates — chrome filtering', () => {
  it('drops footer/nav chrome when no candidate scored', () => {
    const pool = [
      makeCandidate({ name: 'Twitter', similarityScore: 0 }),
      makeCandidate({ name: 'Shopping cart (0)', similarityScore: 0 }),
      makeCandidate({ name: 'Real Product', similarityScore: 0 }),
    ];
    const out = eligibleCandidates(pool);
    expect(out.map((c) => c.name)).toEqual(['Real Product']);
  });

  it('keeps scored candidates as-is even if some look like chrome', () => {
    const pool = [
      makeCandidate({ name: 'Search', similarityScore: 2 }),
      makeCandidate({ name: 'Other', similarityScore: 0 }),
    ];
    // Lexical score wins — we trust the pruner's relevance signal.
    expect(eligibleCandidates(pool).map((c) => c.name)).toEqual(['Search']);
  });
});

describe('resolveCardTitle', () => {
  // Simulate $eval by running the passed fn against a fake element tree.
  const makePage = (impl: (selector: string) => string | null) => ({
    $eval: async <T,>(selector: string, _fn: (el: Element) => T): Promise<T> =>
      impl(selector) as unknown as T,
  });

  it('returns the card title resolved in-browser', async () => {
    const page = makePage(() => '3rd Album');
    const title = await resolveCardTitle(page, 'input.add-to-cart');
    expect(title).toBe('3rd Album');
  });

  it('returns null and swallows $eval errors (caller falls back)', async () => {
    const page = { $eval: async () => { throw new Error('detached'); } };
    expect(await resolveCardTitle(page, 'x')).toBeNull();
  });
});
