import { scrubSecrets, prepareBrief } from '../brief-intake';

/**
 * People paste whatever is on their clipboard into a "describe your app" box.
 * A credential that never enters the system cannot leak from it — so scrubbing
 * happens before storage AND before any prompt (service spec §12/§13.1).
 */

describe('scrubSecrets', () => {
  it('redacts an OpenAI-style API key', () => {
    const result = scrubSecrets('Our backend uses sk-abcdefghijklmnopqrstuvwx for the model.');
    expect(result.text).not.toContain('sk-abcdefghijklmnopqrstuvwx');
    expect(result.text).toContain('[REDACTED]');
    expect(result.redactions).toContain('OpenAI-style API key');
  });

  it('redacts an inline password while keeping the sentence readable', () => {
    const result = scrubSecrets('Test account: password: hunter2 — use it for login tests.');
    expect(result.text).not.toContain('hunter2');
    expect(result.text).toContain('password: [REDACTED]');
  });

  it('redacts a connection string with embedded credentials', () => {
    const result = scrubSecrets('DB is at postgres://admin:s3cret@db.internal:5432/shop');
    expect(result.text).not.toContain('s3cret');
    expect(result.redactions).toContain('connection string with credentials');
  });

  it('redacts a Kaizen API key', () => {
    const result = scrubSecrets('key kzn_live_deadbeefdeadbeef is used by CI');
    expect(result.text).not.toContain('kzn_live_deadbeefdeadbeef');
  });

  it('leaves an ordinary description untouched', () => {
    const text = 'We sell running shoes. Checkout is the most important flow to test.';
    const result = scrubSecrets(text);
    expect(result.text).toBe(text);
    expect(result.redactions).toEqual([]);
  });
});

describe('prepareBrief', () => {
  it('returns null for empty or trivial input', () => {
    expect(prepareBrief(undefined)).toBeNull();
    expect(prepareBrief('   ')).toBeNull();
    expect(prepareBrief('shop')).toBeNull();
  });

  it('caps very long briefs', () => {
    const result = prepareBrief('a'.repeat(20_000));
    expect(result?.text.length).toBe(8_000);
  });
});
