import { expect, test, type Page } from '@playwright/test';
import type {} from './fixtures/native-microphone';
import type {} from './fixtures/native-meeting-notes';

async function openNative(page: Page) {
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
  await page.goto('/');
}

const LINE = 'The fictional greenhouse keys are in the blue tin.';

async function session(page: Page, status: 'running' | 'ended') {
  await page.evaluate(
    ([text, status]) =>
      window.liveTest.publish({
        live: true,
        status: status as 'running' | 'ended',
        transcript: [{ id: 't1-0-0', atMs: 5_000, speaker: 'Speaker', text }],
        cue: null,
        meetingNotes: 'none',
      }),
    [LINE, status],
  );
}

const notesSection = (page: Page) =>
  page.getByRole('region', { name: 'Meeting notes', exact: true });
const writeButton = (page: Page) =>
  page.getByRole('button', { name: 'Generate notes' });
const commands = (page: Page) =>
  page.evaluate(() =>
    window.meetingNotesTest.calls.map((call) => call.command),
  );

test('offered only after a session ends, with an optional Include my notes checkbox', async ({
  page,
}) => {
  await openNative(page);
  await expect(writeButton(page)).toHaveCount(0);
  await session(page, 'running');
  await expect(writeButton(page)).toHaveCount(0);
  await session(page, 'ended');
  await expect(writeButton(page)).toBeVisible();
  const include = notesSection(page).getByRole('checkbox', {
    name: 'Include my notes',
  });
  await expect(include).not.toBeChecked();
  expect(await commands(page)).not.toContain('write_meeting_notes');
});

test('generated notes are checked, editable and join the export only when kept', async ({
  page,
}) => {
  await openNative(page);
  await session(page, 'ended');
  await page.evaluate(() => window.meetingNotesTest.hold());
  await writeButton(page).click();
  await expect(notesSection(page).getByRole('status')).toContainText(
    'Writing meeting notes…',
  );
  await page.evaluate(() => window.meetingNotesTest.release());
  const editor = page.getByRole('textbox', { name: 'Notes to keep, editable' });
  await expect(editor).toHaveValue(/Owner: not stated\. Due: not stated\./);
  await expect(
    page.getByRole('heading', { name: 'Check, edit, then keep or discard' }),
  ).toBeFocused();
  await expect(notesSection(page)).toContainText(
    'Estimated cost: about $0.04.',
  );
  await page.getByText('Where each item came from').click();
  await expect(notesSection(page)).toContainText(`transcript 00:05 “${LINE}”`);
  // Not in the export before it is kept.
  await page
    .getByRole('button', { name: 'Export Markdown…', exact: true })
    .click();
  const exportDialog = page.getByRole('dialog', { name: 'Review your export' });
  await expect(exportDialog.locator('pre')).not.toContainText(
    '## Meeting notes',
  );
  await page.keyboard.press('Escape');
  await editor.fill(
    (await editor.inputValue()).replace(
      'Return the keys',
      'Return the spare keys',
    ),
  );
  await page.getByRole('button', { name: 'Keep with this meeting' }).click();
  await expect(notesSection(page)).toContainText('Notes kept.');
  await expect(writeButton(page)).toHaveCount(0);
  await page
    .getByRole('button', { name: 'Export Markdown…', exact: true })
    .click();
  await expect(exportDialog.locator('pre')).toContainText(
    'Return the spare keys to the blue tin. Owner: not stated.',
  );
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Remove kept notes' }).click();
  await expect(notesSection(page)).toContainText('Notes discarded.');
  await expect(writeButton(page)).toHaveCount(0);
  expect(
    (await commands(page)).filter((name) => name === 'write_meeting_notes'),
  ).toHaveLength(1);
});

test('a failed request is shown as failed and not offered again', async ({
  page,
}) => {
  await openNative(page);
  await session(page, 'ended');
  await page.evaluate(() =>
    window.meetingNotesTest.failNext(
      'The notes that came back failed a check (an action item named an owner that its lines do not mention), so none are shown. No notes were written, and nothing else will be sent for this meeting.',
    ),
  );
  await writeButton(page).click();
  await expect(notesSection(page).getByRole('alert')).toContainText(
    'an action item named an owner that its lines do not mention',
  );
  await expect(
    page.getByRole('textbox', { name: 'Notes to keep, editable' }),
  ).toHaveCount(0);
  await expect(writeButton(page)).toHaveCount(0);
});

test('a key problem sends nothing and leaves the request available', async ({
  page,
}) => {
  await openNative(page);
  await session(page, 'ended');
  await page.evaluate(() =>
    window.meetingNotesTest.refuseNext(
      'Add your Anthropic API key in Settings to write meeting notes. Nothing was sent.',
    ),
  );
  await writeButton(page).click();
  await expect(notesSection(page).getByRole('alert')).toContainText(
    'Nothing was sent.',
  );
  await expect(writeButton(page)).toBeVisible();
});

test('a new session clears the notes and offers the request again', async ({
  page,
}) => {
  await openNative(page);
  await session(page, 'ended');
  await writeButton(page).click();
  await expect(
    page.getByRole('textbox', { name: 'Notes to keep, editable' }),
  ).toBeVisible();
  await page.evaluate(() => window.meetingNotesTest.reset());
  await session(page, 'running');
  await expect(notesSection(page)).toHaveCount(0);
  await session(page, 'ended');
  await expect(writeButton(page)).toBeVisible();
});

test('the notes model is a plain setting with a careful default', async ({
  page,
}) => {
  await openNative(page);
  await page.getByRole('button', { name: 'Settings' }).first().click();
  const choice = page.getByRole('combobox', {
    name: 'Model for meeting notes',
  });
  await expect(choice).toHaveValue('claude-opus-5-5');
  await choice.selectOption('claude-sonnet-5-5');
  await expect(choice).toHaveValue('claude-sonnet-5-5');
  expect(
    await page.evaluate(() =>
      window.meetingNotesTest.calls.find(
        (call) => call.command === 'set_meeting_notes_model',
      ),
    ),
  ).toEqual({
    command: 'set_meeting_notes_model',
    args: { model: 'claude-sonnet-5-5' },
  });
});

test('fits a narrow window', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openNative(page);
  await session(page, 'ended');
  await expect(writeButton(page)).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

test('Stop waiting before anything is sent leaves the request available', async ({
  page,
}) => {
  await openNative(page);
  await session(page, 'ended');
  // The request is held as if the Keychain were still being read.
  await page.evaluate(() => window.meetingNotesTest.hold());
  await writeButton(page).click();
  await page.getByRole('button', { name: 'Stop waiting' }).click();
  await expect(notesSection(page).getByRole('alert')).toContainText(
    'Stopped before anything was sent. Nothing was sent.',
  );
  await expect(writeButton(page)).toBeVisible();
});

test('includes edited notes when Include my notes is checked', async ({
  page,
}) => {
  await openNative(page);
  await session(page, 'ended');
  await page.evaluate(() =>
    window.liveTest.publish({
      notes: 'Fictional first line\nFictional second line',
    }),
  );
  await notesSection(page)
    .getByRole('checkbox', { name: 'Include my notes' })
    .check();
  await writeButton(page).click();
  await expect(
    page.getByRole('textbox', { name: 'Notes to keep, editable' }),
  ).toBeVisible();
  const writeCall = await page.evaluate(() =>
    window.meetingNotesTest.calls.find(
      (call) => call.command === 'write_meeting_notes',
    ),
  );
  expect(writeCall?.args).toMatchObject({ includeNotes: true });
});

test('uses the selected provider and omits cost estimates for custom notes models', async ({
  page,
}) => {
  await openNative(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByLabel('Cue & notes provider').selectOption('openai');
  await page
    .getByLabel('Custom meeting notes model ID (optional)')
    .fill('gpt-5.4-codex');
  await page.getByRole('button', { name: 'Save notes model' }).click();
  await expect(
    page.getByText('Custom meeting notes model saved: gpt-5.4-codex.'),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Notebook', exact: true }).click();
  await session(page, 'ended');
  await writeButton(page).click();

  await expect(notesSection(page)).toContainText(
    'Estimated cost unavailable for custom model; check OpenAI Platform.',
  );
});
