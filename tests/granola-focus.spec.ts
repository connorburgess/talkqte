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
});

test('a pending focus suggestion keeps disconnect and the notebook usable', async ({
  page,
}, testInfo) => {
  await page
    .getByLabel('Focus · optional', { exact: true })
    .fill('Garden access');
  await page
    .getByRole('button', { name: 'Suggest from Granola', exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => window.granolaTest.suggestionRequests))
    .toBe(1);
  await page
    .locator('.meeting-focus')
    .screenshot({ path: testInfo.outputPath('granola-focus-pending.png') });
  await page
    .getByRole('region', { name: 'Prior context' })
    .screenshot({ path: testInfo.outputPath('granola-focus-connection.png') });
  const disconnect = page.getByRole('button', {
    name: 'Disconnect Granola',
    exact: true,
  });
  await expect(disconnect).toBeEnabled();
  await expect(
    page.getByRole('button', { name: 'Try demo', exact: true }),
  ).toBeEnabled();
  await page.setViewportSize({ width: 600, height: 700 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const focusPanel = page.getByRole('region', { name: 'This meeting' });
  expect(
    await focusPanel.evaluate((el) => el.scrollWidth <= el.clientWidth),
  ).toBe(true);
  await focusPanel.screenshot({
    path: testInfo.outputPath('granola-focus-narrow.png'),
  });
  await disconnect.click();
  await expect(
    page.getByRole('button', { name: 'Connect Granola', exact: true }),
  ).toBeFocused();
  await page.evaluate(() =>
    window.granolaTest.releaseSuggestion(0, ['Old garden plan']),
  );
  await expect
    .poll(() => page.evaluate(() => window.granolaTest.completedSuggestions))
    .toBe(1);
  await expect(
    page.getByRole('group', { name: /Granola suggests/ }),
  ).toHaveCount(0);
  await expect(
    page.getByLabel('Focus · optional', { exact: true }),
  ).toHaveValue('Garden access');
});

test('an old suggestion failure cannot clear a replacement request', async ({
  page,
}) => {
  await page
    .getByRole('button', { name: 'Suggest from Granola', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Disconnect Granola', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Connect Granola', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Suggest from Granola', exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => window.granolaTest.suggestionRequests))
    .toBe(2);
  await page.evaluate(() =>
    window.granolaTest.releaseSuggestion(0, 'The old suggestion failed.'),
  );
  await expect
    .poll(() => page.evaluate(() => window.granolaTest.completedSuggestions))
    .toBe(1);
  await expect(
    page.getByRole('button', { name: 'Asking Granola…' }),
  ).toBeDisabled();
  await expect(
    page.getByText('The old suggestion failed.', { exact: false }),
  ).toHaveCount(0);
  await page.evaluate(() =>
    window.granolaTest.releaseSuggestion(1, ['Confirm garden access']),
  );
  await expect(
    page.getByRole('checkbox', { name: 'Confirm garden access' }),
  ).toBeVisible();
  await expect(
    page.getByLabel('Focus · optional', { exact: true }),
  ).toHaveValue('');
});

test('suggestions preserve edits and outside focus and only add selected lines', async ({
  page,
}) => {
  const focus = page.getByLabel('Focus · optional', { exact: true });
  await focus.fill('Garden access');
  await page
    .getByRole('button', { name: 'Suggest from Granola', exact: true })
    .click();
  await focus.fill('Garden access\nVolunteer welcome');
  await page.evaluate(() =>
    window.granolaTest.releaseSuggestion(0, [
      'Confirm garden access',
      'Plan the plant sale',
    ]),
  );
  const group = page.getByRole('group', { name: /Granola suggests/ });
  await expect(group).toBeVisible();
  await expect(focus).toBeFocused();
  await expect(focus).toHaveValue('Garden access\nVolunteer welcome');
  await group.getByRole('checkbox', { name: 'Confirm garden access' }).check();
  await group.getByRole('button', { name: 'Add 1 to the focus' }).click();
  await expect(focus).toHaveValue(
    'Garden access\nVolunteer welcome\nConfirm garden access',
  );
  await expect(focus).toBeFocused();
});

test('keyboard activation sends one request and moves into its ready suggestions', async ({
  page,
  browserName,
}) => {
  const suggest = page.getByRole('button', {
    name: 'Suggest from Granola',
    exact: true,
  });
  await suggest.focus();
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('button', { name: 'Asking Granola…' }),
  ).toBeDisabled();
  // The waiting control stays in the tab order; repeated activation sends nothing.
  await page.keyboard.press('Enter');
  await page.keyboard.press('Space');
  await expect
    .poll(() => page.evaluate(() => window.granolaTest.suggestionRequests))
    .toBe(1);
  await page.evaluate(() =>
    window.granolaTest.releaseSuggestion(0, ['Confirm garden access']),
  );
  await expect(
    page.getByRole('group', { name: /Granola suggests/ }),
  ).toBeFocused();
  await page.keyboard.press(
    browserName === 'webkit' && process.platform === 'darwin'
      ? 'Alt+Tab'
      : 'Tab',
  );
  await expect(
    page.getByRole('checkbox', { name: 'Confirm garden access' }),
  ).toBeFocused();
  await page.keyboard.press('Space');
  await expect(
    page.getByRole('checkbox', { name: 'Confirm garden access' }),
  ).toBeChecked();
});

test('a suggestion failure offers retry and an empty answer leaves manual focus intact', async ({
  page,
}, testInfo) => {
  const focus = page.getByLabel('Focus · optional', { exact: true });
  await focus.fill('Garden access');
  await page
    .getByRole('button', { name: 'Suggest from Granola', exact: true })
    .click();
  await page.evaluate(() =>
    window.granolaTest.releaseSuggestion(0, 'Granola did not answer in time.'),
  );
  const panel = page.getByRole('region', { name: 'This meeting' });
  await expect(panel.getByRole('alert')).toContainText(
    'Ask again, or type your own focus.',
  );
  await panel.screenshot({
    path: testInfo.outputPath('granola-focus-error.png'),
  });
  await expect(
    page.getByRole('button', { name: 'Disconnect Granola', exact: true }),
  ).toBeEnabled();
  await page
    .getByRole('button', { name: 'Suggest from Granola', exact: true })
    .click();
  await expect(panel.getByRole('alert')).toHaveCount(0);
  await page.evaluate(() => window.granolaTest.releaseSuggestion(1, []));
  await expect(panel).toContainText(
    'Nothing came back. Type what matters instead.',
  );
  await expect(focus).toHaveValue('Garden access');
  await panel.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await expect(focus).toBeFocused();
});
