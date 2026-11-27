import AxeBuilder from '@axe-core/playwright';
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
const keepSelect = (page: Page) =>
  page
    .getByRole('region', { name: 'Meetings' })
    .getByRole('combobox', { name: 'After a live session ends' });

test('non-empty live sessions auto-save by default without keeping the application name', async ({
  page,
}) => {
  await openNative(page);
  await expect(offer(page)).toHaveCount(0);
  await endedSession(page, 'Fictional Call');
  await expect(page.getByText(/Saved to Meetings as “Meeting, /)).toBeVisible();
  const [meeting] = await page.evaluate(() => window.historyTest.meetings());
  expect(meeting).toBeTruthy();
  expect(meeting.title).toMatch(/^Meeting, /);
  expect(meeting.application).toBeUndefined();
  expect(meeting.sources).toBe('both');
  expect(meeting.transcript[0]).toMatchObject({ label: 'you', text: LINE });
  expect(meeting.notes).toBe('Ask about the orchard gate.');

  // Notes written after stopping are added only when the person updates it.
  await page.evaluate(() =>
    window.liveTest.publish({ notes: 'Ask about the orchard gate. And keys.' }),
  );
  const update = page.getByRole('button', { name: 'Update saved meeting' });
  await expect(update).toBeVisible();
  await update.click();
  await expect(update).toHaveCount(0);
  expect(
    (await page.evaluate(() => window.historyTest.meetings()))[0].notes,
  ).toBe('Ask about the orchard gate. And keys.');
});

test('under Ask mode, nothing is kept unless the person chooses Keep for that meeting', async ({
  page,
}) => {
  await openNative(page);
  await page.evaluate(() => window.historyTest.setAfterSessionKeep('ask'));
  await expect(offer(page)).toHaveCount(0);
  await endedSession(page);
  await expect(offer(page)).toBeVisible();
  await expect(offer(page)).toContainText('never audio');
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

test('keeping in Ask mode uses the title typed, leaves the application name out unless chosen, and can add later notes', async ({
  page,
}) => {
  await openNative(page);
  await page.evaluate(() => window.historyTest.setAfterSessionKeep('ask'));
  await endedSession(page, 'Fictional Call');
  const title = offer(page).getByRole('textbox', { name: 'Title' });
  await title.fill('Orchard review');
  const name = offer(page).getByRole('checkbox', {
    name: 'Include application name (Fictional Call)',
  });
  await expect(name).not.toBeChecked();
  await offer(page).getByRole('button', { name: 'Keep meeting' }).click();
  const kept = page.getByText('Saved to Meetings as “Orchard review”.');
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
  const update = page.getByRole('button', { name: 'Update saved meeting' });
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

test('the application name is kept only when the person ticks it in Ask mode', async ({
  page,
}) => {
  await openNative(page);
  await page.evaluate(() => window.historyTest.setAfterSessionKeep('ask'));
  await endedSession(page, 'Fictional Call');
  await offer(page)
    .getByRole('checkbox', {
      name: 'Include application name (Fictional Call)',
    })
    .check();
  await offer(page).getByRole('button', { name: 'Keep meeting' }).click();
  await expect(page.getByText(/Saved to Meetings as/)).toBeVisible();
  const [meeting] = await page.evaluate(() => window.historyTest.meetings());
  expect(meeting.application).toBe('Fictional Call');
});

test('a failed keep says nothing was saved and can be tried again', async ({
  page,
}) => {
  await openNative(page);
  await page.evaluate(() => window.historyTest.setAfterSessionKeep('ask'));
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
  await expect(page.getByText(/Saved to Meetings as/)).toBeVisible();
});

test('choosing Don’t keep in Settings stops auto-saving and offers; Delete all asks first', async ({
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
  await page
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('link', { name: 'Meetings & storage', exact: true })
    .click();
  const section = page.getByRole('region', { name: 'Meetings' });
  await expect(section).toContainText('Stored unencrypted in');
  await expect(section).toContainText(
    '~/Library/Application Support/com.talkqte.desktop/meetings',
  );
  await expect(section).toContainText('1 saved meeting.');
  await expect(keepSelect(page)).toHaveValue('auto');
  await keepSelect(page).selectOption('ask');
  await expect(keepSelect(page)).toHaveValue('ask');
  await keepSelect(page).selectOption('off');
  await expect(keepSelect(page)).toHaveValue('off');

  await section.getByRole('button', { name: 'Delete all meetings…' }).click();
  const confirm = section.getByRole('group', {
    name: /Delete all saved meetings from this Mac\?/,
  });
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  expect(await page.evaluate(() => window.historyTest.meetings())).toHaveLength(
    1,
  );
  await section.getByRole('button', { name: 'Delete all meetings…' }).click();
  await confirm.getByRole('button', { name: 'Delete all meetings' }).click();
  await expect(section.getByRole('status')).toHaveText(
    'All saved meetings deleted.',
  );
  expect(await page.evaluate(() => window.historyTest.meetings())).toEqual([]);
  await expect(section).toContainText('No saved meetings.');

  await page.getByRole('button', { name: 'Notebook' }).click();
  await endedSession(page);
  await expect(page.getByText(/Mic|Live session ended/).first()).toBeVisible();
  await expect(offer(page)).toHaveCount(0);
  expect(await page.evaluate(() => window.historyTest.meetings())).toEqual([]);
});

test('a lab run neither offers nor lists kept meetings', async ({ page }) => {
  await openNative(page);
  await page.evaluate(() => window.historyTest.setAvailability('labRun'));
  await endedSession(page);
  await expect(page.getByText('Live session ended').first()).toBeVisible();
  await expect(offer(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'Settings' }).click();
  await page
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('link', { name: 'Meetings & storage', exact: true })
    .click();
  await expect(page.getByRole('region', { name: 'Meetings' })).toContainText(
    'Lab runs don’t read or save meetings.',
  );
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
    page.getByRole('heading', { name: 'Meetings', level: 1 }),
  ).toBeVisible();

  const list = page.getByRole('list', { name: 'Meetings' });
  const items = list.locator('.history-item');
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toContainText('Orchard rota planning');
  await expect(items.nth(0)).toContainText('Meeting notes');
  await expect(items.nth(1)).toContainText('Gate sign options');

  const search = page.getByRole('searchbox', { name: 'Search meetings' });
  await search.fill('painted');
  await expect(items).toHaveCount(1);
  await expect(items.nth(0)).toContainText('Gate sign options');

  await search.fill('nothing-matches');
  await expect(
    page.getByText('No meetings match “nothing-matches”.'),
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
  await expect(
    page.getByRole('heading', { name: 'Transcript (2)', level: 2 }),
  ).toBeVisible();
  await expect(page.getByText('Likely echo', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Can we ship the rota Friday?')).toBeVisible();
  const echoToggle = page.getByRole('button', {
    name: 'Show 1 likely echo line',
  });
  await expect(echoToggle).toHaveAttribute('aria-expanded', 'false');
  await echoToggle.click();
  await expect(page.getByText('Likely echo', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Hide 1 likely echo line' }).click();
  await expect(page.getByText('Likely echo', { exact: true })).toHaveCount(0);
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
  await page.getByRole('button', { name: /^Fictional planning/ }).click();

  await page.getByRole('button', { name: 'Rename', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Meeting title' })
    .fill('Blue tin sync');
  await page.getByRole('button', { name: 'Save title', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Blue tin sync', level: 1 }),
  ).toBeVisible();

  await page
    .getByRole('button', { name: 'Export Markdown…', exact: true })
    .click();
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
  await expect(page.getByText('No meetings yet.')).toBeVisible();
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
    page.getByText('2 meetings could not be read and were left untouched.'),
  ).toBeVisible();

  await page.evaluate(() => window.historyTest.setAvailability('newer'));
  await page.getByRole('button', { name: 'Notebook', exact: true }).click();
  await page.getByRole('button', { name: 'Meetings', exact: true }).click();
  await expect(
    page.getByText('Your meetings were saved by a newer version of TalkQTE'),
  ).toBeVisible();

  await page.evaluate(() => window.historyTest.setAvailability('labRun'));
  await page.getByRole('button', { name: 'Notebook', exact: true }).click();
  await page.getByRole('button', { name: 'Meetings', exact: true }).click();
  await expect(
    page.getByText('Lab runs don’t read or save meetings.'),
  ).toBeVisible();
});

test('kept meetings can be selected into Prior context (notes only), approved in session review, and cited on cues', async ({
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
  await page.goto('/?live&processor&keys=set');

  const id = await page.evaluate(() => {
    window.historyTest.add({
      title: 'Empty notes meeting',
      startedAtMs: Date.UTC(2026, 10, 1, 9),
      durationMs: 300_000,
      sources: 'microphone',
      transcript: [{ atMs: 1_000, text: 'Secret empty-notes transcript.' }],
      notes: '   ',
      cues: [],
    });
    return window.historyTest.add({
      title: 'Orchard supplier sync',
      startedAtMs: Date.UTC(2026, 10, 2, 10),
      durationMs: 900_000,
      sources: 'microphone',
      transcript: [
        { atMs: 1_000, text: 'Secret transcript line that must stay out.' },
      ],
      notes: 'Check gate hinge bolts.',
      cues: [],
      meetingNotes: '## Decisions\n\n- Legal needs two days for review.',
    });
  });

  const context = page.getByRole('region', { name: 'Prior context' });
  await context.locator('summary').click();
  await context
    .getByRole('button', { name: 'Choose kept meetings', exact: true })
    .click();

  const chooser = page.getByRole('dialog', {
    name: /Choose notes from kept meetings/,
  });
  await expect(chooser).toBeVisible();
  await expect(chooser).toContainText('1 more note is not listed');
  await expect(chooser).toContainText('Orchard supplier sync');
  await expect(chooser).not.toContainText('Empty notes meeting');
  await expect(chooser).not.toContainText(
    'Secret transcript line that must stay out.',
  );

  await chooser.getByRole('checkbox').check();
  await chooser
    .getByRole('button', { name: 'Import 1 selected', exact: true })
    .click();
  await expect(chooser).not.toBeVisible();

  await expect(context).toContainText('Orchard supplier sync');
  await expect(context).toContainText('From a kept meeting');
  await expect(context).toContainText('Legal needs two days for review.');
  await expect(context).toContainText('Check gate hinge bolts.');
  await expect(context).not.toContainText(
    'Secret transcript line that must stay out.',
  );

  // Per-session review shows the kept meeting as optional (off unless ticked).
  await page
    .getByRole('button', { name: 'Start live session', exact: true })
    .click();
  const panel = page.getByRole('region', {
    name: 'Cue processing',
    exact: true,
  });
  await panel
    .getByRole('button', { name: 'Turn off processing', exact: true })
    .click();
  await panel
    .getByRole('button', { name: 'Review processing', exact: true })
    .click();
  const historyCheckbox = panel.getByRole('checkbox', {
    name: /Orchard supplier sync.*Kept meeting.*2026-11-02/,
  });
  await expect(historyCheckbox).not.toBeChecked();
  await historyCheckbox.check();
  await panel.getByRole('button', { name: 'Review selected sources' }).click();
  await expect(panel).toContainText('Orchard supplier sync');
  await expect(panel).toContainText('Kept meeting · 2026-11-02 · prior note');
  await panel.getByRole('button', { name: 'Enable for this session' }).click();

  // Cue citing the kept meeting discloses it with Kept meeting provenance.
  await page.evaluate((meetingId) => {
    window.liveTest.setCue({
      id: 'eval:1',
      kind: 'Suggestion',
      question: 'Will legal finish the two-day review before Friday?',
      evidence: '',
      sourceId: `prior:history:${meetingId}`,
      sources: [
        {
          id: `prior:history:${meetingId}`,
          revision: 1,
          text: 'Legal needs two days for review.',
          provenance: {
            kind: 'priorNote',
            provider: 'history',
            date: '2026-11-02',
            title: 'Orchard supplier sync',
          },
        },
      ],
      remainingMs: 18_000,
      totalMs: 18_000,
      held: false,
      resolvedBy: null,
      note: null,
      aboutFocus: false,
    });
  }, id);
  const cue = page.getByRole('region', { name: 'Suggested question' });
  await expect(cue).toContainText(
    'Orchard supplier sync · Kept meeting · 2026-11-02 · prior note',
  );
  await expect(cue).toContainText('Legal needs two days for review.');
});

test('Meetings supports optional collapsible folders: create, move, collapse/expand, search, rename, and delete without losing meetings', async ({
  page,
}) => {
  await openNative(page);
  await page.evaluate(() => {
    window.historyTest.add({
      title: 'Orchard supplier sync',
      startedAtMs: Date.UTC(2026, 10, 4, 14),
      durationMs: 1_200_000,
      sources: 'microphone',
      transcript: [{ atMs: 1_000, text: 'The cedar posts arrive Monday.' }],
      notes: 'Check delivery gate.',
      cues: [],
    });
    window.historyTest.add({
      title: 'Greenhouse roof check',
      startedAtMs: Date.UTC(2026, 10, 3, 10),
      durationMs: 900_000,
      sources: 'microphone',
      transcript: [{ atMs: 1_000, text: 'Glass panels need new putty.' }],
      notes: 'Order glazing clips.',
      cues: [],
    });
    window.historyTest.add({
      title: 'Potluck seating plan',
      startedAtMs: Date.UTC(2026, 10, 2, 9),
      durationMs: 600_000,
      sources: 'microphone',
      transcript: [{ atMs: 1_000, text: 'Put the benches under the oak.' }],
      notes: 'Bring extra napkins.',
      cues: [],
    });
  });

  await page.getByRole('button', { name: 'Meetings', exact: true }).click();

  // Default zero-clutter state: all meetings unfiled at top, single New folder button.
  const unfiledList = page.getByRole('list', { name: 'Meetings', exact: true });
  await expect(unfiledList.locator('.history-item')).toHaveCount(3);
  await expect(
    page.getByRole('button', { name: 'New folder', exact: true }),
  ).toBeVisible();

  // Create a folder.
  await page.getByRole('button', { name: 'New folder', exact: true }).click();
  const folderInput = page.getByRole('textbox', { name: 'Folder name' });
  await expect(folderInput).toBeFocused();
  await folderInput.fill('Client A');
  await page
    .getByRole('button', { name: 'Create folder', exact: true })
    .click();

  const clientDetails = page.locator('details.history-folder', {
    hasText: 'Client A',
  });
  await expect(clientDetails).toBeVisible();
  await expect(clientDetails).toHaveAttribute('open', '');
  await expect(clientDetails.locator('summary')).toBeFocused();
  await expect(clientDetails.locator('summary')).toContainText('Client A');
  await expect(clientDetails.locator('summary')).toContainText('0');

  // Move two meetings into Client A: one from the row selector, one from detail view.
  await page
    .getByRole('combobox', { name: 'Folder for Orchard supplier sync' })
    .selectOption('Client A');
  await expect(unfiledList.locator('.history-item')).toHaveCount(2);
  const clientList = page.getByRole('list', { name: 'Meetings in Client A' });
  await expect(clientList.locator('.history-item')).toHaveCount(1);
  await expect(clientList.locator('.history-item').nth(0)).toContainText(
    'Orchard supplier sync',
  );

  // Open second meeting and move it inside detail view.
  await unfiledList
    .getByRole('button', { name: /^Greenhouse roof check/ })
    .click();
  await page
    .getByRole('combobox', { name: 'Folder', exact: true })
    .selectOption('Client A');
  await page
    .getByRole('button', { name: 'Back to meetings', exact: true })
    .click();

  // Unfiled stays at top (1 meeting), Client A has 2 meetings newest first.
  await expect(unfiledList.locator('.history-item')).toHaveCount(1);
  await expect(unfiledList.locator('.history-item').nth(0)).toContainText(
    'Potluck seating plan',
  );
  await expect(clientList.locator('.history-item')).toHaveCount(2);
  await expect(clientList.locator('.history-item').nth(0)).toContainText(
    'Orchard supplier sync',
  );
  await expect(clientList.locator('.history-item').nth(1)).toContainText(
    'Greenhouse roof check',
  );
  await expect(clientDetails.locator('summary')).toContainText('2');

  // Collapse and expand the accordion.
  await clientDetails.locator('summary').click();
  await expect(clientDetails).not.toHaveAttribute('open', '');
  await expect(clientList).not.toBeVisible();

  // Searching filters across unfiled and folders, auto-expanding matching folders.
  const search = page.getByRole('searchbox', { name: 'Search meetings' });
  await search.fill('glazing');
  await expect(clientDetails).toHaveAttribute('open', '');
  await expect(clientList.locator('.history-item')).toHaveCount(1);
  await expect(clientList.locator('.history-item').nth(0)).toContainText(
    'Greenhouse roof check',
  );
  await expect(unfiledList).toHaveCount(0);

  // Search matching an unfiled meeting hides folders with zero matches.
  await search.fill('napkins');
  await expect(unfiledList.locator('.history-item')).toHaveCount(1);
  await expect(unfiledList.locator('.history-item').nth(0)).toContainText(
    'Potluck seating plan',
  );
  await expect(clientDetails).toHaveCount(0);

  // Clearing search restores collapsed state and shows all folders again.
  await page.getByRole('button', { name: 'Clear', exact: true }).click();
  await expect(clientDetails).toBeVisible();
  await expect(clientDetails).not.toHaveAttribute('open', '');
  await clientDetails.locator('summary').click();
  await expect(clientDetails).toHaveAttribute('open', '');

  // Rename folder.
  await page
    .getByRole('button', { name: 'Rename folder Client A', exact: true })
    .click();
  const renameBox = page.getByRole('textbox', { name: 'Folder name' });
  await expect(renameBox).toBeFocused();
  await renameBox.fill('Orchard Client');
  await page.getByRole('button', { name: 'Save folder', exact: true }).click();
  const renamedDetails = page.locator('details.history-folder', {
    hasText: 'Orchard Client',
  });
  await expect(renamedDetails).toBeVisible();
  await expect(renamedDetails.locator('summary')).toBeFocused();
  await expect(
    page
      .getByRole('list', { name: 'Meetings in Orchard Client' })
      .locator('.history-item'),
  ).toHaveCount(2);

  // Delete folder: confirmation explicitly reassures meetings stay, and moves them back to unfiled at top.
  await page
    .getByRole('button', { name: 'Delete folder Orchard Client', exact: true })
    .click();
  const deleteGroup = page.getByRole('group', {
    name: /Delete folder “Orchard Client”\?/,
  });
  await expect(deleteGroup).toContainText('none will be deleted');
  await deleteGroup
    .getByRole('button', { name: 'Delete folder', exact: true })
    .click();

  await expect(renamedDetails).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'New folder', exact: true }),
  ).toBeFocused();
  await expect(unfiledList.locator('.history-item')).toHaveCount(3);
  // Folder moves now append in the saved organization order. Deleting the
  // folder preserves that order instead of re-sorting by date.
  await expect(unfiledList.locator('.history-item-title')).toHaveText([
    'Potluck seating plan',
    'Orchard supplier sync',
    'Greenhouse roof check',
  ]);
});

test('Meetings folders remain accessible and overflow-free at narrow width', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openNative(page);
  await page.evaluate(() => {
    window.historyTest.add({
      title: 'Fictional unfiled sync',
      startedAtMs: Date.UTC(2026, 10, 4, 10),
      durationMs: 600_000,
      sources: 'microphone',
      transcript: [{ atMs: 1_000, text: 'Hello.' }],
      notes: '',
      cues: [],
    });
    window.historyTest.add({
      title: 'Fictional client sync',
      folder: 'Client A',
      startedAtMs: Date.UTC(2026, 10, 3, 10),
      durationMs: 600_000,
      sources: 'microphone',
      transcript: [{ atMs: 1_000, text: 'Hello.' }],
      notes: '',
      cues: [],
    });
  });

  await page.getByRole('button', { name: 'Meetings', exact: true }).click();
  await expect(
    page.getByRole('list', { name: 'Meetings in Client A' }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  const selector = page.getByRole('combobox', {
    name: 'Folder for Fictional client sync',
  });
  const bounds = await selector.boundingBox();
  expect(bounds?.height).toBeGreaterThanOrEqual(44);
  expect(bounds?.height).toBeLessThanOrEqual(52);
});

test('auto-selects relevant recent meetings on launch and Focus match, respects per-session Remove, Archive, and Settings toggle', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const w = window as unknown as {
      standInMeetings: unknown[];
    };
    w.standInMeetings = [
      {
        title: 'Orchard gate supplier',
        startedAtMs: Date.UTC(2026, 10, 1, 9),
        durationMs: 900_000,
        sources: 'microphone',
        transcript: [
          { atMs: 1_000, text: 'Secret transcript from orchard call.' },
        ],
        notes: 'Check south latch bolts.',
        cues: [],
        meetingNotes: '## Decisions\n\n- Confirm gate delivery.',
      },
      {
        title: 'Archived orchard notes',
        startedAtMs: Date.UTC(2026, 10, 5, 9),
        durationMs: 600_000,
        sources: 'microphone',
        transcript: [{ atMs: 1_000, text: 'Archived transcript.' }],
        notes: 'Archived orchard latch notes.',
        cues: [],
        archived: true,
      },
      {
        title: 'Empty orchard sync',
        startedAtMs: Date.UTC(2026, 10, 6, 9),
        durationMs: 300_000,
        sources: 'microphone',
        transcript: [{ atMs: 1_000, text: 'Only transcript, no notes.' }],
        notes: '   ',
        cues: [],
      },
      {
        title: 'Budget check',
        startedAtMs: Date.UTC(2026, 10, 2, 9),
        durationMs: 600_000,
        sources: 'microphone',
        transcript: [{ atMs: 1_000, text: 'Secret budget transcript.' }],
        notes: 'Review Q4 seed invoices.',
        cues: [],
      },
      {
        title: 'Compost rota',
        startedAtMs: Date.UTC(2026, 10, 3, 9),
        durationMs: 600_000,
        sources: 'microphone',
        transcript: [{ atMs: 1_000, text: 'Secret compost transcript.' }],
        notes: 'Priya keeps bin padlock.',
        cues: [],
      },
      {
        title: 'Tool shed review',
        startedAtMs: Date.UTC(2026, 10, 4, 9),
        durationMs: 600_000,
        sources: 'microphone',
        transcript: [{ atMs: 1_000, text: 'Secret shed transcript.' }],
        notes: 'Oil the hinges.',
        cues: [],
      },
    ];
  });

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
  await page.goto('/?keys=set');
  const context = page.getByRole('region', { name: 'Prior context' });
  await expect(context.locator('summary')).toContainText('3 notes selected');

  await context.locator('summary').click();
  // On launch without Focus, picks 3 newest non-archived meetings with notes.
  await expect(context).toContainText('Tool shed review');
  await expect(context).toContainText('Compost rota');
  await expect(context).toContainText('Budget check');
  await expect(context).not.toContainText('Archived orchard notes');
  await expect(context).not.toContainText('Empty orchard sync');
  await expect(context).not.toContainText('Secret shed transcript.');
  await expect(context.locator('.context-auto-chip')).toHaveCount(3);
  const axeContext = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .disableRules(['color-contrast'])
    .analyze();
  expect(axeContext.violations).toEqual([]);

  // Typing Focus matching "orchard" promotes the older matching meeting.
  const focusToggle = page
    .getByRole('region', { name: 'This meeting' })
    .locator('summary');
  await focusToggle.click();
  const focusInput = page.getByRole('textbox', { name: /Focus/ });
  await focusInput.fill('Check orchard latch');
  await focusInput.blur();

  await expect(context).toContainText('Orchard gate supplier');
  await expect(context).toContainText('Auto-selected from kept meetings');
  await expect(context).not.toContainText('Secret transcript from orchard');

  // Remove one auto-selected item for this session: it stays removed even when Focus changes again.
  await context
    .getByRole('button', { name: /Remove Tool shed review/ })
    .click();
  await expect(context).not.toContainText('Tool shed review');
  await expect(context.locator('summary')).toContainText('2 notes selected');

  await focusInput.fill('Check orchard south latch');
  await focusInput.blur();
  await expect(context).toContainText('Orchard gate supplier');
  await expect(context).not.toContainText('Tool shed review');

  // Archive an auto-selected item from Prior context: removes it now and excludes it permanently.
  await context
    .getByRole('button', { name: /Archive Orchard gate supplier/ })
    .click();
  await expect(context).not.toContainText('Orchard gate supplier');

  // Meetings view hides archived meetings unless Show archived is toggled on, and supports Unarchive.
  await page.getByRole('button', { name: 'Meetings', exact: true }).click();
  const list = page.getByRole('list', { name: 'Meetings' });
  await expect(list).not.toContainText('Orchard gate supplier');
  await expect(list).not.toContainText('Archived orchard notes');
  await page.getByRole('button', { name: /^Filters/ }).click();
  const showArchived = page.getByRole('checkbox', {
    name: /Show archived \(2\)/,
  });
  await showArchived.check();
  await expect(list).toContainText('Orchard gate supplier');
  await expect(list).toContainText('Archived orchard notes');

  // Archive Compost rota from the Meetings list and unarchive Orchard gate supplier in detail view.
  await page
    .getByRole('button', { name: 'Archive Compost rota', exact: true })
    .click();
  await expect(
    page.getByRole('checkbox', { name: /Show archived \(3\)/ }),
  ).toBeVisible();
  await list
    .locator('.history-item', { hasText: 'Orchard gate supplier' })
    .click();
  await expect(page.locator('.history-detail-head')).toContainText('Archived');
  await page.getByRole('button', { name: 'Unarchive', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Archive', exact: true }),
  ).toBeVisible();

  // Turning the Settings toggle off clears auto-selected items; turning it back on restores them.
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('link', { name: 'Meetings & storage', exact: true })
    .click();
  const autoToggle = page
    .getByRole('region', { name: 'Meetings' })
    .getByRole('checkbox', {
      name: 'Auto-select relevant past meetings as prior context',
    });
  await expect(autoToggle).toBeChecked();
  await autoToggle.uncheck();

  await page.getByRole('button', { name: 'Notebook', exact: true }).click();
  await expect(context.locator('summary')).toContainText('0 notes selected');

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('link', { name: 'Meetings & storage', exact: true })
    .click();
  await autoToggle.check();
  await page.getByRole('button', { name: 'Notebook', exact: true }).click();
  await expect(context).toContainText('Orchard gate supplier');
  await expect(context).not.toContainText('Compost rota');
  await expect(context).not.toContainText('Tool shed review');
});

test('Meetings detail renders diarized remote speaker chips and renames all lines inline', async ({
  page,
}) => {
  await openNative(page);
  await page.evaluate(() => {
    window.historyTest.add({
      title: 'Diarized orchard sync',
      startedAtMs: Date.UTC(2026, 10, 6, 11),
      durationMs: 900_000,
      sources: 'both',
      application: 'Fictional Call',
      transcribedBy: 'Deepgram',
      transcript: [
        {
          atMs: 1_000,
          label: 'them',
          speakerId: 0,
          text: 'I will check the south latch.',
        },
        {
          atMs: 2_000,
          label: 'them',
          speakerId: 1,
          text: 'I can bring the spare key.',
        },
        {
          atMs: 3_000,
          label: 'them',
          speakerId: 0,
          text: 'Let us meet at nine.',
        },
        {
          atMs: 4_000,
          label: 'you',
          text: 'Works for me.',
        },
      ],
      notes: 'Confirm gate key.',
      cues: [],
    });
  });

  await page.getByRole('button', { name: 'Meetings', exact: true }).click();
  await page.getByRole('button', { name: 'New folder', exact: true }).click();
  await page.getByRole('textbox', { name: 'Folder name' }).fill('Orchard');
  await page
    .getByRole('button', { name: 'Create folder', exact: true })
    .click();
  await page.getByRole('button', { name: /^Diarized orchard sync/ }).click();

  const transcript = page
    .getByRole('region', { name: /Transcript \(4\)/ })
    .locator('.transcript');
  await expect(transcript.locator('.transcript-speaker-chip')).toHaveText([
    'Speaker 1',
    'Speaker 2',
    'Speaker 1',
  ]);

  await transcript
    .getByRole('button', { name: 'Rename Speaker 1' })
    .first()
    .click();
  const input = transcript.getByRole('textbox', { name: 'Speaker 1 name' });
  await expect(input).toBeFocused();
  await input.fill('Priya');
  await input.press('Enter');

  await expect(transcript.locator('.transcript-speaker-chip')).toHaveText([
    'Priya',
    'Speaker 2',
    'Priya',
  ]);

  // Moving and reopening the meeting keeps both its folder and speaker names.
  await page
    .getByRole('combobox', { name: 'Folder', exact: true })
    .selectOption('Orchard');
  await expect(
    page.getByRole('combobox', { name: 'Folder', exact: true }),
  ).toHaveValue('Orchard');
  await page.getByRole('button', { name: 'Back to meetings' }).click();
  await page.getByRole('button', { name: /^Diarized orchard sync/ }).click();
  await expect(transcript.locator('.transcript-speaker-chip')).toHaveText([
    'Priya',
    'Speaker 2',
    'Priya',
  ]);
  await expect(
    page.getByRole('combobox', { name: 'Folder', exact: true }),
  ).toHaveValue('Orchard');

  // Accessibility check while viewing diarized chips.
  const a11y = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .disableRules(['color-contrast'])
    .analyze();
  expect(a11y.violations).toEqual([]);

  // Export preview reflects renamed speaker label.
  await page
    .getByRole('button', { name: 'Export Markdown…', exact: true })
    .click();
  const dialog = page.getByRole('dialog', { name: 'Review your export' });
  const preview = (await dialog.locator('pre').textContent()) ?? '';
  expect(preview).toContain('- 0:01 Priya: I will check the south latch.');
  expect(preview).toContain('- 0:02 Speaker 2: I can bring the spare key.');
  expect(preview).toContain('- 0:03 Priya: Let us meet at nine.');
  expect(preview).toContain('- 0:04 You: Works for me.');
});

test('folder keyboard controls and archive filtering preserve meetings when a folder is deleted', async ({
  page,
}) => {
  await openNative(page);
  await page.evaluate(() =>
    window.historyTest.add({
      title: 'Fictional gate review',
      folder: 'constructor',
      startedAtMs: Date.UTC(2026, 10, 4, 10),
      durationMs: 600_000,
      sources: 'microphone',
      transcript: [],
      notes: 'Check the gate.',
      cues: [],
    }),
  );
  await page.getByRole('button', { name: 'Meetings', exact: true }).click();
  const section = page.locator('details.history-folder');
  const summary = section.locator('summary');
  await expect(section).toHaveAttribute('open', '');
  await summary.focus();
  await page.keyboard.press('Enter');
  await expect(section).not.toHaveAttribute('open', '');
  await page.keyboard.press('Space');
  await expect(section).toHaveAttribute('open', '');
  await section
    .getByRole('button', { name: 'Archive Fictional gate review', exact: true })
    .click();
  await expect(section.locator('.history-item')).toHaveCount(0);
  await page.getByRole('button', { name: /^Filters/ }).click();
  await page.getByRole('checkbox', { name: /Show archived/ }).check();
  await expect(section.locator('.history-item')).toContainText('Archived');
  await page.getByRole('checkbox', { name: /Show archived/ }).uncheck();
  await page
    .getByRole('button', { name: 'Delete folder constructor', exact: true })
    .click();
  await expect(
    page.getByRole('group', { name: /Delete folder/ }),
  ).toContainText('Any meetings in this folder');
  await page
    .getByRole('group', { name: /Delete folder/ })
    .getByRole('button', { name: 'Delete folder', exact: true })
    .click();
  await expect(section).toHaveCount(0);
  await page.getByRole('checkbox', { name: /Show archived/ }).check();
  const list = page.getByRole('list', { name: 'Meetings', exact: true });
  await expect(list.locator('.history-item')).toContainText(
    'Fictional gate review',
  );
  await expect(list.locator('.history-item')).toContainText('Archived');
  await list
    .getByRole('button', {
      name: 'Unarchive Fictional gate review',
      exact: true,
    })
    .click();
  await expect(list.locator('.history-item')).not.toContainText('Archived');
});
