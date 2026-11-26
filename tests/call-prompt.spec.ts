import { expect, test, type Page } from '@playwright/test';
import { standIn } from './fixtures/stand-in';

// The call-starting offer. The stand-in plays the native side: no
// microphone state or frontmost application is read, nothing is listed or
// captured. These checks establish the interface only.

const offer = (application?: string, kind?: 'meeting' | 'browser') => ({
  id: 7,
  ...(application ? { application } : {}),
  ...(kind ? { kind } : {}),
});

async function companion(page: Page) {
  await page.setViewportSize({ width: 320, height: 160 });
  await standIn(page, '/?window=cue');
}

const answers = (page: Page) =>
  page.evaluate(() => window.captureTest.callPromptAnswers);

test('the companion offers a compact 1-click Start for the call app', async ({
  page,
}) => {
  await companion(page);
  await page.evaluate(
    (callPrompt) => window.liveTest.publish({ callPrompt }),
    offer('Fictional Call', 'meeting'),
  );
  await expect(page.getByRole('status')).toHaveText('Call in Fictional Call');
  await expect(page.locator('.call-prompt-detail')).toHaveCount(0);
  // It fits the companion's compact prompt size with >=44px targets.
  const bounds = await page.evaluate(() => ({
    height: document.querySelector('main')!.scrollHeight,
    width: document.documentElement.scrollWidth,
    innerHeight,
    innerWidth,
  }));
  expect(bounds.height).toBeLessThanOrEqual(bounds.innerHeight);
  expect(bounds.width).toBeLessThanOrEqual(bounds.innerWidth);
  for (const button of await page.getByRole('button').all()) {
    const box = await button.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    expect(box!.width).toBeGreaterThanOrEqual(44);
  }
  await page.getByRole('button', { name: 'Start' }).click();
  await page.getByRole('button', { name: 'Not for Fictional Call' }).click();
  await page.getByRole('button', { name: 'Off' }).click();
  await page.getByRole('button', { name: 'Not now' }).click();
  expect(await answers(page)).toEqual([
    { id: 7, answer: 'start' },
    { id: 7, answer: 'notForThisApp' },
    { id: 7, answer: 'dontAskAgain' },
    { id: 7, answer: 'dismiss' },
  ]);
  // Answering in the stand-in recorded the IPC calls only.
  expect(await page.evaluate(() => window.captureTest.liveStarts)).toEqual([]);
});

test('a browser is named simply, an unknown app asks Start listening?, and large text fits', async ({
  page,
}) => {
  await companion(page);
  await page.evaluate(
    (callPrompt) => window.liveTest.publish({ callPrompt }),
    offer('Fictional Browser', 'browser'),
  );
  await expect(page.getByRole('status')).toHaveText(
    'Call in Fictional Browser',
  );
  await expect(
    page.getByRole('button', { name: 'Not for Fictional Browser' }),
  ).toBeVisible();
  await page.evaluate(
    (callPrompt) => window.liveTest.publish({ callPrompt }),
    offer(),
  );
  await expect(page.getByRole('status')).toHaveText('Start listening?');
  await expect(page.getByRole('button', { name: /^Not for/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Off' })).toBeVisible();

  await page.setViewportSize({ width: 320, height: 204 });
  await page.evaluate(() => window.liveTest.setQuestionSize('large'));
  await page.evaluate(
    (callPrompt) => window.liveTest.publish({ callPrompt }),
    offer('Microsoft Teams', 'meeting'),
  );
  await expect(page.getByRole('status')).toHaveText('Call in Microsoft Teams');
  const fitsLarge = await page.evaluate(
    () =>
      document.querySelector('main')!.scrollHeight <= innerHeight &&
      document.documentElement.scrollWidth <= innerWidth,
  );
  expect(fitsLarge).toBe(true);
});

test('the notebook has no app picker when a live session starts from the dock', async ({
  page,
}) => {
  await standIn(page, '/?live');
  await expect(page.getByRole('region', { name: 'Listen to' })).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'List applications' }),
  ).toHaveCount(0);
  expect(await page.evaluate(() => window.captureTest.liveStarts)).toEqual([]);
});

test('Settings has the dock offer on by default, Start automatically off by default, and says what it reads', async ({
  page,
}) => {
  await standIn(page, '/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const setting = page.getByRole('region', { name: 'When a call starts' });
  await expect(setting).toContainText(
    'never audio, video, or what is on screen, and that stays on this Mac.',
  );
  const box = setting.getByRole('checkbox', {
    name: 'Offer in the dock when a call seems to start',
  });
  const autoStart = setting.getByRole('checkbox', {
    name: 'Start automatically when a call begins',
  });
  await expect(box).toBeChecked();
  await expect(autoStart).not.toBeChecked();
  await box.uncheck();
  await expect(box).not.toBeChecked();
  await autoStart.check();
  await expect(autoStart).toBeChecked();
  expect(await page.evaluate(() => window.captureTest.callPrompt())).toEqual({
    enabled: false,
    autoStart: true,
    notFor: [],
  });
});
