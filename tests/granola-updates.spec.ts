// An explicit "Check for updates" on already selected Granola notes, against
// the simulated provider in fixtures/native-granola.ts. No account or network.
import { expect, test, type Page } from '@playwright/test';
import {
  CHECKED_AT_MS,
  PROVIDER_UPDATED_AT_MS,
} from './fixtures/native-granola-times';
import type {} from './fixtures/native-granola';

// Rendered times must not depend on, or reveal, the machine's settings.
test.use({ timezoneId: 'UTC', locale: 'en-GB' });

const CHANGED = 'Robin moved the open day to Sunday.';
const ORIGINAL = 'Robin will label the watering cans before the open day.';
const context = (page: Page) =>
  page.getByRole('region', { name: 'Prior context' });
const button = (page: Page, name: string) =>
  context(page).getByRole('button', { name, exact: true });
const notes = (page: Page) => context(page).getByRole('listitem');
const provider = (
  page: Page,
  next: Parameters<Window['granolaTest']['setProvider']>[0],
) => page.evaluate((value) => window.granolaTest.setProvider(value), next);
const requests = (page: Page) =>
  page.evaluate(() => window.granolaTest.checkRequests);
const iso = (ms: number) => new Date(ms).toISOString();

test.beforeEach(async ({ page }) => {
  await page.route('**/?granola*', async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      body: (await response.text()).replace(
        '/src/main.tsx',
        '/tests/fixtures/native-microphone.ts',
      ),
    });
  });
  await importTwo(page, '/?granola&update-check');
});

async function importTwo(page: Page, url: string) {
  await page.goto(url);
  await page.locator('.context-disclosure > summary').press('Enter');
  await page
    .getByRole('button', { name: 'Connect Granola', exact: true })
    .press('Enter');
  await page
    .getByRole('button', { name: 'Choose Granola notes', exact: true })
    .press('Enter');
  const chooser = page.getByRole('dialog', { name: /Choose notes/ });
  await chooser.getByRole('checkbox').nth(0).check();
  await chooser.getByRole('checkbox').nth(1).check();
  await chooser.getByRole('button', { name: 'Import 2 selected' }).click();
  await expect(notes(page)).toHaveCount(2);
}

test('the signed-in Granola connection, which reports no update check, offers none', async ({
  page,
}) => {
  await importTwo(page, '/?granola');
  await expect(button(page, 'Disconnect Granola')).toBeEnabled();
  await expect(button(page, 'Check for updates')).toHaveCount(0);
  await expect(context(page)).not.toContainText('Asks Granola about');
  expect(await requests(page)).toEqual([]);
});

test('a check updates a changed note, keeps one Granola no longer returns, and asks only about selected notes', async ({
  page,
}) => {
  // What leaves the device is stated before anything is sent.
  await expect(context(page)).toContainText(
    'Asks Granola about the 2 Granola notes selected here, only when you press this button. Only their identifiers are sent',
  );
  expect(await requests(page)).toEqual([]);
  await provider(page, { changed: ['garden-0'], missing: ['garden-1'] });
  await button(page, 'Check for updates').press('Enter');
  await expect(context(page).getByRole('status').last()).toHaveText(
    'Checked 2 Granola notes: 1 updated, 0 unchanged, 1 not verified. Nothing was removed; see each note for what to do next.',
  );
  await expect(button(page, 'Check for updates')).toBeFocused();
  expect(await requests(page)).toEqual([['garden-0', 'garden-1']]);

  const changed = notes(page).nth(0);
  await expect(changed).toContainText(CHANGED);
  await expect(changed).toContainText('Updated from Granola when checked');
  // The check time and Granola's own update time are separate facts.
  await expect(changed.locator('time')).toHaveCount(2);
  await expect(changed.locator('time').nth(0)).toHaveAttribute(
    'datetime',
    iso(CHECKED_AT_MS),
  );
  await expect(changed.locator('time').nth(1)).toHaveAttribute(
    'datetime',
    iso(PROVIDER_UPDATED_AT_MS),
  );

  const withheld = notes(page).nth(1);
  await expect(withheld).toContainText(ORIGINAL);
  await expect(withheld).toContainText(
    'Not verified. Granola did not return this note.',
  );
  await expect(withheld).toContainText('not proof it was deleted');
  await expect(withheld).not.toContainText('when checked');

  // Asking again neither duplicates nor relabels: the first is now current.
  await button(page, 'Check for updates').press('Enter');
  await expect(context(page).getByRole('status').last()).toContainText(
    '0 updated, 1 unchanged, 1 not verified',
  );
  await expect(changed).toContainText('Matched Granola when checked');
  await expect(notes(page)).toHaveCount(2);
});

for (const [fail, message] of [
  ['unavailable', 'you may be offline'],
  ['expired', 'sign-in has expired'],
  ['revoked', 'withdrew this app’s access'],
  ['rateLimited', 'asked for a pause of about 7 seconds'],
  ['unsupportedFormat', 'a note format TalkQTE cannot read yet'],
  ['workspaceUnverified', 'could not confirm which Granola workspace'],
  ['workspaceChanged', 'The active Granola workspace changed'],
] as const) {
  test(`a check that ends ${fail} says so, keeps every copy, and can be repeated`, async ({
    page,
  }) => {
    await provider(page, { fail, changed: ['garden-0'] });
    await button(page, 'Check for updates').press('Enter');
    await expect(context(page).getByRole('alert')).toContainText(message);
    await expect(notes(page)).toHaveCount(2);
    for (const note of await notes(page).all()) {
      await expect(note).toContainText(ORIGINAL);
      await expect(note).toContainText('Not verified.');
      await expect(note).not.toContainText('when checked');
    }
    // Nothing is retried on its own; Disconnect stays available.
    expect(await requests(page)).toHaveLength(1);
    await expect(button(page, 'Disconnect Granola')).toBeEnabled();

    await provider(page, {});
    await button(page, 'Check for updates').press('Enter');
    await expect(context(page).getByRole('status').last()).toContainText(
      'Checked 2 Granola notes: 0 updated, 2 unchanged, 0 not verified.',
    );
    await expect(context(page).getByRole('alert')).toHaveCount(0);
    await expect(context(page)).not.toContainText('Not verified.');
  });
}

test('a check that times out blocks a second request until the first has ended', async ({
  page,
}) => {
  await provider(page, { hold: true, changed: ['garden-0'] });
  await button(page, 'Check for updates').press('Enter');
  await expect(context(page)).toContainText('Checking 2 Granola notes…');
  await page.evaluate(() => window.granolaTest.timeOutCheck());
  await expect(context(page).getByRole('alert')).toContainText(
    'Granola did not answer in time.',
  );
  await expect(notes(page).nth(0)).toContainText(ORIGINAL);
  await expect(notes(page).nth(0)).toContainText('Not verified.');

  await provider(page, { changed: ['garden-0'] });
  await button(page, 'Check for updates').press('Enter');
  await expect(context(page).getByRole('alert')).toContainText(
    'The earlier check has not finished at Granola yet.',
  );
  expect(await requests(page)).toHaveLength(1);

  await page.evaluate(() => window.granolaTest.settleCheck());
  await button(page, 'Check for updates').press('Enter');
  await expect(notes(page).nth(0)).toContainText(CHANGED);
  expect(await requests(page)).toHaveLength(2);
});

test('stopping a check keeps a late answer out and leaves the notebook usable', async ({
  page,
}) => {
  await provider(page, { hold: true, changed: ['garden-0', 'garden-1'] });
  await button(page, 'Check for updates').press('Enter');
  const stop = button(page, 'Stop check');
  await expect(stop).toBeFocused();
  await expect(button(page, 'Disconnect Granola')).toBeEnabled();
  await expect(button(page, 'Add notes from a file')).toBeEnabled();
  await expect(notes(page).nth(0).getByRole('button')).toBeEnabled();

  await stop.press('Enter');
  await expect(context(page).getByRole('status').last()).toContainText(
    'Check stopped. Nothing was changed.',
  );
  await expect(button(page, 'Check for updates')).toBeFocused();
  expect(await page.evaluate(() => window.granolaTest.stopRequests)).toBe(1);
  await page.evaluate(() => window.granolaTest.releaseCheck());
  await expect(context(page).getByRole('status').last()).toContainText(
    'Check stopped.',
  );
  for (const note of await notes(page).all()) {
    await expect(note).toContainText(ORIGINAL);
    await expect(note.locator('time')).toHaveCount(0);
  }
});

test('disconnecting during a check keeps the copies and discards the answer', async ({
  page,
}) => {
  await provider(page, { changed: ['garden-1'] });
  await button(page, 'Check for updates').press('Enter');
  await expect(notes(page).nth(1)).toContainText('Updated from Granola');

  await provider(page, { hold: true, changed: ['garden-0'] });
  await button(page, 'Check for updates').press('Enter');
  await expect(button(page, 'Stop check')).toBeVisible();
  await button(page, 'Disconnect Granola').press('Enter');
  await expect(button(page, 'Connect Granola')).toBeFocused();
  await expect(button(page, 'Stop check')).toHaveCount(0);
  await expect(button(page, 'Check for updates')).toHaveCount(0);
  await page.evaluate(() => window.granolaTest.releaseCheck());

  // The copies stay as they were; what the old connection found does not.
  await expect(notes(page)).toHaveCount(2);
  await expect(notes(page).nth(0)).toContainText(ORIGINAL);
  await expect(notes(page).nth(1)).toContainText(CHANGED);
  await expect(context(page).locator('time')).toHaveCount(0);
  await expect(context(page)).not.toContainText('Checked 2 Granola notes');

  // Reconnecting offers a new check but does not start one.
  await button(page, 'Connect Granola').press('Enter');
  await expect(button(page, 'Check for updates')).toBeVisible();
  await expect(context(page).locator('time')).toHaveCount(0);
  expect(await requests(page)).toHaveLength(2);
});

test('a note removed during a check is not restored, and removing all ends the check', async ({
  page,
}) => {
  await provider(page, { hold: true, changed: ['garden-0', 'garden-1'] });
  await button(page, 'Check for updates').press('Enter');
  await expect(button(page, 'Stop check')).toBeVisible();
  await notes(page).nth(0).getByRole('button').click();
  await expect(notes(page)).toHaveCount(1);
  await page.evaluate(() => window.granolaTest.releaseCheck());
  await expect(context(page).getByRole('status').last()).toHaveText(
    'Checked 1 Granola note: 1 updated, 0 unchanged, 0 not verified.',
  );
  await expect(notes(page)).toHaveCount(1);
  await expect(notes(page).nth(0)).toContainText('Fictional garden planning 2');
  await expect(notes(page).nth(0)).toContainText(CHANGED);

  await provider(page, { hold: true });
  await button(page, 'Check for updates').press('Enter');
  await expect(button(page, 'Stop check')).toBeVisible();
  await button(page, 'Remove all').click();
  await expect(notes(page)).toHaveCount(0);
  await expect(button(page, 'Stop check')).toHaveCount(0);
  await page.evaluate(() => window.granolaTest.releaseCheck());
  await expect(context(page)).toContainText('No prior notes selected.');
  await expect(notes(page)).toHaveCount(0);
});

test('a finding does not carry over to a note that is removed and imported again', async ({
  page,
}) => {
  await provider(page, { missing: ['garden-1'] });
  await button(page, 'Check for updates').press('Enter');
  await expect(notes(page).nth(0)).toContainText('Matched Granola');
  await expect(notes(page).nth(1)).toContainText('Not verified.');
  await notes(page).nth(1).getByRole('button').click();
  await expect(notes(page)).toHaveCount(1);
  await button(page, 'Choose Granola notes').click();
  const chooser = page.getByRole('dialog', { name: /Choose notes/ });
  await chooser.getByRole('checkbox').nth(0).check();
  await chooser.getByRole('checkbox').nth(1).check();
  await chooser.getByRole('button', { name: 'Import 2 selected' }).click();
  await expect(notes(page)).toHaveCount(2);
  // The copy that stayed keeps its finding; the new copy was never checked.
  await expect(notes(page).nth(0)).toContainText('Matched Granola');
  await expect(notes(page).nth(1)).not.toContainText('Not verified.');
  await expect(notes(page).nth(1).locator('time')).toHaveCount(0);
});

test('leaving the notebook stops a check, and returning shows the last results in a narrow window', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 600, height: 700 });
  await provider(page, { changed: ['garden-0'], missing: ['garden-1'] });
  await button(page, 'Check for updates').press('Enter');
  await expect(notes(page).nth(0)).toContainText('Updated from Granola');

  await provider(page, { hold: true, changed: ['garden-1'] });
  await button(page, 'Check for updates').press('Enter');
  await expect(button(page, 'Stop check')).toBeVisible();
  await page
    .getByRole('button', { name: 'Settings', exact: true })
    .press('Enter');
  await expect
    .poll(() => page.evaluate(() => window.granolaTest.stopRequests))
    .toBe(1);
  await page.evaluate(() => window.granolaTest.releaseCheck());
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Notebook', exact: true })
    .press('Enter');
  await page.locator('.context-disclosure > summary').press('Enter');

  await expect(button(page, 'Check for updates')).toBeVisible();
  await expect(notes(page).nth(0)).toContainText('Updated from Granola');
  await expect(notes(page).nth(1)).toContainText(ORIGINAL);
  await expect(notes(page).nth(1)).toContainText('Not verified.');
  await button(page, 'Check for updates').scrollIntoViewIfNeeded();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await context(page).screenshot({
    path: testInfo.outputPath('fictional-granola-update-check.png'),
  });
});
