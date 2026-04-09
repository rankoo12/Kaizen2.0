/**
 * Tests: password.ts
 * Spec ref: docs/spec-identity.md §14 — Security (password storage)
 */

import { hashPassword, verifyPassword } from '../password';

describe('password utilities', () => {
  describe('hashPassword', () => {
    it('returns a non-empty string in salt:hash format', async () => {
      const hash = await hashPassword('mysecret');
      expect(hash).toMatch(/^[a-f0-9]+:[a-f0-9]+$/);
    });

    it('produces different hashes for the same password (random salt)', async () => {
      const h1 = await hashPassword('samepassword');
      const h2 = await hashPassword('samepassword');
      expect(h1).not.toBe(h2);
    });
  });

  describe('verifyPassword', () => {
    it('returns true for correct password', async () => {
      const hash = await hashPassword('correct-horse');
      expect(await verifyPassword('correct-horse', hash)).toBe(true);
    });

    it('returns false for wrong password', async () => {
      const hash = await hashPassword('correct-horse');
      expect(await verifyPassword('wrong-horse', hash)).toBe(false);
    });

    it('returns false for malformed stored hash', async () => {
      expect(await verifyPassword('any', 'not-a-valid-hash')).toBe(false);
    });

    it('returns false for empty stored hash', async () => {
      expect(await verifyPassword('any', '')).toBe(false);
    });
  });
});
