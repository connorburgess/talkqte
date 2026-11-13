import { expect, test, type Page } from '@playwright/test';
import type {} from './fixtures/native-context';

const panel = (page: Page) =>
  page.getByRole('region', { name: 'Prior context' });
const button = (page: Page, name: string) =>
  page.getByRole('button', { name, exact: true });
const firstTitle = 'Garden signs planning';
const secondTitle = 'Garden paths review';

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

for (const all of [false, true]) {
  test(`a delayed startup list cannot restore ${all ? 'all removed notes' : 'a removed note'}`, async ({
    page,
  }, testInfo) => {
    await page.goto('/?context-ordering&hold-context');
    await page.locator('.context-disclosure > summary').press('Enter');
    await expect
      .poll(() => page.evaluate(() => window.contextTest.pending()))
      .toBeGreaterThan(0);
    await page.evaluate(() => window.contextTest.publish());
    await expect(panel(page)).toContainText(firstTitle);
    await button(
      page,
      all ? 'Remove all' : `Remove ${firstTitle} (2026-11-02)`,
    ).press('Enter');
    await expect(panel(page)).not.toContainText(firstTitle);
    expect(await page.evaluate(() => window.contextTest.items().length)).toBe(
      all ? 0 : 1,
    );
    await button(page, 'Add notes from a file').focus();
    await page.evaluate(() => window.contextTest.release());
    await page.evaluate(() => new Promise(requestAnimationFrame));
    await panel(page).screenshot({
      path: testInfo.outputPath('context-after-reply.png'),
    });
    await expect(panel(page)).not.toContainText(firstTitle);
    if (all)
      await expect(panel(page)).toContainText('No prior notes selected.');
    else await expect(panel(page)).toContainText(secondTitle);
    await expect(button(page, 'Add notes from a file')).toBeFocused();
    if (all) {
      await page.setViewportSize({ width: 600, height: 700 });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      expect(
        await panel(page).evaluate((el) => el.scrollWidth <= el.clientWidth),
      ).toBe(true);
      await panel(page).screenshot({
        path: testInfo.outputPath('context-empty-narrow.png'),
      });
    }
  });
}

test('a delayed empty startup list cannot hide newly imported notes', async ({
  page,
}) => {
  await page.goto('/?context-ordering&hold-context&empty-context');
  await page.locator('.context-disclosure > summary').press('Enter');
  await expect
    .poll(() => page.evaluate(() => window.contextTest.pending()))
    .toBeGreaterThan(0);
  await page.evaluate(() => window.contextTest.importNotes());
  await expect(panel(page)).toContainText(firstTitle);
  await page.evaluate(() => window.contextTest.release());
  await page.evaluate(() => new Promise(requestAnimationFrame));
  await expect(panel(page)).toContainText(firstTitle);
  await expect(panel(page)).toContainText(secondTitle);
});

test('a failed startup read after an event does not detach later removal updates', async ({
  page,
}) => {
  await page.goto('/?context-ordering&hold-context');
  await page.locator('.context-disclosure > summary').press('Enter');
  await expect
    .poll(() => page.evaluate(() => window.contextTest.pending()))
    .toBeGreaterThan(0);
  await page.evaluate(() => window.contextTest.publish());
  await expect(panel(page)).toContainText(firstTitle);
  await page.evaluate(() => window.contextTest.release(true));
  await page.evaluate(() => new Promise(requestAnimationFrame));
  await button(page, 'Remove all').press('Enter');
  await expect(panel(page)).toContainText('No prior notes selected.');
  expect(await page.evaluate(() => window.contextTest.items())).toEqual([]);
  await page.evaluate(() => window.contextTest.importNotes());
  await expect(panel(page)).toContainText(secondTitle);
});

test('the initial list still supplies notes when no event has arrived', async ({
  page,
}) => {
  await page.goto('/?context-ordering&hold-context');
  await page.locator('.context-disclosure > summary').press('Enter');
  await expect
    .poll(() => page.evaluate(() => window.contextTest.pending()))
    .toBeGreaterThan(0);
  await expect(panel(page)).toContainText('No prior notes selected.');
  await page.evaluate(() => window.contextTest.release());
  await expect(panel(page)).toContainText(firstTitle);
  await expect(panel(page)).toContainText(secondTitle);
  await button(page, 'Remove all').press('Enter');
  await expect(panel(page)).toContainText('No prior notes selected.');
});
