import { expect, test, type Page } from '@playwright/test';

// The browser adapter supplies the same session transitions as Rust IPC. These
// tests exercise companion controls; native placement is checked separately.
async function sessionAction(page: Page, name: 'start_demo' | 'end_demo') {
  await page.evaluate(async (command) => {
    const previewPath = '/src/lib/preview.ts';
    const preview = await import(previewPath);
    preview.command(command);
  }, name);
}

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
  await page.clock.install();
  await page.goto('/?window=cue');
  await expect(
    page.getByText('Start the demo or microphone from your notebook.'),
  ).toBeVisible();
  await sessionAction(page, 'start_demo');
});

test('companion stays compact between questions and preserves a paused question', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 76 });
  await expect(page.getByRole('status')).toHaveText('Demo running · Scripted');
  // The controls are icons: each has a name and the same tooltip.
  for (const name of ['Pause demo', 'Hide companion']) {
    const control = page.getByRole('button', { name, exact: true });
    await expect(control).toBeVisible();
    await expect(control).toHaveAttribute('title', name);
    await expect(control).toHaveText('');
  }
  await expect(page.locator('header').getByRole('button')).toHaveCount(2);
  for (const button of await page.getByRole('button').all()) {
    const bounds = await button.boundingBox();
    expect(bounds!.width).toBeGreaterThanOrEqual(44);
    expect(bounds!.height).toBeGreaterThanOrEqual(44);
  }
  await expectCompanionToFit(page);
  await page.clock.runFor(8_200);
  await page.setViewportSize({ width: 420, height: 420 });
  await expect(
    page.getByRole('heading', { name: 'Who will take the first draft?' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Pause demo' }).click();
  await page.clock.runFor(30_000);
  await expect(page.getByRole('status')).toHaveText('Demo paused · Scripted');
  await expect(
    page.getByRole('button', { name: 'Resume demo' }),
  ).toHaveAttribute('title', 'Resume demo');
  await expectCompanionToFit(page);
  await expect(
    page.getByRole('region', { name: 'Suggested question' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Resume demo' }).click();
  await page.setViewportSize({ width: 420, height: 420 });
  await expect(
    page.getByRole('heading', { name: 'Who will take the first draft?' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Dismiss' }).click();
  await expect(
    page.getByRole('region', { name: 'Suggested question' }),
  ).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Pause demo' })).toBeVisible();
});

test('a question fits the narrow window used on a small display', async ({
  page,
}) => {
  // The native window is 360 CSS px wide on a display under 1100 logical px.
  // Measured without the entrance animation, which scales the card briefly.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 360, height: 340 });
  await page.clock.runFor(8_200);
  const question = page.getByRole('region', { name: 'Suggested question' });
  await expect(question.getByRole('heading')).toHaveText(
    'Who will take the first draft?',
  );
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
  await page.evaluate(async () => {
    const previewPath = '/src/lib/preview.ts';
    const preview = await import(previewPath);
    preview.command('set_question_size', { value: 'large' });
  });
  await page.setViewportSize({ width: 360, height: 420 });
  await expectCompanionToFit(page);
  expect(await fitsSideways()).toBe(true);
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

test('hiding a companion suppresses later questions and ending clears its controls', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Hide companion' }).click();
  await page.clock.runFor(6_000);
  await expect(
    page.getByText('Companion hidden. Show it again in Settings.'),
  ).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Suggested question' }),
  ).toHaveCount(0);
  await expect(page.getByRole('button')).toHaveCount(0);
  await sessionAction(page, 'end_demo');
  await expect(page.getByRole('button')).toHaveCount(0);
});

test('question controls remain usable with reduced motion and longer wrapping', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.clock.runFor(8_200);
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

test('questions expire quietly without requiring a response', async ({
  page,
}) => {
  await page.clock.runFor(8_200);
  const question = page.getByRole('region', { name: 'Suggested question' });
  await expect(question).toBeVisible();
  await expect(question).not.toContainText(/\b\d+s\b/);
  await page.clock.runFor(18_000);
  await expect(question).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Pause demo' })).toBeVisible();
  await expect(page.getByRole('status')).toHaveText('Demo running · Scripted');
});

test('a question answered by the conversation leaves, and the words that answered it are quoted', async ({
  page,
}) => {
  await page.clock.runFor(37_200);
  const question = page.getByRole('region', { name: 'Suggested question' });
  await expect(
    page.getByRole('heading', { name: 'What date should we aim for?' }),
  ).toBeVisible();
  // The fictional speakers agree on Friday at 51 s, before the cue would expire.
  await page.clock.runFor(14_000);
  await expect(
    page.getByRole('heading', { name: 'What date should we aim for?' }),
  ).toHaveCount(0);
  await expect(question).toContainText("“Let's have it ready by Friday");
  await expect(question).toContainText('Just said');
  await expect(question).toContainText('From the demo conversation');
  // The quote is the cue: nothing is repeated under it, and the card has
  // no control but Hold and Dismiss.
  await expect(question.locator('blockquote')).toHaveCount(0);
  await expect(question.getByRole('button')).toHaveCount(2);
  await expect(page.getByRole('status')).toHaveText('Demo running · Scripted');
  // The shorter voiced scene ends without leaving an unheld cue behind.
  await page.clock.runFor(18_500);
  await expect(question).toHaveCount(0);
});

test('an answered question being read stays and shows the answer', async ({
  page,
}) => {
  await page.clock.runFor(37_200);
  await page.getByRole('button', { name: 'Hold', exact: true }).click();
  // The window keeps its size; the answer joins the source in the card.
  await page.clock.runFor(14_000);
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
  await page.evaluate(async () => {
    const previewPath = '/src/lib/preview.ts';
    const preview = await import(previewPath);
    preview.command('set_question_size', { value: 'large' });
  });
  await page.setViewportSize({ width: 420, height: 420 });
  await expectCompanionToFit(page);
  await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await expect(question).toHaveCount(0);
});
