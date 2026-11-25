import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { firstLine, standIn } from './fixtures/stand-in';

async function openCompanion(page: Page) {
  await page.setViewportSize({ width: 320, height: 232 });
  await standIn(page, '/?window=cue');
}

async function openNotebook(page: Page) {
  await standIn(page, '/?live&processor=1');
}

async function endLiveSession(
  page: Page,
  {
    transcript = [
      { id: 't1-0-0', atMs: 2_000, speaker: 'You', text: firstLine },
    ],
    notes = 'Check the orchard gate latch.',
    application,
  }: {
    transcript?: { id: string; atMs: number; speaker: string; text: string }[];
    notes?: string;
    application?: string;
  } = {},
) {
  await page.evaluate(
    async ({ transcript, notes, application }) => {
      await window.liveTest.publish({
        live: true,
        status: 'running',
        transcript: [],
        notes: '',
        cue: null,
        sources: application
          ? { microphone: true, application }
          : { microphone: true },
      });
      await window.liveTest.publish({
        status: 'ended',
        elapsedMs: 900_000,
        transcript,
        notes,
        cue: null,
      });
    },
    { transcript, notes, application },
  );
}

test('default auto-save saves on stop and shows Meeting saved in the companion dock', async ({
  page,
}) => {
  await openCompanion(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await endLiveSession(page, { application: 'Fictional Call' });

  const card = page.getByRole('region', { name: 'Meeting saved' });
  await expect(card).toBeVisible();
  await expect(card).toContainText('1 line · notes · Saved to Meetings.');

  // Never exposes transcript, notes, title, or application name in companion.
  await expect(card).not.toContainText(firstLine);
  await expect(card).not.toContainText('orchard gate');
  await expect(card).not.toContainText('Fictional Call');

  // Fits companion viewport and satisfies >=44px hit targets + axe checks.
  const bounds = await page.evaluate(() => ({
    width: document.documentElement.scrollWidth,
    height: document.querySelector('main')!.scrollHeight,
    innerWidth,
    innerHeight,
  }));
  expect(bounds.width).toBeLessThanOrEqual(bounds.innerWidth);
  expect(bounds.height).toBeLessThanOrEqual(bounds.innerHeight);
  for (const button of await card.getByRole('button').all()) {
    const box = await button.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
  }
  const axe = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .disableRules(['color-contrast'])
    .analyze();
  expect(axe.violations).toEqual([]);

  // Meeting was saved locally with default title and without application name.
  const meetings = await page.evaluate(() => window.historyTest.meetings());
  expect(meetings).toHaveLength(1);
  expect(meetings[0].title).toMatch(/^Meeting, /);
  expect(meetings[0].application).toBeUndefined();

  // Delete removes the auto-saved meeting and clears the dock card.
  await card.getByRole('button', { name: 'Delete' }).click();
  await expect(card).toHaveCount(0);
  expect(await page.evaluate(() => window.historyTest.meetings())).toEqual([]);
});

test('auto-saved notes-only live session hides Write notes and supports Dismiss', async ({
  page,
}) => {
  await openCompanion(page);
  await endLiveSession(page, { transcript: [], notes: 'Bring spare keys.' });

  const card = page.getByRole('region', { name: 'Meeting saved' });
  await expect(card).toBeVisible();
  await expect(card).toContainText('Your notes · Saved to Meetings.');
  await expect(card.getByRole('button', { name: 'Write notes' })).toHaveCount(
    0,
  );

  await card.getByRole('button', { name: 'Dismiss' }).click();
  await expect(card).toHaveCount(0);
  expect(await page.evaluate(() => window.historyTest.meetings())).toHaveLength(
    1,
  );
});

test('Ask mode offers Keep meeting in the dock and retries inline on failure', async ({
  page,
}) => {
  await openCompanion(page);
  await page.evaluate(() => window.historyTest.setAfterSessionKeep('ask'));
  await endLiveSession(page, { application: 'Fictional Call' });

  const askCard = page.getByRole('region', { name: 'Meeting ended' });
  await expect(askCard).toBeVisible();
  await expect(askCard).toContainText('1 line · notes · Save to Meetings?');
  expect(await page.evaluate(() => window.historyTest.meetings())).toEqual([]);

  await page.evaluate(() =>
    window.historyTest.failNext('Could not write to kept meetings.'),
  );
  await askCard.getByRole('button', { name: 'Keep meeting' }).click();
  await expect(askCard.getByRole('alert')).toHaveText(
    'Could not write to kept meetings.',
  );
  expect(await page.evaluate(() => window.historyTest.meetings())).toEqual([]);

  await askCard.getByRole('button', { name: 'Keep meeting' }).click();
  const keptCard = page.getByRole('region', { name: 'Kept' });
  await expect(keptCard).toBeVisible();
  await expect(keptCard).toContainText('Saved to Meetings.');
  await expect(keptCard.getByRole('button', { name: 'Open' })).toBeVisible();
  await expect(
    keptCard.getByRole('button', { name: 'Write notes' }),
  ).toBeVisible();
  const [meeting] = await page.evaluate(() => window.historyTest.meetings());
  expect(meeting.application).toBeUndefined();
});

test('Off mode, lab runs, and empty sessions neither auto-save nor show a dock card', async ({
  page,
}) => {
  await openCompanion(page);

  // Off mode
  await page.evaluate(() => window.historyTest.setAfterSessionKeep('off'));
  await endLiveSession(page);
  await expect(page.getByText('Meeting saved')).toHaveCount(0);
  await expect(page.getByText('Meeting ended')).toHaveCount(0);
  expect(await page.evaluate(() => window.historyTest.meetings())).toEqual([]);

  // Auto mode with completely empty live session
  await page.evaluate(() => window.historyTest.setAfterSessionKeep('auto'));
  await endLiveSession(page, { transcript: [], notes: '   ' });
  await expect(page.getByText('Meeting saved')).toHaveCount(0);
  expect(await page.evaluate(() => window.historyTest.meetings())).toEqual([]);

  // Lab run
  await page.evaluate(() => window.historyTest.setAvailability('labRun'));
  await endLiveSession(page);
  await expect(page.getByText('Meeting saved')).toHaveCount(0);
  expect(await page.evaluate(() => window.historyTest.meetings())).toEqual([]);
});

test('Notebook opens the kept meeting on Open and opens confirmation before sending on Write notes', async ({
  page,
}) => {
  await openNotebook(page);
  await endLiveSession(page, {
    notes: 'Confirm gate key pickup.',
  });
  await expect(
    page.getByRole('heading', { name: 'Live session ended' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Write meeting notes…' }),
  ).toBeVisible();
  const [saved] = await page.evaluate(() => window.historyTest.meetings());
  expect(saved).toBeTruthy();

  // Clicking Write notes in the companion invokes respond_to_end_prompt and
  // brings Notebook to the explicit confirmation plan (never auto-sends).
  await page.evaluate(async () => {
    const session = window.liveTest.session().endPrompt!.session;
    const tauri = (
      window as unknown as {
        __TAURI_INTERNALS__: {
          invoke: (cmd: string, args: unknown) => Promise<void>;
        };
      }
    ).__TAURI_INTERNALS__;
    await tauri.invoke('respond_to_end_prompt', {
      session,
      action: 'writeNotes',
    });
  });
  await expect(
    page.getByRole('heading', { name: 'Send this meeting to Anthropic?' }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => window.liveTest.session().endPrompt),
  ).toBeUndefined();

  // End a second live session so endPrompt is active again, then test Open.
  await endLiveSession(page, {
    notes: 'Confirm gate key pickup.',
  });
  const second = (await page.evaluate(() => window.historyTest.meetings()))[1];
  await page.evaluate(async () => {
    const session = window.liveTest.session().endPrompt!.session;
    const tauri = (
      window as unknown as {
        __TAURI_INTERNALS__: {
          invoke: (cmd: string, args: unknown) => Promise<void>;
        };
      }
    ).__TAURI_INTERNALS__;
    await tauri.invoke('respond_to_end_prompt', { session, action: 'open' });
  });
  await expect(page.getByRole('heading', { name: second.title })).toBeVisible();
  await expect(page.getByText('Confirm gate key pickup.')).toBeVisible();
});
