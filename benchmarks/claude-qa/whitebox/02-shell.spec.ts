import { test, expect } from '@playwright/test';
import { signIn, gotoScreen, openMenu, closeMenu, appearance, setAppearance } from './helpers';

/**
 * The authenticated shell: menu bar, sidebar, screen switching, keyboard
 * shortcuts, appearance and the URL-vs-state quirk.
 *
 * Key white-box facts under test:
 *  - (app)/layout.tsx renders <KaizenApp/> without {children}, so every /tests*
 *    URL renders the same single-page app and navigation never changes the URL.
 *  - Shortcuts accept Ctrl as well as Meta, so Ctrl+N etc. work on Windows.
 *  - Appearance defaults to 'aperture' regardless of prefers-color-scheme, and
 *    persists to localStorage['kaizen.appearance'].
 */

test.beforeEach(async ({ page }) => {
  await signIn(page);
});

test.describe('menu bar', () => {
  test('renders the brand item and the four menus', async ({ page }) => {
    await expect(page.locator('.menubar .mb-item.brand')).toHaveText(/Kaizen/);
    const menus = page.locator('.menubar .mb-item').filter({ hasNotText: /^Kaizen$/ });
    await expect(menus).toHaveText(['File', 'View', 'Account', 'Help']);
  });

  test('shows the signed-in email as the menu-bar status', async ({ page }) => {
    await expect(page.locator('.menubar')).toContainText('test@test.com');
  });

  test('the File menu lists New Test with its shortcut, New Suite and Analyze', async ({ page }) => {
    const popover = await openMenu(page, 'File');
    await expect(popover.locator('.menu-item')).toHaveText([
      /New Test\s*⌘N/,
      /New Suite/,
      /Analyze an app…/,
    ]);
    await closeMenu(page, 'File');
  });

  test('the View menu lists all five screens with ⌘1–⌘5', async ({ page }) => {
    const popover = await openMenu(page, 'View');
    const items = popover.locator('.menu-item');
    await expect(items.nth(0)).toHaveText(/Tests\s*⌘1/);
    await expect(items.nth(1)).toHaveText(/Runs\s*⌘2/);
    await expect(items.nth(2)).toHaveText(/Analyses\s*⌘3/);
    await expect(items.nth(3)).toHaveText(/The Brain\s*⌘4/);
    await expect(items.nth(4)).toHaveText(/Usage\s*⌘5/);
    await closeMenu(page, 'View');
  });

  test('the View menu offers the appearance cycle and the sidebar toggle', async ({ page }) => {
    const popover = await openMenu(page, 'View');
    await expect(popover.locator('.menu-item', { hasText: 'Next appearance' })).toHaveText(/⇧⌘A/);
    await expect(popover.locator('.menu-item', { hasText: /sidebar/ })).toHaveText(/⌥⌘S/);
    await closeMenu(page, 'View');
  });

  test('the Help menu contains only a disabled keyboard reminder', async ({ page }) => {
    const popover = await openMenu(page, 'Help');
    const items = popover.locator('.menu-item');
    await expect(items).toHaveCount(1);
    await expect(items.first()).toContainText('⌘N new');
    await expect(items.first()).toBeDisabled();
    await closeMenu(page, 'Help');
  });

  test('sets aria-expanded on the open menu and clears it on close', async ({ page }) => {
    const file = page.locator('.mb-item', { hasText: /^File$/ });
    await expect(file).toHaveAttribute('aria-expanded', 'false');
    await file.click();
    await expect(file).toHaveAttribute('aria-expanded', 'true');
    await file.click();
    await expect(file).toHaveAttribute('aria-expanded', 'false');
  });

  test('hovering a sibling while a menu is open switches to it', async ({ page }) => {
    await openMenu(page, 'File');
    await page.locator('.mb-item', { hasText: /^View$/ }).hover();
    await expect(page.locator('.popover')).toContainText('The Brain');
    await expect(page.locator('.mb-item', { hasText: /^View$/ })).toHaveAttribute('aria-expanded', 'true');
    await closeMenu(page, 'View');
  });

  test('clicking outside the menu bar closes an open menu', async ({ page }) => {
    await openMenu(page, 'File');
    await page.locator('main').click({ position: { x: 500, y: 600 } });
    await expect(page.locator('.popover')).toHaveCount(0);
  });

  test('File > New Test opens the author screen', async ({ page }) => {
    const popover = await openMenu(page, 'File');
    await popover.locator('.menu-item', { hasText: 'New Test' }).click();
    await expect(page.locator('.toolbar-title').first()).toHaveText('New test');
  });

  test('File > New Suite opens the author screen too — it does NOT create a suite', async ({ page }) => {
    const popover = await openMenu(page, 'File');
    await popover.locator('.menu-item', { hasText: 'New Suite' }).click();
    // Documented quirk: the item calls go('author'), so no suite dialog appears.
    await expect(page.locator('.toolbar-title').first()).toHaveText('New test');
    await expect(page.locator('.sheet')).toHaveCount(0);
  });

  test('Account > Usage & settings goes to the Usage screen', async ({ page }) => {
    const popover = await openMenu(page, 'Account');
    await popover.locator('.menu-item', { hasText: 'Usage & settings' }).click();
    await expect(page.locator('.toolbar-title').first()).toHaveText('Usage');
  });

  test('View > Runs switches screens from the menu', async ({ page }) => {
    const popover = await openMenu(page, 'View');
    await popover.locator('.menu-item', { hasText: /^Runs/ }).click();
    await expect(page.locator('.toolbar-title').first()).toHaveText('Runs');
  });
});

test.describe('sidebar', () => {
  test('lists the five workspace destinations in order', async ({ page }) => {
    const items = page.locator('.sidebar .side-item');
    await expect(items.nth(0)).toContainText('Tests');
    await expect(items.nth(1)).toContainText('Runs');
    // Suite rows are interleaved after Tests, so assert by presence rather than index.
    await expect(page.locator('.side-item').filter({ hasText: 'Analyses' })).toBeVisible();
    await expect(page.locator('.side-item').filter({ hasText: 'The Brain' })).toBeVisible();
    await expect(page.locator('.side-item').filter({ hasText: 'Usage' })).toBeVisible();
    await expect(page.locator('.side-item').filter({ hasText: 'Settings' })).toBeVisible();
  });

  test('marks the active destination with aria-current', async ({ page }) => {
    const tests = page.locator('.side-item').filter({ hasText: 'Tests' }).first();
    await expect(tests).toHaveAttribute('aria-current', 'true');
    await gotoScreen(page, 'Runs');
    await expect(page.locator('.side-item').filter({ hasText: 'Runs' }).first())
      .toHaveAttribute('aria-current', 'true');
    await expect(tests).toHaveAttribute('aria-current', 'false');
  });

  test('shows a case count beside Tests and only beside Tests', async ({ page }) => {
    const testsItem = page.locator('.side-item').filter({ hasText: 'Tests' }).first();
    await expect(testsItem.locator('.side-count')).toHaveText(/^\d+$/);
    await expect(page.locator('.side-item').filter({ hasText: 'Runs' }).first().locator('.side-count'))
      .toHaveCount(0);
  });

  test('the Tests count agrees with the toolbar subtitle', async ({ page }) => {
    const count = await page.locator('.side-item').filter({ hasText: 'Tests' }).first()
      .locator('.side-count').innerText();
    await expect(page.locator('.toolbar-sub').first()).toContainText(`${count} tests across`);
  });

  test('offers a new-suite button and a suites disclosure beside Tests', async ({ page }) => {
    await expect(page.locator('.sidebar button[title="New suite"]')).toBeVisible();
    await expect(page.locator('.sidebar button[title="Hide suites"]')).toBeVisible();
  });

  test('the suites disclosure hides and restores the nested suite rows', async ({ page }) => {
    const suiteRows = page.locator('.sidebar .side-item[style*="padding-left: 26px"]');
    // The suite list arrives with the first data fetch, so settle before counting.
    await expect(suiteRows.first()).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => suiteRows.count(), { timeout: 20_000 }).toBeGreaterThan(0);
    const before = await suiteRows.count();
    await page.locator('.sidebar button[title="Hide suites"]').click();
    await expect(suiteRows).toHaveCount(0);
    await page.locator('.sidebar button[title="Show suites"]').click();
    await expect(suiteRows).toHaveCount(before);
  });

  test('each suite row carries its own case count', async ({ page }) => {
    const suiteRow = page.locator('.sidebar .side-item[style*="padding-left: 26px"]').first();
    await expect(suiteRow.locator('.side-count')).toHaveText(/^\d+$/);
  });

  test('the Settings item lands on the Usage screen', async ({ page }) => {
    await page.locator('.side-item').filter({ hasText: 'Settings' }).click();
    await expect(page.locator('.toolbar-title').first()).toHaveText('Usage');
  });

  test('the user pill shows initials and the display name once the session resolves', async ({ page }) => {
    const pill = page.locator('.sidebar .side-item').last();
    await expect(pill).toContainText('Demo user');
    await expect(pill).toContainText('DU');
    await expect(pill).toBeEnabled();
  });

  test('the window traffic lights are present but inert', async ({ page }) => {
    const lights = page.locator('.sidebar .lights .light');
    await expect(lights).toHaveCount(3);
    await expect(lights.nth(0)).toHaveAttribute('title', 'Close');
    await expect(lights.nth(1)).toHaveAttribute('title', 'Minimise');
    await expect(lights.nth(2)).toHaveAttribute('title', 'Fill the screen');
    // Documented dead control: onLights is () => {}, so clicking changes nothing.
    await lights.nth(0).click();
    await expect(page.locator('.sidebar')).toBeVisible();
    await expect(page.locator('.toolbar-title').first()).toHaveText('Tests');
  });
});

test.describe('screen switching', () => {
  const screens = ['Tests', 'Runs', 'Analyses', 'The Brain', 'Usage'] as const;

  for (const name of screens) {
    test(`the sidebar reaches the ${name} screen`, async ({ page }) => {
      await gotoScreen(page, name);
      await expect(page.locator('.toolbar-title').first()).toHaveText(name);
    });
  }

  test('each screen carries its own explanatory subtitle', async ({ page }) => {
    await gotoScreen(page, 'Runs');
    await expect(page.locator('.toolbar-sub').first()).toContainText(/newest first/i);
    await gotoScreen(page, 'Analyses');
    await expect(page.locator('.toolbar-sub').first())
      .toContainText(/Every time Kaizen explored an app/i);
    await gotoScreen(page, 'The Brain');
    await expect(page.locator('.toolbar-sub').first())
      .toContainText(/Every element Kaizen has learned/i);
    await gotoScreen(page, 'Usage');
    await expect(page.locator('.toolbar-sub').first()).toContainText(/Signed in as/i);
  });

  test('switching screens never changes the URL — navigation is React state', async ({ page }) => {
    const before = page.url();
    await gotoScreen(page, 'Runs');
    expect(page.url()).toBe(before);
    await gotoScreen(page, 'The Brain');
    expect(page.url()).toBe(before);
    await gotoScreen(page, 'Usage');
    expect(page.url()).toBe(before);
  });

  test('reloading always returns to the Tests screen regardless of where you were', async ({ page }) => {
    await gotoScreen(page, 'The Brain');
    await page.reload();
    await expect(page.locator('.toolbar-title').first()).toHaveText('Tests', { timeout: 30_000 });
  });

  test('a deep test URL still renders the Tests screen — the layout drops children', async ({ page }) => {
    await page.goto('/tests/00000000-0000-0000-0000-000000000000');
    await expect(page.locator('.toolbar-title').first()).toHaveText('Tests', { timeout: 30_000 });
    // The URL is untouched, proving it is the layout and not a redirect.
    await expect(page).toHaveURL(/\/tests\/00000000-0000-0000-0000-000000000000$/);
  });

  test('/tests/new renders the Tests list, not the author screen', async ({ page }) => {
    await page.goto('/tests/new');
    await expect(page.locator('.toolbar-title').first()).toHaveText('Tests', { timeout: 30_000 });
    await expect(page).toHaveURL(/\/tests\/new$/);
  });

  test('the report route renders the app, not a report screen', async ({ page }) => {
    // (app)/tests/[id]/runs/[runId]/report/page.tsx exists, so the path resolves —
    // but the layout drops {children}, so what renders is the Tests screen.
    // domcontentloaded, then wait for the shell: a cold route compiles on first
    // hit and Next.js shows its own build screen in the meantime.
    await page.goto('/tests/abc-123/runs/def-456/report', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.sidebar')).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('.toolbar-title').first()).toHaveText('Tests', { timeout: 30_000 });
  });

  test('a path with no matching route segment really does 404', async ({ page }) => {
    // Routing is still real: only paths matching an actual page.tsx resolve.
    // /tests/[id]/runs has no page of its own, so it is a genuine 404.
    await page.goto('/tests/abc-123/runs');
    await expect(page.getByRole('heading', { name: '404' })).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.sidebar')).toHaveCount(0);
  });

  test('an arbitrarily deep nonsense path 404s rather than rendering the app', async ({ page }) => {
    await page.goto('/tests/this-is-not-a-real-id/and/neither/is/this');
    await expect(page.getByRole('heading', { name: '404' })).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.sidebar')).toHaveCount(0);
  });
});

test.describe('keyboard shortcuts', () => {
  test('Ctrl+2 opens Runs', async ({ page }) => {
    await page.keyboard.press('Control+2');
    await expect(page.locator('.toolbar-title').first()).toHaveText('Runs', { timeout: 20_000 });
  });

  test('Ctrl+3 opens Analyses', async ({ page }) => {
    await page.keyboard.press('Control+3');
    await expect(page.locator('.toolbar-title').first()).toHaveText('Analyses', { timeout: 20_000 });
  });

  test('Ctrl+4 opens The Brain', async ({ page }) => {
    await page.keyboard.press('Control+4');
    await expect(page.locator('.toolbar-title').first()).toHaveText('The Brain', { timeout: 20_000 });
  });

  test('Ctrl+5 opens Usage', async ({ page }) => {
    await page.keyboard.press('Control+5');
    await expect(page.locator('.toolbar-title').first()).toHaveText('Usage', { timeout: 20_000 });
  });

  test('Ctrl+1 returns to Tests from anywhere', async ({ page }) => {
    await page.keyboard.press('Control+4');
    await expect(page.locator('.toolbar-title').first()).toHaveText('The Brain', { timeout: 20_000 });
    await page.keyboard.press('Control+1');
    await expect(page.locator('.toolbar-title').first()).toHaveText('Tests', { timeout: 20_000 });
  });

  test('Ctrl+N opens a blank new test', async ({ page }) => {
    await page.keyboard.press('Control+n');
    await expect(page.locator('.toolbar-title').first()).toHaveText('New test', { timeout: 20_000 });
    await expect(page.locator('.card input.field').first()).toHaveValue('');
  });

  test('Ctrl+Alt+S collapses the sidebar and exposes a restore button', async ({ page }) => {
    await expect(page.locator('.sidebar')).toBeVisible();
    await page.keyboard.press('Control+Alt+s');
    await expect(page.locator('.sidebar')).toHaveCount(0);
    await expect(page.locator('button[title="Show sidebar (⌥⌘S)"]')).toBeVisible();
  });

  test('the restore button brings the sidebar back', async ({ page }) => {
    await page.keyboard.press('Control+Alt+s');
    await expect(page.locator('.sidebar')).toHaveCount(0);
    await page.locator('button[title="Show sidebar (⌥⌘S)"]').click();
    await expect(page.locator('.sidebar')).toBeVisible();
  });

  test('Ctrl+Alt+S toggles back as well as forward', async ({ page }) => {
    await page.keyboard.press('Control+Alt+s');
    await expect(page.locator('.sidebar')).toHaveCount(0);
    await page.keyboard.press('Control+Alt+s');
    await expect(page.locator('.sidebar')).toBeVisible();
  });

  test('the collapsed shell keeps the window traffic lights in the toolbar area', async ({ page }) => {
    await page.keyboard.press('Control+Alt+s');
    await expect(page.locator('.sidebar')).toHaveCount(0);
    await expect(page.locator('.lights .light')).toHaveCount(3);
    await page.locator('button[title="Show sidebar (⌥⌘S)"]').click();
    await expect(page.locator('.sidebar')).toBeVisible();
  });

  test('the sidebar toggle in the View menu matches the shortcut', async ({ page }) => {
    const popover = await openMenu(page, 'View');
    await popover.locator('.menu-item', { hasText: 'Hide sidebar' }).click();
    await expect(page.locator('.sidebar')).toHaveCount(0);
    await page.locator('button[title="Show sidebar (⌥⌘S)"]').click();
    await expect(page.locator('.sidebar')).toBeVisible();
  });
});

test.describe('appearance', () => {
  test.afterEach(async ({ page }) => {
    // Leave the workspace on its default skin for whatever runs next.
    await page.evaluate(() => localStorage.setItem('kaizen.appearance', 'aperture'));
  });

  test('defaults to aperture, ignoring the system colour scheme', async ({ page }) => {
    await expect.poll(() => appearance(page)).toBe('aperture');
    expect(await page.evaluate(() => localStorage.getItem('kaizen.appearance'))).toBe('aperture');
  });

  test('Ctrl+Shift+A cycles aperture to light', async ({ page }) => {
    await expect.poll(() => appearance(page)).toBe('aperture');
    await page.keyboard.press('Control+Shift+a');
    await expect.poll(() => appearance(page)).toBe('light');
  });

  test('Ctrl+Shift+A cycles all the way round in three presses', async ({ page }) => {
    await expect.poll(() => appearance(page)).toBe('aperture');
    await page.keyboard.press('Control+Shift+a');
    await expect.poll(() => appearance(page)).toBe('light');
    await page.keyboard.press('Control+Shift+a');
    await expect.poll(() => appearance(page)).toBe('dark');
    await page.keyboard.press('Control+Shift+a');
    await expect.poll(() => appearance(page)).toBe('aperture');
  });

  test('the appearance is written to localStorage as it changes', async ({ page }) => {
    await page.keyboard.press('Control+Shift+a');
    await expect.poll(() => appearance(page)).toBe('light');
    expect(await page.evaluate(() => localStorage.getItem('kaizen.appearance'))).toBe('light');
  });

  test('choosing Dark on the Appearance tab applies it immediately', async ({ page }) => {
    await setAppearance(page, 'dark');
    await expect.poll(() => appearance(page)).toBe('dark');
  });

  test('the chosen appearance survives a full page reload', async ({ page }) => {
    await setAppearance(page, 'dark');
    await page.reload();
    await expect(page.locator('.sidebar')).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => appearance(page)).toBe('dark');
    await setAppearance(page, 'aperture');
  });

  test('the Appearance tab reflects the currently active theme', async ({ page }) => {
    await setAppearance(page, 'light');
    const seg = page.locator('.list .seg').first();
    await expect(seg.locator('button', { hasText: /^Light$/ })).toHaveAttribute('aria-pressed', 'true');
    await expect(seg.locator('button', { hasText: /^Dark$/ })).toHaveAttribute('aria-pressed', 'false');
    await setAppearance(page, 'aperture');
  });

  test('the View menu shortcut and the tab control drive the same state', async ({ page }) => {
    await setAppearance(page, 'light');
    await page.keyboard.press('Control+Shift+a');
    await expect.poll(() => appearance(page)).toBe('dark');
    const seg = page.locator('.list .seg').first();
    await expect(seg.locator('button', { hasText: /^Dark$/ })).toHaveAttribute('aria-pressed', 'true');
    await setAppearance(page, 'aperture');
  });

  test('Next appearance in the View menu advances the cycle', async ({ page }) => {
    await expect.poll(() => appearance(page)).toBe('aperture');
    const popover = await openMenu(page, 'View');
    await popover.locator('.menu-item', { hasText: 'Next appearance' }).click();
    await expect.poll(() => appearance(page)).toBe('light');
  });
});

test.describe('grouping preference', () => {
  test.afterEach(async ({ page }) => {
    await page.evaluate(() => localStorage.setItem('kaizen.groupBySuite', '1'));
  });

  test('grouping is on by default and reported by the switch', async ({ page }) => {
    await gotoScreen(page, 'Usage');
    await page.locator('.seg button', { hasText: /^Appearance$/ }).click();
    const groupSwitch = page.locator('.row', { hasText: 'Group tests by suite' }).locator('.switch');
    await expect(groupSwitch).toHaveAttribute('aria-checked', 'true');
  });

  test('turning grouping off is persisted to localStorage', async ({ page }) => {
    await gotoScreen(page, 'Usage');
    await page.locator('.seg button', { hasText: /^Appearance$/ }).click();
    const groupSwitch = page.locator('.row', { hasText: 'Group tests by suite' }).locator('.switch');
    await groupSwitch.click();
    await expect(groupSwitch).toHaveAttribute('aria-checked', 'false');
    await expect.poll(() => page.evaluate(() => localStorage.getItem('kaizen.groupBySuite'))).toBe('0');
    await groupSwitch.click();
    await expect(groupSwitch).toHaveAttribute('aria-checked', 'true');
  });

  test('grouping off collapses the per-suite lists into one flat list', async ({ page }) => {
    await gotoScreen(page, 'Tests');
    await expect(page.locator('.list .row.focus-row').first()).toBeVisible({ timeout: 30_000 });
    // Grouped mode renders one `.list` container per suite that has matching rows.
    await expect.poll(() => page.locator('.scroll .list').count(), { timeout: 20_000 })
      .toBeGreaterThan(1);

    await gotoScreen(page, 'Usage');
    await page.locator('.seg button', { hasText: /^Appearance$/ }).click();
    const groupSwitch = page.locator('.row', { hasText: 'Group tests by suite' }).locator('.switch');
    await groupSwitch.click();
    await expect(groupSwitch).toHaveAttribute('aria-checked', 'false');

    await gotoScreen(page, 'Tests');
    await expect(page.locator('.list .row.focus-row').first()).toBeVisible({ timeout: 30_000 });
    // Flat mode renders exactly one list container for every row.
    await expect(page.locator('.scroll .list')).toHaveCount(1, { timeout: 20_000 });

    await gotoScreen(page, 'Usage');
    await page.locator('.seg button', { hasText: /^Appearance$/ }).click();
    await page.locator('.row', { hasText: 'Group tests by suite' }).locator('.switch').click();
    await expect(page.locator('.row', { hasText: 'Group tests by suite' }).locator('.switch'))
      .toHaveAttribute('aria-checked', 'true');
  });

  test('the grouping switch exposes a switch role for assistive tech', async ({ page }) => {
    await gotoScreen(page, 'Usage');
    await page.locator('.seg button', { hasText: /^Appearance$/ }).click();
    const groupSwitch = page.locator('.row', { hasText: 'Group tests by suite' }).locator('.switch');
    await expect(groupSwitch).toHaveAttribute('role', 'switch');
  });
});
