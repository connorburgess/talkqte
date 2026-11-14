import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.clock.install();
  await page.goto('/');
  await page.locator('.context-disclosure > summary').press('Enter');
  await expect(
    page.getByRole('button', { name: 'Try demo', exact: true }),
  ).toBeVisible();
});

test('focus is optional and the setup card can finish without it', async ({
  page,
}) => {
  await page.locator('.setup-disclosure > summary').press('Enter');
  const card = page.getByRole('region', { name: 'Before your first meeting' });
  await expect(card).toContainText('What matters today · optional');
  await card.getByRole('button', { name: 'Write the focus' }).click();
  await expect(page.getByRole('textbox', { name: 'Focus' })).toBeFocused();
  await expect(page.getByRole('textbox', { name: 'Focus' })).toHaveValue('');
  await card.getByRole('button', { name: 'Add your name' }).click();
  const name = page.getByRole('textbox', { name: 'Name' });
  await name.fill('Robin');
  await page.getByRole('combobox', { name: 'Question timing' }).focus();
  await page.getByRole('button', { name: 'Notebook', exact: true }).click();
  await expect(card).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Focus' })).toHaveValue('');
  await page.getByRole('button', { name: 'Try demo', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Pause', exact: true }),
  ).toBeVisible();
});

test('the setup card sends Choose notes to the prior-context panel without changing view', async ({
  page,
}) => {
  await page.locator('.context-disclosure > summary').press('Enter');
  await page.locator('.setup-disclosure > summary').press('Enter');
  const card = page.getByRole('region', { name: 'Before your first meeting' });
  await card.getByRole('button', { name: 'Choose notes' }).click();
  await expect(
    page.getByRole('button', { name: 'Add notes from a file' }),
  ).toBeFocused();
  await expect(card).toBeVisible();
  // An ordinary tab change afterwards does not move focus anywhere.
  await page.getByRole('tab', { name: /Transcript/ }).click();
  await expect(page.getByRole('tab', { name: /Transcript/ })).toBeFocused();
});

test('the setup card can be put away for the session', async ({ page }) => {
  await page.locator('.setup-disclosure > summary').press('Enter');
  const card = page.getByRole('region', { name: 'Before your first meeting' });
  await card.getByRole('button', { name: 'Not now' }).click();
  await expect(card).toHaveCount(0);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Notebook', exact: true }).click();
  await expect(card).toHaveCount(0);
});

test('dismisses a cue without turning it into a saved question', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Try demo', exact: true }).click();
  await page.clock.runFor(8200);
  await expect(
    page.getByRole('heading', { name: 'Who will take the first draft?' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save question' })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole('button', { name: 'Saved questions' }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await expect(
    page.getByRole('region', { name: 'Suggested question' }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Review your export' });
  await expect(dialog.locator('pre')).not.toContainText(
    'Who will take the first draft?',
  );
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'End demo', exact: true }).click();
  await page.getByRole('button', { name: 'Replay demo', exact: true }).click();
  await page.clock.runFor(8200);
  await expect(
    page.getByRole('heading', { name: 'Who will take the first draft?' }),
  ).toBeVisible();
});

test('keeping a quoted line puts it in the notes with its time and lets the cue go', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Try demo', exact: true }).click();
  await page.clock.runFor(51_200);
  const question = page.getByRole('region', { name: 'Suggested question' });
  await expect(question).toContainText('Just said');
  await question.getByRole('button', { name: 'Keep this line' }).click();
  await page.getByRole('tab', { name: 'Notes', exact: true }).click();
  await expect(question).toHaveCount(0);
  await expect(
    page.getByRole('textbox', { name: 'Meeting notes' }),
  ).toHaveValue(
    /\[00:51\] Robin: “Let's have it ready by Friday and try it with a few new visitors first\.”\n$/,
  );
  await expect(page.getByText('Line kept in your notes.')).toBeVisible();
});

test('pause freezes a question, resume lets it expire without saving it', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Try demo', exact: true }).click();
  await page.clock.runFor(8200);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await page.clock.runFor(30_000);
  await expect(
    page.getByRole('button', { name: 'Dismiss', exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole('heading', { name: 'Who will take the first draft?' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Resume', exact: true }).click();
  await page.clock.runFor(18_200);
  await expect(
    page.getByRole('region', { name: 'Suggested question' }),
  ).toHaveCount(0);
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

test('the sidebar has no meeting list or search, and settings explain the prototype', async ({
  page,
}) => {
  const sidebar = page.getByRole('complementary', {
    name: 'Notebook navigation',
  });
  await expect(sidebar.getByRole('textbox')).toHaveCount(0);
  await expect(sidebar.getByText('Meetings', { exact: true })).toHaveCount(0);
  await expect(sidebar.getByText('A better welcome')).toHaveCount(0);
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

test('focus lines are written in the notebook, kept for the session, cleared in one step, and a line without identifying words is refused', async ({
  page,
}) => {
  await page.locator('.focus-disclosure > summary').press('Enter');
  const box = page.getByRole('region', { name: 'This meeting' });
  const focus = box.getByRole('textbox', { name: 'Focus' });
  await expect(box.getByRole('button', { name: 'Clear' })).toHaveCount(0);
  await focus.fill(
    'Agree the launch plan for the newsletter\nDecide who owns the compost bins',
  );
  await page.getByRole('button', { name: 'Notebook', exact: true }).focus(); // leaving saves
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Focus' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Notebook', exact: true }).click();
  await expect(focus).toHaveValue(
    'Agree the launch plan for the newsletter\nDecide who owns the compost bins',
  );
  await focus.fill('Team sync');
  await page.getByRole('button', { name: 'Notebook', exact: true }).focus();
  await expect(page.getByRole('alert')).toContainText(
    '“Team sync” needs a few specific words',
  );
  // The typed text stays so the line can be fixed in place; Clear straight
  // from the field does not save the rejected line first, and the field
  // keeps the keyboard.
  await expect(focus).toHaveValue('Team sync');
  await focus.fill('Team sync again');
  await box.getByRole('button', { name: 'Clear' }).click();
  await expect(focus).toHaveValue('');
  await expect(focus).toBeFocused();
  await expect(box.getByRole('button', { name: 'Clear' })).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page
    .getByRole('combobox', { name: 'Question timing' })
    .selectOption('focused');
  await expect(
    page.getByRole('combobox', { name: 'Question timing' }),
  ).toHaveValue('focused');
});

test('the browser preview never offers a live microphone session', async ({
  page,
}) => {
  await expect(
    page.getByRole('button', { name: 'Start live session' }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Set up live session' }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Live transcription' }),
  ).toBeVisible();
  await expect(
    page.getByText('Available in the desktop app.', { exact: true }),
  ).toBeVisible();
});

test('narrow layout keeps the demo and question controls usable with reduced motion', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByRole('button', { name: 'Try demo', exact: true }).click();
  await page.clock.runFor(8200);
  await expect(
    page.getByRole('button', { name: 'Dismiss', exact: true }),
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
    await page.clock.runFor(8_200);
    await expect(
      page.getByRole('heading', {
        name: 'Who will take the first draft?',
      }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    for (const name of ['Export', 'Pause', 'End demo', 'Dismiss']) {
      const button = page.getByRole('button', { name, exact: true });
      const bounds = await button.boundingBox();
      expect(bounds!.width, name).toBeGreaterThanOrEqual(44);
      expect(bounds!.height, name).toBeGreaterThanOrEqual(44);
      expect(
        await button.evaluate((el) => el.scrollWidth <= el.clientWidth),
        name,
      ).toBe(true);
    }
    await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
    await expect(
      page.getByRole('region', { name: 'Suggested question' }),
    ).toHaveCount(0);
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

test('the browser preview offers no Granola connection and says where it lives', async ({
  page,
}) => {
  const panel = page.getByRole('region', { name: 'Prior context' });
  await expect(panel.getByRole('button', { name: /Granola/ })).toHaveCount(0);
  await expect(panel).toContainText(
    'Connect Granola to choose from your notes',
  );
  await expect(
    panel.getByRole('button', { name: 'Add notes from a file' }),
  ).toBeVisible();
});

test('a line about an imported note shows a reminder that names the note as its source', async ({
  page,
}) => {
  const panel = page.getByRole('region', { name: 'Prior context' });
  await panel.getByRole('button', { name: 'Add notes from a file' }).click();
  const dialog = page.getByRole('dialog', { name: /Choose notes/ });
  await dialog.getByRole('checkbox', { name: /Garden welcome guide/ }).check();
  await dialog.getByRole('button', { name: 'Import 1 selected' }).click();
  await page.getByRole('button', { name: 'Try demo', exact: true }).click();
  await page.clock.runFor(8200);
  const question = page.getByRole('region', { name: 'Suggested question' });
  await expect(
    question.getByRole('heading', { name: 'Garden welcome guide' }),
  ).toBeVisible();
  // The note is named as the source at once, with its excerpt.
  await expect(question).toContainText('From your notes');
  await expect(question).toContainText(
    'Its title came up · imported note, 2026-10-28',
  );
  await expect(question).not.toContainText('demo conversation');
  await expect(question).toContainText('tool shed');
  await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await expect(question).toHaveCount(0);
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await expect(
    page.getByRole('dialog', { name: 'Review your export' }).locator('pre'),
  ).not.toContainText('tool shed');
});

for (const removeAll of [false, true]) {
  test(`removing ${removeAll ? 'all prior notes' : 'a prior note'} clears its held reminder while paused`, async ({
    page,
  }) => {
    const panel = page.getByRole('region', { name: 'Prior context' });
    await panel.getByRole('button', { name: 'Add notes from a file' }).click();
    const dialog = page.getByRole('dialog', { name: /Choose notes/ });
    await dialog
      .getByRole('checkbox', { name: /Garden welcome guide/ })
      .check();
    await dialog.getByRole('checkbox', { name: /Visitor questions/ }).check();
    await dialog.getByRole('button', { name: 'Import 2 selected' }).click();
    await page.getByRole('button', { name: 'Try demo', exact: true }).click();
    await page.clock.runFor(8200);
    const question = page.getByRole('region', { name: 'Suggested question' });
    await question.getByRole('button', { name: 'Hold', exact: true }).click();
    await expect(question).toContainText('tool shed');
    await expect(
      question.getByRole('button', { name: 'Held', exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    await panel
      .getByRole('button', {
        name: removeAll
          ? 'Remove all'
          : 'Remove Garden welcome guide (2026-10-28)',
        exact: true,
      })
      .click();
    await expect(question).toHaveCount(0);
    await expect(panel.getByRole('listitem')).toHaveCount(removeAll ? 0 : 1);
    await expect(page.getByText(/map of the tool shed/)).toHaveCount(0);
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    await expect(
      page.getByRole('dialog', { name: 'Review your export' }).locator('pre'),
    ).not.toContainText('tool shed');
  });
}

test('a chooser with nothing to choose says so instead of showing a blank list', async ({
  page,
}) => {
  await page.goto('/?notes=empty');
  await page.locator('.context-disclosure > summary').press('Enter');
  const panel = page.getByRole('region', { name: 'Prior context' });
  await panel.getByRole('button', { name: 'Add notes from a file' }).click();
  const dialog = page.getByRole('dialog', { name: /Choose notes/ });
  await expect(dialog.getByRole('status')).toContainText(
    'This file has no notes with an id, a date, and text; nothing was imported.',
  );
  await expect(dialog.getByRole('checkbox')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: /Import/ })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
});

test('prior notes from a file are chosen, shown apart from the conversation, removable, and never exported', async ({
  page,
}) => {
  const panel = page.getByRole('region', { name: 'Prior context' });
  await expect(panel).toContainText('not from this conversation');
  await panel.getByRole('button', { name: 'Add notes from a file' }).click();
  const dialog = page.getByRole('dialog', { name: /Choose notes/ });
  await expect(dialog).toContainText('garden-notes.json');
  await expect(dialog.getByRole('checkbox')).toHaveCount(3);
  await expect(dialog.getByRole('button', { name: /Import/ })).toBeDisabled();
  // Nothing is ticked until the person chooses; Select all ticks every note
  // and turns into Clear all, and one note can still be left out.
  await dialog.getByRole('button', { name: 'Select all' }).click();
  await expect(
    dialog.getByRole('button', { name: 'Import 3 selected' }),
  ).toBeEnabled();
  await dialog.getByRole('button', { name: 'Clear all' }).click();
  await expect(dialog.getByRole('button', { name: /Import/ })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Select all' }).click();
  await dialog.getByRole('checkbox', { name: /Sign at the gate/ }).uncheck();
  await expect(
    dialog.getByRole('button', { name: 'Select all' }),
  ).toBeVisible();
  await dialog.getByRole('button', { name: 'Import 2 selected' }).click();
  await expect(dialog).toBeHidden();
  await expect(panel.getByRole('listitem')).toHaveCount(2);
  await expect(panel).toContainText('2026-10-28 · From a file');
  await expect(panel).toContainText(
    'Visitors asked where to find watering cans',
  );
  await panel
    .getByRole('button', { name: 'Remove Visitor questions (2026-11-02)' })
    .click();
  await expect(panel.getByRole('listitem')).toHaveCount(1);
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const exportDialog = page.getByRole('dialog', { name: 'Review your export' });
  await expect(exportDialog.locator('pre')).not.toContainText('tool shed');
  await page.keyboard.press('Escape');
  await expect(
    page.getByRole('region', { name: 'Suggested question' }),
  ).toHaveCount(0);
  // Importing the same notes again does not duplicate them.
  await panel.getByRole('button', { name: 'Add notes from a file' }).click();
  await dialog.getByRole('checkbox', { name: /Garden welcome guide/ }).check();
  await dialog.getByRole('button', { name: 'Import 1 selected' }).click();
  await expect(panel.getByRole('listitem')).toHaveCount(1);
  await expect(
    page.getByRole('status').filter({ hasText: 'already imported' }),
  ).toHaveCount(1);
  // Remove all clears every imported note at once. Focus only follows a
  // removal made from the focused control, and a pointer click focuses a
  // button on Linux but not in macOS WebKit, so activate it by keyboard.
  await panel.getByRole('button', { name: 'Remove all' }).press('Enter');
  await expect(panel.getByRole('listitem')).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Remove all' })).toHaveCount(
    0,
  );
  await expect(
    panel.getByRole('button', { name: 'Add notes from a file' }),
  ).toBeFocused();
  await expect(
    page.getByRole('status').filter({ hasText: '1 imported note removed.' }),
  ).toHaveCount(1);
  // Escape in the chooser leaves nothing pending and returns focus.
  await panel.getByRole('button', { name: 'Add notes from a file' }).click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(
    panel.getByRole('button', { name: 'Add notes from a file' }),
  ).toBeFocused();
  await expect(panel.getByRole('listitem')).toHaveCount(0);
});

test('starting the demo shows its conversation while notes remain available', async ({
  page,
}) => {
  await page
    .getByRole('textbox', { name: 'Meeting notes' })
    .fill('My fictional practice note.');
  await page.getByRole('button', { name: 'Try demo', exact: true }).click();
  await expect(page.getByRole('tab', { name: /Transcript/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.clock.runFor(8200);
  await expect(
    page.getByRole('tabpanel', { name: /Transcript/ }),
  ).toContainText('Someone can take the first draft');
  await page.getByRole('tab', { name: 'Notes', exact: true }).click();
  await expect(
    page.getByRole('textbox', { name: 'Meeting notes' }),
  ).toHaveValue('My fictional practice note.');
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(
    page.getByRole('tab', { name: 'Notes', exact: true }),
  ).toHaveAttribute('aria-selected', 'true');
});
