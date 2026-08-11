import { isSecretStep, isSecretTarget, isTokenValue, redactStepText, REDACTED } from '../secret-steps';

/**
 * These guard three pre-existing credential leaks that P3 closes
 * (spec-authenticated-scope.md §3.2, §12.2, §12.3). The rule they encode is
 * narrow on purpose: only `type` steps aimed at a credential-named field, so an
 * ordinary "type hello in the search box" keeps logging, caching and
 * screenshotting exactly as before.
 */

describe('isSecretTarget', () => {
  it.each([
    'the password field',
    'Password',
    'the API key input',
    'the api-key box',
    'the CVV field',
    'the passphrase input',
  ])('recognises %s', (target) => {
    expect(isSecretTarget(target)).toBe(true);
  });

  it.each(['the search box', 'the email field', 'the username input', null, undefined, ''])(
    'leaves %s alone',
    (target) => {
      expect(isSecretTarget(target)).toBe(false);
    },
  );
});

describe('isSecretStep', () => {
  it('flags typing into a password field', () => {
    expect(isSecretStep({ action: 'type', targetDescription: 'the password field', value: 'Hunter2!' }))
      .toBe(true);
  });

  it('does not flag CLICKING the password field — nothing is being written', () => {
    expect(isSecretStep({ action: 'click', targetDescription: 'the password field' })).toBe(false);
  });

  it('does not flag typing into an ordinary field', () => {
    expect(isSecretStep({ action: 'type', targetDescription: 'the search box', value: 'shoes' }))
      .toBe(false);
  });
});

describe('isTokenValue', () => {
  it('recognises seed tokens', () => {
    expect(isTokenValue('{{password}}')).toBe(true);
    expect(isTokenValue('  {{email}}  ')).toBe(true);
  });

  it('rejects literals and partial interpolations', () => {
    expect(isTokenValue('Hunter2!')).toBe(false);
    expect(isTokenValue('prefix-{{email}}')).toBe(false);
    expect(isTokenValue(null)).toBe(false);
  });
});

describe('redactStepText', () => {
  // The worker's resolve log writes `step N · type · "<rawText>"`, so redacting
  // data.value alone moved the password one column over into the message.
  it('redacts the known value exactly', () => {
    expect(redactStepText('type "Hunter2!" into the password field', 'Hunter2!'))
      .toBe(`type "${REDACTED}" into the password field`);
  });

  it('redacts a value containing regex metacharacters', () => {
    expect(redactStepText('type "a.*b[0]$" into the password field', 'a.*b[0]$'))
      .toBe(`type "${REDACTED}" into the password field`);
  });

  it('does not mangle an apostrophe when the value is known', () => {
    expect(redactStepText("type \"pw\" into the user's password field", 'pw'))
      .toBe(`type "${REDACTED}" into the user's password field`);
  });

  it('falls back to stripping quoted runs when no value is available', () => {
    expect(redactStepText('type "Hunter2!" into the password field'))
      .toBe(`type "${REDACTED}" into the password field`);
  });

  it('handles curly quotes in the fallback path', () => {
    expect(redactStepText('type “Hunter2!” into the password field'))
      .toBe(`type "${REDACTED}" into the password field`);
  });

  it('leaves an unquoted sentence untouched', () => {
    expect(redactStepText('click the sign in button')).toBe('click the sign in button');
  });
});
