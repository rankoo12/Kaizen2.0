import { login, dump } from './lib';

(async () => {
  const { browser, page } = await login();

  // kebab menu on a row
  const row = page.locator('.row', { hasText: 'Sign in with valid credentials' }).first();
  await row.hover();
  await page.waitForTimeout(300);
  await row.locator('button').last().click();
  await page.waitForTimeout(700);
  await dump(page, '64-row-kebab');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);

  // Settings tabs
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.waitForTimeout(1200);
  for (const [tab, file] of [['API keys', '65-api-keys'], ['Members', '66-members'], ['Appearance', '67-appearance']] as const) {
    await page.getByRole('button', { name: tab, exact: true }).click();
    await page.waitForTimeout(900);
    await dump(page, file);
  }

  // File > New Suite
  await page.getByRole('button', { name: 'File', exact: true }).click();
  await page.waitForTimeout(400);
  await page.getByText('New Suite', { exact: true }).click();
  await page.waitForTimeout(700);
  await dump(page, '68-new-suite');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  // if a cancel button exists click it
  const cancel = page.getByRole('button', { name: 'Cancel' });
  if (await cancel.count()) { try { await cancel.first().click({ timeout: 2000 }); } catch {} }
  await page.waitForTimeout(300);

  // Analyze dialog from Tests screen
  await page.getByRole('button', { name: /^Tests/ }).first().click();
  await page.waitForTimeout(700);
  await page.getByRole('button', { name: 'Analyze', exact: true }).click();
  await page.waitForTimeout(900);
  await dump(page, '69-analyze-dialog');
  const cancel2 = page.getByRole('button', { name: 'Cancel' });
  if (await cancel2.count()) { try { await cancel2.first().click({ timeout: 2000 }); } catch {} }

  // Brain tabs
  await page.getByRole('button', { name: 'The Brain' }).click();
  await page.waitForTimeout(1300);
  await page.getByRole('button', { name: 'Needs review', exact: true }).click();
  await page.waitForTimeout(800);
  await dump(page, '70-brain-needs-review');
  // search
  await page.getByPlaceholder('Search what it knows').fill('checkbox');
  await page.waitForTimeout(700);
  await dump(page, '71-brain-search');
  // click a brain row to expand?
  await page.getByPlaceholder('Search what it knows').fill('');
  await page.getByRole('button', { name: 'All', exact: true }).click();
  await page.waitForTimeout(500);
  await page.getByText('click the "Add Element" button').first().click();
  await page.waitForTimeout(700);
  await dump(page, '72-brain-row-click');

  // Runs filters
  await page.getByRole('button', { name: 'Runs' }).first().click();
  await page.waitForTimeout(1200);
  await page.getByRole('button', { name: 'Active', exact: true }).click();
  await page.waitForTimeout(700);
  await dump(page, '73-runs-active');
  await page.getByRole('button', { name: 'Healed', exact: true }).click();
  await page.waitForTimeout(700);
  await dump(page, '74-runs-healed');

  await browser.close();
})();
