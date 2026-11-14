import { expect, test } from '@playwright/test';
import type {} from './fixtures/native-microphone';
import type {} from './fixtures/native-granola';

test('narrow keyboard flow preserves context controls and independent Stop', async ({
  page,
  browserName,
}) => {
  await page.setViewportSize({ width: 600, height: 700 });
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
  await page.goto('/?granola&live');
  const nav = page.getByRole('navigation', { name: 'Main navigation' });
  const context = page.getByRole('region', { name: 'Prior context' });
  await nav
    .getByRole('button', { name: 'Notebook', exact: true })
    .press('Enter');
  await context.locator('summary').press('Enter');
  await context
    .getByRole('button', { name: 'Connect Granola', exact: true })
    .press('Enter');
  await context
    .getByRole('button', { name: 'Choose Granola notes', exact: true })
    .press('Enter');
  const chooser = page.getByRole('dialog', { name: /Choose notes/ });
  await chooser.getByRole('checkbox').first().press('Space');
  await chooser
    .getByRole('button', { name: 'Import 1 selected' })
    .press('Enter');
  await expect(chooser).not.toBeVisible();
  await expect(context).toContainText('From Granola');
  await expect(context).toContainText(
    'Garden welcome guide: signs, accessible paths, and a plan for the volunteer open day',
  );
  await expect(context).toContainText('2026-11-02');
  expect(await page.evaluate(() => window.granolaTest.selections)).toEqual([
    ['garden-0'],
  ]);
  await expect(context.getByRole('listitem')).toHaveCount(1);
  await page
    .getByRole('button', { name: 'Start live session', exact: true })
    .press('Enter');
  await page.evaluate(() =>
    window.liveTest.say(
      'Could someone own the guide?',
      'Who will take the first draft?',
    ),
  );
  const cue = page.getByRole('region', { name: 'Suggested question' });
  await expect(cue).toContainText('Could someone own the guide?');
  await cue.getByRole('button', { name: 'Hold', exact: true }).press('Enter');
  await expect(
    cue.getByRole('button', { name: 'Held', exact: true }),
  ).toBeFocused();
  await page.evaluate(() => window.granolaTest.holdListing());
  await context
    .getByRole('button', { name: 'Choose Granola notes', exact: true })
    .press('Enter');
  await expect(
    context.getByRole('button', { name: 'Loading Granola notes…' }),
  ).toBeDisabled();
  const stop = page.getByRole('button', {
    name: 'Stop live session',
    exact: true,
  });
  await expect(stop).toBeEnabled();
  await stop.scrollIntoViewIfNeeded();
  await expect(stop).toBeInViewport();
  await stop.press('Enter');
  await expect(stop).toHaveCount(0);
  await page.evaluate(() => window.granolaTest.failDisconnect());
  const disconnect = context.getByRole('button', {
    name: 'Disconnect Granola',
    exact: true,
  });
  await disconnect.focus();
  await page.keyboard.press(
    browserName === 'webkit' && process.platform === 'darwin'
      ? 'Alt+Shift+Tab'
      : 'Shift+Tab',
  );
  await expect(disconnect).not.toBeFocused();
  await page.keyboard.press(
    browserName === 'webkit' && process.platform === 'darwin'
      ? 'Alt+Tab'
      : 'Tab',
  );
  await expect(disconnect).toBeFocused();
  await disconnect.press('Enter');
  await expect(page.getByRole('alert')).toContainText(
    'Granola could not disconnect. Try again.',
  );
  await expect(disconnect).toBeEnabled();
  await disconnect.press('Enter');
  await expect(
    context.getByRole('button', { name: 'Connect Granola', exact: true }),
  ).toBeFocused();
  await expect(context.getByRole('listitem')).toHaveCount(1);
  await page.evaluate(() => window.granolaTest.releaseListing(0));
  await expect
    .poll(() => page.evaluate(() => window.granolaTest.completedListings))
    .toBe(1);
  await expect(chooser).not.toBeVisible();
  await context
    .getByRole('button', { name: 'Remove all', exact: true })
    .press('Enter');
  await expect(context).toContainText('No prior notes selected.');
  await expect(
    context.getByRole('button', { name: 'Add notes from a file' }),
  ).toBeFocused();
  await page
    .getByRole('button', { name: 'Settings', exact: true })
    .press('Enter');
  await expect(
    page.getByRole('heading', { name: 'Make room for your conversation.' }),
  ).toBeVisible();
  await nav
    .getByRole('button', { name: 'Notebook', exact: true })
    .press('Enter');
  await context.locator('summary').press('Enter');
  await expect(context).toContainText('No prior notes selected.');
  await expect(context.getByRole('listitem')).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
