import { generateFormData, FORM_DATA_TOKENS } from '../generate';

describe('generateFormData', () => {
  it('returns a value for every advertised token', () => {
    const data = generateFormData();
    for (const token of FORM_DATA_TOKENS) {
      expect(typeof data[token]).toBe('string');
      expect(data[token].length).toBeGreaterThan(0);
    }
  });

  it('produces a unique email across calls (avoids "user already exists")', () => {
    const emails = new Set(Array.from({ length: 20 }, () => generateFormData().email));
    expect(emails.size).toBe(20);
  });

  it('keeps email and username consistent (shared suffix)', () => {
    const d = generateFormData();
    expect(d.email.startsWith(d.username + '@')).toBe(true);
  });

  it('honours a custom email domain', () => {
    const d = generateFormData('demowebshop.tricentis.com');
    expect(d.email.endsWith('@demowebshop.tricentis.com')).toBe(true);
  });

  it('generates a password meeting common strength rules', () => {
    for (let i = 0; i < 10; i++) {
      const { password } = generateFormData();
      expect(password).toMatch(/[a-z]/);
      expect(password).toMatch(/[A-Z]/);
      expect(password).toMatch(/[0-9]/);
      expect(password).toMatch(/[^A-Za-z0-9]/);
      expect(password.length).toBeGreaterThanOrEqual(8);
    }
  });
});
