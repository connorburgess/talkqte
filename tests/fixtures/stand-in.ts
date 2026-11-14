// Browser tests only. Serves the app on the fictional native stand-in
// (native-microphone.ts) instead of the browser adapter, so a test can run a
// live session and raise a cue without a device, model or transcription.
import type { Page } from '@playwright/test';
import type { Cue } from '../../src/lib/types';
import type {} from './native-microphone';

/** A fictional line and the phrase-rule question the stand-in raises for it. */
export const firstLine =
  'Agreed. Someone can take the first draft of the welcome guide.';
export const firstCue = 'Who will take the first draft?';

/** Opens the notebook, or the companion with `?window=cue`, on the stand-in. */
export async function standIn(page: Page, path = '/') {
  await page.route(/:\d+\/(\?.*)?$/, async (route) => {
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
  await page.goto(path);
  await page.waitForFunction(() => !!window.liveTest);
}

/** Starts the stand-in's live session: no microphone is opened. */
export async function startLive(page: Page) {
  await page.evaluate(() => window.liveTest.start());
}

/** Starts a live session and raises its first cue from a fictional line. */
export async function liveCue(
  page: Page,
  line = firstLine,
  question = firstCue,
) {
  await startLive(page);
  await page.evaluate(
    ([text, cue]) => window.liveTest.say(text, cue),
    [line, question],
  );
}

/** A complete fictional cue for `liveTest.setCue`. */
export function cue(value: Partial<Cue> & Pick<Cue, 'kind' | 'question'>): Cue {
  return {
    id: `live:${value.kind}`,
    evidence: value.question,
    sourceId: 't1-0-0',
    remainingMs: 18_000,
    totalMs: 18_000,
    held: false,
    resolvedBy: null,
    note: null,
    aboutFocus: false,
    ...value,
  };
}
