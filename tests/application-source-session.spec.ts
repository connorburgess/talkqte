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

test("focus stays in the panel when the source's own Stop goes away", async ({
  page,
}) => {
  const panel = await panelAlone(page);
  await sendAlone(page, {
    capture: 'running',
    microphone: 'off',
    source: source('listening', true),
  });
  await panel
    .getByRole('button', { name: 'Stop application audio', exact: true })
    .click();
  // Stop is under way; the button is replaced by the stopping line.
  await sendAlone(page, {
    capture: 'stopping',
    microphone: 'off',
    source: source('stopping', true),
  });
  await expect(
    panel.getByRole('button', { name: 'Stop application audio' }),
  ).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const panel = document
          .querySelector('#processing-title')
          ?.closest('section');
        return !!panel && panel.contains(document.activeElement);
      }),
    )
    .toBe(true);
});

test('with the microphone not off, nothing says the microphone is not used', async ({
  page,
}) => {
  const { microphone } = await notebook(page);
  await page.evaluate(() => window.liveTest.start());
  // The fixture's live start leaves the microphone listening; a source
  // reported as having its own session must not be believed over it.
  await page.evaluate((value) => window.captureTest.send(value), {
    capture: 'running',
    microphone: 'running',
    source: source('listening', true),
  } satisfies Partial<ProcessingSnapshot>);
  await expect(microphone).toContainText(
    'Your microphone is transcribed on this device.',
  );
  await expect(microphone).not.toContainText('the microphone is not used');
  await page
    .getByRole('group', { name: 'Layout', exact: true })
    .getByRole('button', { name: 'Layout preview', exact: true })
    .press('Enter');
  const preview = page.getByRole('region', {
    name: 'Live session layout preview',
  });
  await expect(preview).not.toContainText('The microphone is not used');
});

test('the live layout follows the source session through starting and stopping', async ({
  page,
}) => {
  await notebook(page);
  await sourceSession(page, 'starting');
  await page
    .getByRole('group', { name: 'Layout', exact: true })
    .getByRole('button', { name: 'Layout preview', exact: true })
    .press('Enter');
  const preview = page.getByRole('region', {
    name: 'Live session layout preview',
  });
  await expect(preview).toContainText(
    'No lines yet. Application audio is starting.',
  );
  await expect(preview).not.toContainText('Lines from the application appear');
  // The live session is finishing: the Capture row says so, not "running".
  await page.evaluate((value) => window.captureTest.send(value), {
    phase: 'stopping',
    capture: 'stopping',
    microphone: 'off',
    source: source('stopping', true),
  } satisfies Partial<ProcessingSnapshot>);
  await expect(preview).not.toContainText(
    'Live session running from application audio',
  );
});

// The companion has no processing snapshot; the cue snapshot's flag tells it.

test('the companion names application audio for a session with no microphone, never a bare Off', async ({
  page,
}) => {
  await fixture(page, '/tests/fixtures/native-microphone.ts');
  await page.goto('/?window=cue');
  await page.evaluate(() => window.liveTest.start());
  await page.evaluate((value) => window.microphoneTest.send(value), {
    status: 'off' as const,
    canStart: true,
    message: null,
    deviceName: null,
  });
  // A live session whose microphone stopped, as without a source: as before.
  await expect(page.getByRole('status')).toHaveText('Off');
  await page.evaluate(() => window.liveTest.setSourceSession(true));
  await expect(page.getByRole('status')).toHaveText('App audio · Local');
  const pause = page.getByRole('button', { name: 'Pause cues' });
  await expect(pause).toHaveAttribute(
    'title',
    'Pause cues; application audio and transcript continue',
  );
  await pause.click();
  await expect(page.getByRole('status')).toHaveText('App audio still on');
  // The flag is gone once the source stops: no longer claimed.
  await page.evaluate(() => window.liveTest.setSourceSession(false));
  await expect(page.getByRole('status')).not.toHaveText(/App audio/);
});

test('the session strip and Transcript tab credit the application, not the microphone', async ({
  page,
}) => {
  await notebook(page);
  await sourceSession(page, 'listening');
  await expect(page.locator('.notebook-body')).toContainText(
    'Audio from Fictional player · transcribed on this device · not saved',
  );
  await expect(page.locator('.notebook-body')).not.toContainText(
    'Your microphone · transcribed on this device',
  );
  await page.getByRole('tab', { name: /Transcript/ }).click();
  await expect(
    page.getByText('Audio from Fictional player · transcribed on this device', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByText(
      'Lines from the application appear here a few seconds after they are heard.',
    ),
  ).toBeVisible();
});

test('a stale source-session flag beside a listening microphone credits the microphone', async ({
  page,
}) => {
  const { microphone } = await notebook(page);
  await sourceSession(page, 'listening');
  // The microphone hook reports listening before the next processing
  // snapshot, which still says the microphone is off.
  await page.evaluate((value) => window.microphoneTest.send(value), {
    status: 'listening' as const,
    canStart: false,
    message: null,
    deviceName: 'Fictional USB microphone',
  });
  await expect(microphone).not.toContainText('the microphone is not used');
  await expect(page.locator('.notebook-body')).toContainText(
    'Your microphone · transcribed on this device · not saved',
  );
  // Nor while the source is stopping or failed, whatever the flag says.
  await page.evaluate((value) => window.microphoneTest.send(value), {
    status: 'off' as const,
    canStart: true,
    message: null,
    deviceName: null,
  });
  for (const phase of ['stopping', 'cleanupFailed', 'abandoned'] as const) {
    await page.evaluate((value) => window.captureTest.send(value), {
      capture: 'stopping',
      microphone: 'off',
      source: source(phase, true),
    } satisfies Partial<ProcessingSnapshot>);
    await expect(microphone, phase).not.toContainText(
      'the microphone is not used',
    );
    await expect(page.locator('.notebook-body'), phase).not.toContainText(
      'Audio from Fictional player · transcribed',
    );
  }
});

test('an ordinary session draining is not described as application audio', async ({
  page,
}) => {
  await notebook(page);
  await page.evaluate(() => window.liveTest.start());
  await page.evaluate((value) => window.microphoneTest.send(value), {
    status: 'off' as const,
    canStart: true,
    message: null,
    deviceName: null,
  });
  // A development build always reports a source; here it is off.
  await page.evaluate((value) => window.captureTest.send(value), {
    phase: 'stopping',
    capture: 'off',
    microphone: 'off',
    source: source('off', false),
  } satisfies Partial<ProcessingSnapshot>);
  const body = page.locator('.notebook-body');
  await expect(body).toContainText(
    'Waiting for microphone release and remaining transcription.',
  );
  await expect(body).not.toContainText('Application audio is shown');
  // A source that may still be capturing is named while the session ends.
  await page.evaluate((value) => window.captureTest.send(value), {
    phase: 'stopping',
    capture: 'stopping',
    microphone: 'off',
    source: source('stopping', true),
  } satisfies Partial<ProcessingSnapshot>);
  await expect(body).toContainText(
    'Ending the live session. Application audio is shown under Cue processing.',
  );
});

test('the live layout cue controls credit the application in a session with no microphone', async ({
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
  const pause = preview.locator('.mock-real-pause');
  await expect(pause).toHaveAttribute(
    'title',
    'Clear the current cue; application audio and transcript continue.',
  );
  await pause.click();
  await expect(preview).toContainText(
    'Cues are paused; the application audio and transcript continue.',
  );
  await expect(preview).not.toContainText(
    'the microphone and transcript continue',
  );
});
