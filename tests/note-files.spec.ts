import { expect, test, type Page } from '@playwright/test';

// The browser preview stands in for the desktop file reader with fictional
// Markdown and plain-text files (src/lib/preview.ts). Rust tests cover how
// notes_file.rs reads real files: titles, dates, limits and refusals.

const panel = (page: Page) =>
  page.getByRole('region', { name: 'Prior context' });

async function chooseFile(page: Page, kind: string) {
  await page.clock.install();
  await page.goto(`/?notes=${kind}`);
  await page.locator('.context-disclosure > summary').press('Enter');
  await panel(page)
    .getByRole('button', { name: 'Add notes from a file' })
    .click();
}

test('a Markdown note without a date waits for the date the person enters, then is listed, removable, and never exported', async ({
  page,
}) => {
  await chooseFile(page, 'markdown');
  const dialog = page.getByRole('dialog', { name: /Choose notes/ });
  await expect(dialog).toContainText('Welcome guide printing.md');
  const note = dialog.getByRole('checkbox', {
    name: /Welcome guide printing/,
  });
  await expect(note).toHaveCount(1);
  await expect(note).not.toBeChecked();
  await expect(dialog).toContainText('No date in the file');
  const date = dialog.getByLabel('Date of Welcome guide printing');
  await expect(date).toHaveValue('');
  const importButton = dialog.getByRole('button', { name: /^Import/ });
  await expect(importButton).toBeDisabled();
  // Ticking the note is not enough: nothing guesses its date.
  await note.check();
  await expect(importButton).toBeDisabled();
  await expect(dialog.getByRole('status')).toContainText(
    'Enter the date of each ticked note that has none in the file. TalkQTE never guesses a date.',
  );
  await date.fill('2026-10-21');
  await expect(
    dialog.getByRole('button', { name: 'Import 1 selected' }),
  ).toBeEnabled();
  // Clearing the date, or a year the app cannot accept, holds the import.
  await date.fill('');
  await expect(importButton).toBeDisabled();
  await date.fill('1899-12-31');
  await expect(importButton).toBeDisabled();
  await date.fill('2026-10-21');
  await dialog.getByRole('button', { name: 'Import 1 selected' }).click();
  await expect(dialog).toBeHidden();
  const item = panel(page).getByRole('listitem');
  await expect(item).toHaveCount(1);
  await expect(item).toContainText('Welcome guide printing');
  await expect(item).toContainText('2026-10-21 · From a file');
  await expect(item).toContainText('print shop needs two days');
  await expect(panel(page)).toContainText('not from this conversation');
  await expect(
    page.getByRole('status').filter({ hasText: '1 imported.' }),
  ).toHaveCount(1);

  // Removing the note takes it off the list; export never includes it.
  await panel(page)
    .getByRole('button', {
      name: 'Remove Welcome guide printing (2026-10-21)',
      exact: true,
    })
    .click();
  await expect(panel(page).getByRole('listitem')).toHaveCount(0);
  await expect(panel(page)).toContainText('No prior notes selected.');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await expect(
    page.getByRole('dialog', { name: 'Review your export' }).locator('pre'),
  ).not.toContainText('print shop');
});

test('a date entered and then cancelled is not kept for the next pick', async ({
  page,
}) => {
  await chooseFile(page, 'markdown');
  const dialog = page.getByRole('dialog', { name: /Choose notes/ });
  await dialog
    .getByRole('checkbox', { name: /Welcome guide printing/ })
    .check();
  await dialog.getByLabel('Date of Welcome guide printing').fill('2026-10-21');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  await expect(panel(page).getByRole('listitem')).toHaveCount(0);
  await panel(page)
    .getByRole('button', { name: 'Add notes from a file' })
    .click();
  await expect(
    dialog.getByRole('checkbox', { name: /Welcome guide printing/ }),
  ).not.toBeChecked();
  await expect(dialog.getByLabel('Date of Welcome guide printing')).toHaveValue(
    '',
  );
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(
    panel(page).getByRole('button', { name: 'Add notes from a file' }),
  ).toBeFocused();
});

test('a plain-text note that states its date imports with that date and no date to enter', async ({
  page,
}) => {
  await chooseFile(page, 'text');
  const dialog = page.getByRole('dialog', { name: /Choose notes/ });
  await expect(dialog).toContainText('Tool shed rota.txt');
  await expect(dialog.getByRole('textbox')).toHaveCount(0);
  await expect(dialog.getByLabel(/^Date of/)).toHaveCount(0);
  await expect(dialog.locator('time')).toHaveText('2026-11-04');
  await dialog.getByRole('checkbox', { name: /Tool shed rota/ }).check();
  await dialog.getByRole('button', { name: 'Import 1 selected' }).click();
  await expect(dialog).toBeHidden();
  await expect(panel(page).getByRole('listitem')).toContainText(
    '2026-11-04 · From a file',
  );
  // Choosing the same file again keeps one copy.
  await panel(page)
    .getByRole('button', { name: 'Add notes from a file' })
    .click();
  await dialog.getByRole('checkbox', { name: /Tool shed rota/ }).check();
  await dialog.getByRole('button', { name: 'Import 1 selected' }).click();
  await expect(panel(page).getByRole('listitem')).toHaveCount(1);
  await expect(
    page.getByRole('status').filter({ hasText: '1 already imported.' }),
  ).toHaveCount(1);
  await panel(page).getByRole('button', { name: 'Remove all' }).press('Enter');
  await expect(panel(page).getByRole('listitem')).toHaveCount(0);
  await expect(
    page.getByRole('status').filter({ hasText: '1 imported note removed.' }),
  ).toHaveCount(1);
});

test('a TalkQTE JSON notes file states its dates and never asks for one', async ({
  page,
}) => {
  await chooseFile(page, 'json');
  const dialog = page.getByRole('dialog', { name: /Choose notes/ });
  await expect(dialog).toContainText('garden-notes.json');
  await expect(dialog.getByRole('checkbox')).toHaveCount(3);
  await expect(dialog.locator('time')).toHaveCount(3);
  await expect(dialog.getByLabel(/^Date of/)).toHaveCount(0);
  await expect(dialog).not.toContainText('No date in the file');
});

for (const [kind, message] of [
  ['too-large', 'That file is larger than 1 MB. Choose a smaller notes file.'],
  [
    'unsupported',
    'TalkQTE reads notes from a Markdown (.md) or plain-text (.txt) file, or a TalkQTE JSON notes file.',
  ],
]) {
  test(`a ${kind} file is refused with a plain message and nothing to choose`, async ({
    page,
  }) => {
    await chooseFile(page, kind);
    await expect(page.getByRole('alert')).toContainText(message);
    await expect(
      page.getByRole('dialog', { name: /Choose notes/ }),
    ).toBeHidden();
    await expect(panel(page).getByRole('listitem')).toHaveCount(0);
    await expect(panel(page)).toContainText('No prior notes selected.');
    await expect(panel(page)).toContainText(
      'A file can be one Markdown (.md) or plain-text (.txt) note',
    );
    await expect(
      panel(page).getByRole('button', { name: 'Add notes from a file' }),
    ).toBeEnabled();
  });
}
