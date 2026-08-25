import { test, expect } from '@playwright/test';
import { BASE, signIn, main, gotoScreen } from './helpers';

/**
 * Authentication, session and route guarding.
 * These are the only screens in the app with real URLs (/login, /signup).
 *
 * This whole file opts OUT of the shared signed-in storageState: these tests
 * must start signed out to exercise the login form, the route guards and the
 * sign-out path. Every other spec reuses the session from global-setup.
 */
test.use({ storageState: { cookies: [], origins: [] } });

test.describe('Login screen', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  });

  test('renders the sign-in form with all its controls', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Sign in to Kaizen' })).toBeVisible();
    await expect(page.locator('input[type=email]')).toBeVisible();
    await expect(page.locator('input[type=password]')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /Demo user/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /Create a workspace/i })).toBeVisible();
  });

  test('explains that sessions are cookie-based', async ({ page }) => {
    await expect(page.locator('body')).toContainText('Sessions are cookie-based');
  });

  test('rejects wrong credentials with an inline error', async ({ page }) => {
    // The error must not be present before we submit.
    await expect(page.locator('body')).not.toContainText('Invalid email or password');

    await page.locator('input[type=email]').fill('nobody@nowhere.test');
    await page.locator('input[type=password]').fill('definitely-wrong-password');
    // Confirm the form really holds the credentials before submitting, so a
    // rejected-because-empty response can't masquerade as rejected-because-wrong.
    await expect(page.locator('input[type=email]')).toHaveValue('nobody@nowhere.test');

    const response = page.waitForResponse(
      (r) =>
        r.url().includes('/api/auth/login') &&
        r.request().method() === 'POST' &&
        (r.request().postData() ?? '').includes('nobody@nowhere.test'),
    );
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();

    expect((await response).status()).toBe(401);
    await expect(page.locator('body')).toContainText('Invalid email or password');
    // A failed sign-in must leave the user on /login.
    expect(page.url()).toContain('/login');
    // Let the request settle before the test ends, otherwise tearing the page
    // down mid-flight surfaces as a generic "Something went wrong".
    await page.waitForLoadState('networkidle').catch(() => {});
  });

  test('a failed sign-in does not grant access to the workspace', async ({ page }) => {
    await page.locator('input[type=email]').fill('nobody@nowhere.test');
    await page.locator('input[type=password]').fill('definitely-wrong-password');

    const response = page.waitForResponse(
      (r) => r.url().includes('/api/auth/login') && r.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    // Wait for the rejection to land before navigating away.
    expect((await response).status()).toBe(401);

    await page.goto(`${BASE}/tests`, { waitUntil: 'domcontentloaded' });
    await page.waitForURL(/\/login/, { timeout: 20_000 });
    expect(page.url()).toContain('/login');
  });

  test('Demo user signs in and lands on the Tests workspace', async ({ page }) => {
    const response = page.waitForResponse(
      (r) => r.url().includes('/api/auth/demo') && r.request().method() === 'POST',
    );
    await page.getByRole('button', { name: /Demo user/i }).click();

    expect((await response).status()).toBe(200);
    await page.waitForURL(/\/tests/, { timeout: 30_000 });
    // Headings are uppercased by CSS; the DOM text is lower case.
    await expect(main(page)).toContainText(/tests across/i, { timeout: 30_000 });
    await expect(page.locator('body')).toContainText('test@test.com');
  });

  test('Create a workspace navigates to the signup page', async ({ page }) => {
    await page.getByRole('button', { name: /Create a workspace/i }).click();
    await page.waitForURL(/\/signup/, { timeout: 20_000 });
    await expect(page.getByRole('heading', { name: 'Create your workspace' })).toBeVisible();
  });
});

test.describe('Route guarding', () => {
  test('an unauthenticated visit to /tests redirects to login preserving the destination', async ({
    page,
  }) => {
    await page.goto(`${BASE}/tests`, { waitUntil: 'domcontentloaded' });
    await page.waitForURL(/\/login/, { timeout: 20_000 });
    // The intended destination is carried in ?next so the user returns after signing in.
    expect(page.url()).toContain('next=%2Ftests');
    await expect(page.getByRole('heading', { name: 'Sign in to Kaizen' })).toBeVisible();
  });

  test('an unauthenticated visit to the root redirects to login', async ({ page }) => {
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForURL(/\/login/, { timeout: 20_000 });
    await expect(page.getByRole('heading', { name: 'Sign in to Kaizen' })).toBeVisible();
  });

  test('the session probe returns 401 before signing in', async ({ page }) => {
    const probe = page.waitForResponse((r) => r.url().includes('/api/auth/me'));
    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
    expect((await probe).status()).toBe(401);
  });
});

// Signup fields have no name/id, so address them by their placeholders — these
// are stable, unlike positional nth() which drifts if the form ever re-orders.
const NAME_FIELD = 'input[placeholder="Ada Lovelace"]';
const EMAIL_FIELD = 'input[placeholder="you@company.com"]';
const PASSWORD_FIELDS = 'input[type=password]';

test.describe('Signup screen', () => {
  test.beforeEach(async ({ page }) => {
    // A hard reload guarantees a fresh mount of the form. Without it the client
    // can keep the previous test's field state and validation message, so the
    // rule under test is not the one that fires.
    await page.goto(`${BASE}/signup`, { waitUntil: 'domcontentloaded' });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'Create your workspace' })).toBeVisible();
    await expect(page.locator(NAME_FIELD)).toHaveValue('');
    await expect(page.locator('body')).not.toContainText('What should we call you?');
  });

  test('renders name, email and both password fields', async ({ page }) => {
    await expect(page.locator(NAME_FIELD)).toBeVisible();
    await expect(page.locator(EMAIL_FIELD)).toBeVisible();
    await expect(page.locator(PASSWORD_FIELDS)).toHaveCount(2);
    await expect(page.getByRole('button', { name: /Create workspace/i })).toBeVisible();
  });

  test('states the 8-character password rule up front', async ({ page }) => {
    await expect(page.locator('body')).toContainText('8 characters or more');
  });

  test('requires a name before anything else', async ({ page }) => {
    await expect(page.locator('body')).not.toContainText('What should we call you?');

    // Submitting a completely empty form complains about the name first.
    await page.getByRole('button', { name: /Create workspace/i }).click();

    await expect(page.locator('body')).toContainText('What should we call you?');
    expect(page.url()).toContain('/signup');
  });

  test('rejects a password shorter than 8 characters', async ({ page }) => {
    await expect(page.locator('body')).not.toContainText('Use at least 8 characters');

    // Validation runs in order (name -> length -> match), so the name must be
    // valid before the password-length rule is the one that fires.
    await page.locator(NAME_FIELD).fill('AGENT-A Tester');
    await page.locator(EMAIL_FIELD).fill(`agent-a-${Date.now()}@example.test`);
    await page.locator(PASSWORD_FIELDS).nth(0).fill('abc');
    await page.locator(PASSWORD_FIELDS).nth(1).fill('abc');
    await expect(page.locator(NAME_FIELD)).toHaveValue('AGENT-A Tester');
    await page.getByRole('button', { name: /Create workspace/i }).click();

    await expect(page.locator('body')).toContainText('Use at least 8 characters');
    expect(page.url()).toContain('/signup');
  });

  test('rejects mismatched passwords without calling the API', async ({ page }) => {
    await expect(page.locator('body')).not.toContainText('Those passwords don’t match');

    let apiCalled = false;
    page.on('request', (r) => {
      if (r.url().includes('/api/auth') && r.method() === 'POST') apiCalled = true;
    });

    // Both passwords must clear the 8-character rule so that the mismatch
    // rule is the one under test.
    await page.locator(NAME_FIELD).fill('AGENT-A Tester');
    await page.locator(EMAIL_FIELD).fill(`agent-a-${Date.now()}@example.test`);
    await page.locator(PASSWORD_FIELDS).nth(0).fill('abcdefgh1');
    await page.locator(PASSWORD_FIELDS).nth(1).fill('different1');
    await expect(page.locator(NAME_FIELD)).toHaveValue('AGENT-A Tester');
    await page.getByRole('button', { name: /Create workspace/i }).click();

    await expect(page.locator('body')).toContainText('Those passwords don’t match');
    // Client-side validation must not reach the server at all.
    expect(apiCalled).toBe(false);
    expect(page.url()).toContain('/signup');
  });

  test('"I already have an account" returns to the login page', async ({ page }) => {
    await page.getByRole('button', { name: /I already have an account/i }).click();
    await page.waitForURL(/\/login/, { timeout: 20_000 });
    await expect(page.getByRole('heading', { name: 'Sign in to Kaizen' })).toBeVisible();
  });
});

test.describe('Session lifecycle', () => {
  test('signing out from the Account menu returns to login', async ({ page }) => {
    await signIn(page);
    await expect(main(page)).toContainText('TESTS ACROSS');

    const logout = page.waitForResponse(
      (r) => r.url().includes('/api/auth/logout') && r.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Account', exact: true }).click();
    await page.getByText('Sign out', { exact: true }).click();

    await logout;
    await page.waitForURL(/\/login/, { timeout: 20_000 });
    await expect(page.getByRole('heading', { name: 'Sign in to Kaizen' })).toBeVisible();
  });

  test('after signing out the workspace is no longer reachable', async ({ page }) => {
    await signIn(page);
    await page.getByRole('button', { name: 'Account', exact: true }).click();
    await page.getByText('Sign out', { exact: true }).click();
    await page.waitForURL(/\/login/, { timeout: 20_000 });

    await page.goto(`${BASE}/tests`, { waitUntil: 'domcontentloaded' });
    await page.waitForURL(/\/login/, { timeout: 20_000 });
    expect(page.url()).toContain('/login');
  });

  test('signing out from Settings > Appearance also ends the session', async ({ page }) => {
    await signIn(page);
    await gotoScreen(page, 'Settings');
    await page.getByRole('button', { name: 'Appearance', exact: true }).click();
    await expect(page.locator('body')).toContainText('SESSION');

    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await page.waitForURL(/\/login/, { timeout: 20_000 });
    await expect(page.getByRole('heading', { name: 'Sign in to Kaizen' })).toBeVisible();
  });

  test('the signed-in session identifies the demo user and workspace', async ({ page }) => {
    await signIn(page);
    await expect(page.locator('body')).toContainText('test@test.com');
    // "Workspace" is uppercased by CSS only.
    await expect(page.locator('body')).toContainText(/workspace/i);
    await expect(page.locator('body')).toContainText('Demo user');
  });
});
