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

test('Meetings lists kept meetings newest first, searches by text, and opens read-only', async ({
  page,
}) => {
  await openNative(page);
  await page.evaluate(() => {
    window.historyTest.add({
      title: 'Gate sign options',
      startedAtMs: Date.UTC(2026, 10, 2, 9),
      durationMs: 600_000,
      sources: 'microphone',
      transcript: [{ atMs: 1_000, text: 'The painted sign costs less.' }],
      notes: 'Measure the north post.',
      cues: [],
    });
    window.historyTest.add({
      title: 'Orchard rota planning',
      startedAtMs: Date.UTC(2026, 10, 3, 14),
      durationMs: 1_800_000,
      sources: 'both',
      application: 'Fictional Call',
      transcribedBy: 'Deepgram',
      transcript: [
        { atMs: 2_000, label: 'you', text: 'Can we ship the rota Friday?' },
        {
          atMs: 3_000,
          label: 'you',
          echo: true,
          text: 'Legal said review takes two days.',
        },
        {
          atMs: 3_100,
          label: 'them',
          text: 'Legal said review takes two days.',
        },
      ],
      notes: 'Bring the orchard key.',
      cues: [
        {
          atMs: 4_000,
          kind: 'Timing',
          question: 'Will the draft be ready Wednesday?',
          evidence: 'Legal said review takes two days.',
        },
      ],
      meetingNotes: '## Summary\n\n- Review takes two days.',
    });
  });

  await page.getByRole('button', { name: 'Meetings', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Kept meetings', level: 1 }),
  ).toBeVisible();

  const list = page.getByRole('list', { name: 'Kept meetings' });
  const items = list.getByRole('button');
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toContainText('Orchard rota planning');
  await expect(items.nth(0)).toContainText('Meeting notes');
  await expect(items.nth(1)).toContainText('Gate sign options');

  const search = page.getByRole('searchbox', { name: 'Search kept meetings' });
  await search.fill('painted');
  await expect(items).toHaveCount(1);
  await expect(items.nth(0)).toContainText('Gate sign options');

  await search.fill('nothing-matches');
  await expect(
    page.getByText('No kept meetings match “nothing-matches”.'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Clear search' }).click();
  await expect(items).toHaveCount(2);

  await items.nth(0).click();
  await expect(
    page.getByRole('heading', { name: 'Orchard rota planning', level: 1 }),
  ).toBeVisible();
  await expect(page.getByText('Microphone and Fictional Call')).toBeVisible();
  await expect(page.getByText('Transcribed by Deepgram')).toBeVisible();
  await expect(page.getByText('Bring the orchard key.')).toBeVisible();
  await expect(
    page
      .getByRole('region', { name: 'Meeting notes' })
      .getByText('Review takes two days.'),
  ).toBeVisible();
  await expect(
    page.getByText('Will the draft be ready Wednesday?'),
  ).toBeVisible();
  await expect(page.getByText('Likely echo')).toBeVisible();
  await expect(page.getByText('Can we ship the rota Friday?')).toBeVisible();
  // Read-only detail view has no editor textarea for notes or transcript.
  await expect(page.locator('textarea')).toHaveCount(0);
});

test('Meetings renames, exports the reviewed Markdown, and deletes with confirmation', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openNative(page);
  await page.evaluate(() => {
    window.historyTest.add({
      title: 'Fictional planning',
      startedAtMs: Date.UTC(2026, 10, 4, 10),
      durationMs: 900_000,
      sources: 'microphone',
      transcribedBy: 'Deepgram',
      transcript: [{ atMs: 1_500, text: 'The keys are in the blue tin.' }],
      notes: 'Check the blue tin.',
      cues: [],
    });
  });

  await page.getByRole('button', { name: 'Meetings', exact: true }).click();
  await page.getByRole('button', { name: /Fictional planning/ }).click();

  await page.getByRole('button', { name: 'Rename', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Meeting title' })
    .fill('Blue tin sync');
  await page.getByRole('button', { name: 'Save title', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Blue tin sync', level: 1 }),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Export…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Review your export' });
  await expect(dialog).toBeVisible();
  const preview = (await dialog.locator('pre').textContent()) ?? '';
  expect(preview).toContain('# Blue tin sync');
  expect(preview).toContain('Check the blue tin.');
  expect(preview).toContain('The keys are in the blue tin.');
  await dialog
    .getByRole('button', { name: 'Choose destination', exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(() => window.historyTest.exports())).toEqual([
    preview,
  ]);

  await page
    .getByRole('button', { name: 'Delete meeting…', exact: true })
    .click();
  const confirm = page.getByRole('group', {
    name: /Delete “Blue tin sync” from this Mac\?/,
  });
  await confirm.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Blue tin sync', level: 1 }),
  ).toBeVisible();

  await page
    .getByRole('button', { name: 'Delete meeting…', exact: true })
    .click();
  await confirm
    .getByRole('button', { name: 'Delete meeting', exact: true })
    .click();
  await expect(page.getByText('No meetings kept yet.')).toBeVisible();
  expect(await page.evaluate(() => window.historyTest.meetings())).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test('Meetings discloses unreadable entries, lab runs, and newer versions', async ({
  page,
}) => {
  await openNative(page);
  await page.evaluate(() => window.historyTest.setUnreadable(2));
  await page.getByRole('button', { name: 'Meetings', exact: true }).click();
  await expect(
    page.getByText(
      '2 kept meetings could not be read and were left untouched.',
    ),
  ).toBeVisible();

  await page.evaluate(() => window.historyTest.setAvailability('newer'));
  await page.getByRole('button', { name: 'Notebook', exact: true }).click();
  await page.getByRole('button', { name: 'Meetings', exact: true }).click();
  await expect(
    page.getByText(
      'Your kept meetings were saved by a newer version of TalkQTE.',
    ),
  ).toBeVisible();

  await page.evaluate(() => window.historyTest.setAvailability('labRun'));
  await page.getByRole('button', { name: 'Notebook', exact: true }).click();
  await page.getByRole('button', { name: 'Meetings', exact: true }).click();
  await expect(
    page.getByText('This is a lab run: kept meetings are not read or written.'),
  ).toBeVisible();
});
