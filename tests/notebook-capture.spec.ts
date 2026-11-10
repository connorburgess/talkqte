import { expect, test, type Page } from '@playwright/test';
import type {} from './fixtures/native-microphone';

async function open(page: Page, query = '?live&hold-start') {
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
  await expect(
    page.getByRole('button', { name: 'Start live session', exact: true }),
  ).toBeEnabled();
}
const start = (page: Page) =>
  page.getByRole('button', { name: 'Start live session', exact: true });
const cancel = (page: Page) =>
  page.getByRole('button', { name: 'Cancel start', exact: true });
const stop = (page: Page) =>
  page.getByRole('button', { name: 'Stop live session', exact: true });
const mic = (page: Page) =>
  page.getByRole('region', { name: 'Microphone', exact: true });

test('pending Start can be cancelled outside the busy queue; late preparation never starts capture', async ({
  page,
}) => {
  await open(page);
  await start(page).focus();
  await page.keyboard.press('Enter');
  await expect(cancel(page)).toBeEnabled();
  await expect(cancel(page)).toBeFocused();
  await expect(mic(page)).toContainText('Preparing local transcription');
  await expect(
    page.getByRole('button', { name: 'Start microphone', exact: true }),
  ).toHaveCount(0);
  const target = await page.evaluate(
    () => window.captureTest.state().stopTarget,
  );
  await page.keyboard.press('Enter');
  await expect(mic(page)).toContainText(
    'Start cancelled. Waiting for model preparation',
  );
  expect(await page.evaluate(() => window.captureTest.targets)).toEqual([
    target,
  ]);
  await expect(
    page.getByRole('button', { name: 'Cancelling…', exact: true }),
  ).toBeDisabled();
  await page.evaluate(() => window.captureTest.releaseStart());
  await expect(start(page)).toBeEnabled();
  await expect(start(page)).toBeFocused();
  await expect(mic(page).getByRole('status')).toHaveText('Off');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(stop(page)).toHaveCount(0);
  await start(page).click();
  await expect(stop(page)).toBeEnabled();
  const calls = await page.evaluate(() => window.microphoneTest.calls);
  expect(calls.filter((name) => name === 'start_live_session')).toHaveLength(2);
  expect(calls).not.toContain('approve_processing_scope');
});

test('Stop remains reachable in Settings while a note command is pending; acknowledgement is not Off', async ({
  page,
}) => {
  await open(page, '?live');
  await start(page).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.evaluate(() => window.captureTest.holdName());
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Sam');
  await page.getByRole('textbox', { name: 'Name', exact: true }).press('Tab');
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.microphoneTest.calls.includes('set_user_name'),
      ),
    )
    .toBe(true);
  await page.evaluate(() => window.captureTest.holdDrain());
  await stop(page).click();
  await expect(mic(page).getByRole('status')).toHaveText('Stopping…');
  await expect(stop(page)).toBeEnabled();
  expect(await page.evaluate(() => window.captureTest.targets)).toHaveLength(1);
  await page.evaluate(() => window.captureTest.finishStop());
  await expect(mic(page).getByRole('status')).toHaveText('Off');
  await expect(stop(page)).toHaveCount(0);
  await page.evaluate(() => window.captureTest.releaseName());
});

test('late initial status cannot restore an older startup or stop target', async ({
  page,
}) => {
  await open(page, '?live&hold-start&delay-processing');
  const initial = await page.evaluate(() => window.captureTest.state());
  await start(page).click();
  await expect(cancel(page)).toBeEnabled();
  const target = await page.evaluate(
    () => window.captureTest.state().stopTarget,
  );
  await page.evaluate(
    (initial) => window.captureTest.resolveSnapshots(initial),
    initial,
  );
  await expect(cancel(page)).toBeEnabled();
  await cancel(page).click();
  expect(await page.evaluate(() => window.captureTest.targets)).toEqual([
    target,
  ]);
  await page.evaluate(() => window.captureTest.releaseStart());
  await expect(start(page)).toBeEnabled();
});

test('a stale Stop rejects a replacement operation and refreshes without automatically stopping it', async ({
  page,
}) => {
  await open(page, '?live');
  await start(page).click();
  const oldTarget = await page.evaluate(
    () => window.captureTest.state().stopTarget,
  );
  await page.evaluate(() => window.captureTest.holdStop());
  await stop(page).click();
  const freshTarget = { operation: 'b'.repeat(64), microphone: '7' };
  await page.evaluate(
    (stopTarget) => window.captureTest.send({ stopTarget }),
    freshTarget,
  );
  await page.evaluate(() => window.captureTest.releaseStop());
  await expect(page.getByRole('alert')).toContainText(
    'Could not stop this session',
  );
  await expect(mic(page).getByRole('status')).toHaveText('On');
  expect(await page.evaluate(() => window.captureTest.targets)).toEqual([
    oldTarget,
  ]);
  await stop(page).click();
  expect(await page.evaluate(() => window.captureTest.targets)).toEqual([
    oldTarget,
    freshTarget,
  ]);
  await expect(mic(page).getByRole('status')).toHaveText('Off');
});

test('failed cancellation is retryable, and a genuine model failure remains visible', async ({
  page,
}) => {
  await open(page);
  await start(page).click();
  await page.evaluate(() => window.captureTest.failStop());
  await cancel(page).click();
  await expect(page.getByRole('alert')).toContainText(
    'Could not stop this session',
  );
  await expect(cancel(page)).toBeEnabled();
  await cancel(page).click();
  await page.evaluate(() => window.captureTest.releaseStart());
  await expect(start(page)).toBeEnabled();
  await page.evaluate(() =>
    window.captureTest.failStart('Could not load the local speech model.'),
  );
  await start(page).click();
  await expect(page.getByRole('alert')).toContainText(
    'Could not load the local speech model.',
  );
  await expect(start(page)).toBeEnabled();
});

test('narrow and desktop preparation controls fit, and cancellation does not take focus back from Settings', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  await start(page).click();
  await expect(cancel(page)).toBeEnabled();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.setViewportSize({ width: 1320, height: 880 });
  const box = (await cancel(page).boundingBox())!;
  expect(box.height).toBeGreaterThanOrEqual(44);
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(1320);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(1320);
  await cancel(page).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).focus();
  await page.keyboard.press('Enter');
  await page.evaluate(() => window.captureTest.releaseStart());
  await expect(
    page.getByRole('button', { name: 'Settings', exact: true }),
  ).toBeFocused();
  await expect(
    mic(page).getByRole('button', { name: 'Start microphone', exact: true }),
  ).toBeEnabled();
  await expect(mic(page).getByRole('status')).toHaveText('Off');
});

test('Stop bypasses the still-pending Start during microphone permission, without returning to preparation', async ({
  page,
}) => {
  await open(page, '?live');
  await page.evaluate(() => window.captureTest.holdPermission());
  await start(page).click();
  await expect(mic(page)).toContainText('Waiting for microphone permission');
  await expect(page.getByRole('button', { name: 'Pause cues' })).toBeDisabled();
  await expect(stop(page)).toBeEnabled();
  await stop(page).click();
  await expect(mic(page).getByRole('status')).toHaveText('Off');
  await expect(cancel(page)).toHaveCount(0);
  await page.evaluate(() => window.captureTest.releasePermission());
  await expect(start(page)).toBeEnabled();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('missing capture status offers recovery without an unscoped Stop fallback', async ({
  page,
}) => {
  await open(page, '?live&fail-processing&no-processing-events');
  await start(page).click();
  await expect(page.getByRole('alert')).toContainText(
    'Capture status is unavailable',
  );
  await expect(stop(page)).toBeDisabled();
  await page.getByRole('button', { name: 'Refresh capture status' }).click();
  await expect(stop(page)).toBeEnabled();
  await stop(page).click();
  const calls = await page.evaluate(() => window.microphoneTest.calls);
  expect(calls).toContain('stop_capture');
  expect(calls).not.toContain('stop_live_session');
  expect(calls).not.toContain('stop_microphone');
  await expect(mic(page).getByRole('status')).toHaveText('Off');
});

test('independent microphone cleanup is not relabelled as a live session', async ({
  page,
}) => {
  await open(page, '?live');
  await page
    .getByRole('button', { name: 'Start microphone', exact: true })
    .click();
  await page.evaluate(() => window.captureTest.send({ capture: 'starting' }));
  await page
    .getByRole('button', { name: 'Stop microphone', exact: true })
    .click();
  await page.evaluate(() => window.captureTest.send({ capture: 'stopping' }));
  await expect(mic(page)).toContainText('Microphone only');
  await expect(mic(page).getByRole('status')).toHaveText('Stopping…');
  await expect(stop(page)).toHaveCount(0);
});
