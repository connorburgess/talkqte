import { expect, test } from '@playwright/test';
import { firstCue, firstLine, liveCue, standIn } from './fixtures/stand-in';

// Cues here come from the fictional native stand-in's live session: no
// device, model or transcription is involved.

test('keyboard Dismiss returns to notes after removing a held question', async ({
  page,
}) => {
  await standIn(page, '/?live');
  await liveCue(page);
  const question = page.getByRole('region', { name: 'Suggested question' });
  const notes = page.getByRole('textbox', { name: 'Meeting notes' });
  // Native Tab navigation is checked separately; begin at the control so
  // this regression does not depend on the browser's tab-to-buttons setting.
  await question.getByRole('button', { name: 'Hold', exact: true }).focus();
  await page.keyboard.press('Enter');
  // Holding keeps focus on the same control, which now says the cue is held.
  const held = question.getByRole('button', { name: 'Held', exact: true });
  await expect(held).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(held).toBeFocused();
  await expect(question.locator('blockquote')).toBeVisible();
  await question.getByRole('button', { name: 'Dismiss' }).focus();
  await expect(question.getByRole('button', { name: 'Dismiss' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(question).toHaveCount(0);
  await expect(notes).toBeFocused();
  await page.keyboard.type('Fictional follow-up note.');
  await expect(notes).toHaveValue('Fictional follow-up note.');
});

test('a transcript reader returns to the selected tab after dismissing a question', async ({
  page,
}) => {
  await standIn(page, '/?live');
  await liveCue(page);
  const transcript = page.getByRole('tab', { name: /Transcript/ });
  await transcript.click();
  const dismiss = page.getByRole('button', { name: 'Dismiss', exact: true });
  await dismiss.focus();
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('region', { name: 'Suggested question' }),
  ).toHaveCount(0);
  await expect(transcript).toBeFocused();
  await expect(transcript).toHaveAttribute('aria-selected', 'true');
  await expect(
    page.getByRole('tabpanel', { name: /Transcript/ }),
  ).toBeVisible();
});

test('a cue that passes, arrives or is answered elsewhere leaves the current notebook control focused', async ({
  page,
}) => {
  await standIn(page, '/?live');
  await liveCue(page);
  const question = page.getByRole('region', { name: 'Suggested question' });
  await expect(question).toBeVisible();
  const other = page.getByRole('button', { name: 'Settings', exact: true });
  await other.focus();
  // The cue passes untouched, as an expiry does.
  await page.evaluate(() => window.liveTest.setCue(null));
  await expect(question).toHaveCount(0);
  await expect(other).toBeFocused();
  // A later line raises another cue.
  await page.evaluate(() =>
    window.liveTest.say(
      'We should have it ready soon.',
      'What date should we aim for?',
    ),
  );
  await expect(question).toBeVisible();
  await expect(other).toBeFocused();
  // The companion window dismisses it; the notebook only receives the
  // resulting snapshot, which must not move focus.
  await page.evaluate(() => window.liveTest.setCue(null));
  await expect(question).toHaveCount(0);
  await expect(other).toBeFocused();
});

test('a delayed Dismiss acknowledgement does not take focus back from another notebook control', async ({
  page,
}) => {
  await standIn(page, '/?live');
  await liveCue(page);
  await page.evaluate(() => window.questionTest.holdNextResponse());
  const question = page.getByRole('region', { name: 'Suggested question' });
  await question.getByRole('button', { name: 'Dismiss' }).focus();
  await page.keyboard.press('Enter');
  // The shared snapshot removes the card before the command acknowledges it.
  await expect(question).toHaveCount(0);
  await expect(page.getByText('Question dismissed.')).toBeHidden();
  const other = page.getByRole('button', { name: 'Settings', exact: true });
  await other.focus();
  await page.evaluate(() => window.questionTest.releaseResponse());
  await expect(page.getByText('Question dismissed.')).toBeVisible();
  await expect(other).toBeFocused();
});

test('the source shows without a click, and Hold keeps a question through later lines and the end of the session', async ({
  page,
}) => {
  await standIn(page, '/?live');
  await liveCue(page);
  const question = page.getByRole('region', { name: 'Suggested question' });
  const source = question.getByText(`“${firstLine}”`);
  await expect(source).toBeVisible();
  await expect(question).toContainText('You could ask');
  await expect(question).toContainText('From this conversation');
  // No disclosure is left to open.
  await expect(question.locator('[aria-expanded]')).toHaveCount(0);
  await question.getByRole('button', { name: 'Hold', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(
    question.getByRole('button', { name: 'Held', exact: true }),
  ).toBeFocused();
  // Holding does not ask for the taller window that opening context used.
  expect(
    await page.evaluate(() => window.liveTest.session().cue),
  ).toMatchObject({ held: true, expanded: false });
  // Its time passes and a later line is heard; the held cue stays.
  await page.evaluate(async () => {
    const held = window.liveTest.session().cue!;
    await window.liveTest.setCue({ ...held, remainingMs: 0 });
    await window.liveTest.say('We should have it ready soon.');
  });
  await expect(question.getByRole('heading')).toHaveText(firstCue);
  await expect(question).toContainText('From earlier in this conversation');
  await expect(source).toBeVisible();
  // The session ends with the held cue still showing.
  await page.evaluate(() => window.liveTest.publish({ status: 'ended' }));
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'Live session ended',
  );
  await expect(question.getByRole('heading')).toHaveText(firstCue);
  await question.getByRole('button', { name: 'Dismiss' }).click();
  await expect(question).toHaveCount(0);
});

test('appearance controls are discoverable, apply to cues, and last into the next session', async ({
  page,
}) => {
  await standIn(page, '/?live');
  await page
    .getByRole('button', { name: 'Question appearance & timing' })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Glance view' }),
  ).toBeVisible();
  await expect(page.getByLabel('Question text')).toHaveValue('standard');
  await expect(page.getByLabel('Position', { exact: true })).toHaveValue(
    'bottomRight',
  );
  await page.getByLabel('Question text').selectOption('large');
  await page.getByLabel('Position', { exact: true }).selectOption('topCenter');
  await page.getByRole('button', { name: 'Notebook', exact: true }).click();
  const size = await page.evaluate(
    () => window.liveTest.session().questionSize,
  );
  expect(size).toBe('large');
  await liveCue(page);
  const question = page.getByRole('region', { name: 'Suggested question' });
  await expect(question.getByRole('heading')).toHaveCSS('font-size', '28px');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByLabel('Position', { exact: true })).toHaveValue(
    'topCenter',
  );
  await page.setViewportSize({ width: 320, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

for (const size of ['standard', 'large'] as const) {
  test(`companion fits ${size} text and keeps controls usable with custom spacing`, async ({
    page,
  }) => {
    // The native companion's question height: 340 CSS px, 420 with large text.
    const height = size === 'large' ? 420 : 340;
    await page.setViewportSize({ width: 420, height });
    await standIn(page, '/?window=cue');
    await expect(
      page.getByText(
        'Start a live session or the microphone check in your notebook.',
      ),
    ).toBeVisible();
    await liveCue(page);
    await page.evaluate(
      (value) => window.liveTest.setQuestionSize(value),
      size,
    );
    const question = page.getByRole('region', { name: 'Suggested question' });
    await expect(question.getByRole('heading')).toHaveText(firstCue);
    expect(
      await page.evaluate(
        () => document.querySelector('main')!.scrollHeight <= innerHeight,
      ),
    ).toBe(true);
    // The source is already in view, and holding the cue changes no size.
    await expect(question.locator('blockquote')).toBeVisible();
    const before = (await question.boundingBox())!.height;
    await question.getByRole('button', { name: 'Hold', exact: true }).click();
    await expect(
      question.getByRole('button', { name: 'Held', exact: true }),
    ).toBeVisible();
    expect((await question.boundingBox())!.height).toBe(before);
    expect(
      await page.evaluate(
        () => document.querySelector('main')!.scrollHeight <= innerHeight,
      ),
    ).toBe(true);
    await page.addStyleTag({
      content:
        '.question { line-height: 1.5; letter-spacing: .12em; word-spacing: .16em }',
    });
    await page.setViewportSize({ width: 280, height: 240 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await question
      .getByRole('button', { name: 'Dismiss', exact: true })
      .click();
    await expect(question).toHaveCount(0);
  });
}
