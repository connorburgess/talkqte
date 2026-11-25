import { expect, test, type Page } from '@playwright/test';
import { standIn } from './fixtures/stand-in';

// The settings file, as the notebook uses it. The stand-in plays the native
// side and keeps the "file" in memory: nothing is written to disk.

type Saved = {
  status?: { saving: string; error?: string };
  panels?: { sidebarWidth: number | null; notesRatio: number | null };
};

async function open(page: Page, saved: Saved = {}) {
  await page.addInitScript((value) => {
    (
      window as unknown as { standInSavedSettings: Saved }
    ).standInSavedSettings = value;
  }, saved);
  await standIn(page, '/');
}

const saved = (page: Page) =>
  page.evaluate(() => window.captureTest.savedSettings());

const sidebar = (page: Page) =>
  page.getByRole('separator', { name: 'Sidebar', exact: true });

test('panel sizes come back from the settings file and are saved once settled', async ({
  page,
}) => {
  await open(page, { panels: { sidebarWidth: 320, notesRatio: null } });
  await expect(sidebar(page)).toHaveAttribute('aria-valuenow', '320');
  // Loading the saved sizes writes nothing back.
  await page.waitForTimeout(600);
  expect((await saved(page)).panelWrites).toBe(0);

  await sidebar(page).focus();
  for (let step = 0; step < 4; step++) await page.keyboard.press('ArrowLeft');
  const width = Number(await sidebar(page).getAttribute('aria-valuenow'));
  expect(width).toBeLessThan(320);
  // Four steps, one write once the keys stop.
  await expect
    .poll(async () => (await saved(page)).panels)
    .toEqual({
      sidebarWidth: width,
      notesRatio: null,
    });
  expect((await saved(page)).panelWrites).toBe(1);
});

test('Settings says what is remembered, and Reset settings asks first and restores the defaults', async ({
  page,
}) => {
  await open(page, { panels: { sidebarWidth: 320, notesRatio: 0.6 } });
  await expect(sidebar(page)).toHaveAttribute('aria-valuenow', '320');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const section = page.getByRole('region', { name: 'Saved settings' });
  await expect(section).toContainText(
    'Keys stay in your Keychain, and nothing from a meeting is saved there.',
  );
  await section.getByRole('button', { name: 'Reset settings…' }).click();
  await expect(section).toContainText('Return every setting to its default?');
  await section.getByRole('button', { name: 'Keep them' }).click();
  expect((await saved(page)).resets).toBe(0);

  const callOffer = page.getByRole('checkbox', {
    name: 'Offer in the dock when a call seems to start',
  });
  await expect(callOffer).toBeChecked();
  await callOffer.uncheck();
  await expect(callOffer).not.toBeChecked();

  await section.getByRole('button', { name: 'Reset settings…' }).click();
  await section
    .getByRole('button', { name: 'Reset settings', exact: true })
    .click();
  await expect(
    page.getByText('Settings are back to their defaults.'),
  ).toBeAttached();
  expect((await saved(page)).resets).toBe(1);
  // The call-starting offer reads its setting again: back to its default (on).
  await expect(callOffer).toBeChecked();
  await page.getByRole('button', { name: 'Notebook', exact: true }).click();
  await expect(sidebar(page)).not.toHaveAttribute('aria-valuenow', '320');
});

test('a lab run says its choices are not saved, keeps call offer off, and offers no reset', async ({
  page,
}) => {
  await open(page, { status: { saving: 'labRun' } });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const section = page.getByRole('region', { name: 'Saved settings' });
  await expect(section).toContainText(
    'This is a lab run: its choices are not saved, and your settings file is not read.',
  );
  await expect(
    section.getByRole('button', { name: 'Reset settings…' }),
  ).toBeDisabled();
  await expect(
    page.getByRole('checkbox', {
      name: 'Offer in the dock when a call seems to start',
    }),
  ).not.toBeChecked();
});

test('settings from a newer version are left as they are, and Reset is offered', async ({
  page,
}) => {
  await open(page, { status: { saving: 'newer' } });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const section = page.getByRole('region', { name: 'Saved settings' });
  await expect(section).toContainText(
    'Your settings were saved by a newer version of TalkQTE.',
  );
  await expect(
    section.getByRole('button', { name: 'Reset settings…' }),
  ).toBeEnabled();
});

test('a failed save is reported', async ({ page }) => {
  await open(page, {
    status: {
      saving: 'on',
      error: 'Your settings could not be saved, so they last until you quit.',
    },
  });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(
    page.getByRole('region', { name: 'Saved settings' }).getByRole('alert'),
  ).toHaveText(
    'Your settings could not be saved, so they last until you quit.',
  );
});
