import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.route('**/?granola', async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      body: (await response.text()).replace(
        '/src/main.tsx',
        '/tests/fixtures/native-microphone.ts',
      ),
    });
  });
  await page.goto('/?granola');
  await page
    .getByRole('button', { name: 'Connect Granola', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Choose Granola notes', exact: true })
    .click();
});

test('a failed selected-note import stays visible and can retry without listing again', async ({
  page,
}) => {
  const chooser = page.getByRole('dialog', { name: /Choose notes/ });
  await expect(chooser.getByRole('button', { name: /Import/ })).toBeDisabled();
  await chooser.getByRole('checkbox').first().check();
  await expect(chooser.getByRole('status')).toHaveText('1 of 24 selected');
  await page.evaluate(() => window.granolaTest.fail());
  await chooser.getByRole('button', { name: 'Import 1 selected' }).click();
  await expect(chooser.getByRole('alert')).toContainText(
    'Nothing was imported',
  );
  await expect(chooser.getByRole('checkbox').first()).toBeChecked();
  await chooser.getByRole('button', { name: 'Import 1 selected' }).click();
  await expect(chooser).not.toBeVisible();
  const context = page.getByRole('region', { name: 'Prior context' });
  await expect(context.getByRole('listitem')).toHaveCount(1);
  await expect(context).toContainText('From Granola');
  await expect(context).toContainText('Robin will label the watering cans');
  await expect(
    page.getByRole('button', { name: 'Choose Granola notes' }),
  ).toBeFocused();
  expect(await page.evaluate(() => window.granolaTest.selections)).toEqual([
    ['garden-0'],
    ['garden-0'],
  ]);
});

test('cancel during import keeps late notes out and restores the launch button', async ({
  page,
}) => {
  const chooser = page.getByRole('dialog', { name: /Choose notes/ });
  await chooser.getByRole('checkbox').first().check();
  await page.evaluate(() => window.granolaTest.hold());
  await chooser.getByRole('button', { name: 'Import 1 selected' }).click();
  await expect(
    chooser.getByRole('button', { name: 'Importing…' }),
  ).toBeDisabled();
  await expect(chooser.getByRole('checkbox').first()).toBeDisabled();
  await chooser.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(chooser).not.toBeVisible();
  await page.evaluate(() => window.granolaTest.release());
  await expect(
    page.getByRole('region', { name: 'Prior context' }).getByRole('listitem'),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Choose Granola notes' }),
  ).toBeFocused();
  await page.getByRole('button', { name: 'Choose Granola notes' }).click();
  await expect(chooser.getByRole('alert')).toHaveCount(0);
  await expect(chooser.getByRole('status')).toHaveText('0 of 24 selected');
});

test('long titles wrap, the list scrolls, and actions fit in a narrow chooser', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 600, height: 700 });
  const chooser = page.getByRole('dialog', { name: /Choose notes/ });
  await chooser.getByRole('checkbox').first().focus();
  await page.keyboard.press('Space');
  await expect(chooser.getByRole('checkbox').first()).toBeChecked();
  const dimensions = await chooser.evaluate((el) => ({
    width: el.clientWidth,
    content: el.scrollWidth,
    bottom: el.getBoundingClientRect().bottom,
  }));
  expect(dimensions.content).toBeLessThanOrEqual(dimensions.width);
  expect(dimensions.bottom).toBeLessThanOrEqual(700);
  await expect(
    chooser.getByRole('button', { name: 'Import 1 selected' }),
  ).toBeInViewport();
  await chooser.screenshot({
    path: testInfo.outputPath('fictional-granola-chooser.png'),
  });
  await page.keyboard.press('Escape');
  await expect(chooser).not.toBeVisible();
});

test('bulk selection respects the provider ten-note limit', async ({
  page,
}) => {
  const chooser = page.getByRole('dialog', { name: /Choose notes/ });
  await chooser.getByRole('button', { name: 'Select first 10' }).click();
  await expect(chooser.getByRole('checkbox').nth(10)).toBeDisabled();
  await chooser.getByRole('button', { name: 'Import 10 selected' }).click();
  expect(
    (await page.evaluate(() => window.granolaTest.selections))[0],
  ).toHaveLength(10);
  await expect(chooser).not.toBeVisible();
});

test('disconnect stays reachable while listing and ignores a late chooser', async ({
  page,
  browserName,
}, testInfo) => {
  const chooser = page.getByRole('dialog', { name: /Choose notes/ });
  await chooser.getByRole('checkbox').first().check();
  await chooser.getByRole('button', { name: 'Import 1 selected' }).click();
  const context = page.getByRole('region', { name: 'Prior context' });
  await expect(context.getByRole('listitem')).toHaveCount(1);
  await page.evaluate(() => window.granolaTest.holdListing());
  await page.getByRole('button', { name: 'Choose Granola notes' }).click();
  await expect(
    page.getByRole('button', { name: 'Loading Granola notes…' }),
  ).toBeDisabled();
  await context.screenshot({
    path: testInfo.outputPath('granola-loading.png'),
  });
  const disconnect = page.getByRole('button', {
    name: 'Disconnect Granola',
    exact: true,
  });
  await expect(disconnect).toBeEnabled();
  await page.setViewportSize({ width: 600, height: 700 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await disconnect.scrollIntoViewIfNeeded();
  await expect(disconnect).toBeInViewport();
  expect(await context.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
    true,
  );
  await context.screenshot({
    path: testInfo.outputPath('granola-loading-narrow.png'),
  });
  // Check the surrounding tab route before keyboard activation.
  await page
    .getByRole('button', { name: 'Disconnect Granola', exact: true })
    .focus();
  await page.keyboard.press(
    browserName === 'webkit' && process.platform === 'darwin'
      ? 'Alt+Shift+Tab'
      : 'Shift+Tab',
  );
  await page.keyboard.press(
    browserName === 'webkit' && process.platform === 'darwin'
      ? 'Alt+Tab'
      : 'Tab',
  );
  await expect(disconnect).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('button', { name: 'Connect Granola', exact: true }),
  ).toBeFocused();
  await expect(context.getByRole('listitem')).toHaveCount(1);
  await page.evaluate(() => window.granolaTest.releaseListing(0));
  await expect
    .poll(() => page.evaluate(() => window.granolaTest.completedListings))
    .toBe(1);
  await expect(chooser).not.toBeVisible();
  await expect(context.getByRole('listitem')).toHaveCount(1);
  await expect(
    page.getByRole('button', { name: 'Add notes from a file' }),
  ).toBeEnabled();
});

test('an old listing failure cannot clear a new connection loading state', async ({
  page,
}) => {
  const chooser = page.getByRole('dialog', { name: /Choose notes/ });
  await chooser.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.evaluate(() => window.granolaTest.holdListing());
  await page.getByRole('button', { name: 'Choose Granola notes' }).click();
  await page
    .getByRole('button', { name: 'Disconnect Granola', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Connect Granola', exact: true })
    .click();
  await page.evaluate(() => window.granolaTest.holdListing());
  await page.getByRole('button', { name: 'Choose Granola notes' }).click();
  await page.evaluate(() => window.granolaTest.releaseListing(0, true));
  await expect
    .poll(() => page.evaluate(() => window.granolaTest.completedListings))
    .toBe(1);
  await expect(
    page.getByRole('button', { name: 'Loading Granola notes…' }),
  ).toBeDisabled();
  await expect(page.getByText('The old Granola listing failed.')).toHaveCount(
    0,
  );
  await expect(chooser).not.toBeVisible();
  await page.evaluate(() => window.granolaTest.releaseListing(1));
  await expect(chooser).toBeVisible();
  await chooser.getByRole('checkbox').first().check();
  await chooser.getByRole('button', { name: 'Import 1 selected' }).click();
  await expect(
    page.getByRole('region', { name: 'Prior context' }).getByRole('listitem'),
  ).toHaveCount(1);
});

test('a failed disconnect stays connected and offers an explicit retry', async ({
  page,
}) => {
  const chooser = page.getByRole('dialog', { name: /Choose notes/ });
  await chooser.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.evaluate(() => {
    window.granolaTest.holdListing();
    window.granolaTest.failDisconnect();
  });
  await page.getByRole('button', { name: 'Choose Granola notes' }).click();
  const disconnect = page.getByRole('button', {
    name: 'Disconnect Granola',
    exact: true,
  });
  await disconnect.click();
  await expect(page.getByRole('alert')).toContainText(
    'Granola could not disconnect. Try again.',
  );
  await expect(disconnect).toBeEnabled();
  await page.evaluate(() => window.granolaTest.releaseListing(0));
  await expect
    .poll(() => page.evaluate(() => window.granolaTest.completedListings))
    .toBe(1);
  await expect(chooser).not.toBeVisible();
  await disconnect.click();
  await expect(
    page.getByRole('button', { name: 'Connect Granola', exact: true }),
  ).toBeFocused();
});
