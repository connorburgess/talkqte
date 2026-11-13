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
type Stuck = 'stopping' | 'stalled' | 'cleanupFailed' | 'abandoned';
const microphones: Mic[] = ['off', 'starting', 'running'];
const stuck: Stuck[] = ['stopping', 'stalled', 'cleanupFailed', 'abandoned'];

function source(state: Stuck): SourceCapture {
  return {
    phase: state === 'stalled' ? 'stopping' : state,
    mayBeCapturing: true,
    stalled: state === 'stalled',
    canRetry: state === 'cleanupFailed',
    application: 'Fictional player',
    problem: state === 'cleanupFailed' ? 'stopFailed' : null,
  };
}

// What the native combination gives for each microphone state with a source
// that may still be capturing (see overall_capture in the host).
const combined = { off: 'stopping', starting: 'starting', running: 'running' };

const sourceWords: Record<Stuck, string> = {
  stopping:
    'Stopping application audio from Fictional player. It may be captured until macOS confirms.',
  stalled:
    'macOS has not confirmed that application audio from Fictional player stopped. It may still be captured.',
  cleanupFailed:
    'Stopping application audio from Fictional player failed. It may still be captured until cleanup is retried.',
  abandoned:
    'Application audio from Fictional player was never confirmed stopped. It may still be captured until TalkQTE quits.',
};

const microphoneWords: Record<Mic, string> = {
  off: 'Microphone is off.',
  starting: 'Starting microphone… you can stop while it starts.',
  running: 'Microphone is on. Stop capture to stop listening.',
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
  for (const mic of microphones)
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
  return { preview, source: row('Source'), capture: row('Capture') };
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
  const { preview, source: sourceRow, capture } = await livePreview(page);
  await expect(capture).toHaveText('Real Off. Nothing is being captured.');
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
      if (mic === 'off') {
        await expect(capture, label).toHaveText('Real The microphone is off.');
        await expect(sourceRow, label).toHaveText('Real No microphone open.');
      }
      const text = await realText(preview);
      expect(text, label).not.toMatch(
        /\bnothing\b.*captur|captur\w*\s+nothing|\bnot\b.*captur/i,
      );
    }
});

test('the live layout reads as before without the development fields', async ({
  page,
}) => {
  const { source: sourceRow, capture } = await livePreview(page);
  await page.evaluate((value) => window.captureTest.send(value), {
    capture: 'off',
  } satisfies Partial<ProcessingSnapshot>);
  await expect(sourceRow).toHaveText('Real None open.');
  await expect(capture).toHaveText('Real Off. Nothing is being captured.');
});
