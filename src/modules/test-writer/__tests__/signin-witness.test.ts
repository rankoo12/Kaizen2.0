import { withSigninWitness, distinctivePath } from '../validate/signin-witness';
import type { StepAST } from '../../../types';

/** Spec: spec-validation-trust.md §5 (amended 2026-08-18) — the observed landing url stands in
 *  for the final check a sign-in recipe forgot to make. */

const ast = (action: StepAST['action'], extra: Partial<StepAST> = {}): StepAST => ({
  action, targetDescription: null, value: null, url: null, rawText: action, contentHash: 'c', targetHash: 't', ...extra,
});
const recipeNoAssert = [
  { rawText: 'navigate to https://www.saucedemo.com/', ast: ast('navigate', { url: 'https://www.saucedemo.com/' }) },
  { rawText: 'type standard_user in username', ast: ast('type', { value: 'standard_user' }) },
  { rawText: 'click login', ast: ast('click', { targetDescription: 'login' }) },
];
const auth = { loginPageUrl: 'https://www.saucedemo.com/', landedUrl: 'https://www.saucedemo.com/inventory.html' };

describe('withSigninWitness', () => {
  it('appends "verify the url contains <landing path>" when the recipe ends without a check', () => {
    const out = withSigninWitness(recipeNoAssert, auth);
    expect(out.witness).toBe('verify the url contains "/inventory.html"');
    expect(out.prefix).toHaveLength(4);
    expect(out.prefix[3].ast).toMatchObject({ action: 'assert_url', value: '/inventory.html' });
  });

  it('leaves a recipe that already ends on an assertion alone', () => {
    const withAssert = [...recipeNoAssert, { rawText: 'verify the "Products" heading is visible', ast: ast('assert_visible') }];
    const out = withSigninWitness(withAssert, auth);
    expect(out.witness).toBeNull();
    expect(out.prefix).toBe(withAssert);
  });

  it('has nothing to witness when sign-in lands on the root, the login page, or nowhere known', () => {
    expect(withSigninWitness(recipeNoAssert, { loginPageUrl: 'https://a.test/login', landedUrl: 'https://a.test/' }).witness).toBeNull();
    expect(withSigninWitness(recipeNoAssert, { loginPageUrl: 'https://a.test/login', landedUrl: 'https://a.test/login?err=1' }).witness).toBeNull();
    expect(withSigninWitness(recipeNoAssert, null).witness).toBeNull();
    expect(withSigninWitness([], auth).witness).toBeNull();
  });

  it('distinctivePath keeps the path only — no query, no hash, no trailing slash', () => {
    expect(distinctivePath('https://a.test/app/home/?tab=1#x', 'https://a.test/login')).toBe('/app/home');
  });
});
