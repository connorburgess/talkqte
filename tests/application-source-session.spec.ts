import { expect, test, type Page } from '@playwright/test';
import type { ProcessingSnapshot, SourceCapture } from '../src/lib/processing';
import type {} from './fixtures/native-processing';
import type {} from './fixtures/native-microphone';

// A development build can start a live session fed by one selected
// application alone, with no microphone, and gives that source its own Stop.
// The fixtures stand in for the native side; no device, stream or permission
// is involved, so these checks establish the interface, not capture.

function source(
  phase: SourceCapture['phase'],
  sourceSession: boolean,
): SourceCapture {
  return {
    phase,
    mayBeCapturing: !['off', 'listing', 'reviewing'].includes(phase),
    stalled: false,
    canRetry: phase === 'cleanupFailed',
    application: 'Fictional player',
    problem: phase === 'cleanupFailed' ? 'stopFailed' : null,
    operation: 'fictional-operation',
    sourceSession,
  };
}

async function fixture(page: Page, file: string) {
  await page.route('**/*', async (route) => {
    if (route.request().resourceType() !== 'document') return route.continue();
    const response = await route.fetch();
    await route.fulfill({
      response,
      body: (await response.text()).replace('/src/main.tsx', file),
    });
  });
  await page.goto('/');
}

async function panelAlone(page: Page) {
  await fixture(page, '/tests/fixtures/native-processing.tsx');
  await expect(
    page.getByRole('heading', { name: 'Cue processing' }),
  ).toBeVisible();
  return page.locator('#processing-title').locator('xpath=ancestor::section');
}

const sendAlone = (page: Page, value: Partial<ProcessingSnapshot>) =>
  page.evaluate((value) => window.processingTest.send(value), value);

test('a starting or capturing source has its own Stop, even with the microphone off', async ({
  page,
}) => {
  const panel = await panelAlone(page);
  const own = panel.getByRole('button', {
    name: 'Stop application audio',
    exact: true,
  });
  for (const phase of ['starting', 'listening'] as const) {
    await sendAlone(page, {
      capture: phase === 'listening' ? 'running' : 'starting',
      microphone: 'off',
      source: source(phase, true),
    });
    await expect(own, phase).toBeEnabled();
    // The microphone's Stop concerns the microphone, which is off.
    await expect(
      panel.getByRole('button', { name: 'Stop capture', exact: true }),
      phase,
    ).toHaveCount(0);
  }
  await own.click();
  const asked = await page.evaluate(() =>
    window.processingTest.calls.filter(
      (call) => call.command === 'application_audio',
    ),
  );
  expect(asked).toEqual([
    {
      command: 'application_audio',
      args: { action: { kind: 'stop', operation: 'fictional-operation' } },
    },
  ]);
  // Nothing else was stopped on its behalf.
  expect(
    await page.evaluate(() =>
      window.processingTest.calls.filter(
        (call) => call.command === 'stop_capture',
      ),
    ),
  ).toEqual([]);
});

test('once Stop is under way, failed or abandoned, the source offers no Stop of its own', async ({
  page,
}) => {
  const panel = await panelAlone(page);
  for (const phase of [
    'stopping',
    'cleanupFailed',
    'abandoned',
    'off',
  ] as const) {
    await sendAlone(page, {
      capture: phase === 'off' ? 'off' : 'stopping',
      microphone: 'off',
      source: source(phase, true),
    });
    await expect(
      panel.getByRole('button', { name: 'Stop application audio' }),
      phase,
    ).toHaveCount(0);
  }
  // Nor does a snapshot without the development fields.
  await sendAlone(page, {
    capture: 'running',
    microphone: undefined,
    source: undefined,
  });
  await expect(
    panel.getByRole('button', { name: 'Stop application audio' }),
  ).toHaveCount(0);
});

// The notebook, with the full app on the fictional native side.

async function notebook(page: Page) {
  await fixture(page, '/tests/fixtures/native-microphone.ts');
  return {
    microphone: page.getByRole('region', { name: 'Microphone', exact: true }),
    panel: page.getByRole('region', { name: 'Cue processing', exact: true }),
  };
}

async function sourceSession(page: Page, phase: SourceCapture['phase']) {
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
    source: source(phase, true),
  } satisfies Partial<ProcessingSnapshot>);
}

test('a session for an application alone never says the microphone is transcribed', async ({
  page,
}) => {
  const { microphone, panel } = await notebook(page);
  await sourceSession(page, 'listening');
  await expect(microphone).toContainText(
    'Audio from Fictional player is transcribed on this device; the microphone is not used. Audio is not recorded.',
  );
  await expect(microphone).toContainText('Stop live session to end it.');
  await expect(microphone).not.toContainText('Your microphone is transcribed');
  await expect(microphone).not.toContainText('release the microphone');
  await expect(
    page.getByRole('button', { name: 'Stop live session', exact: true }),
  ).toBeEnabled();
  // The source's own Stop sits with its line and asks only for it.
  await panel
    .getByRole('button', { name: 'Stop application audio', exact: true })
    .click();
  expect(
    await page.evaluate(() => window.captureTest.applicationAudio),
  ).toEqual([{ action: { kind: 'stop', operation: 'fictional-operation' } }]);
});

test('an ordinary live session keeps its microphone wording', async ({
  page,
}) => {
  const { microphone } = await notebook(page);
  await page.evaluate(() => window.liveTest.start());
  await expect(microphone).toContainText(
    'Your microphone is transcribed on this device. Audio is not recorded.',
  );
  await expect(microphone).toContainText(
    'Stop live session to release the microphone.',
  );
});

test('the live layout says a source session runs without the microphone', async ({
  page,
}) => {
  await notebook(page);
  await sourceSession(page, 'listening');
  await page
    .getByRole('group', { name: 'Layout', exact: true })
    .getByRole('button', { name: 'Layout preview', exact: true })
    .press('Enter');
  const preview = page.getByRole('region', {
    name: 'Live session layout preview',
  });
  const frame = preview.getByRole('group', { name: 'Session layout preview' });
  const row = (name: string) =>
    frame.locator('dt', { hasText: name }).locator('+ dd');
  await expect(row('Capture')).toHaveText(
    'Real Live session running from application audio. The microphone is not used.',
  );
  await expect(row('Application audio')).toHaveText(
    'Real Application audio from Fictional player is being captured, including all of its windows.',
  );
  await expect(preview).toContainText(
    'No lines yet. Lines from the application appear a few seconds after they are heard.',
  );
  await expect(preview).not.toContainText('The microphone is not listening');
});
