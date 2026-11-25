import { expect, test, type Page } from '@playwright/test';
import type {} from './fixtures/native-microphone';

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

async function endedSession(page: Page) {
  await page.evaluate(
    (text) =>
      window.liveTest.publish({
        live: true,
        status: 'ended',
        transcript: [{ id: 't1-0-0', atMs: 5_000, speaker: 'Speaker', text }],
        cue: null,
      }),
    LINE,
  );
}

const exportDialog = (page: Page) =>
  page.getByRole('dialog', { name: 'Review your export' });

test('notes only by default; keeping the meeting is a reviewed choice', async ({
  page,
}) => {
  await openNative(page);
  await endedSession(page);
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const dialog = exportDialog(page);
  const keep = dialog.getByRole('checkbox', {
    name: 'Also keep this meeting: its transcript and the cues shown',
  });
  await expect(keep).not.toBeChecked();
  await expect(dialog.locator('pre')).not.toContainText(LINE);
  await expect(dialog.locator('pre')).not.toContainText('auto-saved');
  await keep.check();
  // The preview now shows exactly what will be saved.
  await expect(dialog.locator('pre')).toContainText(LINE);
  await expect(dialog).toContainText(
    'nothing is written until you choose a destination',
  );
  await keep.uncheck();
  await expect(dialog.locator('pre')).not.toContainText(LINE);
});

test('a running session offers no choice and a new session starts with it off', async ({
  page,
}) => {
  await openNative(page);
  await page.evaluate(() =>
    window.liveTest.publish({
      live: true,
      status: 'ended',
      transcript: [],
      cue: null,
      keepMeeting: true,
    }),
  );
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  // Nothing to keep: no transcript, so no choice is offered.
  await expect(exportDialog(page).getByRole('checkbox')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await endedSession(page);
  await page.evaluate(() => window.liveTest.publish({ keepMeeting: false }));
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await expect(exportDialog(page).getByRole('checkbox')).not.toBeChecked();
});
