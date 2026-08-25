import { login, dump } from './lib';

(async () => {
  const { browser, page } = await login();

  await dump(page, '01-tests');

  for (const [nav, file] of [['Runs', '02-runs'], ['Analyses', '03-analyses'], ['The Brain', '04-brain'], ['Usage', '05-usage'], ['Settings', '06-settings']] as const) {
    await page.getByRole('button', { name: nav }).first().click();
    await page.waitForTimeout(1800);
    await dump(page, file);
  }

  // menus (from settings page, then go back to tests)
  await page.getByRole('button', { name: /^Tests/ }).first().click();
  await page.waitForTimeout(1000);
  for (const [menu, file] of [['File', '07-menu-file'], ['View', '08-menu-view'], ['Account', '09-menu-account'], ['Help', '10-menu-help']] as const) {
    await page.getByRole('button', { name: menu, exact: true }).click();
    await page.waitForTimeout(700);
    await dump(page, file);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
  }

  await browser.close();
})();
