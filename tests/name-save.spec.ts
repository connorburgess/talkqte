import { expect, test, type Page } from '@playwright/test';
import type {} from './fixtures/native-microphone';

const name = (page: Page) =>
  page.getByRole('textbox', { name: 'Name', exact: true });
async function open(page: Page) {
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
  await page.goto('/');
  await page
    .getByRole('button', { name: 'Settings', exact: true })
    .press('Enter');
  await expect(name(page)).toBeVisible();
}
async function saved(page: Page, value: string | null) {
  await expect
    .poll(() => page.evaluate(() => window.nameTest.current()))
    .toBe(value);
}
async function submit(page: Page, value: string) {
  await name(page).fill(value);
  await name(page).press('Enter');
}
async function firstPending(page: Page, value: string) {
  await page.evaluate(() => window.captureTest.holdName());
  await submit(page, value);
  await expect
    .poll(() => page.evaluate(() => window.nameTest.submissions.at(-1)))
    .toBe(value);
}

for (const first of ['Robin', 'Robin!']) {
  test(`a delayed ${first.endsWith('!') ? 'rejection' : 'success'} leaves a newer unsubmitted name draft intact`, async ({
    page,
  }, testInfo) => {
    await open(page);
    await firstPending(page, first);
    await name(page).fill('Alex');
    await page.evaluate(() => window.captureTest.releaseName());
    if (first === 'Robin') await saved(page, 'Robin');
    else await expect(page.getByRole('alert')).toContainText('Use letters');
    await page.evaluate(() => new Promise(requestAnimationFrame));
    await name(page)
      .locator('..')
      .locator('..')
      .screenshot({ path: testInfo.outputPath('name-draft.png') });
    await expect(name(page)).toHaveValue('Alex');
    await expect(name(page)).toBeFocused();
    expect(await page.evaluate(() => window.nameTest.submissions)).toEqual([
      first,
    ]);
    // Only leaving the field submits the newer draft.
    await page.getByRole('button', { name: 'Notebook', exact: true }).focus();
    await saved(page, 'Alex');
    await expect(page.getByRole('alert')).toHaveCount(0);
  });
}

for (const first of ['Robin', 'Robin!']) {
  test(`newer submissions follow a ${first.endsWith('!') ? 'rejected' : 'successful'} save without duplicate blur submissions`, async ({
    page,
  }) => {
    await open(page);
    await firstPending(page, first);
    await submit(page, 'Alex');
    // Resubmitting the same trimmed name still confirms the latest edit.
    await name(page).fill('  Alex  ');
    await name(page).press('Enter');
    const notebook = page.getByRole('button', {
      name: 'Notebook',
      exact: true,
    });
    await notebook.focus();
    await page.evaluate(() => window.captureTest.releaseName());
    await saved(page, 'Alex');
    await expect(name(page)).toHaveValue('Alex');
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(notebook).toBeFocused();
    expect(await page.evaluate(() => window.nameTest.submissions)).toEqual([
      first,
      'Alex',
    ]);
    expect(
      await page.evaluate(() => window.microphoneTest.calls),
    ).not.toContain('start_microphone');
  });
}

test('the latest rejected name rolls back to the last successful queued save', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 600, height: 700 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await open(page);
  await submit(page, 'Sam');
  await saved(page, 'Sam');
  await firstPending(page, 'Robin');
  await submit(page, 'Alex!');
  const notebook = page.getByRole('button', { name: 'Notebook', exact: true });
  await notebook.focus();
  await page.evaluate(() => window.captureTest.releaseName());
  await expect(page.getByRole('alert')).toContainText('Use letters');
  await expect(name(page)).toHaveValue('Robin');
  await saved(page, 'Robin');
  await expect(notebook).toBeFocused();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(600);
  await name(page)
    .locator('..')
    .locator('..')
    .screenshot({
      path: testInfo.outputPath('name-rejected-narrow.png'),
    });
  await submit(page, 'Alex');
  await saved(page, 'Alex');
  await expect(page.getByRole('alert')).toHaveCount(0);
});

for (const latest of ['', 'Sam']) {
  test(`a pending name save cannot undo ${latest ? 'returning to the previous name' : 'clearing the name'}`, async ({
    page,
  }) => {
    await open(page);
    await submit(page, 'Sam');
    await saved(page, 'Sam');
    await firstPending(page, 'Robin');
    await submit(page, latest);
    await page.evaluate(() => window.captureTest.releaseName());
    await expect
      .poll(() => page.evaluate(() => window.nameTest.submissions))
      .toEqual(['Sam', 'Robin', latest || null]);
    await saved(page, latest || null);
    await expect(name(page)).toHaveValue(latest);
  });
}
