import { expect, test, type Page } from '@playwright/test';
import type { Snapshot } from '../src/lib/types';
import type {} from './fixtures/native-microphone';

// The live layout preview shows a live session's real transcript lines,
// read-only, apart from its simulated example conversation. The fixture
// stands in for the native side: no device, model or transcription is
// involved, so these checks do not establish native transcription.

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

async function openPreview(page: Page) {
  await page
    .getByRole('group', { name: 'Layout', exact: true })
    .getByRole('button', { name: 'Layout preview', exact: true })
    .press('Enter');
  const preview = page.getByRole('region', {
    name: 'Live session layout preview',
  });
  return {
    preview,
    picker: preview.getByLabel('Preview a state'),
    real: preview.getByRole('region', { name: 'Real Transcript' }),
    realLines: preview.getByRole('list', { name: 'Real transcript lines' }),
    example: preview.getByRole('region', {
      name: 'Simulated Example conversation',
    }),
    exampleLines: preview.getByRole('list', {
      name: 'Simulated example conversation lines',
    }),
  };
}

const say = (page: Page, text: string) =>
  page.evaluate((line) => window.liveTest.say(line), text);

/**
 * Sends a session snapshot the way the native side does, through the mocked
 * event plugin, one revision after the fixture's own snapshot so the
 * fixture's next snapshot is still accepted.
 */
async function sendSession(page: Page, value: Partial<Snapshot>) {
  await page.evaluate(async (change) => {
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
      payload: { ...current, ...change, revision: current.revision + 1 },
    });
  }, value);
}

test('the browser preview has no real transcript, even while the demo plays', async ({
  page,
}) => {
  await page.clock.install();
  await page.goto('/');
  await page.getByRole('button', { name: 'Try demo', exact: true }).click();
  await page.clock.runFor(30_000);
  await page.getByRole('tab', { name: /Transcript/ }).click();
  const demoLine = await page
    .locator('.transcript-segment p')
    .first()
    .innerText();
  const { real, realLines, example, picker } = await openPreview(page);
  await expect(real).toContainText(
    'This browser preview has no live session, so there is no real transcript.',
  );
  await expect(realLines).toHaveCount(0);
  await expect(real).not.toContainText(demoLine);
  // The example conversation is a separate, simulated list.
  await picker.selectOption('listening');
  await expect(example.getByRole('listitem')).toHaveText([
    'Alex (fictional line) Who can bring the first draft to the review?',
  ]);
});

test('on the desktop, scripted demo lines are never shown as real', async ({
  page,
}) => {
  await native(page, '');
  // Wait for the notebook's first snapshot, so this one arrives after it.
  await expect(
    page.getByRole('button', { name: 'Try demo', exact: true }),
  ).toBeVisible();
  await sendSession(page, {
    live: false,
    status: 'running',
    transcript: [
      {
        id: 'demo-1',
        atMs: 4_000,
        speaker: 'Robin',
        text: 'A fictional scripted demo line.',
      },
    ],
  });
  const { real, realLines } = await openPreview(page);
  await expect(real).toContainText(
    'No live session. The demo’s scripted lines are fictional and are not shown here.',
  );
  await expect(realLines).toHaveCount(0);
  await expect(real).not.toContainText('A fictional scripted demo line.');
});

test('on the desktop with no live session there is no real transcript', async ({
  page,
}) => {
  await native(page, '');
  const { real, realLines } = await openPreview(page);
  await expect(real).toContainText(
    'No live session, so there is no real transcript.',
  );
  await expect(realLines).toHaveCount(0);
});

test('a demo started after a live session replaces its lines; none are shown as real', async ({
  page,
}) => {
  await native(page);
  await page
    .getByRole('button', { name: 'Start live session', exact: true })
    .press('Enter');
  await say(page, 'A fictional line from the live session.');
  await page
    .getByRole('button', { name: 'Stop live session', exact: true })
    .press('Enter');
  const { real, realLines } = await openPreview(page);
  await expect(realLines.getByRole('listitem')).toHaveCount(1);
  // The native side starts the demo with a fresh, non-live session.
  await sendSession(page, {
    live: false,
    status: 'running',
    transcript: [
      {
        id: 'demo-1',
        atMs: 4_000,
        speaker: 'Robin',
        text: 'A fictional scripted demo line.',
      },
    ],
  });
  await expect(real).toContainText(
    'No live session. The demo’s scripted lines are fictional and are not shown here.',
  );
  await expect(realLines).toHaveCount(0);
  await expect(real).not.toContainText('A fictional scripted demo line.');
  await expect(real).not.toContainText('from the live session');
});

test('before permission is granted the note does not invite speech', async ({
  page,
}) => {
  await native(page);
  await page.evaluate(() => window.captureTest.holdPermission());
  await page
    .getByRole('button', { name: 'Start live session', exact: true })
    .press('Enter');
  const { real } = await openPreview(page);
  await expect(real).toContainText(
    'No lines yet. The microphone is not listening yet.',
  );
  await expect(real).not.toContainText('after they are spoken');
  await page.evaluate(() =>
    window.microphoneTest.send({ status: 'listening', message: null }),
  );
  await expect(real).toContainText(
    'No lines yet. Lines from the microphone appear a few seconds after they are spoken.',
  );
  await page.evaluate(() => window.captureTest.releasePermission());
});

test('stopping without lines says so, then the session ends without lines', async ({
  page,
}) => {
  await native(page);
  await page
    .getByRole('button', { name: 'Start live session', exact: true })
    .press('Enter');
  const { real } = await openPreview(page);
  await page.evaluate(() => window.captureTest.holdDrain());
  await page
    .getByRole('button', { name: 'Stop live session', exact: true })
    .press('Enter');
  await expect(real).toContainText(
    'Stopping. Lines from audio already captured may still appear.',
  );
  await expect(real).not.toContainText('after they are spoken');
  await page.evaluate(() => window.captureTest.finishStop());
  await expect(real).toContainText(
    'The live session ended without transcribed lines.',
  );
});

test('a cancelled start says no lines will appear', async ({ page }) => {
  await native(page, '?live&hold-start');
  await page
    .getByRole('button', { name: 'Start live session', exact: true })
    .press('Enter');
  await page
    .getByRole('button', { name: 'Cancel start', exact: true })
    .press('Enter');
  const { real } = await openPreview(page);
  await expect(real).toContainText(
    'The start was cancelled, so no lines will appear.',
  );
  await page.evaluate(() => window.captureTest.releaseStart());
  await expect(real).toContainText(
    'No live session, so there is no real transcript.',
  );
});

test('a live session’s lines appear in the real list only, from preparing to after Stop', async ({
  page,
}) => {
  await native(page, '?live&hold-start');
  await page
    .getByRole('button', { name: 'Start live session', exact: true })
    .press('Enter');
  const { preview, picker, real, realLines, example, exampleLines } =
    await openPreview(page);
  await expect(real).toContainText(
    'A live session is being prepared. Its lines appear here once it is transcribing.',
  );
  await page.evaluate(() => window.captureTest.releaseStart());
  await expect(real).toContainText(
    'No lines yet. Lines from the microphone appear a few seconds after they are spoken.',
  );
  await say(page, 'Can we keep the fictional garden gate open on Saturday?');
  await say(page, 'Let us check with the fictional committee first.');
  await expect(real).toContainText(
    'From the live session, transcribed on this device.',
  );
  await expect(realLines.getByRole('listitem')).toHaveText([
    'Speaker 0:01 Can we keep the fictional garden gate open on Saturday?',
    'Speaker 0:02 Let us check with the fictional committee first.',
  ]);
  // Whatever the example shows, the two lists stay apart.
  for (const state of ['idle', 'listening', 'cue', 'paused', 'stopped']) {
    await picker.selectOption(state);
    await expect(realLines.getByRole('listitem')).toHaveCount(2);
    await expect(realLines).not.toContainText('Alex');
    if (['listening', 'cue', 'paused'].includes(state))
      await expect(exampleLines.getByRole('listitem')).toHaveText([
        'Alex (fictional line) Who can bring the first draft to the review?',
      ]);
    else await expect(example).toHaveCount(0);
    await expect(
      preview.locator('ol').filter({ hasText: 'garden gate' }),
    ).toHaveCount(1);
  }
  await page
    .getByRole('button', { name: 'Stop live session', exact: true })
    .press('Enter');
  await expect(real).toContainText(
    'From the live session that has ended, transcribed on this device.',
  );
  await expect(realLines.getByRole('listitem')).toHaveCount(2);
  await expect(preview).not.toContainText('A real live session is running');
});

test('a long session shows the latest lines and says where the rest are', async ({
  page,
}) => {
  await native(page);
  await page
    .getByRole('button', { name: 'Start live session', exact: true })
    .press('Enter');
  for (let line = 1; line <= 7; line++)
    await say(page, `Fictional line number ${line}.`);
  const { real, realLines } = await openPreview(page);
  await expect(real).toContainText(
    'Showing the latest 5 of 7; the notebook’s Transcript tab has all of them.',
  );
  await expect(realLines.getByRole('listitem')).toHaveCount(5);
  await expect(realLines.getByRole('listitem').first()).toContainText(
    'Fictional line number 3.',
  );
  await expect(realLines.getByRole('listitem').last()).toContainText(
    'Fictional line number 7.',
  );
});

test('headings and list names tell a screen reader which lines are real', async ({
  page,
}) => {
  await native(page);
  await page
    .getByRole('button', { name: 'Start live session', exact: true })
    .press('Enter');
  await say(page, 'A fictional spoken line.');
  const { preview, picker, realLines, exampleLines } = await openPreview(page);
  await picker.selectOption('listening');
  // The real heading sits beside the fictional conversation heading, not
  // under it.
  await expect(
    preview.getByRole('heading', {
      name: 'Real Transcript',
      exact: true,
      level: 2,
    }),
  ).toBeVisible();
  await expect(
    preview.getByRole('heading', {
      name: 'Fictional planning conversation',
      level: 2,
    }),
  ).toBeVisible();
  await expect(
    preview.getByRole('heading', {
      name: 'Simulated Example conversation',
      exact: true,
    }),
  ).toBeVisible();
  await expect(realLines).toBeVisible();
  await expect(exampleLines).toBeVisible();
  // WebKit drops list semantics under list-style none unless the role is set.
  await expect(realLines).toHaveAttribute('role', 'list');
  // The real lines come before the fictional conversation heading, so they
  // are not read as part of it.
  const order = await preview.evaluate((root) => {
    const real = root.querySelector('[aria-label="Real transcript lines"]')!;
    const fictional = [...root.querySelectorAll('h2')].find((heading) =>
      heading.textContent?.includes('Fictional planning conversation'),
    )!;
    return !!(
      real.compareDocumentPosition(fictional) & Node.DOCUMENT_POSITION_FOLLOWING
    );
  });
  expect(order).toBe(true);
  // Each line belongs to exactly one list.
  await expect(
    preview.locator('ol').filter({ hasText: 'A fictional spoken line.' }),
  ).toHaveCount(1);
  await expect(
    preview.locator('ol').filter({ hasText: 'Who can bring the first draft' }),
  ).toHaveCount(1);
});

test('real lines fit a 480 pixel window', async ({ page }) => {
  await page.setViewportSize({ width: 480, height: 800 });
  await native(page);
  await page
    .getByRole('button', { name: 'Start live session', exact: true })
    .press('Enter');
  await say(
    page,
    'Averyveryverylongfictionalwordwithoutanyspacesatalltocheckwrapping and some more fictional words after it.',
  );
  const { real } = await openPreview(page);
  await expect(real.getByRole('listitem')).toHaveCount(1);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(480);
});
