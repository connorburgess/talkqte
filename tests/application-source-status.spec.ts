import { expect, test, type Locator, type Page } from '@playwright/test';
import type { ProcessingSnapshot, SourceCapture } from '../src/lib/processing';
import type { MicrophoneSnapshot } from '../src/lib/microphone';
import type {} from './fixtures/native-processing';
import type {} from './fixtures/native-microphone';

// A development build with the native-audio-spike feature reports a selected
// application beside the microphone: `microphone` alone, `source`, and a
// combined `capture`. These fixtures stand in for the native side; no device,
// stream or permission is involved, so they establish wording, not capture.

type Mic = 'off' | 'starting' | 'running';
type PanelMic = Mic | 'unknown';
type Stuck = 'stopping' | 'stalled' | 'cleanupFailed' | 'abandoned';
const microphones: Mic[] = ['off', 'starting', 'running'];
// The panel also sees an unknown microphone, which the live layout does not.
const panelMicrophones: PanelMic[] = [...microphones, 'unknown'];
const stuck: Stuck[] = ['stopping', 'stalled', 'cleanupFailed', 'abandoned'];

function source(state: Stuck): SourceCapture {
  return {
    phase: state === 'stalled' ? 'stopping' : state,
    mayBeCapturing: true,
    stalled: state === 'stalled',
    canRetry: state === 'cleanupFailed',
    application: 'Fictional player',
    problem: state === 'cleanupFailed' ? 'stopFailed' : null,
    operation: 'fictional-operation',
    sourceSession: false,
  };
}

// What the native combination gives for each microphone state with a source
// that may still be capturing (see overall_capture in the host).
const combined = {
  off: 'stopping',
  starting: 'starting',
  running: 'running',
  // Folded to stopping, never unknown: a source may still be capturing.
  unknown: 'stopping',
};

const sourceWords: Record<Stuck, string> = {
  stopping:
    'Stopping application audio from Fictional player. It may be captured until macOS confirms.',
  stalled:
    'macOS has not confirmed that application audio from Fictional player stopped. It may still be captured.',
  cleanupFailed:
    'Stopping application audio from Fictional player failed. It may still be captured. A retry exists only as a development command.',
  abandoned:
    'Application audio from Fictional player was never confirmed stopped. It may still be captured. Nothing in TalkQTE can stop it; whether quitting does has not been checked.',
};

const microphoneWords: Record<PanelMic, string> = {
  off: 'Microphone is off.',
  starting: 'Starting microphone… you can stop while it starts.',
  running: 'Microphone is on. Stop capture to stop listening.',
  unknown:
    'Microphone status is unknown. Use Stop capture to request that it stops.',
};

async function processingControl(page: Page) {
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

test('each stuck source reads in its own words beside the microphone', async ({
  page,
}) => {
  const panel = await processingControl(page);
  for (const mic of panelMicrophones)
    for (const state of stuck) {
      await send(page, {
        capture: combined[mic] as ProcessingSnapshot['capture'],
        microphone: mic,
        source: source(state),
      });
      const label = `${state} with microphone ${mic}`;
      await expect(panel.getByText(sourceWords[state]), label).toBeVisible();
      await expect(
        panel.getByText(microphoneWords[mic], { exact: true }),
        label,
      ).toBeVisible();
      // Stop concerns the microphone: offered while it is open, absent when
      // it is off, never shown as a disabled "Stopping…" for the source.
      const stop = panel.getByRole('button', { name: 'Stop capture' });
      if (mic === 'off') {
        await expect(stop, label).toHaveCount(0);
        await expect(
          panel.getByRole('button', { name: 'Stopping…' }),
          label,
        ).toHaveCount(0);
      } else await expect(stop, label).toBeEnabled();
    }
});

test('an unknown microphone keeps Stop usable during startup beside a stuck source', async ({
  page,
}) => {
  // As without a source: an unknown microphone offers Stop capture, which
  // also cancels startup, rather than claiming it is off.
  const panel = await processingControl(page);
  for (const state of stuck) {
    await send(page, {
      startup: 'loading',
      capture: 'stopping',
      microphone: 'unknown',
      source: source(state),
    });
    await expect(
      panel.getByRole('button', { name: 'Stop capture', exact: true }),
      state,
    ).toBeEnabled();
    await expect(panel.getByText(sourceWords[state]), state).toBeVisible();
  }
  await send(page, { startup: 'idle' });
});

test('Cancel start stays available while a stuck source keeps capture combined', async ({
  page,
}) => {
  const panel = await processingControl(page);
  for (const state of stuck) {
    await send(page, {
      startup: 'loading',
      capture: 'stopping',
      microphone: 'off',
      source: source(state),
    });
    await expect(
      panel.getByRole('button', { name: 'Cancel start', exact: true }),
      state,
    ).toBeEnabled();
    await expect(panel.getByText(sourceWords[state]), state).toBeVisible();
  }
  await send(page, { startup: 'idle' });
});

test('a snapshot without the development fields renders as before', async ({
  page,
}) => {
  const panel = await processingControl(page);
  const legacy: Record<
    ProcessingSnapshot['capture'],
    { words: string; stop: string | null }
  > = {
    running: { words: microphoneWords.running, stop: 'Stop capture' },
    starting: { words: microphoneWords.starting, stop: 'Stop capture' },
    stopping: {
      words: 'Waiting for the microphone to stop…',
      stop: 'Stopping…',
    },
    off: { words: 'Microphone is off.', stop: null },
    unknown: {
      words:
        'Microphone status is unknown. Use Stop capture to request that it stops.',
      stop: 'Stop capture',
    },
  };
  for (const [capture, expected] of Object.entries(legacy)) {
    await send(page, { capture: capture as ProcessingSnapshot['capture'] });
    await expect(
      panel.getByText(expected.words, { exact: true }),
    ).toBeVisible();
    await expect(panel.getByText(/Application audio/)).toHaveCount(0);
    if (expected.stop)
      await expect(
        panel.getByRole('button', { name: expected.stop, exact: true }),
      ).toBeVisible();
    else
      await expect(
        panel.getByRole('button', { name: 'Stop capture' }),
      ).toHaveCount(0);
  }
  // The same snapshot with the source off adds nothing either.
  await send(page, {
    capture: 'off',
    microphone: 'off',
    source: {
      phase: 'off',
      mayBeCapturing: false,
      stalled: false,
      canRetry: false,
      application: null,
      problem: null,
      operation: null,
      sourceSession: false,
    },
  });
  await expect(
    panel.getByText('Microphone is off.', { exact: true }),
  ).toBeVisible();
  await expect(panel.getByText(/Application audio/)).toHaveCount(0);
});

// The live layout preview's Real rows come from the notebook's microphone and
// processing snapshots.

async function livePreview(page: Page) {
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
  await page.goto('/');
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
  return {
    preview,
    source: row('Source'),
    capture: row('Capture'),
    application: row('Application audio'),
  };
}

const microphoneStates: Record<Mic, Partial<MicrophoneSnapshot>> = {
  off: { status: 'off', canStart: true, message: null, deviceName: null },
  starting: {
    status: 'starting',
    canStart: false,
    message: 'Checking microphone access…',
    deviceName: null,
  },
  running: {
    status: 'listening',
    canStart: false,
    message: null,
    deviceName: 'Fictional USB microphone',
  },
};

async function realText(preview: Locator) {
  // Sentences of the Real rows only; the simulated example is not about the app.
  const rows = await preview
    .locator('dd', {
      has: preview.page().locator('.mock-tag', { hasText: 'Real' }),
    })
    .allInnerTexts();
  return rows.join(' ');
}

test('the live layout never says nothing is captured while a source may be', async ({
  page,
}) => {
  const {
    preview,
    source: sourceRow,
    capture,
    application,
  } = await livePreview(page);
  await expect(capture).toHaveText('Real Off. Nothing is being captured.');
  await expect(application).toHaveCount(0);
  for (const mic of microphones)
    for (const state of stuck) {
      await page.evaluate(
        (value) => window.microphoneTest.send(value),
        microphoneStates[mic],
      );
      await page.evaluate((value) => window.captureTest.send(value), {
        capture: combined[mic] as ProcessingSnapshot['capture'],
        microphone: mic,
        source: source(state),
      } satisfies Partial<ProcessingSnapshot>);
      const label = `${state} with microphone ${mic}`;
      // The source has a row of its own, so the layout never shows capture
      // state without it.
      await expect(application, label).toHaveText(`Real ${sourceWords[state]}`);
      if (mic === 'off') {
        await expect(capture, label).toHaveText('Real The microphone is off.');
        await expect(sourceRow, label).toHaveText('Real No microphone open.');
      }
      // Sentence by sentence, as in the live layout's own checks: "not
      // confirmed … stopped" followed by "may still be captured" is true.
      const sentences = (await realText(preview))
        .split(/(?<=[.!?…])\s+|\n+/)
        .filter((sentence) => sentence && sentence !== 'Real');
      expect(sentences.length, label).toBeGreaterThan(2);
      for (const sentence of sentences)
        expect(sentence, label).not.toMatch(
          /\bnothing\b.*captur|captur\w*\s+nothing|\bnot\b.*captur/i,
        );
    }
});

test('the live layout reads as before without the development fields', async ({
  page,
}) => {
  const { source: sourceRow, capture, application } = await livePreview(page);
  await page.evaluate((value) => window.captureTest.send(value), {
    capture: 'off',
  } satisfies Partial<ProcessingSnapshot>);
  await expect(sourceRow).toHaveText('Real None open.');
  await expect(capture).toHaveText('Real Off. Nothing is being captured.');
  await expect(application).toHaveCount(0);
});

test('the live layout names Application audio among its real parts only with a source', async ({
  page,
}) => {
  const { preview } = await livePreview(page);
  const banner = preview.locator('.mock-banner');
  // Without the development fields, the text is as before.
  await expect(preview).toContainText(
    'Source, Capture, Transcript and Cue show the app’s real state, read-only. Everything else is a fictional example.',
  );
  await expect(banner).toContainText(
    'Source, Capture, Transcript and Cue are real and read-only',
  );
  await page.evaluate((value) => window.captureTest.send(value), {
    capture: 'stopping',
    microphone: 'off',
    source: source('abandoned'),
  } satisfies Partial<ProcessingSnapshot>);
  await expect(preview).toContainText(
    'Source, Capture, Application audio, Transcript and Cue show the app’s real state, read-only. Everything else is a fictional example.',
  );
  await expect(banner).toContainText(
    'Source, Capture, Application audio, Transcript and Cue are real and read-only',
  );
});

// The notebook itself, with the full app on the fictional native side.

async function notebook(page: Page) {
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
  await page.goto('/');
  return {
    microphone: page.getByRole('region', { name: 'Microphone', exact: true }),
    panel: page.getByRole('region', { name: 'Cue processing', exact: true }),
  };
}

const offSource: SourceCapture = {
  phase: 'off',
  mayBeCapturing: false,
  stalled: false,
  canRetry: false,
  application: null,
  problem: null,
  operation: null,
  sourceSession: false,
};

test('with no live session a stuck source keeps the panel visible until it is off', async ({
  page,
}) => {
  const { panel } = await notebook(page);
  await expect(panel).toBeHidden();
  for (const state of stuck) {
    await page.evaluate((value) => window.captureTest.send(value), {
      capture: 'stopping',
      microphone: 'off',
      source: source(state),
    } satisfies Partial<ProcessingSnapshot>);
    await expect(panel, state).toBeVisible();
    await expect(panel.getByText(sourceWords[state]), state).toBeVisible();
  }
  await page.evaluate((value) => window.captureTest.send(value), {
    capture: 'off',
    microphone: 'off',
    source: offSource,
  } satisfies Partial<ProcessingSnapshot>);
  await expect(panel).toBeHidden();
});

test('the microphone panel claims no system audio only when no source may be captured', async ({
  page,
}) => {
  const { microphone } = await notebook(page);
  const plain =
    'Activity check only. No recording, transcription, or system audio. Demo questions are scripted.';
  await expect(microphone).toContainText(plain);
  for (const state of stuck) {
    await page.evaluate((value) => window.captureTest.send(value), {
      capture: 'stopping',
      microphone: 'off',
      source: source(state),
    } satisfies Partial<ProcessingSnapshot>);
    await expect(microphone, state).not.toContainText('system audio');
    await expect(microphone, state).toContainText(
      'Activity check only. No recording or transcription from the microphone. Audio from a selected application may still be captured; see Cue processing below.',
    );
  }
  await page.evaluate((value) => window.captureTest.send(value), {
    capture: 'off',
    microphone: 'off',
    source: offSource,
  } satisfies Partial<ProcessingSnapshot>);
  await expect(microphone).toContainText(plain);
});

test('focus returns after Stop when only the microphone changes beside a stuck source', async ({
  page,
}) => {
  const panel = await processingControl(page);
  await send(page, {
    capture: 'running',
    microphone: 'running',
    source: source('cleanupFailed'),
  });
  await panel
    .getByRole('button', { name: 'Stop capture', exact: true })
    .click();
  // The combined state stays stopping throughout, because the source is
  // stuck; only the microphone moves from stopping to off.
  await send(page, { capture: 'stopping', microphone: 'stopping' });
  await expect(panel.getByRole('button', { name: 'Stopping…' })).toBeDisabled();
  await send(page, { capture: 'stopping', microphone: 'off' });
  await expect(
    page.getByRole('heading', { name: 'Cue processing' }),
  ).toBeFocused();
});

test('the source status is mounted before its first line, so the line is announced', async ({
  page,
}) => {
  const panel = await processingControl(page);
  await send(page, { source: offSource, microphone: 'running' });
  const live = panel.locator('p.processing-capture[role="status"]');
  await expect(live).toHaveCount(1);
  await expect(live).toHaveText('');
  // Mark this element, then check the line arrives in the same one.
  await live.evaluate((element) => element.setAttribute('data-probe', 'kept'));
  await send(page, {
    capture: 'stopping',
    microphone: 'off',
    source: source('stopping'),
  });
  await expect(panel.locator('[data-probe="kept"]')).toHaveText(
    sourceWords.stopping,
  );
  // Without the development fields there is no such element at all.
  await send(page, {
    source: undefined,
    microphone: undefined,
    capture: 'off',
  });
  await expect(live).toHaveCount(0);
});
