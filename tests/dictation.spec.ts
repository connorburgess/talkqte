import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { standIn, startLive } from './fixtures/stand-in';

async function openNotebook(page: Page, query = '/?live&keys=set') {
  await standIn(page, query);
  await expect(
    page.getByRole('heading', { name: 'No session yet', level: 1 }),
  ).toBeVisible();
}

async function axeViolations(page: Page) {
  const result = await new AxeBuilder({ page })
    .withTags([
      'wcag2a',
      'wcag2aa',
      'wcag21a',
      'wcag21aa',
      'wcag22aa',
      'best-practice',
    ])
    .disableRules(['color-contrast'])
    .analyze();
  return result.violations.map(
    (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`,
  );
}

test('browser preview disables dictation buttons cleanly', async ({ page }) => {
  await page.goto('/');
  const noteBtn = page.getByRole('button', { name: 'Dictate note' });
  await expect(noteBtn).toBeDisabled();
  await expect(noteBtn).toHaveAttribute('aria-pressed', 'false');
  await expect(noteBtn).toHaveAttribute(
    'title',
    'Dictation is available in the desktop app.',
  );

  await page.locator('.focus-disclosure > summary').press('Enter');
  const focusBtn = page.getByRole('button', { name: 'Dictate focus' });
  await expect(focusBtn).toBeDisabled();
  await expect(focusBtn).toHaveAttribute('aria-pressed', 'false');
});

test('dictating into Notes shows listening state, appends text without clobbering, and stops cleanly', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openNotebook(page);

  const notes = page.getByRole('textbox', {
    name: 'Meeting notes',
    exact: true,
  });
  await notes.fill('Bring the ladder.');

  const dictateBtn = page.getByRole('button', { name: 'Dictate note' });
  await expect(dictateBtn).toBeEnabled();
  await expect(dictateBtn).toHaveAttribute('aria-pressed', 'false');
  expect(await axeViolations(page), 'idle notebook').toEqual([]);

  await dictateBtn.click();

  const stopBtn = page.getByRole('button', { name: 'Stop dictating' });
  await expect(stopBtn).toBeVisible();
  await expect(stopBtn).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#notes-panel').getByRole('status')).toContainText(
    'Listening… Speak to dictate.',
  );

  // Confirm uniform borders on the active listening button (no one-sided border).
  const borders = await stopBtn.evaluate((el) => {
    const cs = getComputedStyle(el);
    return {
      top: cs.borderTopWidth,
      right: cs.borderRightWidth,
      bottom: cs.borderBottomWidth,
      left: cs.borderLeftWidth,
    };
  });
  expect(borders.top).toBe(borders.left);
  expect(borders.right).toBe(borders.left);
  expect(borders.bottom).toBe(borders.left);

  // Focus dictation button is disabled while dictating Notes.
  await page.locator('.focus-disclosure > summary').press('Enter');
  const focusBtn = page.getByRole('button', { name: 'Dictate focus' });
  await expect(focusBtn).toBeDisabled();
  await expect(focusBtn).toHaveAttribute(
    'title',
    'Stop dictating before switching fields.',
  );

  expect(await axeViolations(page), 'listening notes').toEqual([]);

  await page.evaluate(async () => {
    await window.dictationTest.deliverText(
      'notes',
      'Check the greenhouse key with Priya.',
    );
    await window.dictationTest.deliverText('notes', 'Confirm Friday handover.');
  });

  await expect(notes).toHaveValue(
    'Bring the ladder. Check the greenhouse key with Priya. Confirm Friday handover.',
  );

  await stopBtn.click();
  await expect(
    page.getByRole('button', { name: 'Dictate note' }),
  ).toHaveAttribute('aria-pressed', 'false');
  await expect(focusBtn).toBeEnabled();
});

test('dictating into Focus appends cleanly and saves on stop', async ({
  page,
}) => {
  await openNotebook(page);
  await page.locator('.focus-disclosure > summary').press('Enter');

  const focus = page.getByLabel('Focus · optional', { exact: true });
  await focus.fill('Confirm greenhouse');

  const focusBtn = page.getByRole('button', { name: 'Dictate focus' });
  await expect(focusBtn).toBeEnabled();
  await focusBtn.click();

  const stopBtn = page.getByRole('button', { name: 'Stop dictating' });
  await expect(stopBtn).toHaveAttribute('aria-pressed', 'true');
  await expect(
    page.getByRole('button', { name: 'Dictate note' }),
  ).toBeDisabled();

  await page.evaluate(async () => {
    await window.dictationTest.deliverText('focus', 'key handover with Priya');
  });
  await expect(focus).toHaveValue('Confirm greenhouse key handover with Priya');

  await stopBtn.click();
  await expect(
    page.getByRole('button', { name: 'Dictate focus' }),
  ).toHaveAttribute('aria-pressed', 'false');
  await expect
    .poll(() => page.evaluate(() => window.focusTest.current()))
    .toEqual(['Confirm greenhouse key handover with Priya']);
});

test('dictation is disabled during a live session and during microphone monitoring', async ({
  page,
}) => {
  await openNotebook(page);
  await page.locator('.focus-disclosure > summary').press('Enter');

  const noteBtn = page.getByRole('button', { name: 'Dictate note' });
  const focusBtn = page.getByRole('button', { name: 'Dictate focus' });

  // Active microphone check (started from Settings) disables dictation on Notebook.
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Start microphone' }).click();
  await page.getByRole('button', { name: 'Notebook', exact: true }).click();
  if (!(await focusBtn.isVisible())) {
    await page.locator('.focus-disclosure > summary').press('Enter');
  }
  await expect(noteBtn).toBeDisabled();
  await expect(noteBtn).toHaveAttribute(
    'title',
    'Stop the microphone check before dictating.',
  );
  await expect(focusBtn).toBeDisabled();
  await expect(focusBtn).toHaveAttribute(
    'title',
    'Stop the microphone check before dictating.',
  );

  // Release microphone check from Notebook's active-mic bar.
  await page.getByRole('button', { name: 'Stop microphone' }).click();
  await page.evaluate(() =>
    window.microphoneTest.send({ status: 'off', canStart: true }),
  );
  await expect(noteBtn).toBeEnabled();
  await expect(focusBtn).toBeEnabled();

  // Active live session disables dictation.
  await startLive(page);
  await expect(noteBtn).toBeDisabled();
  await expect(noteBtn).toHaveAttribute(
    'title',
    'Stop the live session before dictating.',
  );
  await expect(focusBtn).toBeDisabled();
  await expect(focusBtn).toHaveAttribute(
    'title',
    'Stop the live session before dictating.',
  );
});

test('missing Deepgram key disables dictation with a plain explanation', async ({
  page,
}) => {
  // Only Anthropic key stored -> Deepgram key is missing.
  await standIn(page, '/?keys=anthropic');
  await expect(
    page.getByRole('heading', { name: 'No session yet', level: 1 }),
  ).toBeVisible();

  const noteBtn = page.getByRole('button', { name: 'Dictate note' });
  await expect(noteBtn).toBeDisabled();
  await expect(noteBtn).toHaveAttribute(
    'title',
    'Add your Deepgram API key in Settings to dictate.',
  );
  await expect(page.locator('#notes-dictation-hint')).toHaveText(
    'Add your Deepgram API key in Settings to dictate.',
  );

  await page.locator('.focus-disclosure > summary').press('Enter');
  const focusBtn = page.getByRole('button', { name: 'Dictate focus' });
  await expect(focusBtn).toBeDisabled();
  await expect(page.locator('#focus-dictation-hint')).toHaveText(
    'Add your Deepgram API key in Settings to dictate.',
  );
  expect(await axeViolations(page), 'missing key').toEqual([]);
});

test('switching away from Notes stops active dictation cleanly', async ({
  page,
}) => {
  await openNotebook(page);
  await page.getByRole('button', { name: 'Dictate note' }).click();
  await expect(
    page.getByRole('button', { name: 'Stop dictating' }),
  ).toBeVisible();

  await page.getByRole('tab', { name: /Transcript/ }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.dictationTest.calls().map((call) => call.command),
      ),
    )
    .toEqual(['start_note_dictation', 'stop_note_dictation']);
});

test('dictation controls fit without horizontal overflow at 320px', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await openNotebook(page);
  await page.locator('.focus-disclosure > summary').press('Enter');
  await page.getByRole('button', { name: 'Dictate note' }).click();
  await expect(page.locator('#notes-panel').getByRole('status')).toContainText(
    'Listening… Speak to dictate.',
  );
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(320);
});
