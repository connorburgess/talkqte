import { expect, test, type Page } from '@playwright/test';
import type {} from './fixtures/native-microphone';
import type {} from './fixtures/native-meeting-history';

// Keeping a meeting after it ends. Every meeting here is fictional, and the
// stand-in writes nothing; storage itself is tested in Rust.

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

const LINE = 'Legal said the fictional review takes two days.';

async function endedSession(page: Page, application?: string) {
  await page.evaluate(
    async ({ text, application }) => {
      await window.liveTest.publish({
        live: true,
        status: 'running',
        transcript: [],
        cue: null,
      });
      await window.liveTest.publish({
        status: 'ended',
        elapsedMs: 1_800_000,
        notes: 'Ask about the orchard gate.',
        transcript: [{ id: 't1-0-0', atMs: 5_000, speaker: 'You', text }],
        sources: application
          ? { microphone: true, application }
          : { microphone: true },
        cue: null,
      });
    },
    { text: LINE, application },
  );
}

const offer = (page: Page) =>
  page.getByRole('region', { name: 'Keep this meeting?' });

test('nothing is kept unless the person chooses Keep for that meeting', async ({
  page,
}) => {
  await openNative(page);
  await expect(offer(page)).toHaveCount(0);
  await endedSession(page);
  await expect(offer(page)).toBeVisible();
  await expect(offer(page)).toContainText('Never its audio');
  const title = offer(page).getByRole('textbox', { name: 'Title' });
  await expect(title).toHaveValue(/^Meeting, /);
  // Not this one: nothing is written and the offer goes for this session.
  await offer(page).getByRole('button', { name: 'Not this one' }).click();
  await expect(offer(page)).toHaveCount(0);
  const keeps = await page.evaluate(() =>
    window.historyTest.calls.filter(
      (call) => call.command === 'keep_meeting_in_history',
    ),
  );
  expect(keeps).toEqual([]);
  expect(await page.evaluate(() => window.historyTest.meetings())).toEqual([]);
  // The next meeting is offered again.
  await endedSession(page);
  await expect(offer(page)).toBeVisible();
});

test('keeping uses the title typed, leaves the application name out unless chosen, and can add later notes', async ({
  page,
}) => {
  await openNative(page);
  await endedSession(page, 'Fictional Call');
  const title = offer(page).getByRole('textbox', { name: 'Title' });
  await title.fill('Orchard review');
  const name = offer(page).getByRole('checkbox', {
    name: 'Also keep the application’s name (Fictional Call)',
  });
  await expect(name).not.toBeChecked();
  await offer(page).getByRole('button', { name: 'Keep meeting' }).click();
  const kept = page.getByText('Kept in your meetings as “Orchard review”.');
  await expect(kept).toBeVisible();
  await expect(kept).toBeFocused();
  const [meeting] = await page.evaluate(() => window.historyTest.meetings());
  expect(meeting.title).toBe('Orchard review');
  expect(meeting.application).toBeUndefined();
  expect(meeting.sources).toBe('both');
  expect(meeting.transcript[0]).toMatchObject({ label: 'you', text: LINE });
  expect(meeting.notes).toBe('Ask about the orchard gate.');

  // Notes written after keeping are added only when the person updates it.
  await page.evaluate(() =>
    window.liveTest.publish({ notes: 'Ask about the orchard gate. And keys.' }),
  );
  const update = page.getByRole('button', { name: 'Update kept meeting' });
  await expect(update).toBeVisible();
  expect(
    (await page.evaluate(() => window.historyTest.meetings()))[0].notes,
  ).toBe('Ask about the orchard gate.');
  await update.click();
  await expect(update).toHaveCount(0);
  expect(
    (await page.evaluate(() => window.historyTest.meetings()))[0].notes,
  ).toBe('Ask about the orchard gate. And keys.');
});

test('the application name is kept only when the person ticks it', async ({
  page,
}) => {
  await openNative(page);
  await endedSession(page, 'Fictional Call');
  await offer(page)
    .getByRole('checkbox', {
      name: 'Also keep the application’s name (Fictional Call)',
    })
    .check();
  await offer(page).getByRole('button', { name: 'Keep meeting' }).click();
  await expect(page.getByText(/Kept in your meetings as/)).toBeVisible();
  const [meeting] = await page.evaluate(() => window.historyTest.meetings());
  expect(meeting.application).toBe('Fictional Call');
});

test('a failed keep says nothing was saved and can be tried again', async ({
  page,
}) => {
  await openNative(page);
  await endedSession(page);
  await page.evaluate(() =>
    window.historyTest.failNext(
      'The meeting could not be saved. Nothing was changed.',
    ),
  );
  await offer(page).getByRole('button', { name: 'Keep meeting' }).click();
  await expect(offer(page).getByRole('alert')).toHaveText(
    'The meeting could not be saved. Nothing was changed.',
  );
  await offer(page).getByRole('button', { name: 'Keep meeting' }).click();
  await expect(page.getByText(/Kept in your meetings as/)).toBeVisible();
});

test('turning the offer off in Settings stops the offer; Delete all asks first', async ({
  page,
}) => {
  await openNative(page);
  await page.evaluate(() =>
    window.historyTest.add({
      title: 'Fictional planning',
      startedAtMs: Date.UTC(2026, 10, 2, 9),
      durationMs: 600_000,
      sources: 'microphone',
      transcript: [{ atMs: 1_000, text: 'Hello.' }],
      notes: '',
      cues: [],
    }),
  );
  await page.getByRole('button', { name: 'Settings' }).click();
  const section = page.getByRole('region', { name: 'Kept meetings' });
  await expect(section).toContainText('stored unencrypted on this Mac');
  await expect(section).toContainText(
    '~/Library/Application Support/com.talkqte.desktop/meetings',
  );
  await expect(section).toContainText('1 meeting is kept.');
  const toggle = section.getByRole('checkbox', {
    name: 'Offer to keep each meeting',
  });
  await expect(toggle).toBeChecked();
  await toggle.uncheck();
  await expect(toggle).not.toBeChecked();

  await section.getByRole('button', { name: 'Delete all meetings…' }).click();
  const confirm = section.getByRole('group', {
    name: /Delete every kept meeting from this Mac\?/,
  });
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  expect(await page.evaluate(() => window.historyTest.meetings())).toHaveLength(
    1,
  );
  await section.getByRole('button', { name: 'Delete all meetings…' }).click();
  await confirm.getByRole('button', { name: 'Delete all meetings' }).click();
  await expect(section.getByRole('status')).toHaveText(
    'Every kept meeting was deleted.',
  );
  expect(await page.evaluate(() => window.historyTest.meetings())).toEqual([]);
  await expect(section).toContainText('No meetings are kept.');

  await page.getByRole('button', { name: 'Notebook' }).click();
  await endedSession(page);
  await expect(page.getByText(/Mic|Live session ended/).first()).toBeVisible();
  await expect(offer(page)).toHaveCount(0);
});

test('a lab run neither offers nor lists kept meetings', async ({ page }) => {
  await openNative(page);
  await page.evaluate(() => window.historyTest.setAvailability('labRun'));
  await endedSession(page);
  await expect(page.getByText('Live session ended').first()).toBeVisible();
  await expect(offer(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(
    page.getByRole('region', { name: 'Kept meetings' }),
  ).toContainText('This is a lab run: kept meetings are not read or written.');
});
