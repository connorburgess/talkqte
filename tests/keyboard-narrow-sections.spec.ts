import { expect, test, type Locator, type Page } from '@playwright/test';
import { cue, liveCue, standIn } from './fixtures/stand-in';

// Keyboard operation and focus placement at the 480 px width for the cue
// card, the Prior context section and the processing controls. A browser
// check does not establish native keyboard or screen-reader behavior.

const width = 480;

async function expectToFit(target: Locator, name: string) {
  const box = await target.boundingBox();
  expect(box, name).not.toBeNull();
  expect(box!.x, `${name} left edge`).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width, `${name} right edge`).toBeLessThanOrEqual(width);
}

async function expectNoSidewaysScroll(page: Page) {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
    'page width',
  ).toBeLessThanOrEqual(width);
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width, height: 800 });
});

test('a question is held and dismissed from the keyboard at 480px, and a quoted line fits', async ({
  page,
}) => {
  await standIn(page, '/?live');
  await liveCue(page);
  const question = page.getByRole('region', { name: 'Suggested question' });
  const notes = page.getByRole('textbox', { name: 'Meeting notes' });
  await expect(
    question.getByRole('heading', { name: 'Who will take the first draft?' }),
  ).toBeVisible();
  // The source is in view before anything is pressed.
  await expect(question.locator('blockquote')).toBeVisible();
  await question
    .getByRole('button', { name: 'Hold', exact: true })
    .press('Enter');
  const held = question.getByRole('button', { name: 'Held', exact: true });
  await expect(held).toBeFocused();
  await expectToFit(question, 'question with its source');
  await expectToFit(held, 'Held');
  const dismiss = question.getByRole('button', {
    name: 'Dismiss',
    exact: true,
  });
  await expectToFit(dismiss, 'Dismiss');
  await expectNoSidewaysScroll(page);
  await dismiss.press('Enter');
  await expect(question).toHaveCount(0);
  await expect(notes).toBeFocused();

  // The next cue quotes what was said.
  const friday = "A single page sounds right. Let's have it ready by Friday.";
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
  await expect(question).toContainText('Just said');
  await expectToFit(question, 'quoted line');
  await expectNoSidewaysScroll(page);
  await question
    .getByRole('button', { name: 'Dismiss', exact: true })
    .press('Enter');
  await expect(question).toHaveCount(0);
  await expect(notes).toBeFocused();
});

test('Prior context opens, imports and removes notes from the keyboard at 480px and keeps focus in the section', async ({
  page,
}) => {
  await page.goto('/');
  const panel = page.getByRole('region', { name: 'Prior context' });
  const summary = panel.locator('summary');
  const add = panel.getByRole('button', { name: 'Add notes from a file' });
  await expect(add).toBeHidden();
  await summary.press('Enter');
  await expect(add).toBeVisible();
  await expect(summary).toBeFocused();
  await expectToFit(add, 'Add notes from a file');
  await add.press('Enter');
  const chooser = page.getByRole('dialog', { name: /Choose notes/ });
  await expect(chooser).toBeVisible();
  await expectToFit(chooser, 'note chooser');
  await chooser.getByRole('button', { name: 'Select all' }).press('Enter');
  const confirm = chooser.getByRole('button', { name: 'Import 3 selected' });
  await expect(confirm).toBeInViewport();
  await confirm.press('Enter');
  await expect(chooser).toBeHidden();
  await expect(add).toBeFocused();
  await expect(panel.getByRole('listitem')).toHaveCount(3);
  for (const button of await panel.getByRole('button').all())
    await expectToFit(button, await button.innerText());
  await expectNoSidewaysScroll(page);

  // Removing one note leaves focus on the section's own heading control.
  await panel
    .getByRole('button', { name: 'Remove Visitor questions (2026-11-02)' })
    .press('Enter');
  await expect(panel.getByRole('listitem')).toHaveCount(2);
  await expect(panel).not.toContainText('Visitor questions');
  await expect(summary).toBeFocused();
  await expect(summary).toContainText('2 notes selected');

  // Removing the rest returns to the control that can add notes again.
  await panel.getByRole('button', { name: 'Remove all' }).press('Enter');
  await expect(panel.getByRole('listitem')).toHaveCount(0);
  await expect(add).toBeFocused();
  await expect(summary).toContainText('0 notes selected');
  await expectNoSidewaysScroll(page);

  // Closing the section keeps focus on its heading control.
  await summary.press('Enter');
  await expect(add).toBeHidden();
  await expect(summary).toBeFocused();
});

test('processing is reviewed, enabled, paused, resumed and disabled from the keyboard at 480px', async ({
  page,
}) => {
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
  await page.goto('/?live&processor');
  await page
    .getByRole('button', { name: 'Start live session', exact: true })
    .press('Enter');
  const stop = page.getByRole('button', {
    name: 'Stop live session',
    exact: true,
  });
  await expect(stop).toBeEnabled();
  const panel = page.getByRole('region', {
    name: 'Cue processing',
    exact: true,
  });
  const status = panel.getByRole('status');
  const microphone = page
    .getByRole('region', { name: 'Microphone', exact: true })
    .getByRole('status');
  const review = panel.getByRole('button', {
    name: 'Review processing',
    exact: true,
  });
  await expectToFit(review, 'Review processing');
  await review.press('Enter');
  await panel
    .getByRole('button', { name: 'Review selected sources' })
    .press('Enter');
  await expect(
    panel.getByRole('heading', { name: 'Review before enabling' }),
  ).toBeFocused();
  const approve = panel.getByRole('button', {
    name: 'Enable for this session',
  });
  await expectToFit(approve, 'Enable for this session');
  await expectNoSidewaysScroll(page);
  await approve.press('Enter');
  await expect(status).toHaveText('Model connection on');

  const pause = panel.getByRole('button', { name: 'Pause cues', exact: true });
  const resume = panel.getByRole('button', { name: 'Resume cues' });
  const disable = panel.getByRole('button', { name: 'Disable processing' });
  for (const [control, name] of [
    [pause, 'Pause cues'],
    [disable, 'Disable processing'],
  ] as const)
    await expectToFit(control, name);
  await expectNoSidewaysScroll(page);

  // Pausing and resuming relabel one control, so focus stays on it.
  await pause.press('Enter');
  await expect(status).toHaveText('Cues paused');
  await expect(resume).toBeFocused();
  await expectToFit(resume, 'Resume cues');
  await expect(microphone).toHaveText('On');
  await resume.press('Enter');
  await expect(status).toHaveText('Model connection on');
  await expect(pause).toBeFocused();

  // Disabling returns to an unapproved session without ending capture.
  await disable.press('Enter');
  await expect(review).toBeEnabled();
  await expect(pause).toHaveCount(0);
  await expect(microphone).toHaveText('On');
  await expect(stop).toBeEnabled();
  await expectToFit(stop, 'Stop live session');
  await expectNoSidewaysScroll(page);
});
