const fs = require('node:fs');
const { test, expect } = require('@playwright/test');
const credentials = JSON.parse(
  fs.readFileSync(
    process.env.ACCOUNT_CREDENTIALS_FILE || '/app/data/provisioned-accounts.json',
    'utf8',
  ),
);

test.beforeEach(async ({ context, page }) => {
  await context.route('**/*', (route) =>
    ['localhost', '127.0.0.1'].includes(new URL(route.request().url()).hostname)
      ? route.continue()
      : route.abort(),
  );
  await page.addInitScript(() => {
    window.uiFailures = [];
    const original = console.error;
    console.error = function (...args) {
      window.uiFailures.push(args.map(String).join(' '));
      original.apply(this, args);
    };
  });
});

test('room links use the current origin and management tabs render', async ({ page }) => {
  const owner = credentials.accounts.enterpriseOwner;
  await page.goto('/ptrApp#/page/welcome');
  await page.getByRole('textbox', { name: 'Your email', exact: true }).fill(owner.email);
  await page.getByLabel('Your password', { exact: true }).fill(owner.password);
  await page.getByRole('button', { name: 'Login', exact: true }).click();
  await page
    .getByRole('link', { name: /Manage/ })
    .first()
    .click();
  await expect(page.locator('#webinarLinkTxt')).toHaveValue(
    new URL(`/u/${credentials.rooms.enterprise.id}`, page.url()).href,
  );
  for (const heading of ['Branding (Logo / Landing Page)', 'User Stats', 'Settings', 'Users']) {
    await page.getByText(heading, { exact: true }).click();
    await expect(page.locator('.tab-content')).toBeVisible();
  }
  expect(await page.evaluate(() => window.uiFailures)).toEqual([]);
});

test('room controls and recording stop tolerate absent optional media', async ({ page }) => {
  const account = credentials.accounts.presenter;
  await page.goto(`/u/${credentials.rooms.enterprise.id}`);
  await page.getByPlaceholder('Your Nick/Name').fill(account.name);
  await page.getByPlaceholder('Your Email', { exact: true }).fill(account.email);
  await page.getByPlaceholder('Password', { exact: true }).fill(account.password);
  await page.getByRole('button', { name: 'Enter', exact: true }).click();
  await expect(page.getByPlaceholder(/Type your message here/)).toBeVisible();
  await expect(page.locator('#soundCloudIFrame')).toHaveAttribute('src', 'about:blank');
  await page.evaluate(() => {
    const injector = angular.element(document.documentElement).injector();
    const model = injector.get('chatModel');
    const video = injector.get('webRTCService');
    // Audio-only recordings never acquire a screen publisher handle.
    video.sessions[model.uid + '-p'] = { screentest: null };
    injector.get('$rootScope').$broadcast('recStopped', { uid: model.uid, isSilent: true });
    delete video.sessions[model.uid + '-p'];
  });
  await page.locator('[ng-click="doSessionControl()"]').click();
  await expect(page.locator('.modal-title').filter({ hasText: 'Session Control' })).toBeVisible();
  await expect(page.getByText('Lock Room', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.uiFailures)).toEqual([]);
});
