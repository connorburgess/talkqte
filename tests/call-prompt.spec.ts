import { expect, test, type Page } from '@playwright/test';
import type { ProcessingSnapshot, SourceCapture } from '../src/lib/processing';
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
  await page.setViewportSize({ width: 320, height: 232 });
  await standIn(page, '/?window=cue');
}

const answers = (page: Page) =>
  page.evaluate(() => window.captureTest.callPromptAnswers);

test('the companion offers a session for the call app and never starts one itself', async ({
  page,
}) => {
  await companion(page);
  await page.evaluate(
    (callPrompt) => window.liveTest.publish({ callPrompt }),
    offer('Fictional Call', 'meeting'),
  );
  await expect(page.getByRole('status')).toHaveText(
    'A call seems to be starting in Fictional Call.',
  );
  await expect(page.locator('main')).toContainText(
    'nothing is heard until then',
  );
  // It fits the companion's cue size.
  const fits = await page.evaluate(
    () => document.querySelector('main')!.scrollHeight <= innerHeight,
  );
  expect(fits).toBe(true);
  await page.getByRole('button', { name: 'Start session…' }).click();
  await page.getByRole('button', { name: 'Not for Fictional Call' }).click();
  await page.getByRole('button', { name: 'Don’t ask again' }).click();
  await page.getByRole('button', { name: 'Not now' }).click();
  expect(await answers(page)).toEqual([
    { id: 7, answer: 'start' },
    { id: 7, answer: 'notForThisApp' },
    { id: 7, answer: 'dontAskAgain' },
    { id: 7, answer: 'dismiss' },
  ]);
  // Answering asked for nothing else.
  expect(await page.evaluate(() => window.captureTest.liveStarts)).toEqual([]);
});

test('a browser is named with its caveat, and an unknown app gets a microphone offer', async ({
  page,
}) => {
  await companion(page);
  await page.evaluate(
    (callPrompt) => window.liveTest.publish({ callPrompt }),
    offer('Fictional Browser', 'browser'),
  );
  await expect(page.getByRole('status')).toHaveText(
    'The microphone is in use and Fictional Browser is in front. A call?',
  );
  await expect(page.locator('main')).toContainText(
    'A browser’s audio may not be heard yet.',
  );
  await page.evaluate(
    (callPrompt) => window.liveTest.publish({ callPrompt }),
    offer(),
  );
  await expect(page.getByRole('status')).toHaveText(
    'The microphone is in use. A call?',
  );
  await expect(page.getByRole('button', { name: /^Not for/ })).toHaveCount(0);
});

test('Start opens the notebook with the microphone and the offered app chosen once listed', async ({
  page,
}) => {
  await standIn(page, '/?live');
  await page.evaluate(() => window.captureTest.host({}));
  const off: SourceCapture = {
    phase: 'off',
    mayBeCapturing: false,
    stalled: false,
    canRetry: false,
    application: null,
    problem: null,
    operation: null,
    sourceSession: false,
  };
  await page.evaluate(
    (source) =>
      window.captureTest.send({
        capture: 'off',
        microphone: 'off',
        source,
      } as Partial<ProcessingSnapshot>),
    off,
  );
  const chooser = page.getByRole('region', { name: 'Listen to' });
  await expect(chooser).toBeVisible();
  await page.evaluate(() =>
    window.captureTest.callPromptStart('Fictional Call'),
  );
  await expect(
    chooser.getByRole('radio', { name: /^Microphone and one application/ }),
  ).toBeChecked();
  await expect(chooser).toContainText('For the call in Fictional Call');
  // Nothing was listed for it: the person lists, as always.
  const listed = () =>
    page.evaluate(() =>
      window.captureTest.applicationAudio
        .map((call) => (call as { action: { kind: string } }).action.kind)
        .filter((kind) => kind !== 'snapshot'),
    );
  expect(await listed()).toEqual([]);
  await chooser.getByRole('button', { name: 'List applications' }).click();
  await page.evaluate(() =>
    window.captureTest.hostChanged({
      phase: 'off',
      choices: [
        { id: 'fictional-player', name: 'Fictional player' },
        { id: 'fictional-call', name: 'Fictional Call' },
      ],
    }),
  );
  await expect(
    chooser.getByRole('radio', { name: 'Fictional Call' }),
  ).toBeChecked();
  expect(await page.evaluate(() => window.captureTest.liveStarts)).toEqual([]);
});

test('Settings has the prompt off by default and says what it reads', async ({
  page,
}) => {
  await standIn(page, '/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const setting = page.getByRole('region', { name: 'When a call starts' });
  await expect(setting).toContainText(
    'It reads only whether the microphone is in use and which app is in front, never audio or what is on screen, and that stays on this Mac.',
  );
  const box = setting.getByRole('checkbox', {
    name: 'Offer to start a session when a call seems to start',
  });
  await expect(box).not.toBeChecked();
  await box.check();
  await expect(box).toBeChecked();
  expect(await page.evaluate(() => window.captureTest.callPrompt())).toEqual({
    enabled: true,
    notFor: [],
  });
});
