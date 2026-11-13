import { expect, test, type Locator, type Page } from '@playwright/test';
import type { MicrophoneSnapshot } from '../src/lib/microphone';
import type {} from './fixtures/native-microphone';

// The live layout preview shows the app's real microphone and live-session
// state in its Source and Capture rows, read-only. The fixture stands in for
// the native side: no device, model or transcription is involved, so these
// checks do not establish native capture behavior.

async function native(page: Page, query = '') {
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
  await page.goto(`/${query}`);
}

async function openPreview(page: Page) {
  await page
    .getByRole('group', { name: 'Layout', exact: true })
    .getByRole('button', { name: 'Layout preview', exact: true })
    .press('Enter');
  const preview = page.getByRole('region', {
    name: 'Live session layout preview',
  });
  const frame = preview.getByRole('group', {
    name: 'Session layout preview',
  });
  const row = (name: string) =>
    frame.locator('dt', { hasText: name }).locator('+ dd');
  return {
    preview,
    frame,
    source: row('Source'),
    capture: row('Capture'),
    example: row('Example'),
  };
}

const signal = (page: Page, state: Partial<MicrophoneSnapshot>) =>
  page.evaluate((value) => window.microphoneTest.send(value), state);

// While a real microphone or session is active, no sentence about the app
// may say that nothing is captured, in any phrasing. Sentences that name the
// example or call themselves simulated are about the example and are skipped.
async function expectNoClaimThatNothingIsCaptured(preview: Locator) {
  const sentences = (await preview.innerText())
    .split(/(?<=[.!?…])\s+|\n+|\s·\s/)
    .filter((sentence) => !/example|simulated/i.test(sentence));
  expect(sentences.length).toBeGreaterThan(3);
  for (const sentence of sentences)
    expect(sentence).not.toMatch(
      /\bnothing\b.*captur|captur\w*\s+nothing|\bnot\b.*captur/i,
    );
}

test('the browser preview reports that it has no microphone, and the example stays simulated', async ({
  page,
}) => {
  await page.goto('/');
  const { preview, frame, source, capture, example } = await openPreview(page);
  await expect(source).toHaveText(
    'Real None. This browser preview cannot open a microphone.',
  );
  await expect(capture).toHaveText(
    'Real Off. This browser preview captures nothing.',
  );
  await expect(example).toHaveText(
    'Simulated Fictional sample conversation. Example not started',
  );
  await expect(preview).not.toContainText('Stop and other controls are above');
  // The example moves on; the real rows do not.
  await frame.getByRole('button', { name: 'Start (simulated)' }).press('Enter');
  await frame
    .getByRole('button', { name: 'Finish start (simulated)' })
    .press('Enter');
  await expect(example).toHaveText(
    'Simulated Fictional sample conversation. Simulated listening. This example captures no audio',
  );
  await expect(capture).toHaveText(
    'Real Off. This browser preview captures nothing.',
  );
});

test('with the microphone off the real rows say so, and no simulated control sends a capture command', async ({
  page,
}) => {
  await native(page);
  const { preview, frame, source, capture } = await openPreview(page);
  await expect(source).toHaveText('Real None open.');
  await expect(capture).toHaveText('Real Off. Nothing is being captured.');
  await expect(preview).not.toContainText('Stop and other controls are above');
  // Commands that start or stop real capture; other startup reads may still
  // be arriving and are not this test's concern.
  const captureCalls = () =>
    page.evaluate(() =>
      window.microphoneTest.calls.filter((command) =>
        /microphone$|live_session|capture/.test(command),
      ),
    );
  const before = await captureCalls();
  const picker = preview.getByLabel('Preview a state');
  for (const name of [
    'Start (simulated)',
    'Finish start (simulated)',
    'Show example cue (simulated)',
    'Why? (simulated)',
    'Pause (simulated)',
    'Resume (simulated)',
    'Dismiss (simulated)',
    'Remove (simulated): Fictional planning notes',
    'Restore fictional notes (simulated)',
    'Stop (simulated)',
    'Start again (simulated)',
  ])
    await frame.getByRole('button', { name, exact: true }).press('Enter');
  await picker.selectOption('failed');
  await frame.getByRole('button', { name: 'Retry (simulated)' }).press('Enter');
  for (const state of ['listening', 'cue', 'paused', 'stopped', 'idle'])
    await picker.selectOption(state);
  expect(await captureCalls()).toEqual(before);
  await expect(capture).toHaveText('Real Off. Nothing is being captured.');
});

test('a microphone-only check shows starting, listening with its input, and stopping', async ({
  page,
}) => {
  await native(page);
  const { preview, frame, source, capture } = await openPreview(page);
  await signal(page, {
    status: 'starting',
    canStart: false,
    message: 'Checking microphone access…',
  });
  await expect(source).toHaveText('Real Microphone');
  await expect(capture).toHaveText(
    'Real Starting the microphone. Checking microphone access…',
  );
  await expect(preview).toContainText(
    'The real microphone is starting. Its Stop and other controls are above; nothing in this preview starts or stops it.',
  );
  await expectNoClaimThatNothingIsCaptured(preview);
  await signal(page, {
    status: 'listening',
    message: null,
    deviceName: 'Fictional USB microphone',
  });
  await expect(source).toHaveText('Real Microphone: Fictional USB microphone');
  await expect(capture).toHaveText(
    'Real Listening for an activity check only. Nothing is transcribed.',
  );
  await expect(preview).toContainText('The real microphone is in use.');
  // While the real microphone is open, no line claims that nothing is
  // captured, whatever the example shows.
  for (const state of ['idle', 'listening', 'stopped', 'failed']) {
    await preview.getByLabel('Preview a state').selectOption(state);
    await expectNoClaimThatNothingIsCaptured(preview);
    await expect(capture).toContainText('Listening for an activity check');
  }
  await expect(frame).toContainText(
    'Simulated Fictional sample conversation. Simulated failure',
  );
  // Native sends this message with the stopping status; it is not repeated.
  await signal(page, { status: 'stopping', message: 'Stopping microphone…' });
  await expect(source).toHaveText('Real Microphone: Fictional USB microphone');
  await expect(capture).toHaveText(
    'Real Stopping. The microphone is being released.',
  );
  await expectNoClaimThatNothingIsCaptured(preview);
  await signal(page, {
    status: 'off',
    canStart: true,
    message: null,
    deviceName: null,
  });
  await expect(capture).toHaveText('Real Off. Nothing is being captured.');
  await expect(preview).not.toContainText('Stop and other controls are above');
});

test('a denied permission and a device failure show the native message and whether the microphone is released', async ({
  page,
}) => {
  await native(page);
  const { preview, source, capture } = await openPreview(page);
  // A denied permission opens no stream, so a new start is allowed at once.
  await signal(page, {
    status: 'error',
    canStart: true,
    message: 'Check microphone permission in System Settings.',
  });
  await expect(source).toHaveText('Real None open.');
  await expect(capture).toHaveText(
    'Real Failed. The microphone is not open. Check microphone permission in System Settings.',
  );
  await expect(preview).not.toContainText('Stop and other controls are above');
  // A device failure keeps the input held until cleanup finishes.
  await signal(page, {
    status: 'error',
    canStart: false,
    message: 'The fictional input stopped responding.',
  });
  await expect(source).toHaveText('Real Microphone, being released.');
  await expect(capture).toHaveText(
    'Real Failed. The microphone is still being released. The fictional input stopped responding.',
  );
  await expect(preview).toContainText(
    'The real microphone is being released after a failure. Its Stop and other controls are above; nothing in this preview starts or stops it.',
  );
  await expectNoClaimThatNothingIsCaptured(preview);
  await signal(page, { status: 'error', canStart: true });
  await expect(source).toHaveText('Real None open.');
  await expect(preview).not.toContainText('Stop and other controls are above');
});

test('a cancelled start is shown as cancelled until preparation finishes', async ({
  page,
}) => {
  await native(page, '?live&hold-start');
  await page
    .getByRole('button', { name: 'Start live session', exact: true })
    .press('Enter');
  await page
    .getByRole('button', { name: 'Cancel start', exact: true })
    .press('Enter');
  const { preview, capture } = await openPreview(page);
  await expect(capture).toHaveText(
    'Real Start cancelled. Waiting for preparation to finish. Microphone: Off.',
  );
  await expectNoClaimThatNothingIsCaptured(preview);
  await page.evaluate(() => window.captureTest.releaseStart());
  await expect(capture).toHaveText('Real Off. Nothing is being captured.');
});

test('a live session shows preparing, listening and stopping, and only the real Stop ends it', async ({
  page,
}) => {
  await native(page, '?live&hold-start');
  await page
    .getByRole('button', { name: 'Start live session', exact: true })
    .press('Enter');
  const { preview, frame, source, capture } = await openPreview(page);
  await expect(capture).toHaveText(
    'Real Preparing a live session. Microphone: Off.',
  );
  await expectNoClaimThatNothingIsCaptured(preview);
  await expect(preview).toContainText(
    'A real live session is being prepared. You can stop it here or with its controls above; nothing in this preview starts it.',
  );
  await page.evaluate(() => window.captureTest.releaseStart());
  await signal(page, { deviceName: 'Fictional USB microphone' });
  await expect(source).toHaveText('Real Microphone: Fictional USB microphone');
  await expect(capture).toHaveText(
    'Real Listening. A live session is transcribing this microphone on this device.',
  );
  await expect(preview).toContainText('A real live session is running.');

  // The example's Stop is simulated: the real session keeps listening.
  await preview.getByLabel('Preview a state').selectOption('listening');
  await frame.getByRole('button', { name: 'Stop (simulated)' }).press('Enter');
  await expect(frame).toContainText('Simulated stop.');
  await expectNoClaimThatNothingIsCaptured(preview);
  await expect(capture).toContainText('Listening. A live session');
  const realStop = page
    .getByRole('region', { name: 'Microphone', exact: true })
    .getByRole('button', { name: 'Stop live session', exact: true });
  await expect(realStop).toBeEnabled();

  // The native side reports stopping before the microphone is released.
  await page.evaluate(() => window.captureTest.holdDrain());
  await realStop.press('Enter');
  await expect(capture).toHaveText(
    'Real Stopping the live session. The microphone is being released.',
  );
  await expect(preview).toContainText('A real live session is stopping.');
  await expectNoClaimThatNothingIsCaptured(preview);
  await page.evaluate(() => window.captureTest.finishStop());
  await expect(capture).toHaveText('Real Off. Nothing is being captured.');
  await expect(preview).not.toContainText('Stop and other controls are above');
});

test('until the first native status arrives the rows say it is unknown, not off', async ({
  page,
}) => {
  await native(page, '?delay-microphone');
  const { preview, source, capture } = await openPreview(page);
  await expect(source).toHaveText('Real Unknown.');
  await expect(capture).toHaveText('Real Checking microphone status…');
  await expectNoClaimThatNothingIsCaptured(preview);
  await page.evaluate(() =>
    window.microphoneTest.resolveSnapshot({
      revision: 1,
      status: 'listening',
      activity: 'quiet',
      canStart: false,
      message: null,
      deviceName: null,
    }),
  );
  await expect(source).toHaveText('Real Microphone: name unavailable');
  await expect(capture).toContainText('Listening for an activity check only');
});

test('the real rows fit a 480 pixel window', async ({ page }) => {
  await page.setViewportSize({ width: 480, height: 800 });
  await native(page);
  const { frame, capture } = await openPreview(page);
  await signal(page, {
    status: 'error',
    canStart: false,
    message: 'Check microphone permission in System Settings.',
  });
  await expect(capture).toContainText('System Settings');
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(480);
  const box = (await frame.boundingBox())!;
  const row = (await capture.boundingBox())!;
  expect(row.x + row.width).toBeLessThanOrEqual(box.x + box.width);
});
