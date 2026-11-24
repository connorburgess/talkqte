import { expect, test, type Page } from '@playwright/test';
import type { ProcessingSnapshot, SourceCapture } from '../src/lib/processing';
import type {} from './fixtures/native-microphone';

// Before a live session the notebook offers the microphone, one application,
// or both. The fixture stands in for the native host; no application is
// listed by the OS, no prompt is shown and nothing is captured, so these
// checks establish the interface, not capture.

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

const choices = [
  { id: 'fictional-player', name: 'Fictional player' },
  { id: 'fictional-call', name: 'Fictional Call' },
];

async function notebook(page: Page, source: SourceCapture | null = off) {
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
  await page.goto('/?live&keys=set');
  await page.evaluate(() => window.captureTest.host({}));
  await page.evaluate(
    (source) =>
      window.captureTest.send(
        (source
          ? { capture: 'off', microphone: 'off', source }
          : { capture: 'off' }) as Partial<ProcessingSnapshot>,
      ),
    source,
  );
  return page.getByRole('region', { name: 'Listen to' });
}

const hostCalls = (page: Page) =>
  page.evaluate(() =>
    window.captureTest.applicationAudio
      .map((call) => (call as { action: { kind: string } }).action)
      .filter((action) => action.kind !== 'snapshot'),
  );
const liveStarts = (page: Page) =>
  page.evaluate(() => window.captureTest.liveStarts);
const start = (page: Page) =>
  page.getByRole('button', { name: 'Start live session', exact: true });

test('a build that cannot hear an application starts from the microphone with no choice', async ({
  page,
}) => {
  const chooser = await notebook(page, null);
  await expect(start(page)).toBeEnabled();
  await expect(chooser).toHaveCount(0);
  await start(page).click();
  // No application named: the microphone alone.
  await expect.poll(() => liveStarts(page)).toEqual([{}]);
  expect(await hostCalls(page)).toEqual([]);
});

test('the microphone is the default, and starting with it asks nothing of the host', async ({
  page,
}) => {
  const chooser = await notebook(page);
  await expect(
    chooser.getByRole('radio', { name: /^Microphone Everyone/ }),
  ).toBeChecked();
  await expect(
    chooser.getByRole('button', { name: 'List applications' }),
  ).toHaveCount(0);
  await start(page).click();
  // No application named: the microphone alone.
  await expect.poll(() => liveStarts(page)).toEqual([{}]);
  expect(await hostCalls(page)).toEqual([]);
});

test('both sides: the notice comes first, then the chosen application joins the microphone session', async ({
  page,
}) => {
  const chooser = await notebook(page);
  await chooser
    .getByRole('radio', { name: /^Microphone and one application/ })
    .check();
  // The scope, the macOS prompt, the one approval and headphones are said
  // before anything is listed.
  await expect(chooser).toContainText(
    'Audio from all windows of this application may be included.',
  );
  await expect(chooser).toContainText(
    'macOS asks you to allow Screen & System Audio Recording for TalkQTE',
  );
  await expect(chooser).toContainText(
    'that one approval covers the microphone and the application',
  );
  await expect(chooser).toContainText('Use headphones if you can.');
  await expect(start(page)).toBeDisabled();
  expect(await hostCalls(page)).toEqual([]);

  await chooser.getByRole('button', { name: 'List applications' }).click();
  await expect(
    chooser.getByRole('button', { name: 'Cancel listing' }),
  ).toBeVisible();
  await page.evaluate(
    (choices) => window.captureTest.hostChanged({ phase: 'off', choices }),
    choices,
  );
  await chooser.getByRole('radio', { name: 'Fictional Call' }).check();
  await expect(start(page)).toBeEnabled();
  await start(page).click();
  await expect
    .poll(() => liveStarts(page))
    .toEqual([{ application: 'fictional-review-1' }]);
  expect(await hostCalls(page)).toEqual([
    { kind: 'list', acknowledged: true },
    { kind: 'review', source: 'fictional-call' },
  ]);
});

test('one application only starts a session of its own, without the microphone', async ({
  page,
}) => {
  const chooser = await notebook(page);
  await chooser.getByRole('radio', { name: /^One application only/ }).check();
  await expect(chooser).not.toContainText('Use headphones');
  await chooser.getByRole('button', { name: 'List applications' }).click();
  await page.evaluate(
    (choices) => window.captureTest.hostChanged({ phase: 'off', choices }),
    choices,
  );
  await chooser.getByRole('radio', { name: 'Fictional player' }).check();
  await start(page).click();
  await expect
    .poll(() => hostCalls(page))
    .toEqual([
      { kind: 'list', acknowledged: true },
      { kind: 'review', source: 'fictional-player' },
      { kind: 'startSession', review: 'fictional-review-1' },
    ]);
  expect(await liveStarts(page)).toEqual([]);
});

test('a refused listing says why, and listing can be cancelled', async ({
  page,
}) => {
  const chooser = await notebook(page);
  await chooser
    .getByRole('radio', { name: /^Microphone and one application/ })
    .check();
  await chooser.getByRole('button', { name: 'List applications' }).click();
  await page.evaluate(() =>
    window.captureTest.hostChanged({
      phase: 'off',
      problem: 'permissionDenied',
    }),
  );
  await expect(chooser.getByRole('alert')).toHaveText(
    'macOS did not allow it. Grant Screen & System Audio Recording to TalkQTE in System Settings, then list applications again.',
  );
  await chooser.getByRole('button', { name: 'List applications' }).click();
  await chooser.getByRole('button', { name: 'Cancel listing' }).click();
  await expect(
    chooser.getByRole('button', { name: 'List applications' }),
  ).toBeVisible();
  expect((await hostCalls(page)).slice(-2)).toEqual([
    { kind: 'list', acknowledged: true },
    { kind: 'cancelList' },
  ]);
  await expect(start(page)).toBeDisabled();
});
