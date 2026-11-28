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
    .getByRole('button', { name: 'Add notes from files' })
    .click();
}

test('an optional entered source date is preserved, removable, and never exported', async ({
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
  await expect(dialog).toContainText('Unknown date');
  const date = dialog.getByLabel('Date of Welcome guide printing');
  await expect(date).toHaveValue('');
  const importButton = dialog.getByRole('button', { name: /^Import/ });
  await expect(importButton).toBeDisabled();
  // Undated references can import without inventing a source date.
  await note.check();
  await expect(importButton).toBeEnabled();
  await date.fill('2026-10-21');
  await expect(
    dialog.getByRole('button', { name: 'Import 1 selected' }),
  ).toBeEnabled();
  // Clearing a date keeps it unknown; an invalid nonempty date blocks import.
  await date.fill('');
  await expect(importButton).toBeEnabled();
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
  await expect(panel(page)).toContainText('excluded from Markdown exports');
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
  await expect(panel(page)).toContainText('0 notes selected');
  await page
    .getByRole('textbox', { name: 'Meeting notes', exact: true })
    .fill('Fictional note without prior context.');
  await page
    .getByRole('button', { name: 'Export Markdown…', exact: true })
    .click();
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
    .getByRole('button', { name: 'Add notes from files' })
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
    panel(page).getByRole('button', { name: 'Add notes from files' }),
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
    .getByRole('button', { name: 'Add notes from files' })
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
  await expect(dialog.locator('.context-choices')).not.toContainText(
    'Unknown date',
  );
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
    await expect(panel(page)).toContainText('0 notes selected');
    await expect(panel(page)).toContainText(
      'add a Markdown (.md), text (.txt), or TalkQTE JSON notes file',
    );
    await expect(
      panel(page).getByRole('button', { name: 'Add notes from files' }),
    ).toBeEnabled();
  });
}

test('local path fallback lists notes without importing and clears the transient path', async ({
  page,
}) => {
  await page.goto('/?notes=markdown');
  await page.locator('.context-disclosure > summary').press('Enter');
  await panel(page)
    .getByRole('button', { name: 'Use a local file path' })
    .click();
  const input = panel(page).getByLabel('Local notes file path');
  await expect(panel(page)).toContainText('excluded from Markdown exports');
  await expect(panel(page)).toContainText(
    'Review and approve them separately before sending them to a cue provider.',
  );
  await input.fill('/fictional/notes.md');
  await panel(page).getByRole('button', { name: 'Cancel file path' }).click();
  await panel(page)
    .getByRole('button', { name: 'Use a local file path' })
    .click();
  await expect(input).toHaveValue('');
  await input.fill('/fictional/notes.md');
  await panel(page).getByRole('button', { name: 'Read notes file' }).click();
  const dialog = page.getByRole('dialog', { name: /Choose notes/ });
  await expect(dialog).toContainText('Welcome guide printing.md');
  await expect(dialog.getByRole('checkbox')).not.toBeChecked();
  await expect(dialog.getByRole('button', { name: /^Import/ })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(panel(page).getByRole('listitem')).toHaveCount(0);
});

test('an undated reference imports explicitly unknown without a date or processing approval', async ({
  page,
}) => {
  await chooseFile(page, 'markdown');
  const dialog = page.getByRole('dialog', { name: /Choose notes/ });
  await dialog
    .getByRole('checkbox', { name: /Welcome guide printing/ })
    .check();
  await expect(dialog.getByLabel('Date of Welcome guide printing')).toHaveValue(
    '',
  );
  await dialog.getByRole('button', { name: 'Import 1 selected' }).click();
  await expect(dialog).toBeHidden();
  await expect(panel(page).getByRole('listitem')).toContainText(
    'Unknown date · From a file',
  );
  await expect(panel(page).getByRole('listitem')).not.toContainText('2026-');
  await expect(
    panel(page).getByRole('button', {
      name: 'Remove Welcome guide printing (Unknown date)',
      exact: true,
    }),
  ).toBeVisible();
});

test('a fictional file batch reports each failure and imports only explicitly ticked readable notes', async ({
  page,
}) => {
  await chooseFile(page, 'batch');
  const dialog = page.getByRole('dialog', {
    name: /Choose notes from 3 files/,
  });
  await expect(
    dialog.getByRole('list', { name: 'Selected file results' }),
  ).toContainText('Unreadable.md');
  await expect(dialog).toContainText('The file could not be read.');
  await expect(dialog.getByRole('checkbox')).toHaveCount(2);
  await expect(dialog.getByRole('button', { name: /^Import/ })).toBeDisabled();
  await dialog
    .getByRole('checkbox', { name: /Welcome guide printing/ })
    .check();
  await dialog.getByRole('button', { name: 'Import 1 selected' }).click();
  await expect(panel(page).getByRole('listitem')).toHaveCount(1);
  await expect(panel(page)).toContainText('Unknown date · From a file');
  await expect(panel(page)).not.toContainText('Tool shed rota');
});
