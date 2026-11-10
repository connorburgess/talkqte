import { expect, test, type Page } from '@playwright/test';
import type {} from './fixtures/native-granola';

const button = (page: Page, name: string) =>
  page.getByRole('button', { name, exact: true });
const context = (page: Page) =>
  page.getByRole('region', { name: 'Prior context' });
async function pendingStatus(page: Page) {
  await expect
    .poll(() => page.evaluate(() => window.granolaTest.pendingStatuses))
    .toBeGreaterThan(0);
}
async function connected(page: Page) {
  await expect(button(page, 'Choose Granola notes')).toBeEnabled();
  await expect(button(page, 'Disconnect Granola')).toBeEnabled();
  await expect(button(page, 'Suggest from Granola')).toBeEnabled();
  await expect(button(page, 'Connect Granola')).toHaveCount(0);
  await expect(context(page)).toContainText(
    'No prior notes selected. Choose Granola notes',
  );
}

test.beforeEach(async ({ page }) => {
  await page.route('**/*', async (route) => {
    if (route.request().resourceType() !== 'document') return route.continue();
    const response = await route.fetch();
    await route.fulfill({
      response,
      body: (await response.text()).replace(
        '/src/main.tsx',
        '/tests/fixtures/native-microphone.ts',
      ),
    });
  });
});

for (const fail of [false, true]) {
  test(`an old ${fail ? 'failed' : 'disconnected'} snapshot cannot hide a newly connected account`, async ({
    page,
  }, testInfo) => {
    await page.goto('/?granola&hold-granola-status');
    await pendingStatus(page);
    await button(page, 'Connect Granola').press('Enter');
    await connected(page);
    await button(page, 'Disconnect Granola').focus();
    await page.evaluate(
      (failure) => window.granolaTest.releaseStatuses(failure),
      fail,
    );
    await page.evaluate(() => new Promise(requestAnimationFrame));
    await connected(page);
    await expect(button(page, 'Disconnect Granola')).toBeFocused();
    if (!fail) {
      await context(page).screenshot({
        path: testInfo.outputPath('granola-status-connected.png'),
      });
      await page.setViewportSize({ width: 600, height: 700 });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      expect(
        await context(page).evaluate((el) => el.scrollWidth <= el.clientWidth),
      ).toBe(true);
      await context(page).screenshot({
        path: testInfo.outputPath('granola-status-narrow.png'),
      });
    }
    await button(page, 'Disconnect Granola').press('Enter');
    await expect(button(page, 'Connect Granola')).toBeFocused();
    await expect(button(page, 'Suggest from Granola')).toHaveCount(0);
  });

  test(`a ${fail ? 'failed' : 'connected'} snapshot from a closed notebook cannot replace a newer connection`, async ({
    page,
  }) => {
    await page.goto('/?granola');
    await button(page, 'Connect Granola').press('Enter');
    await connected(page);
    await button(page, 'Settings').press('Enter');
    await page.evaluate(() => window.granolaTest.holdStatuses());
    await button(page, 'Notebook').press('Enter');
    await pendingStatus(page);
    await button(page, 'Settings').press('Enter');
    await page.evaluate(() => window.granolaTest.holdStatuses(false));
    await button(page, 'Notebook').press('Enter');
    await connected(page);
    await button(page, 'Disconnect Granola').press('Enter');
    await expect(button(page, 'Connect Granola')).toBeFocused();
    // A stale success must not restore suggestions after disconnect. A stale
    // failure must not remove suggestions after an explicit reconnect.
    if (fail) {
      await button(page, 'Connect Granola').press('Enter');
      await connected(page);
      await button(page, 'Disconnect Granola').focus();
    }
    await page.evaluate(
      (failure) => window.granolaTest.releaseStatuses(failure),
      fail,
    );
    await page.evaluate(() => new Promise(requestAnimationFrame));
    if (fail) {
      await connected(page);
      await expect(button(page, 'Disconnect Granola')).toBeFocused();
    } else {
      await expect(button(page, 'Connect Granola')).toBeFocused();
      await expect(button(page, 'Suggest from Granola')).toHaveCount(0);
      await expect(button(page, 'Choose Granola notes')).toHaveCount(0);
    }
  });
}

test('a current connection snapshot restores controls on returning to the notebook', async ({
  page,
}) => {
  await page.goto('/?granola');
  await button(page, 'Connect Granola').press('Enter');
  await connected(page);
  await button(page, 'Settings').press('Enter');
  await button(page, 'Notebook').press('Enter');
  await connected(page);
  await button(page, 'Choose Granola notes').press('Enter');
  await expect(
    page.getByRole('dialog', { name: /Choose notes/ }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Cancel', exact: true })
    .press('Enter');
  await expect(button(page, 'Choose Granola notes')).toBeFocused();
});

test('an initial status failure leaves explicit connection available', async ({
  page,
}) => {
  await page.goto('/?granola&hold-granola-status');
  await pendingStatus(page);
  await page.evaluate(() => window.granolaTest.releaseStatuses(true));
  await expect(button(page, 'Connect Granola')).toBeEnabled();
  await expect(button(page, 'Suggest from Granola')).toHaveCount(0);
  await button(page, 'Connect Granola').press('Enter');
  await connected(page);
});
