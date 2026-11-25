import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { firstLine, standIn, startLive } from './fixtures/stand-in';

// Fictional dock checks for the "Call ended" prompt surfaced while a live
// session is running when a previously active call's camera and mic go inactive.

async function companion(page: Page, size: 'standard' | 'large' = 'standard') {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({
    width: 320,
    height: size === 'large' ? 276 : 232,
  });
  await standIn(page, '/?window=cue&live');
  await startLive(page);
  if (size === 'large') {
    await page.evaluate(() => window.liveTest.setQuestionSize('large'));
  }
}

test('Call ended dock prompt renders cleanly, passes accessibility checks, and Keep recording continues the live session', async ({
  page,
}) => {
  await companion(page);
  await page.evaluate(() =>
    window.liveTest.publish({
      callEndPrompt: { id: 11 },
      transcript: [
        {
          id: 't1-0-0',
          atMs: 2_000,
          speaker: 'You',
          text: 'Someone can check the greenhouse roof before Friday.',
        },
      ],
    }),
  );

  const card = page.getByRole('region', { name: 'Call ended' });
  await expect(card).toBeVisible();
  await expect(card).toContainText('Call ended');
  await expect(card).toContainText('Camera and mic look inactive.');

  const stopAndSave = card.getByRole('button', { name: 'Stop & save' });
  const keepRecording = card.getByRole('button', { name: 'Keep recording' });
  await expect(stopAndSave).toBeVisible();
  await expect(keepRecording).toBeVisible();

  // Fits 320x232 companion viewport with >= 44px hit targets and zero overflow.
  const bounds = await page.evaluate(() => ({
    width: document.documentElement.scrollWidth,
    height: document.querySelector('main')!.scrollHeight,
    innerWidth,
    innerHeight,
  }));
  expect(bounds.width).toBeLessThanOrEqual(bounds.innerWidth);
  expect(bounds.height).toBeLessThanOrEqual(bounds.innerHeight);
  for (const button of await card.getByRole('button').all()) {
    const box = await button.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    expect(box!.width).toBeGreaterThanOrEqual(44);
  }

  const axe = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .disableRules(['color-contrast'])
    .analyze();
  expect(axe.violations).toEqual([]);

  // Keep recording sends keepRecording, clears the card, and keeps the session running.
  await keepRecording.click();
  await expect(card).toHaveCount(0);
  expect(
    await page.evaluate(() => window.captureTest.callEndPromptAnswers),
  ).toEqual([{ id: 11, answer: 'keepRecording' }]);
  expect(await page.evaluate(() => window.liveTest.session().status)).toBe(
    'running',
  );
  expect(await page.evaluate(() => window.historyTest.meetings())).toEqual([]);
});

test('Stop & save ends the live session, saves the meeting, and transitions to Meeting saved', async ({
  page,
}) => {
  await companion(page);
  await page.evaluate(
    (line) =>
      window.liveTest.publish({
        callEndPrompt: { id: 12 },
        transcript: [{ id: 't1-0-0', atMs: 1_500, speaker: 'You', text: line }],
        notes: 'Confirm the orchard gate latch.',
      }),
    firstLine,
  );

  const card = page.getByRole('region', { name: 'Call ended' });
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: 'Stop & save' }).click();

  expect(
    await page.evaluate(() => window.captureTest.callEndPromptAnswers),
  ).toEqual([{ id: 12, answer: 'stopAndSave' }]);
  expect(await page.evaluate(() => window.liveTest.session().status)).toBe(
    'ended',
  );
  await expect(
    page.getByRole('region', { name: 'Meeting saved' }),
  ).toBeVisible();
  const meetings = await page.evaluate(() => window.historyTest.meetings());
  expect(meetings).toHaveLength(1);
  expect(meetings[0].notes).toBe('Confirm the orchard gate latch.');
});

test('Call ended dock card fits large text and bottom-anchored placement', async ({
  page,
}) => {
  await companion(page, 'large');
  await page.evaluate(async () => {
    await window.liveTest.anchor('bottom');
    await window.liveTest.publish({ callEndPrompt: { id: 13 } });
  });

  const card = page.getByRole('region', { name: 'Call ended' });
  await expect(card).toBeVisible();
  await expect(page.locator('.companion-shell')).toHaveClass(/is-bottom/);
  const bounds = await page.evaluate(() => ({
    width: document.documentElement.scrollWidth,
    height: document.querySelector('main')!.scrollHeight,
    innerWidth,
    innerHeight,
  }));
  expect(bounds.width).toBeLessThanOrEqual(bounds.innerWidth);
  expect(bounds.height).toBeLessThanOrEqual(bounds.innerHeight);
  for (const button of await card.getByRole('button').all()) {
    const box = await button.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
  }
});

test('Stop & save also saves immediately when Kept meetings is set to Ask each time', async ({
  page,
}) => {
  await companion(page);
  await page.evaluate(async () => {
    window.historyTest.setAfterSessionKeep('ask');
    await window.liveTest.publish({
      callEndPrompt: { id: 14 },
      transcript: [
        {
          id: 't1-0-0',
          atMs: 1_000,
          speaker: 'You',
          text: 'Someone should send the garden schedule.',
        },
      ],
    });
  });

  await page
    .getByRole('region', { name: 'Call ended' })
    .getByRole('button', { name: 'Stop & save' })
    .click();

  await expect(
    page.getByRole('region', { name: 'Meeting saved' }),
  ).toBeVisible();
  expect(await page.evaluate(() => window.historyTest.meetings())).toHaveLength(
    1,
  );
});
