import { expect, test, type Page } from '@playwright/test';
import type { ProcessingSnapshot, SourceCapture } from '../src/lib/processing';
import type {} from './fixtures/native-microphone';

// The live layout's real Stop calls the notebook's own Stop for the running
// session, and the source's own Stop where the notebook offers it. The
// fixture stands in for the native side and records each command; no device,
// stream or permission is involved.

async function native(page: Page, query = '?live') {
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

const notebookStop = (page: Page) =>
  page
    .getByRole('region', { name: 'Microphone', exact: true })
    .getByRole('button', { name: 'Stop live session', exact: true });

async function openPreview(page: Page) {
  await page
    .getByRole('group', { name: 'Layout', exact: true })
    .getByRole('button', { name: 'Layout preview', exact: true })
    .press('Enter');
  const preview = page.getByRole('region', {
    name: 'Live session layout preview',
  });
  const stops = preview.getByRole('group', { name: 'Real session Stop' });
  return {
    preview,
    stops,
    frame: preview.getByRole('group', { name: 'Session layout preview' }),
    capture: preview.locator('#real-capture-state'),
    stop: (name: string) => stops.getByRole('button', { name, exact: true }),
  };
}

/** How many times each Stop command has been sent so far. */
const sent = (page: Page) =>
  page.evaluate(() => ({
    capture: window.microphoneTest.calls.filter((c) => c === 'stop_capture')
      .length,
    source: window.captureTest.applicationAudio.length,
    live: window.microphoneTest.calls.filter((c) => c === 'stop_live_session')
      .length,
  }));

function source(
  phase: SourceCapture['phase'],
  sourceSession: boolean,
): SourceCapture {
  return {
    phase,
    mayBeCapturing: !['off', 'listing', 'reviewing'].includes(phase),
    stalled: false,
    canRetry: false,
    application: 'Fictional player',
    problem: null,
    operation: 'fictional-operation',
    sourceSession,
  };
}

test('Stop live session in the layout sends the notebook’s Stop once and focus lands on the Capture row', async ({
  page,
}) => {
  await native(page);
  await notebookStop(page)
    .page()
    .getByRole('button', { name: 'Start live session', exact: true })
    .press('Enter');
  await expect(notebookStop(page)).toBeEnabled();
  const { preview, stops, stop, capture } = await openPreview(page);
  await expect(stop('Stop live session')).toBeEnabled();
  await expect(stops.getByRole('button')).toHaveCount(1);
  await expect(preview).toContainText(
    'A real live session is running. You can stop it here or with its controls above; nothing in this preview starts it.',
  );
  const before = await sent(page);
  await stop('Stop live session').press('Enter');
  await expect(capture).toHaveText('Real Off. Nothing is being captured.');
  await expect(capture).toBeFocused();
  const after = await sent(page);
  expect(after.capture - before.capture).toBe(1);
  expect(after.source - before.source).toBe(0);
  expect(after.live - before.live).toBe(0);
  // The same session ended for the notebook, and the layout offers no Stop.
  await expect(notebookStop(page)).toHaveCount(0);
  await expect(stops).toHaveCount(0);
  await expect(preview).not.toContainText('You can stop it here');
});

test('while preparing, Cancel start sends the notebook’s Stop once; focus follows the outcome', async ({
  page,
}) => {
  await native(page, '?live&hold-start');
  await page
    .getByRole('button', { name: 'Start live session', exact: true })
    .press('Enter');
  const { preview, stop, capture } = await openPreview(page);
  await expect(stop('Cancel start')).toBeEnabled();
  // One control: the intro agrees with it.
  await expect(preview).toContainText(
    'Cancel start acts on the real live session',
  );
  const before = await sent(page);
  await stop('Cancel start').press('Enter');
  // Disabled while cancelling, as in the notebook; the browser drops focus
  // from a disabled button, and it is restored once the start has ended.
  await expect(stop('Cancelling…')).toBeDisabled();
  expect((await sent(page)).capture - before.capture).toBe(1);
  await page.evaluate(() => window.captureTest.releaseStart());
  await expect(capture).toHaveText('Real Off. Nothing is being captured.');
  await expect(capture).toBeFocused();
  expect((await sent(page)).capture - before.capture).toBe(1);
});

test('while the session stops, its Stop stays visible until it has ended', async ({
  page,
}) => {
  await native(page);
  await page
    .getByRole('button', { name: 'Start live session', exact: true })
    .press('Enter');
  const { stop, capture, stops } = await openPreview(page);
  const before = await sent(page);
  await page.evaluate(() => window.captureTest.holdDrain());
  await stop('Stop live session').press('Enter');
  await expect(capture).toContainText('Stopping the live session');
  await expect(stop('Stop live session')).toBeVisible();
  // Focus stays on the Stop while it is still shown.
  await expect(stop('Stop live session')).toBeFocused();
  expect((await sent(page)).capture - before.capture).toBe(1);
  await page.evaluate(() => window.captureTest.finishStop());
  await expect(stops).toHaveCount(0);
  await expect(capture).toBeFocused();
  expect((await sent(page)).capture - before.capture).toBe(1);
});

test('a session from one application has both Stops; Stop application audio sends the source’s own Stop once', async ({
  page,
}) => {
  await native(page);
  await page.evaluate(() => window.liveTest.start());
  await page.evaluate((value) => window.microphoneTest.send(value), {
    status: 'off' as const,
    canStart: true,
    message: null,
    deviceName: null,
  });
  await page.evaluate((value) => window.captureTest.send(value), {
    capture: 'running',
    microphone: 'off',
    source: source('listening', true),
  } satisfies Partial<ProcessingSnapshot>);
  const { stops, stop } = await openPreview(page);
  await expect(stops.getByRole('button')).toHaveText([
    'Stop live session',
    'Stop application audio',
  ]);
  const before = await sent(page);
  await stop('Stop application audio').press('Enter');
  await expect
    .poll(() => page.evaluate(() => window.captureTest.applicationAudio))
    .toEqual([{ action: { kind: 'stop', operation: 'fictional-operation' } }]);
  let after = await sent(page);
  expect(after.capture - before.capture).toBe(0);
  // The source reports stopping: its Stop goes, and focus moves to the
  // session's Stop, which remains.
  await page.evaluate((value) => window.captureTest.send(value), {
    source: source('stopping', true),
  } satisfies Partial<ProcessingSnapshot>);
  await expect(stop('Stop application audio')).toHaveCount(0);
  await expect(stop('Stop live session')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect
    .poll(async () => (await sent(page)).capture - before.capture)
    .toBe(1);
  after = await sent(page);
  expect(after.source - before.source).toBe(1);
});

test('a microphone session with a selected application offers the source’s Stop beside the session’s', async ({
  page,
}) => {
  await native(page);
  await page
    .getByRole('button', { name: 'Start live session', exact: true })
    .press('Enter');
  await page.evaluate((value) => window.captureTest.send(value), {
    source: source('starting', false),
  } satisfies Partial<ProcessingSnapshot>);
  const { stops, stop } = await openPreview(page);
  await expect(stops.getByRole('button')).toHaveText([
    'Stop live session',
    'Stop application audio',
  ]);
  const before = await sent(page);
  await stop('Stop application audio').press('Enter');
  await expect
    .poll(() => page.evaluate(() => window.captureTest.applicationAudio))
    .toEqual([{ action: { kind: 'stop', operation: 'fictional-operation' } }]);
  expect((await sent(page)).capture - before.capture).toBe(0);
  await page.evaluate((value) => window.captureTest.send(value), {
    source: source('stopping', false),
  } satisfies Partial<ProcessingSnapshot>);
  await expect(stop('Stop live session')).toBeFocused();
});

test('a selected application without a session offers only its own Stop, worded for the audio', async ({
  page,
}) => {
  await native(page);
  await page.evaluate((value) => window.captureTest.send(value), {
    source: source('listening', false),
  } satisfies Partial<ProcessingSnapshot>);
  const { preview, stops } = await openPreview(page);
  await expect(stops.getByRole('button')).toHaveText([
    'Stop application audio',
  ]);
  await expect(preview).toContainText(
    'Stop application audio acts on the real application audio;',
  );
  await expect(preview).not.toContainText('real live session');
  await expect(preview).not.toContainText('You can stop it here');
  // With the microphone check on as well, the layout cannot stop the
  // microphone, so the line above the frame does not say it can.
  await page.evaluate((value) => window.microphoneTest.send(value), {
    status: 'listening' as const,
    canStart: false,
  });
  await expect(preview).toContainText(
    'The real microphone is in use. Its Stop and other controls are above; nothing in this preview starts or stops it.',
  );
});

test('a failed Stop forgets the press, so a later end elsewhere does not move focus', async ({
  page,
}) => {
  await native(page);
  await page
    .getByRole('button', { name: 'Start live session', exact: true })
    .press('Enter');
  const { stop, stops, capture } = await openPreview(page);
  await page.evaluate(() => window.captureTest.failStop());
  await stop('Stop live session').press('Enter');
  await expect(page.getByRole('alert')).toContainText(
    'Could not stop this session',
  );
  await expect(stop('Stop live session')).toBeEnabled();
  // The session ends from the notebook's own Stop, by pointer.
  await notebookStop(page).click();
  await expect(stops).toHaveCount(0);
  await expect(capture).not.toBeFocused();
});

test('the simulated Stop sends no command while a real session runs', async ({
  page,
}) => {
  await native(page);
  await page
    .getByRole('button', { name: 'Start live session', exact: true })
    .press('Enter');
  const { preview, frame, stop } = await openPreview(page);
  const before = await page.evaluate(() => [...window.microphoneTest.calls]);
  await preview.getByLabel('Preview a state').selectOption('listening');
  await frame
    .getByRole('button', { name: 'Stop (simulated)', exact: true })
    .press('Enter');
  await frame
    .getByRole('button', { name: 'Start again (simulated)', exact: true })
    .press('Enter');
  await frame
    .getByRole('button', { name: 'Stop (simulated)', exact: true })
    .press('Enter');
  expect(await page.evaluate(() => [...window.microphoneTest.calls])).toEqual(
    before,
  );
  expect(
    await page.evaluate(() => window.captureTest.applicationAudio),
  ).toEqual([]);
  await expect(stop('Stop live session')).toBeEnabled();
  await expect(notebookStop(page)).toBeEnabled();
});

test('no real Stop appears without a running session', async ({ page }) => {
  // Browser preview.
  await page.goto('/');
  let { stops } = await openPreview(page);
  await expect(stops).toHaveCount(0);
  // Desktop, nothing running.
  await native(page);
  ({ stops } = await openPreview(page));
  await expect(stops).toHaveCount(0);
  // The microphone activity check alone is not a session; its Stop stays in
  // the notebook's Microphone panel.
  await page.evaluate((value) => window.microphoneTest.send(value), {
    status: 'listening' as const,
    canStart: false,
  });
  await expect(
    page
      .getByRole('region', { name: 'Live session layout preview' })
      .getByText('The real microphone is in use.'),
  ).toBeVisible();
  await expect(stops).toHaveCount(0);
});

test('the real Stop fits a 480 pixel window', async ({ page }) => {
  await page.setViewportSize({ width: 480, height: 800 });
  await native(page);
  await page
    .getByRole('button', { name: 'Start live session', exact: true })
    .press('Enter');
  const { stop } = await openPreview(page);
  await expect(stop('Stop live session')).toBeVisible();
  const box = (await stop('Stop live session').boundingBox())!;
  expect(box.height).toBeGreaterThanOrEqual(44);
  expect(box.x + box.width).toBeLessThanOrEqual(480);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(480);
});
