import { expect, test, type Page } from '@playwright/test';
import type { ProcessingSnapshot, SourceCapture } from '../src/lib/processing';
import type {} from './fixtures/native-processing';

// A development build with native-audio-spike offers a Start for application
// audio in the Cue processing panel. The fixture stands in for the native
// host; no application is listed by the OS, no prompt is shown and nothing is
// captured, so these checks establish the interface, not capture.

function source(phase: SourceCapture['phase']): SourceCapture {
  return {
    phase,
    mayBeCapturing: !['off', 'listing', 'reviewing'].includes(phase),
    stalled: false,
    canRetry: false,
    application: phase === 'off' ? null : 'Fictional player',
    problem: null,
    operation: phase === 'off' ? null : 'fictional-operation',
    sourceSession: phase !== 'off',
  };
}

async function panel(page: Page) {
  await page.route('**/*', async (route) => {
    if (route.request().resourceType() !== 'document') return route.continue();
    const response = await route.fetch();
    await route.fulfill({
      response,
      body: (await response.text()).replace(
        '/src/main.tsx',
        '/tests/fixtures/native-processing.tsx',
      ),
    });
  });
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'Cue processing' }),
  ).toBeVisible();
  return page.locator('#processing-title').locator('xpath=ancestor::section');
}

const send = (page: Page, value: Partial<ProcessingSnapshot>) =>
  page.evaluate((value) => window.processingTest.send(value), value);

const hostCalls = (page: Page) =>
  page.evaluate(() =>
    window.processingTest.calls
      .filter((call) => call.command === 'application_audio')
      .map((call) => (call.args as { action: { kind: string } }).action)
      // Status reads are harmless; only the actions matter here.
      .filter((action) => action.kind !== 'snapshot'),
  );

const choices = [
  { id: 'fictional-player', name: 'Fictional player' },
  { id: 'fictional-browser', name: 'Fictional browser' },
];

test('a build that reports no application source offers no Start for one', async ({
  page,
}) => {
  const section = await panel(page);
  await send(page, { microphone: 'off', capture: 'off' });
  await expect(section.getByText('Microphone is off.')).toBeVisible();
  await expect(
    section.getByRole('button', { name: 'List applications' }),
  ).toHaveCount(0);
  expect(await hostCalls(page)).toEqual([]);
});

test('listing shows the scope notice first, then one chosen application starts a session alone', async ({
  page,
}) => {
  const section = await panel(page);
  await page.evaluate(() => window.processingTest.host({}));
  await send(page, {
    microphone: 'off',
    capture: 'off',
    source: source('off'),
  });
  const list = section.getByRole('button', { name: 'List applications' });
  await expect(list).toBeVisible();
  // The notice and the prompt warning come before anything is listed.
  await expect(
    section.getByText(
      'Audio from all windows of this application may be included.',
      { exact: false },
    ),
  ).toBeVisible();
  await expect(
    section.getByText('Screen & System Audio Recording prompt', {
      exact: false,
    }),
  ).toBeVisible();
  expect(await hostCalls(page)).toEqual([]);

  await list.click();
  const cancel = section.getByRole('button', { name: 'Cancel listing' });
  await expect(cancel).toBeVisible();
  await page.evaluate(
    (choices) => window.processingTest.hostChanged({ phase: 'off', choices }),
    choices,
  );
  await expect(cancel).toHaveCount(0);

  const start = section.getByRole('button', { name: /^Start session/ });
  await expect(start).toBeDisabled();
  await section.getByRole('radio', { name: 'Fictional player' }).check();
  await expect(start).toHaveText('Start session from Fictional player');
  await start.click();
  expect(await hostCalls(page)).toEqual([
    { kind: 'list', acknowledged: true },
    { kind: 'review', source: 'fictional-player' },
    { kind: 'startSession', review: 'fictional-review-1' },
  ]);

  // Once the source is starting, its status line and own Stop take over.
  await send(page, {
    capture: 'starting',
    source: source('starting'),
  });
  await expect(
    section.getByRole('button', { name: 'Stop application audio' }),
  ).toBeEnabled();
  await expect(section.getByRole('radio')).toHaveCount(0);
  await expect(
    section.getByRole('button', { name: 'List applications' }),
  ).toHaveCount(0);
});

test('a refused start says why, and listing can be cancelled', async ({
  page,
}) => {
  const section = await panel(page);
  await page.evaluate((choices) => {
    window.processingTest.host({ choices });
    window.processingTest.refuseStart('sessionBusy');
  }, choices);
  await send(page, {
    microphone: 'off',
    capture: 'off',
    source: source('off'),
  });
  await section.getByRole('radio', { name: 'Fictional browser' }).check();
  await section
    .getByRole('button', { name: 'Start session from Fictional browser' })
    .click();
  await expect(section.getByRole('alert')).toHaveText(
    'Another session or the microphone is running. Stop it, then start again.',
  );

  await section.getByRole('button', { name: 'List again' }).click();
  await section.getByRole('button', { name: 'Cancel listing' }).click();
  await expect(
    section.getByRole('button', { name: 'List applications' }),
  ).toBeVisible();
  const calls = await hostCalls(page);
  expect(calls.slice(-2)).toEqual([
    { kind: 'list', acknowledged: true },
    { kind: 'cancelList' },
  ]);
});

test('the list says what to do when an app is missing, and a start macOS refused says to reopen TalkQTE', async ({
  page,
}) => {
  const section = await panel(page);
  await page.evaluate((choices) => {
    window.processingTest.host({ choices });
    window.processingTest.refuseStart('permissionNeedsReopen');
  }, choices);
  await send(page, {
    microphone: 'off',
    capture: 'off',
    source: source('off'),
  });
  await expect(
    section.getByText(
      'Only open applications with a window are listed. If yours is missing, open it or one of its windows, then press List again.',
    ),
  ).toBeVisible();
  await section.getByRole('radio', { name: 'Fictional player' }).check();
  await section
    .getByRole('button', { name: 'Start session from Fictional player' })
    .click();
  await expect(section.getByRole('alert')).toHaveText(
    'macOS has not given this copy of TalkQTE Screen & System Audio Recording yet. If you just granted it, quit and reopen TalkQTE, then start again.',
  );
});

test('a start by the launch setting says so, and a refusal says why in plain words', async ({
  page,
}) => {
  const section = await panel(page);
  await page.evaluate(() =>
    window.processingTest.host({
      bySetting: true,
      problem: 'noMatchingApplication',
    }),
  );
  await send(page, {
    microphone: 'off',
    capture: 'off',
    source: { ...source('off'), problem: 'noMatchingApplication' },
  });
  await expect(
    section.getByText(
      'The TALKQTE_DEV_APPLICATION_SOURCE launch setting acknowledged this notice',
      { exact: false },
    ),
  ).toBeVisible();
  await expect(section.getByRole('alert')).toHaveText(
    'No single running application has the exact name TALKQTE_DEV_APPLICATION_SOURCE gives. Nothing was started.',
  );
  // Nothing was listed or started from the panel by showing this.
  expect(await hostCalls(page)).toEqual([]);

  await send(page, {
    capture: 'running',
    source: { ...source('listening'), bySetting: true },
  });
  await expect(
    section.getByText(
      'Application audio from Fictional player is being captured, including all of its windows. Started by the TALKQTE_DEV_APPLICATION_SOURCE launch setting.',
    ),
  ).toBeVisible();
});
