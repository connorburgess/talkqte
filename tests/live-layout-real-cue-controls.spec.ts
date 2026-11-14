import { expect, test, type Page } from '@playwright/test';
import type { Snapshot } from '../src/lib/types';
import type {} from './fixtures/native-microphone';

// The live layout's real Why?, Dismiss and Pause cues call the notebook's own
// handlers, which send the existing commands. The fixture stands in for the
// native side and records each command; no device or processor is used.

const cueCommands = [
  'inspect_cue',
  'respond_to_cue',
  'set_live_cues_paused',
  'set_processing_paused',
];

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

async function startLive(page: Page) {
  await page
    .getByRole('button', { name: 'Start live session', exact: true })
    .press('Enter');
  await expect(
    page
      .getByRole('region', { name: 'Microphone', exact: true })
      .getByRole('button', { name: 'Stop live session', exact: true }),
  ).toBeEnabled();
}

async function openPreview(page: Page) {
  await page
    .getByRole('group', { name: 'Layout', exact: true })
    .getByRole('button', { name: 'Layout preview', exact: true })
    .press('Enter');
  const preview = page.getByRole('region', {
    name: 'Live session layout preview',
  });
  const real = preview.getByRole('region', { name: 'Real Cue', exact: true });
  return {
    preview,
    real,
    frame: preview.getByRole('group', { name: 'Session layout preview' }),
    button: (name: string) => real.getByRole('button', { name, exact: true }),
  };
}

const raiseCue = (page: Page) =>
  page.evaluate(() =>
    window.liveTest.say(
      'Someone can take the fictional draft.',
      'Who will take the first draft?',
    ),
  );

const preview = (page: Page) =>
  page.getByRole('region', { name: 'Live session layout preview' });

/** How many times each cue command has been sent so far. */
const sent = (page: Page) =>
  page.evaluate(
    (names) =>
      Object.fromEntries(
        names.map((name) => [
          name,
          window.microphoneTest.calls.filter((call) => call === name).length,
        ]),
      ),
    cueCommands,
  );

test('each real control sends its existing command once, and focus stays on a control', async ({
  page,
}) => {
  await native(page);
  await startLive(page);
  const { real, button } = await openPreview(page);
  await raiseCue(page);
  await expect(real).toContainText('Who will take the first draft?');
  const before = await sent(page);
  const more = async (name: string, count = 1) => {
    const now = await sent(page);
    for (const command of cueCommands)
      expect(now[command] - before[command], command).toBe(
        command === name ? count : 0,
      );
  };

  // Why? opens the sources and keeps the cue, as on the notebook card.
  await button('Why?').press('Enter');
  await expect(button('Hide sources')).toBeFocused();
  await expect(button('Hide sources')).toHaveAttribute('aria-expanded', 'true');
  await expect(
    real.getByRole('list', { name: 'Real cue sources' }),
  ).toBeVisible();
  await expect(real).toContainText('Kept until you dismiss it.');
  await more('inspect_cue');
  // The intro names the control by the label it now shows.
  await expect(
    page.getByRole('region', { name: 'Live session layout preview' }),
  ).toContainText(
    'Stop live session, Hide sources, Dismiss and Pause cues act on the real live session',
  );
  await button('Hide sources').press('Enter');
  await expect(button('Why?')).toBeFocused();
  await more('inspect_cue', 2);

  // Dismiss removes the cue; focus goes to Pause cues, which replaces it as
  // the section's next control.
  const dismissed = await sent(page);
  await button('Dismiss').press('Enter');
  await expect(real).toContainText('None.');
  await expect(button('Pause cues')).toBeFocused();
  let now = await sent(page);
  expect(now.respond_to_cue - dismissed.respond_to_cue).toBe(1);
  expect(now.inspect_cue - dismissed.inspect_cue).toBe(0);

  // Pause cues and Resume cues each send the notebook's command once.
  await page.keyboard.press('Enter');
  await expect(button('Resume cues')).toBeFocused();
  await expect(real).toContainText('Cues are paused');
  await page.keyboard.press('Enter');
  await expect(button('Pause cues')).toBeFocused();
  now = await sent(page);
  expect(now.set_live_cues_paused - dismissed.set_live_cues_paused).toBe(2);
  expect(now.respond_to_cue - dismissed.respond_to_cue).toBe(1);
  expect(now.set_processing_paused - dismissed.set_processing_paused).toBe(0);

  // The notebook sees the same state.
  await page.getByRole('button', { name: 'Notebook', exact: true }).click();
  await expect(
    page.getByRole('region', { name: 'Suggested question' }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Pause cues', exact: true }),
  ).toBeVisible();
});

test('the simulated controls send no command while the real cue is shown', async ({
  page,
}) => {
  await native(page);
  await startLive(page);
  const { preview, real, frame } = await openPreview(page);
  await raiseCue(page);
  await expect(real).toContainText('Who will take the first draft?');
  const before = await page.evaluate(() => [...window.microphoneTest.calls]);
  const picker = preview.getByLabel('Preview a state');
  await picker.selectOption('idle');
  for (const name of [
    'Start (simulated)',
    'Finish start (simulated)',
    'Show example cue (simulated)',
    'Why? (simulated)',
    'Hide sources (simulated)',
    'Pause (simulated)',
    'Resume (simulated)',
    'Dismiss (simulated)',
    'Remove (simulated): Fictional planning notes',
    'Restore fictional notes (simulated)',
    'Stop (simulated)',
  ])
    await frame.getByRole('button', { name, exact: true }).press('Enter');
  expect(await page.evaluate(() => [...window.microphoneTest.calls])).toEqual(
    before,
  );
  // The real cue is untouched.
  await expect(real).toContainText('Who will take the first draft?');
  await expect(real.getByRole('button', { name: 'Why?' })).toBeVisible();
});

test('real and simulated controls look different and are named apart', async ({
  page,
}) => {
  await native(page);
  await startLive(page);
  const { preview, real, frame } = await openPreview(page);
  await raiseCue(page);
  await preview.getByLabel('Preview a state').selectOption('cue');
  const border = (name: string) =>
    frame
      .getByRole('button', { name, exact: true })
      .evaluate((button) => getComputedStyle(button).borderTopWidth);
  expect(await border('Dismiss')).toBe('2px');
  expect(await border('Dismiss (simulated)')).not.toBe('2px');
  for (const button of await real.getByRole('button').all())
    await expect(button).not.toContainText('simulated');
  // While real controls are shown, the text no longer calls the layout
  // read-only or every control simulated.
  await expect(preview).toContainText(
    'Source, Capture, Transcript, Cue and Prior context show the app’s real state. Stop live session, Why?, Dismiss and Pause cues act on the real live session; everything else is a fictional example.',
  );
  await expect(preview.locator('.mock-banner')).toContainText(
    'Source, Capture, Transcript, Cue and Prior context are real · Stop live session, Why?, Dismiss and Pause cues act on the real live session; every control marked (simulated) only changes the example · the preview starts no capture, connects to no meeting, and generates no cues of its own',
  );
  await expect(preview).not.toContainText('every control here is simulated');
  await expect(preview).not.toContainText('real state, read-only');
});

test('with cue processing the layout points to its Pause cues only while processing is on, and Dismiss focuses the section', async ({
  page,
}) => {
  await native(page, '?live&processor');
  await startLive(page);
  const { real, button } = await openPreview(page);
  const pointer =
    'Pause cues for this session is in the notebook’s Cue processing panel.';
  // Processing configured but off: the notebook offers no Pause cues either.
  await expect(real).toHaveText('Real CueNone.');
  await expect(button('Pause cues')).toHaveCount(0);
  await page.evaluate(() => window.captureTest.send({ phase: 'active' }));
  await expect(real).toContainText(pointer);
  // The panel it points to does offer Pause cues.
  await page.getByRole('button', { name: 'Notebook', exact: true }).click();
  await expect(
    page
      .getByRole('region', { name: 'Cue processing', exact: true })
      .getByRole('button', { name: 'Pause cues', exact: true }),
  ).toBeVisible();
  await page
    .getByRole('group', { name: 'Layout', exact: true })
    .getByRole('button', { name: 'Layout preview', exact: true })
    .click();
  await page.evaluate(() => window.captureTest.send({ phase: 'off' }));
  await expect(real).not.toContainText(pointer);
  await raiseCue(page);
  await button('Dismiss').press('Enter');
  await expect(real).toContainText('None.');
  await expect(
    real.getByRole('heading', { name: 'Real Cue', exact: true }),
  ).toBeFocused();
});

test('no real control appears without a real live session', async ({
  page,
}) => {
  // Browser preview.
  await page.goto('/');
  let { real } = await openPreview(page);
  await expect(real.getByRole('button')).toHaveCount(0);

  // Desktop demo with a cue.
  await native(page, '');
  await expect(
    page.getByRole('button', { name: 'Try demo', exact: true }),
  ).toBeVisible();
  await page.evaluate(async () => {
    const internals = (
      window as unknown as {
        __TAURI_INTERNALS__: {
          invoke: (command: string, args?: unknown) => Promise<unknown>;
        };
      }
    ).__TAURI_INTERNALS__;
    const current = (await internals.invoke('snapshot')) as Snapshot;
    await internals.invoke('plugin:event|emit', {
      event: 'session:changed',
      payload: {
        ...current,
        live: false,
        status: 'running',
        cue: {
          id: 'demo-cue',
          kind: 'Owner',
          question: 'Who will take the first draft?',
          evidence: 'Someone can take the fictional draft.',
          sourceId: 'demo-1',
          remainingMs: 18_000,
          totalMs: 18_000,
          held: false,
          expanded: false,
          resolvedBy: null,
          note: null,
          aboutFocus: false,
        },
        revision: current.revision + 1,
      },
    });
  });
  ({ real } = await openPreview(page));
  await expect(real).toContainText(
    'The demo’s cues come from a fictional script',
  );
  await expect(real.getByRole('button')).toHaveCount(0);

  // Preparing, stopping, then an ended session.
  await native(page, '?live&hold-start');
  await page
    .getByRole('button', { name: 'Start live session', exact: true })
    .press('Enter');
  ({ real } = await openPreview(page));
  await expect(real.getByRole('button')).toHaveCount(0);
  await page.evaluate(() => window.captureTest.releaseStart());
  await expect(
    real.getByRole('button', { name: 'Pause cues', exact: true }),
  ).toBeVisible();
  await page.evaluate(() => window.captureTest.holdDrain());
  await page
    .getByRole('region', { name: 'Microphone', exact: true })
    .getByRole('button', { name: 'Stop live session', exact: true })
    .press('Enter');
  await expect(
    preview(page).getByText('A real live session is stopping.'),
  ).toBeVisible();
  await expect(real.getByRole('button')).toHaveCount(0);
  await page.evaluate(() => window.captureTest.finishStop());
  await expect(real.getByRole('button')).toHaveCount(0);
  await expect(real).toHaveText('Real CueNone.');
});

test('the real controls fit a 480 pixel window', async ({ page }) => {
  await page.setViewportSize({ width: 480, height: 800 });
  await native(page);
  await startLive(page);
  const { real } = await openPreview(page);
  await raiseCue(page);
  await expect(real.getByRole('button')).toHaveCount(3);
  for (const button of await real.getByRole('button').all())
    expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(480);
});
