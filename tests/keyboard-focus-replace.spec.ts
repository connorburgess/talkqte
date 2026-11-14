import { expect, test, type Page } from '@playwright/test';
import type {} from './fixtures/native-microphone';

// Where keyboard focus goes when the control that was pressed is removed or
// replaced. A browser check does not establish native keyboard or
// screen-reader behavior, or focus between applications.

async function liveWithProcessor(page: Page) {
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
  await page.goto('/?live&processor');
  await page
    .getByRole('button', { name: 'Start live session', exact: true })
    .press('Enter');
  await expect(
    page.getByRole('button', { name: 'Stop live session', exact: true }),
  ).toBeEnabled();
  const panel = page.getByRole('region', {
    name: 'Cue processing',
    exact: true,
  });
  const review = panel.getByRole('button', {
    name: 'Review processing',
    exact: true,
  });
  await review.press('Enter');
  await panel
    .getByRole('button', { name: 'Review selected sources' })
    .press('Enter');
  await panel
    .getByRole('button', { name: 'Enable for this session' })
    .press('Enter');
  await expect(panel.getByRole('status')).toHaveText('Processing on');
  return {
    panel,
    review,
    disable: panel.getByRole('button', { name: 'Disable processing' }),
  };
}

test('keyboard Disable processing moves focus to Review processing and leaves capture on', async ({
  page,
}) => {
  const { review, disable } = await liveWithProcessor(page);
  await disable.press('Enter');
  await expect(disable).toHaveCount(0);
  await expect(review).toBeFocused();
  await expect(
    page.getByRole('button', { name: 'Stop live session', exact: true }),
  ).toBeEnabled();
  // The control that received focus works from the keyboard.
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('button', { name: 'Review selected sources' }),
  ).toBeVisible();
});

test('a delayed Disable processing does not take focus back from another control', async ({
  page,
}) => {
  const { review, disable } = await liveWithProcessor(page);
  await page.evaluate(() => window.permissionTest.hold('revoke_processing'));
  await disable.press('Enter');
  const search = page.getByRole('textbox', { name: 'Search meetings' });
  await search.focus();
  await page.evaluate(() => window.permissionTest.release('revoke_processing'));
  await expect(disable).toHaveCount(0);
  await expect(review).toBeEnabled();
  await expect(search).toBeFocused();
});

for (const width of [1320, 480]) {
  test(`keyboard Try demo moves focus to Pause at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/');
    await page
      .getByRole('button', { name: 'Try demo', exact: true })
      .press('Enter');
    const controls = page.getByRole('region', { name: 'Demo controls' });
    const pause = controls.getByRole('button', { name: 'Pause', exact: true });
    await expect(pause).toBeFocused();
    // The control that received focus works from the keyboard.
    await page.keyboard.press('Enter');
    await expect(
      controls.getByRole('button', { name: 'Resume', exact: true }),
    ).toBeFocused();
  });
}

test('a demo started from the companion does not move focus in the notebook', async ({
  page,
}) => {
  await page.goto('/');
  const notes = page.getByRole('textbox', { name: 'Meeting notes' });
  await notes.focus();
  await page.evaluate(async () => {
    const path = '/src/lib/preview.ts';
    const preview = await import(path);
    preview.command('start_demo');
  });
  await expect(
    page
      .getByRole('region', { name: 'Demo controls' })
      .getByRole('button', { name: 'Pause', exact: true }),
  ).toBeVisible();
  await expect(notes).toBeFocused();
});

test('keyboard Replay demo also moves focus to Pause', async ({ page }) => {
  await page.goto('/');
  await page
    .getByRole('button', { name: 'Try demo', exact: true })
    .press('Enter');
  await page
    .getByRole('button', { name: 'End demo', exact: true })
    .press('Enter');
  await page
    .getByRole('button', { name: 'Replay demo', exact: true })
    .press('Enter');
  await expect(
    page
      .getByRole('region', { name: 'Demo controls' })
      .getByRole('button', { name: 'Pause', exact: true }),
  ).toBeFocused();
});
