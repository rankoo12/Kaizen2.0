import { semanticGuardPasses, cosine, SEMANTIC_GUARD_THRESHOLD } from '../cache-semantic-guard';

describe('cache-semantic-guard', () => {
  describe('cosine', () => {
    it('returns 1.0 for identical vectors', () => {
      expect(cosine([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 6);
    });

    it('returns 0 for orthogonal vectors', () => {
      expect(cosine([1, 0], [0, 1])).toBeCloseTo(0, 6);
    });

    it('returns -1 for anti-parallel vectors', () => {
      expect(cosine([1, 2], [-1, -2])).toBeCloseTo(-1, 6);
    });

    it('returns 0 when either vector is all zeros (never NaN)', () => {
      expect(cosine([0, 0, 0], [1, 2, 3])).toBe(0);
      expect(cosine([1, 2, 3], [0, 0, 0])).toBe(0);
    });
  });

  describe('semanticGuardPasses', () => {
    it('passes when stepEmbedding is undefined (cannot evaluate)', () => {
      const result = semanticGuardPasses(undefined, [0.1, 0.2], [0.3, 0.4]);
      expect(result.passed).toBe(true);
      expect(result.bestSimilarity).toBeNull();
    });

    it('passes when both stored vectors are null (legacy row)', () => {
      const result = semanticGuardPasses([0.1, 0.2], null, null);
      expect(result.passed).toBe(true);
      expect(result.bestSimilarity).toBeNull();
    });

    it('passes when the step vector closely matches step_embedding', () => {
      const step = [1, 0, 0];
      const rowStep = [1, 0.01, 0]; // near-identical → cosine ≈ 1
      const result = semanticGuardPasses(step, rowStep, null);
      expect(result.passed).toBe(true);
      expect(result.bestSimilarity).toBeGreaterThan(SEMANTIC_GUARD_THRESHOLD);
    });

    it('passes when only element_embedding agrees', () => {
      const step = [1, 0, 0];
      const rowStep = [0, 1, 0]; // orthogonal → cosine 0, fails
      const rowElement = [1, 0.02, 0]; // near-identical → cosine ≈ 1, saves it
      const result = semanticGuardPasses(step, rowStep, rowElement);
      expect(result.passed).toBe(true);
      expect(result.bestSimilarity).toBeGreaterThan(SEMANTIC_GUARD_THRESHOLD);
    });

    it('rejects when neither vector reaches the threshold (Test Cases vs day 12 case)', () => {
      const step = [1, 0, 0];
      const rowStep = [0, 1, 0]; // orthogonal → 0
      const rowElement = [0, 0, 1]; // orthogonal → 0
      const result = semanticGuardPasses(step, rowStep, rowElement);
      expect(result.passed).toBe(false);
      expect(result.bestSimilarity).toBeLessThan(SEMANTIC_GUARD_THRESHOLD);
    });

    it('rejects when both vectors are strongly anti-correlated', () => {
      const step = [1, 2, 3];
      const anti = [-1, -2, -3];
      const result = semanticGuardPasses(step, anti, anti);
      expect(result.passed).toBe(false);
      expect(result.bestSimilarity).toBeLessThan(0);
    });

    it('uses the BEST of the two similarities, not the worst', () => {
      const step = [1, 0, 0];
      const strong = [1, 0, 0]; // 1.0
      const weak = [0, 1, 0];   // 0.0
      // step_embedding strong, element_embedding weak → should pass
      expect(semanticGuardPasses(step, strong, weak).passed).toBe(true);
      // step_embedding weak, element_embedding strong → should still pass
      expect(semanticGuardPasses(step, weak, strong).passed).toBe(true);
    });

    it('passes when stored vector dimension mismatches (treated as unevaluable)', () => {
      const step = [1, 0, 0];
      const wrongDim = [1, 0]; // different length — can't meaningfully compare
      const result = semanticGuardPasses(step, wrongDim, null);
      expect(result.passed).toBe(true);
      expect(result.bestSimilarity).toBeNull();
    });

    it('threshold boundary: exactly at threshold passes', () => {
      const step = [1, 0];
      // Build a vector whose cosine with [1,0] is exactly SEMANTIC_GUARD_THRESHOLD.
      // cos = a / sqrt(a^2 + b^2) = T  →  a^2 / (a^2+b^2) = T^2  →  b = a*sqrt(1-T^2)/T
      const T = SEMANTIC_GUARD_THRESHOLD;
      const a = 1;
      const b = a * Math.sqrt(1 - T * T) / T;
      const onEdge = [a, b];
      const result = semanticGuardPasses(step, onEdge, null);
      expect(result.passed).toBe(true);
      expect(result.bestSimilarity!).toBeCloseTo(T, 5);
    });
  });
});
