import { test, expect } from '@playwright/test';
import { signIn, uniqueName } from './helpers';

/**
 * Authentication: routing/gating, the sign-in screen, the sign-up screen and
 * every client-side validation rule in `design/screen-auth.tsx`.
 *
 * These tests deliberately do NOT sign in first (except where stated) — the
 * signed-out state is the thing under test.
 *
 * Selector note: Next.js injects <div role="alert" id="__next-route-announcer__">,
 * so every alert assertion is scoped to `form [role="alert"]`.
 */

const alert = 'form [role="alert"]';

/* This file tests the SIGNED-OUT app and the login flow itself, so it opts out of
   the run-wide shared session that global-setup saves. Every test here starts with
   no cookies; the handful that need an authenticated shell call signIn() to get one. */
test.use({ storageState: { cookies: [], origins: [] } });

test.describe('routing and auth gating', () => {
  test('the root path redirects to the sign-in screen', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole('heading', { name: 'Sign in to Kaizen' })).toBeVisible();
  });

  test('a signed-out visit to /tests redirects to login carrying next=/tests', async ({ page }) => {
    await page.goto('/tests');
    await expect(page).toHaveURL('http://localhost:3001/login?next=%2Ftests');
    await expect(page.getByRole('heading', { name: 'Sign in to Kaizen' })).toBeVisible();
  });

  test('a signed-out visit to a nested test URL preserves the full path in next', async ({ page }) => {
    await page.goto('/tests/abc-123/runs/def-456/report');
    await expect(page).toHaveURL(
      'http://localhost:3001/login?next=%2Ftests%2Fabc-123%2Fruns%2Fdef-456%2Freport',
    );
  });

  test('signing in from a gated URL lands on the app rather than back at login', async ({ page }) => {
    await page.goto('/tests');
    await expect(page).toHaveURL(/next=%2Ftests/);
    await page.getByRole('button', { name: 'Demo user' }).click();
    await expect(page).toHaveURL(/\/tests$/, { timeout: 45_000 });
    await expect(page.locator('.sidebar')).toBeVisible();
  });

  test('an authenticated visitor is bounced away from /login', async ({ page }) => {
    await signIn(page);
    await page.goto('/login');
    await expect(page).toHaveURL(/\/tests$/);
    await expect(page.locator('.sidebar')).toBeVisible();
  });

  test('an authenticated visitor is bounced away from /signup', async ({ page }) => {
    await signIn(page);
    await page.goto('/signup');
    await expect(page).toHaveURL(/\/tests$/);
    await expect(page.locator('.sidebar')).toBeVisible();
  });

  test('the login redirect strips a stale next parameter for an authenticated visitor', async ({ page }) => {
    await signIn(page);
    await page.goto('/login?next=%2Ftests%2Fsomething');
    await expect(page).toHaveURL('http://localhost:3001/tests');
  });
});

test.describe('sign-in screen structure', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/login');
  });

  test('shows the heading and the reassurance subtitle', async ({ page }) => {
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Sign in to Kaizen');
    await expect(page.locator('form')).toContainText('Your tests have been running while you were away.');
  });

  test('exposes exactly an email field and a password field, correctly typed', async ({ page }) => {
    const email = page.locator('input[type="email"]');
    const password = page.locator('input[type="password"]');
    await expect(email).toHaveCount(1);
    await expect(password).toHaveCount(1);
    await expect(email).toHaveAttribute('placeholder', 'you@company.com');
    await expect(email).toHaveAttribute('autocomplete', 'email');
    await expect(password).toHaveAttribute('autocomplete', 'current-password');
  });

  test('labels the two fields Email and Password', async ({ page }) => {
    await expect(page.locator('form .label')).toHaveText(['Email', 'Password']);
  });

  test('autofocuses the email field so typing starts in the right place', async ({ page }) => {
    await expect(page.locator('input[type="email"]')).toBeFocused();
  });

  test('offers Sign in, Demo user and Create a workspace, in that order', async ({ page }) => {
    const buttons = page.locator('form button').filter({ hasText: /\S/ });
    await expect(buttons).toHaveText(['Sign in', 'Demo user', 'Create a workspace']);
  });

  test('the primary button submits the form and the others do not', async ({ page }) => {
    await expect(page.getByRole('button', { name: 'Sign in' })).toHaveAttribute('type', 'submit');
    await expect(page.getByRole('button', { name: 'Demo user' })).toHaveAttribute('type', 'button');
    await expect(page.getByRole('button', { name: 'Create a workspace' })).toHaveAttribute('type', 'button');
  });

  test('explains the demo account and the cookie session', async ({ page }) => {
    await expect(page.locator('form')).toContainText(
      'Look around a real workspace without signing up.',
    );
    await expect(page.locator('form')).toContainText(
      'Sessions are cookie-based, so you stay signed in on this device.',
    );
  });

  test('shows no error alert before anything is submitted', async ({ page }) => {
    await expect(page.locator(alert)).toHaveCount(0);
  });

  test('does not offer the name or confirm-password fields that signup has', async ({ page }) => {
    await expect(page.getByPlaceholder('Ada Lovelace')).toHaveCount(0);
    await expect(page.locator('form .label')).not.toContainText(['Confirm password']);
  });
});

test.describe('sign-in failures', () => {
  test('a wrong password produces the mapped 401 message, not a raw server error', async ({ page }) => {
    await page.goto('/login');
    await page.locator('input[type="email"]').fill('nobody-agent-b@example.com');
    await page.locator('input[type="password"]').fill('definitely-not-the-password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.locator(alert)).toHaveText('Invalid email or password', { timeout: 30_000 });
  });

  test('a failed sign-in leaves the user on the login screen', async ({ page }) => {
    await page.goto('/login');
    await page.locator('input[type="email"]').fill('nobody-agent-b@example.com');
    await page.locator('input[type="password"]').fill('wrong-password-here');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.locator(alert)).toBeVisible({ timeout: 30_000 });
    await expect(page).toHaveURL(/\/login/);
    await expect(page.locator('.sidebar')).toHaveCount(0);
  });

  test('a failed sign-in re-enables the button so it can be retried', async ({ page }) => {
    await page.goto('/login');
    await page.locator('input[type="email"]').fill('nobody-agent-b@example.com');
    await page.locator('input[type="password"]').fill('wrong-password-here');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.locator(alert)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeEnabled();
  });

  test('a second failed attempt replaces rather than stacks the alert', async ({ page }) => {
    await page.goto('/login');
    await page.locator('input[type="email"]').fill('nobody-agent-b@example.com');
    await page.locator('input[type="password"]').fill('wrong-password-one');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.locator(alert)).toBeVisible({ timeout: 30_000 });
    await page.locator('input[type="password"]').fill('wrong-password-two');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.locator(alert)).toHaveCount(1, { timeout: 30_000 });
  });

  test('the email field enforces its native type so a malformed address never reaches the API', async ({ page }) => {
    await page.goto('/login');
    await page.locator('input[type="email"]').fill('not-an-email');
    await page.locator('input[type="password"]').fill('anything-at-all');
    await page.getByRole('button', { name: 'Sign in' }).click();
    // Native constraint validation blocks submit; no alert is rendered and the URL is unchanged.
    await expect(page.locator('input[type="email"]')).toHaveJSProperty('validity.typeMismatch', true);
    await expect(page).toHaveURL(/\/login/);
  });
});

test.describe('demo sign-in', () => {
  test('the Demo user button opens the workspace and lands on the Tests screen', async ({ page }) => {
    await page.goto('/login');
    await page.getByRole('button', { name: 'Demo user' }).click();
    await expect(page).toHaveURL(/\/tests$/, { timeout: 45_000 });
    await expect(page.locator('.toolbar-title').first()).toHaveText('Tests');
  });

  test('the demo session identifies a real signed-in user in the shell', async ({ page }) => {
    await signIn(page);
    await expect(page.locator('.menubar')).toContainText('test@test.com');
    await expect(page.locator('.sidebar')).toContainText('Demo user');
  });

  test('the demo account is the workspace OWNER, not a read-only visitor', async ({ page }) => {
    await signIn(page);
    const me = await page.evaluate(async () => (await fetch('/api/auth/me')).json());
    expect(me.role).toBe('owner');
    expect(me.user.email).toBe('test@test.com');
  });

  test('signing in sets a session that survives a reload', async ({ page }) => {
    await signIn(page);
    await page.reload();
    await expect(page.locator('.sidebar')).toBeVisible({ timeout: 30_000 });
    await expect(page).toHaveURL(/\/tests/);
  });

  test('the demo route needs no credentials in the request body', async ({ page }) => {
    await page.goto('/login');
    const [request] = await Promise.all([
      page.waitForRequest((r) => r.url().includes('/api/auth/demo') && r.method() === 'POST'),
      page.getByRole('button', { name: 'Demo user' }).click(),
    ]);
    // The whole point of the server-side demo route: no password in the client bundle.
    expect(request.postData() ?? '').toBe('');
    await expect(page).toHaveURL(/\/tests$/, { timeout: 45_000 });
  });
});

test.describe('sign-up screen structure', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/signup');
  });

  test('shows the workspace-creation heading and subtitle', async ({ page }) => {
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Create your workspace');
    await expect(page.locator('form')).toContainText(
      'Tests written in English that keep passing on their own.',
    );
  });

  test('offers four fields in the documented order', async ({ page }) => {
    const types = await page.locator('form input').evaluateAll((els) =>
      els.map((e) => (e as HTMLInputElement).type),
    );
    expect(types).toEqual(['text', 'email', 'password', 'password']);
  });

  test('labels the fields and states the password rule inline', async ({ page }) => {
    const labels = await page.locator('form .label').allInnerTexts();
    expect(labels[0]).toBe('Your name');
    expect(labels[1]).toBe('Email');
    expect(labels[2]).toContain('Password');
    expect(labels[2]).toContain('8 characters or more');
    expect(labels[3]).toBe('Confirm password');
  });

  test('uses new-password autocomplete on both password fields', async ({ page }) => {
    const pw = page.locator('input[type="password"]');
    await expect(pw.nth(0)).toHaveAttribute('autocomplete', 'new-password');
    await expect(pw.nth(1)).toHaveAttribute('autocomplete', 'new-password');
  });

  test('prompts the name field with a placeholder', async ({ page }) => {
    await expect(page.getByPlaceholder('Ada Lovelace')).toBeVisible();
    await expect(page.getByPlaceholder('Ada Lovelace')).toHaveAttribute('autocomplete', 'name');
  });

  test('deliberately hides the demo shortcut on the signup screen', async ({ page }) => {
    await expect(page.getByRole('button', { name: 'Demo user' })).toHaveCount(0);
    await expect(page.locator('form')).not.toContainText('Look around a real workspace');
  });

  test('the submit button reads Create workspace', async ({ page }) => {
    const submit = page.locator('form button[type="submit"]');
    await expect(submit).toHaveText(/Create workspace/);
  });

  test('offers a way back to sign-in', async ({ page }) => {
    await expect(page.getByRole('button', { name: 'I already have an account' })).toBeVisible();
  });
});

test.describe('sign-up client-side validation', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/signup');
  });

  test('an empty form is rejected on the missing name, before anything else', async ({ page }) => {
    await page.locator('form button[type="submit"]').click();
    await expect(page.locator(alert)).toHaveText('What should we call you?');
  });

  test('a whitespace-only name counts as no name', async ({ page }) => {
    await page.getByPlaceholder('Ada Lovelace').fill('     ');
    await page.locator('input[type="email"]').fill('agent-b@example.com');
    await page.locator('input[type="password"]').nth(0).fill('longenoughpassword');
    await page.locator('input[type="password"]').nth(1).fill('longenoughpassword');
    await page.locator('form button[type="submit"]').click();
    await expect(page.locator(alert)).toHaveText('What should we call you?');
  });

  test('a password under 8 characters is rejected with the length message', async ({ page }) => {
    await page.getByPlaceholder('Ada Lovelace').fill('Agent B');
    await page.locator('input[type="email"]').fill('agent-b@example.com');
    await page.locator('input[type="password"]').nth(0).fill('short');
    await page.locator('input[type="password"]').nth(1).fill('short');
    await page.locator('form button[type="submit"]').click();
    await expect(page.locator(alert)).toHaveText('Use at least 8 characters for the password.');
  });

  test('exactly 7 characters is still too short', async ({ page }) => {
    await page.getByPlaceholder('Ada Lovelace').fill('Agent B');
    await page.locator('input[type="email"]').fill('agent-b@example.com');
    await page.locator('input[type="password"]').nth(0).fill('7chars!');
    await page.locator('input[type="password"]').nth(1).fill('7chars!');
    await page.locator('form button[type="submit"]').click();
    await expect(page.locator(alert)).toHaveText('Use at least 8 characters for the password.');
  });

  test('mismatched passwords are rejected once the length rule passes', async ({ page }) => {
    await page.getByPlaceholder('Ada Lovelace').fill('Agent B');
    await page.locator('input[type="email"]').fill('agent-b@example.com');
    await page.locator('input[type="password"]').nth(0).fill('longenoughpassword');
    await page.locator('input[type="password"]').nth(1).fill('adifferentpassword');
    await page.locator('form button[type="submit"]').click();
    await expect(page.locator(alert)).toHaveText('Those passwords don’t match.');
  });

  test('validation order: a short AND mismatched pair reports the length problem first', async ({ page }) => {
    await page.getByPlaceholder('Ada Lovelace').fill('Agent B');
    await page.locator('input[type="email"]').fill('agent-b@example.com');
    await page.locator('input[type="password"]').nth(0).fill('abc');
    await page.locator('input[type="password"]').nth(1).fill('xyz');
    await page.locator('form button[type="submit"]').click();
    await expect(page.locator(alert)).toHaveText('Use at least 8 characters for the password.');
  });

  test('validation order: a missing name beats a short password', async ({ page }) => {
    await page.locator('input[type="email"]').fill('agent-b@example.com');
    await page.locator('input[type="password"]').nth(0).fill('abc');
    await page.locator('input[type="password"]').nth(1).fill('abc');
    await page.locator('form button[type="submit"]').click();
    await expect(page.locator(alert)).toHaveText('What should we call you?');
  });

  test('a rejected submit never calls the register endpoint', async ({ page }) => {
    let called = false;
    page.on('request', (r) => {
      if (r.url().includes('/api/auth/register')) called = true;
    });
    await page.locator('form button[type="submit"]').click();
    await expect(page.locator(alert)).toBeVisible();
    await page.waitForTimeout(1000);
    expect(called).toBe(false);
  });

  test('a rejected submit never enters the busy state', async ({ page }) => {
    await page.locator('form button[type="submit"]').click();
    await expect(page.locator(alert)).toBeVisible();
    // Validation runs before setBusy(true), so no spinner and no "Creating…" label.
    await expect(page.locator('form .spinner')).toHaveCount(0);
    await expect(page.locator('form button[type="submit"]')).toHaveText(/Create workspace/);
    await expect(page.locator('form button[type="submit"]')).toBeEnabled();
  });

  test('correcting the input clears the previous error on the next submit', async ({ page }) => {
    await page.locator('form button[type="submit"]').click();
    await expect(page.locator(alert)).toHaveText('What should we call you?');
    await page.getByPlaceholder('Ada Lovelace').fill('Agent B');
    await page.locator('input[type="email"]').fill('agent-b@example.com');
    await page.locator('input[type="password"]').nth(0).fill('short');
    await page.locator('input[type="password"]').nth(1).fill('short');
    await page.locator('form button[type="submit"]').click();
    await expect(page.locator(alert)).toHaveText('Use at least 8 characters for the password.');
  });

  test('an 8-character matching pair with a name passes client validation and reaches the API', async ({ page }) => {
    // Uses a deliberately-taken address so the API answers 409 rather than creating an
    // account: the point is that the CLIENT rules were satisfied and the request went out.
    const requestPromise = page.waitForRequest(
      (r) => r.url().includes('/api/auth/register') && r.method() === 'POST',
    );
    await page.getByPlaceholder('Ada Lovelace').fill(uniqueName('Person'));
    await page.locator('input[type="email"]').fill('test@test.com');
    await page.locator('input[type="password"]').nth(0).fill('12345678');
    await page.locator('input[type="password"]').nth(1).fill('12345678');
    await page.locator('form button[type="submit"]').click();
    await requestPromise;
    await expect(page.locator(alert)).toHaveText('An account with this email already exists', {
      timeout: 30_000,
    });
  });

  test('the name is trimmed before it is sent', async ({ page }) => {
    const requestPromise = page.waitForRequest(
      (r) => r.url().includes('/api/auth/register') && r.method() === 'POST',
    );
    await page.getByPlaceholder('Ada Lovelace').fill('   Padded Name   ');
    await page.locator('input[type="email"]').fill('  test@test.com  ');
    await page.locator('input[type="password"]').nth(0).fill('12345678');
    await page.locator('input[type="password"]').nth(1).fill('12345678');
    await page.locator('form button[type="submit"]').click();
    const request = await requestPromise;
    const body = JSON.parse(request.postData() ?? '{}');
    expect(body.displayName).toBe('Padded Name');
    expect(body.email).toBe('test@test.com');
  });
});

test.describe('navigation between auth screens', () => {
  test('Create a workspace goes from login to signup', async ({ page }) => {
    await page.goto('/login');
    await page.getByRole('button', { name: 'Create a workspace' }).click();
    await expect(page).toHaveURL(/\/signup$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Create your workspace');
  });

  test('I already have an account goes from signup back to login', async ({ page }) => {
    await page.goto('/signup');
    await page.getByRole('button', { name: 'I already have an account' }).click();
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Sign in to Kaizen');
  });

  test('moving between the two screens does not carry an error alert across', async ({ page }) => {
    await page.goto('/signup');
    await page.locator('form button[type="submit"]').click();
    await expect(page.locator(alert)).toBeVisible();
    await page.getByRole('button', { name: 'I already have an account' }).click();
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.locator(alert)).toHaveCount(0);
  });
});

test.describe('sign out', () => {
  test('signing out from the Account menu returns to the login screen', async ({ page }) => {
    await signIn(page);
    await page.locator('.mb-item', { hasText: /^Account$/ }).click();
    await page.locator('.popover .menu-item', { hasText: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login$/, { timeout: 30_000 });
    await expect(page.getByRole('heading', { name: 'Sign in to Kaizen' })).toBeVisible();
  });

  test('signing out actually clears the session, not just the screen', async ({ page }) => {
    await signIn(page);
    await page.locator('.mb-item', { hasText: /^Account$/ }).click();
    await page.locator('.popover .menu-item', { hasText: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login$/, { timeout: 30_000 });
    await page.goto('/tests');
    await expect(page).toHaveURL(/\/login\?next=%2Ftests$/);
  });

  test('signing out from the Appearance tab works the same way', async ({ page }) => {
    await signIn(page);
    await page.locator('.side-item').filter({ hasText: 'Usage' }).first().click();
    await expect(page.locator('.toolbar-title').first()).toHaveText('Usage');
    await page.locator('.seg button', { hasText: /^Appearance$/ }).click();
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login$/, { timeout: 30_000 });
  });

  test('the Account menu names the signed-in user as a disabled item', async ({ page }) => {
    await signIn(page);
    await page.locator('.mb-item', { hasText: /^Account$/ }).click();
    const item = page.locator('.popover .menu-item', { hasText: 'test@test.com' });
    await expect(item).toBeVisible();
    await expect(item).toBeDisabled();
  });
});
