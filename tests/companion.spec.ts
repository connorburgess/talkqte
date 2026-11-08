import { expect, test, type Page } from '@playwright/test';

// The browser adapter supplies the same session transitions as Rust IPC. These
// tests exercise companion controls; native placement is checked separately.
async function sessionAction(page: Page, name: 'start_demo' | 'end_demo') {
  await page.evaluate(async (command) => {
    const previewPath = '/src/lib/preview.ts';
    const preview = await import(previewPath);
    preview.command(command);
  }, name);
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 380, height: 390 });
  await page.clock.install();
  await page.goto('/?window=cue');
  await expect(
    page.getByText('Start the demo from your notebook.'),
  ).toBeVisible();
  await sessionAction(page, 'start_demo');
});

test('companion stays compact between questions and preserves a paused question', async ({
  page,
}) => {
  await page.setViewportSize({ width: 380, height: 88 });
  await expect(page.getByRole('status')).toHaveText('Demo running · No audio');
  await expect(page.getByRole('button', { name: 'Pause demo' })).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <= innerWidth &&
        document.querySelector('main')!.scrollHeight <= innerHeight,
    ),
  ).toBe(true);
  await page.clock.runFor(5_200);
  await page.setViewportSize({ width: 380, height: 390 });
  await expect(
    page.getByRole('heading', { name: 'Who will take the first draft?' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Pause demo' }).click();
  await page.clock.runFor(30_000);
  await expect(page.getByRole('status')).toHaveText('Demo paused · No audio');
  await expect(
    page.getByRole('region', { name: 'Suggested question' }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Resume demo' }).click();
  await expect(
    page.getByRole('heading', { name: 'Who will take the first draft?' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Save question' }).click();
  await expect(
    page.getByRole('region', { name: 'Suggested question' }),
  ).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Pause demo' })).toBeVisible();
});

test('hiding a companion suppresses later questions and ending clears its controls', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Hide companion' }).click();
  await page.clock.runFor(6_000);
  await expect(
    page.getByText('Companion hidden. Show it again in Settings.'),
  ).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Suggested question' }),
  ).toHaveCount(0);
  await expect(page.getByRole('button')).toHaveCount(0);
  await sessionAction(page, 'end_demo');
  await expect(page.getByRole('button')).toHaveCount(0);
});

test('question controls remain usable with reduced motion and longer wrapping', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.clock.runFor(42_000);
  await expect(
    page.getByRole('button', { name: 'Dismiss', exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <= innerWidth &&
        document.querySelector('main')!.scrollHeight <= innerHeight,
    ),
  ).toBe(true);
  await expect(page.locator('.time-track > div')).toHaveCSS(
    'transition-duration',
    '0s',
  );
  await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await expect(
    page.getByRole('region', { name: 'Suggested question' }),
  ).toHaveCount(0);
});
