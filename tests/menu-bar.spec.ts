import { expect, test, type Page } from '@playwright/test';
import { standIn } from './fixtures/stand-in';

// The menu bar item and Open at login, as Settings shows them. The stand-in
// plays the native side: there is no status item, and no login item is
// registered.

type Presence = {
  menuBar?: boolean;
  openAtLogin?: 'off' | 'on' | 'needsApproval' | 'unavailable';
  approval?: boolean;
};

async function settings(page: Page, presence: Presence = {}, path = '/') {
  await page.addInitScript((value) => {
    (window as unknown as { standInPresence: Presence }).standInPresence =
      value;
  }, presence);
  await standIn(page, path);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  return page.getByRole('region', { name: 'Menu bar and login' });
}

const presence = (page: Page) =>
  page.evaluate(() => window.captureTest.presence());

test('both are off by default, and Settings says what off and on mean', async ({
  page,
}) => {
  const section = await settings(page);
  const keep = section.getByRole('checkbox', {
    name: 'Keep running in the menu bar when the notebook is closed',
  });
  const login = section.getByRole('checkbox', { name: 'Open at login' });
  await expect(keep).not.toBeChecked();
  await expect(login).not.toBeChecked();
  await expect(section).toContainText(
    'Off by default: closing the notebook quits TalkQTE.',
  );
  await expect(section).toContainText(
    'nothing starts from the menu bar by itself',
  );
  await keep.check();
  await expect(keep).toBeChecked();
  expect((await presence(page)).keepRunning).toBe(true);
  await login.check();
  await expect(login).toBeChecked();
  await expect(section.getByRole('status')).toContainText(
    'TalkQTE opens when you log in to this Mac.',
  );
  await login.uncheck();
  expect((await presence(page)).openAtLogin).toBe('off');
});

test('Open at login shows what macOS says, including when it needs approval', async ({
  page,
}) => {
  const section = await settings(page, { approval: true });
  await section.getByRole('checkbox', { name: 'Open at login' }).check();
  await expect(section.getByRole('status')).toContainText(
    'macOS needs your approval before TalkQTE opens at login',
  );
  await section.getByRole('button', { name: 'Open Login Items' }).click();
  expect((await presence(page)).loginItemsOpened).toBe(1);
});

test('a copy that cannot be a login item says so', async ({ page }) => {
  const section = await settings(page, { openAtLogin: 'unavailable' });
  await expect(
    section.getByRole('checkbox', { name: 'Open at login' }),
  ).toBeDisabled();
  await expect(section.getByRole('status')).toHaveText(
    'Open at login is not available for this copy of TalkQTE.',
  );
});

test('without a menu bar item the section is not offered', async ({ page }) => {
  await settings(page, { menuBar: false });
  await expect(
    page.getByRole('heading', { name: 'Saved settings' }),
  ).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Menu bar and login' }),
  ).toHaveCount(0);
});

test('the menu bar’s Start session… opens the notebook’s start and starts nothing', async ({
  page,
}) => {
  // A build that can run a live session.
  await settings(page, {}, '/?live');
  await page.evaluate(() => window.captureTest.menuBarStart());
  const start = page.getByRole('button', { name: 'Start live session' });
  await expect(start).toBeFocused();
  expect(await page.evaluate(() => window.captureTest.liveStarts)).toEqual([]);
});

test('the menu bar’s call-starting switch is the one in Settings', async ({
  page,
}) => {
  await settings(page);
  const offer = page.getByRole('checkbox', {
    name: 'Offer in the dock when a call seems to start',
  });
  await expect(offer).not.toBeChecked();
  await page.evaluate(() => window.captureTest.menuBarOffer(true));
  await expect(offer).toBeChecked();
});
