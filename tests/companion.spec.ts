import { expect, test, type Page } from '@playwright/test';
import {
  cue,
  firstCue,
  firstLine,
  standIn,
  startLive,
} from './fixtures/stand-in';

// The fictional native stand-in supplies a live session's snapshots without a
// device or transcription. These tests exercise companion controls; native
// placement is checked separately.

const say = (page: Page, text = firstLine, question = firstCue) =>
  page.evaluate(
    ([line, asked]) => window.liveTest.say(line, asked),
    [text, question],
  );

async function expectCompanionToFit(page: Page) {
  const bounds = await page.evaluate(() => ({
    width: document.documentElement.scrollWidth,
    height: document.querySelector('main')!.scrollHeight,
    viewportWidth: innerWidth,
    viewportHeight: innerHeight,
  }));
  expect(bounds.width, 'companion width').toBeLessThanOrEqual(
    bounds.viewportWidth,
  );
  expect(bounds.height, 'companion height').toBeLessThanOrEqual(
    bounds.viewportHeight,
  );
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 420, height: 420 });
  await standIn(page, '/?window=cue');
  await expect(
    page.getByText(
      'Start a live session or the microphone check in your notebook.',
    ),
  ).toBeVisible();
  await expect(page.getByRole('button')).toHaveCount(0);
  await startLive(page);
});

test('companion stays compact between cues and returns to its bar after Dismiss', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 76 });
  await expect(page.getByRole('status')).toHaveText('Mic on · Local');
  await expect(page.getByRole('button', { name: 'Pause cues' })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Stop live session' }),
  ).toHaveText('Stop');
  await expect(page.getByRole('button', { name: 'Hide companion' })).toHaveText(
    'Hide',
  );
  for (const button of await page.getByRole('button').all()) {
    const bounds = await button.boundingBox();
    expect(bounds!.width).toBeGreaterThanOrEqual(44);
    expect(bounds!.height).toBeGreaterThanOrEqual(44);
  }
  await expectCompanionToFit(page);
  await say(page);
  await page.setViewportSize({ width: 420, height: 420 });
  await expect(page.getByRole('heading', { name: firstCue })).toBeVisible();
  await expectCompanionToFit(page);
  await page.getByRole('button', { name: 'Dismiss' }).click();
  await expect(
    page.getByRole('region', { name: 'Suggested question' }),
  ).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Pause cues' })).toBeVisible();
  await expect(page.getByRole('status')).toHaveText('Mic on · Local');
});

test('a question fits the narrow window used on a small display', async ({
  page,
}) => {
  // The native window is 360 CSS px wide on a display under 1100 logical px.
  // Measured without the entrance animation, which scales the card briefly.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 360, height: 340 });
  await say(page);
  const question = page.getByRole('region', { name: 'Suggested question' });
  await expect(question.getByRole('heading')).toHaveText(firstCue);
  const fitsSideways = () =>
    page.evaluate(() => {
      const main = document.querySelector('main')!;
      return main.scrollWidth <= main.clientWidth;
    });
  await expectCompanionToFit(page);
  expect(await fitsSideways()).toBe(true);
  for (const button of await question.getByRole('button').all()) {
    const bounds = await button.boundingBox();
    expect(bounds!.height).toBeGreaterThanOrEqual(44);
  }
  // The source is in view from the start, and holding the cue keeps the
  // window at the same size.
  await expect(question.locator('blockquote')).toBeVisible();
  await question.getByRole('button', { name: 'Hold', exact: true }).click();
  await expect(
    question.getByRole('button', { name: 'Held', exact: true }),
  ).toBeVisible();
  await expectCompanionToFit(page);
  expect(await fitsSideways()).toBe(true);
  // Large text in the same narrow window: 420 px tall.
  await page.evaluate(() => window.liveTest.setQuestionSize('large'));
  await page.setViewportSize({ width: 360, height: 420 });
  await expectCompanionToFit(page);
  expect(await fitsSideways()).toBe(true);
});

test('the companion switches between only what matters and all questions', async ({
  page,
}) => {
  const focus = page.getByRole('button', { name: 'Show only what matters' });
  await expect(focus).toHaveAttribute('aria-pressed', 'false');
  await focus.click();
  const all = page.getByRole('button', { name: 'Show all questions' });
  await expect(all).toHaveAttribute('aria-pressed', 'true');
  await all.click();
  await expect(
    page.getByRole('button', { name: 'Show only what matters' }),
  ).toHaveAttribute('aria-pressed', 'false');
});

test('the companion bar is the native drag handle and its controls are not', async ({
  page,
}) => {
  const bar = page.locator('header.companion-bar');
  await expect(bar).toHaveAttribute('data-tauri-drag-region', /.*/);
  await expect(page.getByRole('status')).toHaveAttribute(
    'data-tauri-drag-region',
    /.*/,
  );
  for (const button of await bar.getByRole('button').all()) {
    await expect(button).not.toHaveAttribute('data-tauri-drag-region');
  }
});

test('hiding the companion suppresses later cues and its controls', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Hide companion' }).click();
  await expect(
    page.getByText('Companion hidden. Show it again in Settings.'),
  ).toBeVisible();
  await say(page);
  await expect(
    page.getByRole('region', { name: 'Suggested question' }),
  ).toHaveCount(0);
  await expect(page.getByRole('button')).toHaveCount(0);
  await page.evaluate(() =>
    window.liveTest.publish({ status: 'ended', cue: null }),
  );
  await expect(page.getByRole('button')).toHaveCount(0);
});

test('question controls remain usable with reduced motion and longer wrapping', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await say(page);
  await expect(
    page.getByRole('button', { name: 'Dismiss', exact: true }),
  ).toBeVisible();
  await expectCompanionToFit(page);
  await expect(
    page.getByRole('button', { name: 'Dismiss', exact: true }),
  ).toHaveCSS('transition-duration', '0s');
  const question = page.getByRole('region', { name: 'Suggested question' });
  await expect(question).not.toContainText(/\b\d+s\b/);
  for (const button of await question.getByRole('button').all()) {
    const bounds = await button.boundingBox();
    expect(bounds!.height).toBeGreaterThanOrEqual(44);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(420);
  }
  await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await expect(
    page.getByRole('region', { name: 'Suggested question' }),
  ).toHaveCount(0);
});

test('a cue that passes untouched leaves the bar, with no countdown shown meanwhile', async ({
  page,
}) => {
  await say(page);
  const question = page.getByRole('region', { name: 'Suggested question' });
  await expect(question).toBeVisible();
  await expect(question).not.toContainText(/\b\d+s\b/);
  await page.evaluate(() => window.liveTest.setCue(null));
  await expect(question).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Pause cues' })).toBeVisible();
  await expect(page.getByRole('status')).toHaveText('Mic on · Local');
});

const soon = 'We should have it ready soon, before the next visitors arrive.';
const friday = "A single page sounds right. Let's have it ready by Friday.";

test('a quoted line says it is word for word and can be kept', async ({
  page,
}) => {
  await say(page, soon, 'What date should we aim for?');
  await expect(
    page.getByRole('heading', { name: 'What date should we aim for?' }),
  ).toBeVisible();
  // The answer replaces the question, as the engine does when a line
  // answers it: the words that answered are quoted.
  await page.evaluate((text) => window.liveTest.say(text), friday);
  await page.evaluate(
    (value) => window.liveTest.setCue(value),
    cue({
      kind: 'Said',
      question: "Let's have it ready by Friday.",
      evidence: friday,
      sourceId: 't1-0-1',
    }),
  );
  const question = page.getByRole('region', { name: 'Suggested question' });
  await expect(
    page.getByRole('heading', { name: 'What date should we aim for?' }),
  ).toHaveCount(0);
  await expect(question).toContainText("Let's have it ready by Friday");
  await expect(question).toContainText('Just said');
  await expect(question).toContainText('a date or commitment, word for word');
  await expect(
    question.getByRole('button', { name: 'Keep this line' }),
  ).toBeVisible();
  await expect(page.getByRole('status')).toHaveText('Mic on · Local');
});

test('an answered question being read stays and shows the answer', async ({
  page,
}) => {
  await say(page, soon, 'What date should we aim for?');
  await page.getByRole('button', { name: 'Hold', exact: true }).click();
  // A later line answers it; the held cue stays and carries the answer.
  await page.evaluate(async (text) => {
    await window.liveTest.say(text);
    const held = window.liveTest.session().cue!;
    await window.liveTest.setCue({
      ...held,
      resolvedBy: { sourceId: 't1-0-1', evidence: text },
    });
  }, friday);
  const question = page.getByRole('region', { name: 'Suggested question' });
  await expect(
    question.getByRole('heading', { name: 'What date should we aim for?' }),
  ).toBeVisible();
  await expect(
    question.getByRole('button', { name: 'Held', exact: true }),
  ).toBeVisible();
  await expect(question).toContainText('Answered later in the conversation');
  await expect(question.locator('blockquote').first()).toContainText(
    'ready by Friday',
  );
  // The line that raised the question stays below the answer.
  await expect(question.locator('blockquote').last()).toContainText(
    'We should have it ready soon',
  );
  await expectCompanionToFit(page);
  await page.evaluate(() => window.liveTest.setQuestionSize('large'));
  await page.setViewportSize({ width: 420, height: 420 });
  await expectCompanionToFit(page);
  await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await expect(question).toHaveCount(0);
});
