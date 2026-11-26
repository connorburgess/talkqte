import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { firstLine, standIn } from './fixtures/stand-in';

async function companion(page: Page) {
  await page.setViewportSize({ width: 320, height: 232 });
  await standIn(page, '/?window=cue');
}

test('Settings → Calendar & call prompts is off by default and shows clear permission states', async ({
  page,
}) => {
  await standIn(page, '/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const section = page.getByRole('region', {
    name: 'Calendar & call prompts',
  });
  await expect(section).toContainText(
    'Reads upcoming meeting titles and links locally from Apple Calendar (which syncs Google Calendar, iCloud, and Outlook)',
  );
  await expect(section).toContainText('never uploads your calendar');

  const toggle = section.getByRole('checkbox', {
    name: 'Use macOS Calendar for upcoming meetings',
  });
  await expect(toggle).not.toBeChecked();
  await expect(section.getByRole('status')).toHaveText('Off');

  // Opt in when permission is granted -> Connected.
  await toggle.check();
  await expect(toggle).toBeChecked();
  await expect(section.getByRole('status')).toHaveText('Connected');
  expect(await page.evaluate(() => window.calendarTest.settings())).toEqual({
    enabled: true,
    status: 'connected',
  });

  // Turn off -> Off.
  await toggle.uncheck();
  await expect(toggle).not.toBeChecked();
  await expect(section.getByRole('status')).toHaveText('Off');

  // Opt in when permission is denied -> Denied guidance + System Settings button.
  await page.evaluate(() => window.calendarTest.setGrantResult('denied'));
  await toggle.check();
  await expect(section.getByRole('status')).toHaveText(
    'Permission denied — enable in System Settings → Privacy & Security → Calendars',
  );
  await section
    .getByRole('button', { name: 'Open Calendar privacy settings' })
    .click();
  expect(await page.evaluate(() => window.calendarTest.settingsOpened())).toBe(
    1,
  );

  const axe = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .disableRules(['color-contrast'])
    .analyze();
  expect(axe.violations).toEqual([]);
});

test('non-macOS platforms show Calendar prompts as not available yet', async ({
  page,
}) => {
  for (const [os, name] of [
    ['windows', 'Windows'],
    ['linux', 'Linux'],
  ] as const) {
    await standIn(page, `/?platform=${os}&live`);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const section = page.getByRole('region', {
      name: 'Calendar & call prompts',
    });
    await expect(section).toContainText(`Not available on ${name} yet.`);
    await expect(section.getByRole('checkbox')).toHaveCount(0);
  }
});

test('floating dock shows pre-call prompt with Start listening / Dismiss and fits companion bounds', async ({
  page,
}) => {
  await companion(page);
  await page.evaluate(() =>
    window.liveTest.publish({
      calendarPrompt: {
        id: 11,
        title: 'Weekly Design Sync',
        minutesUntilStart: 2,
      },
    }),
  );

  const card = page.getByRole('region', {
    name: 'Weekly Design Sync starts in 2 min',
  });
  await expect(card).toBeVisible();
  await expect(card.getByRole('status')).toHaveText(
    'Weekly Design Sync starts in 2 min',
  );

  // Fits 320x232 companion viewport and satisfies >=44px hit targets + axe.
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

  await card.getByRole('button', { name: 'Start listening' }).click();
  await card.getByRole('button', { name: 'Dismiss' }).click();
  expect(await page.evaluate(() => window.calendarTest.answers())).toEqual([
    { id: 11, answer: 'start' },
    { id: 11, answer: 'dismiss' },
  ]);
  // Never starts capture on its own from the companion window.
  expect(await page.evaluate(() => window.captureTest.liveStarts)).toEqual([]);
});

test('pre-call prompt pre-fills default meeting title on Start live session and saves to Meetings', async ({
  page,
}) => {
  await standIn(page, '/?live');
  await expect(
    page.getByRole('button', { name: 'Start live session' }),
  ).toBeVisible();
  await page.evaluate(() =>
    window.calendarTest.triggerStart('Weekly Design Sync'),
  );

  const titleInput = page.getByRole('textbox', { name: 'Meeting title' });
  await expect(titleInput).toHaveValue('Weekly Design Sync');

  await page.getByRole('button', { name: 'Start live session' }).click();
  await expect
    .poll(() => page.evaluate(() => window.captureTest.liveStarts))
    .toEqual([{ title: 'Weekly Design Sync' }]);
  await expect(
    page.getByText('Meeting: Weekly Design Sync', { exact: true }),
  ).toBeVisible();

  // Simulated speech + stop auto-saves with the calendar event title.
  await page.evaluate((line) => window.liveTest.say(line), firstLine);
  await page.getByRole('button', { name: 'Stop live session' }).click();
  const meetings = await page.evaluate(() => window.historyTest.meetings());
  expect(meetings).toHaveLength(1);
  expect(meetings[0].title).toBe('Weekly Design Sync');
});

for (const clear of [false, true]) {
  test(`calendar title can be ${clear ? 'cleared' : 'edited'} before starting`, async ({
    page,
  }) => {
    await standIn(page, '/?live');
    await expect(
      page.getByRole('button', { name: 'Start live session' }),
    ).toBeVisible();
    await page.evaluate(() =>
      window.calendarTest.triggerStart('Fictional Planning'),
    );
    const title = page.getByRole('textbox', { name: 'Meeting title' });
    await expect(title).toHaveValue('Fictional Planning');
    if (clear)
      await page.getByRole('button', { name: 'Clear', exact: true }).click();
    else await title.fill('Fictional Design Review');
    await page.getByRole('button', { name: 'Start live session' }).click();
    await expect
      .poll(() => page.evaluate(() => window.captureTest.liveStarts))
      .toEqual([{ title: clear ? '' : 'Fictional Design Review' }]);
  });
}
