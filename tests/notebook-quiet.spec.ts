import { expect, test } from '@playwright/test';

test('the notebook starts with the editor visible and optional setup folded away', async ({
  page,
}, testInfo) => {
  await page.goto('/');
  const notes = page.getByRole('textbox', {
    name: 'Meeting notes',
    exact: true,
  });
  await expect(notes).toBeInViewport();
  await expect(
    page.getByRole('button', { name: 'Try demo', exact: true }),
  ).toBeInViewport();
  await expect(page.getByRole('button', { name: 'Add your name' })).toHaveCount(
    0,
  );
  await expect(page.getByRole('textbox', { name: 'Focus' })).toHaveCount(0);
  await notes.fill('Fictional note: confirm the garden welcome date.');
  await page.screenshot({
    path: testInfo.outputPath('notebook-quiet-desktop.png'),
  });

  const setup = page.locator('.setup-disclosure > summary');
  await setup.press('Enter');
  await expect(
    page.getByRole('button', { name: 'Add your name' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Not now' }).press('Enter');
  await expect(
    page.getByRole('button', { name: 'Notebook', exact: true }),
  ).toBeFocused();
  await expect(notes).toHaveValue(
    'Fictional note: confirm the garden welcome date.',
  );

  const focus = page.locator('.focus-disclosure > summary');
  await focus.press('Space');
  await page.getByRole('textbox', { name: 'Focus' }).fill('Garden access');
  await focus.press('Space');
  await expect(page.getByRole('textbox', { name: 'Focus' })).toHaveCount(0);
  await focus.press('Enter');
  await expect(page.getByRole('textbox', { name: 'Focus' })).toHaveValue(
    'Garden access',
  );
  await expect(notes).toHaveValue(
    'Fictional note: confirm the garden welcome date.',
  );
});

test('a collapsed focus section reveals a rejected save without moving keyboard focus', async ({
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
  await page.goto('/?granola');
  const summary = page.locator('.focus-disclosure > summary');
  await summary.press('Enter');
  await page.evaluate(() => window.focusTest.hold());
  await page.getByRole('textbox', { name: 'Focus' }).fill('Team sync');
  await summary.press('Enter');
  await expect(page.getByRole('textbox', { name: 'Focus' })).toHaveCount(0);
  const notes = page.getByRole('textbox', {
    name: 'Meeting notes',
    exact: true,
  });
  await notes.focus();
  await page.evaluate(() => window.focusTest.release());
  await expect(page.getByRole('alert')).toContainText("Focus wasn't applied");
  await expect(page.getByRole('textbox', { name: 'Focus' })).toBeVisible();
  await expect(notes).toBeFocused();
  await page.getByRole('textbox', { name: 'Focus' }).fill('Garden access');
  await notes.focus();
  await expect(page.getByRole('alert')).toHaveCount(0);

  // Recovery must also be visible if the save finishes while Settings is open.
  await page.evaluate(() => window.focusTest.hold());
  await page.getByRole('textbox', { name: 'Focus' }).fill('Team sync');
  await summary.press('Enter');
  await page
    .getByRole('button', { name: 'Settings', exact: true })
    .press('Enter');
  await page.evaluate(() => window.focusTest.release());
  await expect
    .poll(() => page.evaluate(() => window.focusTest.completed()))
    .toBe(3);
  const notebook = page.getByRole('button', { name: 'Notebook', exact: true });
  await notebook.press('Enter');
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Focus' })).toBeVisible();
  await expect(notebook).toBeFocused();
});

for (const width of [320, 600]) {
  test(`optional notebook sections remain usable at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    await page.locator('.setup-disclosure > summary').press('Enter');
    await page.getByRole('button', { name: 'Write the focus' }).press('Enter');
    const focus = page.getByRole('textbox', { name: 'Focus' });
    await expect(focus).toBeFocused();
    await focus.fill('Garden welcome guide');
    await page.locator('.focus-disclosure > summary').press('Enter');
    await expect(focus).toBeHidden();
    await page.locator('.context-disclosure > summary').press('Enter');
    await page
      .getByRole('button', { name: 'Add notes from a file' })
      .press('Enter');
    await expect(
      page.getByRole('dialog', { name: /Choose notes/ }),
    ).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(
      page.getByRole('button', { name: 'Add notes from a file' }),
    ).toBeFocused();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    await page.screenshot({
      path: testInfo.outputPath(`notebook-quiet-${width}.png`),
      fullPage: true,
    });
  });
}
