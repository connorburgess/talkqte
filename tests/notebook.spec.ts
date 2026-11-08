import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.clock.install();
  await page.goto('/');
  await expect(
    page.getByRole('button', { name: 'Try demo', exact: true }),
  ).toBeVisible();
});

test('saves a question, preserves it on replay, and never duplicates it', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Try demo', exact: true }).click();
  await page.clock.runFor(5200);
  await page
    .getByRole('button', { name: 'Save question', exact: true })
    .click();
  await expect(
    page
      .getByRole('region', { name: 'Saved questions', exact: true })
      .getByText('Who will take the first draft?'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'End demo', exact: true }).click();
  await page.getByRole('button', { name: 'Replay demo', exact: true }).click();
  await page.clock.runFor(5200);
  await page
    .getByRole('button', { name: 'Save question', exact: true })
    .click();
  await expect(page.locator('.saved-question')).toHaveCount(1);
});

test('pause freezes a question, resume lets it expire without saving it', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Try demo', exact: true }).click();
  await page.clock.runFor(5200);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await page.clock.runFor(30_000);
  await expect(
    page.getByRole('button', { name: 'Save question', exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole('heading', { name: 'Who will take the first draft?' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Resume', exact: true }).click();
  await page.clock.runFor(18_200);
  await expect(
    page.getByRole('region', { name: 'Suggested question' }),
  ).toHaveCount(0);
  await expect(page.locator('.saved-question')).toHaveCount(0);
});

test('export saves exactly the reviewed text even as the demo moves on', async ({
  page,
}) => {
  await page
    .getByRole('textbox', { name: 'Meeting notes', exact: true })
    .fill('Ask about a large-print welcome guide.');
  await page.getByRole('button', { name: 'Try demo', exact: true }).click();
  await page.clock.runFor(1200);
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Review your export' });
  await expect(dialog).toContainText('Ask about a large-print welcome guide.');
  const reviewed = await dialog.locator('pre').innerText();
  expect(reviewed).toContain('not derived from microphone audio');
  await page.clock.runFor(12_000);
  const downloading = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Download Markdown' }).click();
  const stream = await (await downloading).createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  expect(Buffer.concat(chunks).toString('utf8')).toBe(reviewed);
  await expect(dialog).not.toBeVisible();
});

test('search has a recoverable empty state and settings explain the prototype', async ({
  page,
}) => {
  await page
    .getByRole('textbox', { name: 'Search meetings' })
    .fill('nothing here');
  await expect(page.getByText('No matching meetings.')).toBeVisible();
  await page.getByRole('button', { name: 'Clear search' }).first().click();
  await expect(
    page.getByRole('button', { name: /Demo meeting A better welcome/ }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page
    .getByRole('combobox', { name: 'Question timing' })
    .selectOption('quiet');
  await expect(
    page.getByRole('combobox', { name: 'Question timing' }),
  ).toHaveValue('quiet');
  await expect(
    page.getByRole('switch', { name: 'Floating question window' }),
  ).toBeDisabled();
  await expect(
    page.getByText('These features are not available in this prototype.'),
  ).toBeVisible();
});

test('narrow layout keeps the demo and question controls usable with reduced motion', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByRole('button', { name: 'Try demo', exact: true }).click();
  await page.clock.runFor(5200);
  await expect(
    page.getByRole('button', { name: 'Save question', exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await expect(
    page.getByRole('button', { name: 'Dismiss', exact: true }),
  ).toHaveCSS('transition-duration', '0s');
  await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await expect(
    page.getByRole('region', { name: 'Suggested question' }),
  ).toHaveCount(0);
});

for (const width of [320, 880]) {
  test(`notebook controls remain readable and comfortably sized at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.getByRole('button', { name: 'Try demo', exact: true }).click();
    await page.clock.runFor(72_000);
    await expect(
      page.getByRole('heading', {
        name: 'How will we choose between those options?',
      }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    for (const name of [
      'Export',
      'Pause',
      'End demo',
      'Save question',
      'Dismiss',
    ]) {
      const button = page.getByRole('button', { name, exact: true });
      const bounds = await button.boundingBox();
      expect(bounds!.width, name).toBeGreaterThanOrEqual(44);
      expect(bounds!.height, name).toBeGreaterThanOrEqual(44);
      expect(
        await button.evaluate((el) => el.scrollWidth <= el.clientWidth),
        name,
      ).toBe(true);
    }
    await page
      .getByRole('button', { name: 'Save question', exact: true })
      .click();
    await expect(
      page.getByRole('region', { name: 'Saved questions', exact: true }),
    ).toContainText('How will we choose between those options?');
  });
}

test('keyboard users can change notebook tabs and close the export preview', async ({
  page,
}) => {
  await page.getByRole('tab', { name: 'Notes', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: /Transcript/ })).toBeFocused();
  await expect(page.getByRole('tabpanel')).toContainText(
    'A conversation starts here.',
  );
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Export', exact: true }),
  ).toBeFocused();
});
