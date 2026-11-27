import { expect, test } from '@playwright/test';
import { standIn, startLive } from './fixtures/stand-in';

test('session type is keyboard accessible, survives navigation, and resets on a fresh launch', async ({
  page,
}, testInfo) => {
  await page.goto('/');
  await page.locator('.focus-disclosure > summary').click();
  const mode = page.getByRole('combobox', { name: 'Session type' });
  await expect(mode).toHaveValue('meeting');
  await expect(page.locator('.focus-disclosure')).toContainText(
    'Session type stays selected until you quit.',
  );
  await mode.focus();
  await mode.selectOption('interview');
  await expect(mode).toBeFocused();
  await expect(mode).toHaveValue('interview');
  await page
    .getByText('Prepare for your interview', { exact: true })
    .press('Enter');
  await expect(
    page.getByText(
      'Selecting Interview does not add or share any past meetings.',
      { exact: false },
    ),
  ).toBeVisible();
  await page
    .getByRole('textbox', { name: 'Meeting notes', exact: true })
    .fill('Fictional example: I evaluated two garden irrigation layouts.');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Notebook', exact: true }).click();
  await expect(mode).toHaveValue('interview');
  const preparation = page.getByText('Prepare for your interview', {
    exact: true,
  });
  await preparation.focus();
  await preparation.press('Enter');
  await expect(preparation).toBeFocused();
  await expect(preparation).toHaveCSS('outline-style', 'solid');
  await expect(preparation).toHaveCSS('outline-width', '3px');
  await page.screenshot({
    path: testInfo.outputPath('interview-summary-focus.png'),
    fullPage: true,
  });
  await page.screenshot({
    path: testInfo.outputPath('interview-desktop.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1512, height: 982 });
  await page.screenshot({
    path: testInfo.outputPath('interview-user-1512.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await mode.scrollIntoViewIfNeeded();
  expect(
    await mode.evaluate((el) => el.getBoundingClientRect().height),
  ).toBeGreaterThanOrEqual(44);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath('interview-preparation-narrow.png'),
  });
  await page.reload();
  await page.locator('.focus-disclosure > summary').click();
  await expect(mode).toHaveValue('meeting');
});

test('a failed mode change preserves Meeting and presents a recoverable error', async ({
  page,
}) => {
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
  await page.goto('/?keys=set&reject-session-mode');
  await page.locator('.focus-disclosure > summary').click();
  const mode = page.getByRole('combobox', { name: 'Session type' });
  await mode.selectOption('interview');
  await expect(
    page
      .getByRole('alert')
      .filter({ hasText: 'Session type could not be changed' }),
  ).toBeVisible();
  await expect(mode).toHaveValue('meeting');
  await expect(mode).toBeEnabled();
});

test('Interview stays locked during a live session and becomes editable after Stop', async ({
  page,
}, testInfo) => {
  await standIn(page, '/?live');
  await page.locator('.focus-disclosure > summary').click();
  const mode = page.getByRole('combobox', { name: 'Session type' });
  await mode.selectOption('interview');
  await expect(mode).toHaveValue('interview');
  await startLive(page);
  await expect(mode).toBeDisabled();
  await expect(mode).toHaveValue('interview');
  await expect(
    page.getByText('Stop the session to change its type.', { exact: false }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('interview-locked.png'),
    fullPage: true,
  });
  await page
    .getByRole('button', { name: 'Stop live session', exact: true })
    .click();
  await expect(mode).toBeEnabled();
  await mode.selectOption('meeting');
  await expect(mode).toHaveValue('meeting');
});

test('a delayed session-type save restores lost focus without stealing outside focus', async ({
  page,
}) => {
  await page.goto('/');
  await page.evaluate(async () => {
    document.body.innerHTML = '<main id="mode-fixture"></main>';
    const path = '/tests/fixtures/session-mode.tsx';
    const { mountSessionMode } = await import(path);
    mountSessionMode(document.getElementById('mode-fixture')!);
  });
  const mode = page.getByRole('combobox', { name: 'Session type' });
  const release = () =>
    page.evaluate(async () => {
      const path = '/tests/fixtures/session-mode.tsx';
      const { releaseSessionMode } = await import(path);
      releaseSessionMode();
    });
  await mode.focus();
  await mode.selectOption('interview');
  await expect(mode).toBeDisabled();
  await release();
  await expect(mode).toBeEnabled();
  await expect(mode).toBeFocused();
  await expect(mode).toHaveValue('interview');

  await mode.selectOption('meeting');
  await expect(mode).toBeDisabled();
  const outside = page.getByRole('button', { name: 'Another control' });
  await outside.focus();
  await release();
  await expect(mode).toBeEnabled();
  await expect(outside).toBeFocused();
  await expect(mode).toHaveValue('meeting');
});
