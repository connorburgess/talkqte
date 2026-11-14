import { expect, test, type Locator, type Page } from '@playwright/test';
import type {} from './fixtures/native-microphone';

// Keyboard operation and focus placement at the 480 px width, for flows that
// were otherwise exercised with a pointer or only at other widths. A browser
// check does not establish native keyboard or screen-reader behavior.

function tabKey(browserName: string) {
  // macOS WebKit follows Safari's keyboard navigation mode, where Option-Tab
  // reaches every control and plain Tab depends on a host setting.
  return browserName === 'webkit' && process.platform === 'darwin'
    ? 'Alt+Tab'
    : 'Tab';
}

async function expectWithinViewport(page: Page, target: Locator, name: string) {
  const box = await target.boundingBox();
  const viewport = page.viewportSize()!;
  expect(box, name).not.toBeNull();
  expect(box!.x, `${name} left edge`).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width, `${name} right edge`).toBeLessThanOrEqual(
    viewport.width,
  );
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
    'page width',
  ).toBeLessThanOrEqual(viewport.width);
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 480, height: 800 });
});

test('the export preview opens, keeps focus inside, and returns it to Export from the keyboard at 480px', async ({
  page,
  browserName,
}) => {
  await page.goto('/');
  const exportButton = page.getByRole('button', {
    name: 'Export',
    exact: true,
  });
  const dialog = page.getByRole('dialog', { name: 'Review your export' });
  await exportButton.press('Enter');
  await expect(dialog).toBeVisible();
  // Focus starts on a control inside the preview, never behind it.
  await expect(dialog.locator(':focus')).toHaveCount(1);
  await expectWithinViewport(page, dialog, 'export preview');
  for (const name of ['Close export preview', 'Cancel', 'Download Markdown'])
    await expect(dialog.getByRole('button', { name })).toBeInViewport();
  // The notebook behind the preview cannot take focus while it is open.
  for (let step = 0; step < 6; step++) {
    await page.keyboard.press(tabKey(browserName));
    await expect(page.locator('main :focus')).toHaveCount(0);
  }
  await dialog.getByRole('button', { name: 'Cancel' }).press('Enter');
  await expect(dialog).toBeHidden();
  await expect(exportButton).toBeFocused();
  await exportButton.press('Enter');
  await dialog
    .getByRole('button', { name: 'Close export preview' })
    .press('Enter');
  await expect(dialog).toBeHidden();
  await expect(exportButton).toBeFocused();
});

test('arrow keys move both ways between notebook tabs, which stay a single tab stop at 480px', async ({
  page,
  browserName,
}) => {
  await page.goto('/');
  const notes = page.getByRole('tab', { name: 'Notes', exact: true });
  const transcript = page.getByRole('tab', { name: /Transcript/ });
  await expectWithinViewport(page, notes, 'Notes tab');
  await expectWithinViewport(page, transcript, 'Transcript tab');
  await notes.focus();
  await page.keyboard.press('ArrowRight');
  await expect(transcript).toBeFocused();
  await expect(transcript).toHaveAttribute('aria-selected', 'true');
  await expect(
    page.getByRole('tabpanel', { name: /Transcript/ }),
  ).toContainText('A conversation starts here.');
  await page.keyboard.press('ArrowLeft');
  await expect(notes).toBeFocused();
  await expect(notes).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tabpanel', { name: 'Notes' })).toBeVisible();
  // Tab leaves the tab list for the selected panel instead of the other tab.
  await page.keyboard.press(tabKey(browserName));
  await expect(
    page.getByRole('textbox', { name: 'Meeting notes' }),
  ).toBeFocused();
});

test('Add your name on the setup card moves keyboard focus to the Name field at 480px', async ({
  page,
}) => {
  await page.goto('/');
  await page.locator('.setup-disclosure > summary').press('Enter');
  const card = page.getByRole('region', { name: 'Before your first meeting' });
  const add = card.getByRole('button', { name: 'Add your name' });
  await expectWithinViewport(page, add, 'Add your name');
  await add.press('Enter');
  const name = page.getByRole('textbox', { name: 'Name' });
  await expect(name).toBeFocused();
  await expect(name).toBeInViewport();
  await expectWithinViewport(page, name, 'Name field');
});

test('a live session starts and stops from the keyboard without losing focus at 480px', async ({
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
  await page.goto('/?live');
  await page
    .getByRole('button', { name: 'Start live session', exact: true })
    .press('Enter');
  const stop = page.getByRole('button', {
    name: 'Stop live session',
    exact: true,
  });
  await expect(stop).toBeEnabled();
  await expect(stop).toBeFocused();
  await expectWithinViewport(page, stop, 'Stop live session');
  await stop.press('Enter');
  await expect(stop).toHaveCount(0);
  // Focus stays on a capture control instead of falling back to the page.
  await expect(
    page
      .getByRole('region', { name: 'Microphone', exact: true })
      .locator(':focus'),
  ).toHaveCount(1);
});

test('the companion shows a question and its source without animation under reduced motion', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 420, height: 420 });
  await page.clock.install();
  await page.goto('/?window=cue');
  await page.evaluate(async () => {
    const previewPath = '/src/lib/preview.ts';
    const preview = await import(previewPath);
    preview.command('start_demo');
  });
  await page.clock.runFor(5_200);
  const question = page.getByRole('region', { name: 'Suggested question' });
  await expect(question.getByRole('heading')).toBeVisible();
  expect(
    await question.evaluate(
      (element) => element.getAnimations({ subtree: true }).length,
    ),
  ).toBe(0);
  await expect(question.locator('blockquote')).toBeVisible();
  await question
    .getByRole('button', { name: 'Hold', exact: true })
    .press('Enter');
  await expect(
    question.getByRole('button', { name: 'Held', exact: true }),
  ).toBeFocused();
  expect(
    await question.evaluate(
      (element) => element.getAnimations({ subtree: true }).length,
    ),
  ).toBe(0);
});
