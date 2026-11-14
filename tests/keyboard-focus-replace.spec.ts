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
  const other = page.getByRole('button', { name: 'Settings', exact: true });
  await other.focus();
  await page.evaluate(() => window.permissionTest.release('revoke_processing'));
  await expect(disable).toHaveCount(0);
  await expect(review).toBeEnabled();
  await expect(other).toBeFocused();
});
