import { expect, test, type Page } from '@playwright/test';
import { liveCue, standIn } from './fixtures/stand-in';

// Where keyboard focus goes when the control that was just used disappears.
// A browser check does not establish native keyboard or screen-reader
// behavior, or focus between the companion and another application.

const focusedOnBody = (page: Page) =>
  page.evaluate(() => document.activeElement === document.body);

/** The companion during the stand-in's live session, with its first cue. */
async function companionWithQuestion(page: Page) {
  await page.setViewportSize({ width: 420, height: 500 });
  await standIn(page, '/?window=cue');
  await liveCue(page);
  const question = page.getByRole('region', { name: 'Suggested question' });
  await expect(question).toBeVisible();
  return question;
}

test('saving an export from the keyboard returns focus to Export', async ({
  page,
}) => {
  await page.goto('/');
  const exportButton = page.getByRole('button', {
    name: 'Export',
    exact: true,
  });
  const dialog = page.getByRole('dialog', { name: 'Review your export' });
  await exportButton.press('Enter');
  await expect(dialog).toBeVisible();
  const download = page.waitForEvent('download');
  await dialog
    .getByRole('button', { name: 'Download Markdown' })
    .press('Enter');
  await download;
  await expect(dialog).toBeHidden();
  await expect(
    page.getByRole('status').filter({ hasText: 'Export saved.' }),
  ).toHaveCount(1);
  await expect(exportButton).toBeFocused();
  // Export still opens the preview again from where focus landed.
  await page.keyboard.press('Enter');
  await expect(dialog).toBeVisible();
});

test('Question appearance & timing opens Settings with focus on the first appearance control', async ({
  page,
}) => {
  await page.goto('/');
  await page
    .getByRole('button', { name: 'Question appearance & timing' })
    .press('Enter');
  await expect(
    page.getByRole('heading', { name: 'Make room for your conversation.' }),
  ).toBeVisible();
  const size = page.locator('#question-size');
  await expect(size).toBeFocused();
  await expect(size).toBeInViewport();
  // The Settings entry in navigation is not a jump to a section.
  await page.getByRole('button', { name: 'Notebook', exact: true }).click();
  await page
    .getByRole('button', { name: 'Settings', exact: true })
    .press('Enter');
  await expect(size).not.toBeFocused();
});

test('keyboard Dismiss in the companion moves focus to its first remaining control', async ({
  page,
}) => {
  const question = await companionWithQuestion(page);
  await question.getByRole('button', { name: 'Dismiss' }).press('Enter');
  await expect(question).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Pause cues', exact: true }),
  ).toBeFocused();
  // The control that received focus works from the keyboard.
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('button', { name: 'Resume cues', exact: true }),
  ).toBeVisible();
});

test('a question dismissed elsewhere does not pull focus into the companion', async ({
  page,
}) => {
  const question = await companionWithQuestion(page);
  expect(await focusedOnBody(page)).toBe(true);
  // The notebook window sends the same command; the companion only receives
  // the shared snapshot.
  await page.evaluate(() => window.liveTest.setCue(null));
  await expect(question).toHaveCount(0);
  expect(await focusedOnBody(page)).toBe(true);
});

test('a delayed Dismiss acknowledgement still ends with focus on a companion control', async ({
  page,
}) => {
  const question = await companionWithQuestion(page);
  await page.evaluate(() => window.questionTest.holdNextResponse());
  await question.getByRole('button', { name: 'Dismiss' }).press('Enter');
  // The shared snapshot removes the card while the companion's controls are
  // still disabled, so nothing can take focus yet.
  await expect(question).toHaveCount(0);
  const pause = page.getByRole('button', { name: 'Pause cues', exact: true });
  await expect(pause).toBeDisabled();
  expect(await focusedOnBody(page)).toBe(true);
  await page.evaluate(() => window.questionTest.releaseResponse());
  await expect(pause).toBeFocused();
});

test('Home and End move between the notebook tabs', async ({ page }) => {
  await page.goto('/');
  const notes = page.getByRole('tab', { name: 'Notes' });
  const transcript = page.getByRole('tab', { name: /Transcript/ });
  await notes.focus();
  await page.keyboard.press('End');
  await expect(transcript).toBeFocused();
  await expect(transcript).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tabpanel')).toHaveAttribute(
    'id',
    'transcript-panel',
  );
  // End on the last tab and Home on the first stay put.
  await page.keyboard.press('End');
  await expect(transcript).toBeFocused();
  await page.keyboard.press('Home');
  await expect(notes).toBeFocused();
  await expect(notes).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Home');
  await expect(notes).toBeFocused();
  // The arrow keys still move both ways.
  await page.keyboard.press('ArrowRight');
  await expect(transcript).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(notes).toBeFocused();
});
