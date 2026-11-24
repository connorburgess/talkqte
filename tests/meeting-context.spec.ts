import { expect, test, type Page } from '@playwright/test';
import type {} from './fixtures/native-microphone';
import type {} from './fixtures/native-meeting-history';

// Kept meetings as prior context. Every meeting is fictional; the stand-in
// contacts nothing. What reaches a cue model is tested in Rust.

async function open(page: Page, query = '?keys=set') {
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
  await page.goto(`/${query}`);
  await page.evaluate(() => {
    window.historyTest.add({
      title: 'Welcome pack review',
      startedAtMs: Date.UTC(2026, 10, 20, 9),
      durationMs: 1_800_000,
      sources: 'microphone',
      transcript: [
        { atMs: 1_000, text: 'The fictional padlock code is 4417.' },
      ],
      notes: 'Ask whether Friday still works.',
      cues: [],
      meetingNotes: '## Decisions\n\n- Legal said review takes two days.',
    });
    window.historyTest.add({
      title: 'Nothing written down',
      startedAtMs: Date.UTC(2026, 10, 21, 9),
      durationMs: 600_000,
      sources: 'microphone',
      transcript: [{ atMs: 1_000, text: 'Hello.' }],
      notes: '',
      cues: [],
    });
  });
}

const context = (page: Page) =>
  page.getByRole('region', { name: 'Prior context' });

async function chooseMeeting(page: Page) {
  await context(page).locator('summary').click();
  await context(page)
    .getByRole('button', { name: 'Choose kept meetings' })
    .click();
  const chooser = page.getByRole('dialog', {
    name: 'Choose notes from your kept meetings',
  });
  await expect(chooser).toContainText('never its transcript');
  await expect(chooser.getByRole('checkbox')).toHaveCount(1);
  await expect(chooser).not.toContainText('padlock');
  await expect(chooser).not.toContainText('Nothing written down');
  await chooser.getByRole('checkbox', { name: /Welcome pack review/ }).check();
  await chooser.getByRole('button', { name: /Import/ }).click();
  await expect(chooser).not.toBeVisible();
}

test('a kept meeting is chosen as prior context through the same chooser, bringing its notes only', async ({
  page,
}) => {
  await open(page);
  await chooseMeeting(page);
  const item = context(page).getByRole('listitem');
  await expect(item).toContainText('Welcome pack review');
  await expect(item).toContainText(
    '2026-11-20 · From a kept meeting: its meeting notes and your notes',
  );
  await expect(item).toContainText('Legal said review takes two days.');
  await expect(item).toContainText('Ask whether Friday still works.');
  await expect(item).not.toContainText('padlock');
});

test('the review shows exactly what a chosen meeting would send, and nothing unless it is selected', async ({
  page,
}) => {
  await open(page, '?live&processor&hosted&keys=set');
  await chooseMeeting(page);
  const [meeting] = await page.evaluate(() =>
    window.historyTest
      .meetings()
      .filter((m) => m.title === 'Welcome pack review'),
  );
  // The processing snapshot lists the imported meeting as a prior note.
  await page.evaluate((id) => {
    const state = window.captureTest.state();
    return window.captureTest.send({
      notes: [
        ...state.notes,
        {
          provider: 'meeting',
          sourceId: id,
          revision: 1,
          title: 'Welcome pack review',
          sourceDate: '2026-11-20',
        },
      ],
    });
  }, meeting.id);
  await page
    .getByRole('button', { name: 'Start live session', exact: true })
    .click();
  const panel = page.getByRole('region', {
    name: 'Cue processing',
    exact: true,
  });
  await panel
    .getByRole('button', { name: 'Review processing', exact: true })
    .click();
  const choice = panel.getByRole('checkbox', { name: /Welcome pack review/ });
  await expect(choice).not.toBeChecked();
  await expect(panel).toContainText('Kept meeting · 2026-11-20 · prior note');

  // Not selected: the review lists no meeting text.
  await panel.getByRole('button', { name: 'Review selected sources' }).click();
  await expect(
    panel.getByRole('heading', { name: 'Review before enabling' }),
  ).toBeFocused();
  await expect(panel).not.toContainText('Legal said review takes two days.');
  await panel.getByRole('button', { name: 'Cancel', exact: true }).click();

  // Selected: the review shows the exact, bounded text it would send.
  await panel
    .getByRole('button', { name: 'Review processing', exact: true })
    .click();
  await panel.getByRole('checkbox', { name: /Welcome pack review/ }).check();
  await panel.getByRole('button', { name: 'Review selected sources' }).click();
  const sent = panel.locator('.processing-meeting-text');
  await expect(sent).toContainText(
    'Sends from this meeting its meeting notes and your notes, never its transcript',
  );
  await expect(sent.locator('pre')).toHaveText(
    'Meeting notes:\n## Decisions\n\n- Legal said review takes two days.\n\nYour notes:\nAsk whether Friday still works.',
  );
  await expect(sent).not.toContainText('padlock');
  const reviews = await page.evaluate(() =>
    window.permissionTest.calls.filter(
      (call) => call.command === 'review_processing_scope',
    ),
  );
  expect(reviews.at(-1)!.args).toMatchObject({
    scope: {
      notes: [{ provider: 'meeting', sourceId: meeting.id, revision: 1 }],
    },
  });
});

test('a connection that takes no prior notes says a chosen meeting stays on this Mac', async ({
  page,
}) => {
  await open(page, '?live&processor&keys=set');
  await chooseMeeting(page);
  await page.evaluate(() => {
    const state = window.captureTest.state();
    return window.captureTest.send({
      processor: { ...state.processor!, acceptsNotes: false },
    });
  });
  await page
    .getByRole('button', { name: 'Start live session', exact: true })
    .click();
  const panel = page.getByRole('region', {
    name: 'Cue processing',
    exact: true,
  });
  await panel
    .getByRole('button', { name: 'Review processing', exact: true })
    .click();
  await expect(panel).toContainText(
    'Prior notes are never sent to this processor. Kept meetings you chose stay on this Mac.',
  );
});

test('deleting a kept meeting removes it from prior context', async ({
  page,
}) => {
  await open(page);
  await chooseMeeting(page);
  await expect(context(page).getByRole('listitem')).toHaveCount(1);
  await page.getByRole('button', { name: 'Meetings', exact: true }).click();
  await page
    .getByRole('list', { name: 'Kept meetings' })
    .getByRole('button', { name: /^Welcome pack review/ })
    .click();
  await page.getByRole('button', { name: 'Delete…' }).click();
  await page.getByRole('button', { name: 'Delete meeting' }).click();
  await page.getByRole('button', { name: 'Notebook', exact: true }).click();
  await expect(context(page).getByRole('listitem')).toHaveCount(0);
});
