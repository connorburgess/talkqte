import { expect, test, type Page } from '@playwright/test';
import type {} from './fixtures/native-context';
import type {} from './fixtures/native-microphone';

// The live layout preview lists the prior notes selected in the notebook,
// read-only, apart from its simulated example notes. The fixture's fictional
// context store (served under ?context-ordering) stands in for the native
// one: no file or account is read.

async function native(page: Page, query = '?context-ordering') {
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
  await page.goto(`/${query}`);
}

const layout = (page: Page) =>
  page.getByRole('group', { name: 'Layout', exact: true });

async function openPreview(page: Page) {
  await layout(page)
    .getByRole('button', { name: 'Layout preview', exact: true })
    .press('Enter');
  const preview = page.getByRole('region', {
    name: 'Live session layout preview',
  });
  return {
    preview,
    real: preview.getByRole('region', {
      name: 'Real Prior context',
      exact: true,
    }),
    notes: preview.getByRole('list', { name: 'Real prior notes' }),
    example: preview.getByRole('region', {
      name: 'Simulated Example prior context',
      exact: true,
    }),
  };
}

test('selected notes are listed read-only with provider, date and source label', async ({
  page,
}) => {
  await native(page);
  const { preview, real, notes, example } = await openPreview(page);
  await expect(real).toContainText(
    '2 notes selected in the notebook. Add or remove notes in the notebook’s Prior context panel.',
  );
  await expect(notes.getByRole('listitem')).toHaveText([
    'Garden signs planning · Imported file · 2026-11-02 · not from this conversation',
    'Garden paths review · Granola · 2026-11-03 · not from this conversation',
  ]);
  await expect(notes).toHaveAttribute('role', 'list');
  // Read-only: no control, and the example notes stay in their own section.
  await expect(real.getByRole('button')).toHaveCount(0);
  await expect(real).not.toContainText('Fictional planning notes');
  await expect(example).toContainText('Fictional planning notes');
  await expect(example).not.toContainText('Garden signs planning');
  await expect(
    preview.getByRole('heading', {
      name: 'Real Prior context',
      exact: true,
      level: 2,
    }),
  ).toBeVisible();
  const before = await preview.evaluate((root) => {
    const context = root.querySelector('#real-context-title')!;
    const fictional = [...root.querySelectorAll('h2')].find((heading) =>
      heading.textContent?.includes('Fictional planning conversation'),
    )!;
    return !!(
      context.compareDocumentPosition(fictional) &
      Node.DOCUMENT_POSITION_FOLLOWING
    );
  });
  expect(before).toBe(true);
});

test('with no notes selected it says None, and follows notes added later', async ({
  page,
}) => {
  await native(page, '?context-ordering&empty-context');
  const { real, notes } = await openPreview(page);
  await expect(real).toHaveText(
    'Real Prior contextNone. Add notes in the notebook’s Prior context panel.',
  );
  await expect(notes).toHaveCount(0);
  await page.evaluate(() => window.contextTest.importNotes());
  await expect(notes.getByRole('listitem')).toHaveCount(2);
});

test('removal in the notebook updates the layout; the example’s Remove changes nothing real', async ({
  page,
}) => {
  await native(page);
  const { preview, real, notes, example } = await openPreview(page);
  await expect(notes.getByRole('listitem')).toHaveCount(2);
  // The simulated Remove sends no command and leaves the real notes alone.
  await preview
    .getByRole('button', {
      name: 'Remove (simulated): Fictional planning notes',
    })
    .press('Enter');
  await expect(example).not.toContainText('Fictional planning notes');
  await expect(notes.getByRole('listitem')).toHaveCount(2);
  expect(
    await page.evaluate(() =>
      window.microphoneTest.calls.filter((call) => call.startsWith('remove_')),
    ),
  ).toEqual([]);
  expect(await page.evaluate(() => window.contextTest.items().length)).toBe(2);

  await page.getByRole('button', { name: 'Notebook', exact: true }).click();
  await page.locator('.context-disclosure > summary').press('Enter');
  await page
    .getByRole('region', { name: 'Prior context', exact: true })
    .getByRole('button', { name: 'Remove all' })
    .press('Enter');
  await expect
    .poll(() => page.evaluate(() => window.contextTest.items().length))
    .toBe(0);
  await layout(page)
    .getByRole('button', { name: 'Layout preview', exact: true })
    .click();
  await expect(real).toHaveText(
    'Real Prior contextNone. Add notes in the notebook’s Prior context panel.',
  );
});

test('the browser preview says its notes are built-in fictional ones, not a chosen file', async ({
  page,
}) => {
  await page.goto('/');
  const { real, notes } = await openPreview(page);
  await expect(real).toHaveText(
    'Real Prior contextNone. Add notes in the notebook’s Prior context panel.',
  );
  // The browser preview's file import always returns its built-in notes.
  await page.getByRole('button', { name: 'Notebook', exact: true }).click();
  await page.locator('.context-disclosure > summary').click();
  await page
    .getByRole('region', { name: 'Prior context', exact: true })
    .getByRole('button', { name: 'Add notes from a file' })
    .click();
  const dialog = page.getByRole('dialog', { name: /Choose notes/ });
  await dialog.getByRole('button', { name: 'Select all' }).click();
  await dialog.getByRole('button', { name: 'Import 3 selected' }).click();
  await expect(dialog).toBeHidden();
  await layout(page)
    .getByRole('button', { name: 'Layout preview', exact: true })
    .click();
  await expect(real).toContainText(
    '3 notes selected in the notebook. Add or remove notes in the notebook’s Prior context panel. In this browser preview these are its built-in fictional notes, not a file you chose.',
  );
  await expect(notes.getByRole('listitem')).toHaveCount(3);
  for (const item of await notes.getByRole('listitem').all())
    await expect(item).toContainText('· Built-in fictional note ·');
  await expect(notes).not.toContainText('Imported file');
});

test('the real notes fit a 480 pixel window', async ({ page }) => {
  await page.setViewportSize({ width: 480, height: 800 });
  await native(page);
  const { notes } = await openPreview(page);
  await expect(notes.getByRole('listitem')).toHaveCount(2);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(480);
});
