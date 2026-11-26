import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import type {} from './fixtures/native-microphone';
import type {} from './fixtures/native-meeting-history';

test.use({ timezoneId: 'UTC' });
async function openFictional(page: Page) {
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
  await page.goto('/');
  await page.evaluate(() => {
    const common = {
      durationMs: 60_000,
      sources: 'microphone' as const,
      transcript: [{ atMs: 1_000, text: 'A fictional garden conversation.' }],
      cues: [],
    };
    window.historyTest.add({
      ...common,
      title: 'Visible Apple',
      startedAtMs: Date.parse('2026-01-15T12:00:00Z'),
      folder: 'Orchard',
      notes: 'A user note.',
    });
    window.historyTest.add({
      ...common,
      title: 'Archived Birch',
      startedAtMs: Date.parse('2026-01-14T12:00:00Z'),
      folder: 'Orchard',
      archived: true,
      notes: 'An archived note.',
    });
    window.historyTest.add({
      ...common,
      title: 'Hidden Cedar',
      startedAtMs: Date.parse('2026-01-13T12:00:00Z'),
      folder: 'Orchard',
      notes: '   ',
      meetingNotes: ' \t ',
    });
    window.historyTest.add({
      ...common,
      title: 'Visible Damson',
      startedAtMs: Date.parse('2026-01-12T12:00:00Z'),
      folder: 'Orchard',
      notes: '',
      meetingNotes: 'A kept model note.',
    });
    window.historyTest.add({
      ...common,
      title: 'Unfiled Elm',
      startedAtMs: Date.parse('2026-01-11T12:00:00Z'),
      notes: '',
    });
    window.historyTest.add({
      ...common,
      title: 'Garden Fig',
      startedAtMs: Date.parse('2026-01-10T12:00:00Z'),
      folder: 'Garden',
      notes: 'Another note.',
    });
  });
  await page.getByRole('button', { name: 'Meetings', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Drag Visible Apple', exact: true }),
  ).toBeVisible();
}
const titles = (page: Page) =>
  page.locator('.history-item-title').allTextContents();

test('keyboard reorder under search preserves hidden and archived entries, then survives navigation', async ({
  page,
}) => {
  await openFictional(page);
  await page
    .getByRole('searchbox', { name: 'Search meetings' })
    .fill('Visible');
  const up = page.getByRole('button', {
    name: 'Move Visible Damson up',
    exact: true,
  });
  await up.focus();
  await page.keyboard.press('Enter');
  await expect
    .poll(() => titles(page))
    .toEqual(['Visible Damson', 'Visible Apple']);
  await expect(
    page.getByRole('button', { name: 'Drag Visible Damson', exact: true }),
  ).toBeFocused();
  await expect(
    page.getByRole('status').filter({ hasText: 'Meeting moved before' }),
  ).toBeVisible();
  const stored = await page.evaluate(() =>
    window.historyTest.meetings().map((m) => m.title),
  );
  expect(
    stored.filter((t) => t.includes('Birch') || t.includes('Cedar')),
  ).toEqual(['Archived Birch', 'Hidden Cedar']);
  expect(stored).toHaveLength(6);
  await page.getByRole('searchbox', { name: 'Search meetings' }).fill('');
  await page.getByRole('checkbox', { name: /Show archived/ }).check();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Meetings', exact: true }).click();
  await expect
    .poll(() => titles(page))
    .toEqual([
      'Unfiled Elm',
      'Visible Damson',
      'Visible Apple',
      'Hidden Cedar',
      'Garden Fig',
    ]);
});

test('drag handles move to collapsed folders, reorder before a meeting, and return to Unfiled', async ({
  page,
}) => {
  await openFictional(page);
  const garden = page
    .locator('details.history-folder')
    .filter({ has: page.locator('summary', { hasText: 'Garden' }) });
  await garden.locator('summary').click();
  await page
    .getByRole('button', { name: 'Drag Unfiled Elm', exact: true })
    .dragTo(garden.locator('summary'));
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.historyTest.meetings().find((m) => m.title === 'Unfiled Elm')
            ?.folder,
      ),
    )
    .toBe('Garden');
  await garden.locator('summary').click();
  await page
    .getByRole('button', { name: 'Drag Unfiled Elm', exact: true })
    .dragTo(page.getByRole('button', { name: /^Garden Fig / }));
  await expect(garden.locator('.history-item-title')).toHaveText([
    'Unfiled Elm',
    'Garden Fig',
  ]);
  await page
    .getByRole('button', { name: 'Drag Unfiled Elm', exact: true })
    .dragTo(page.getByRole('region', { name: 'Unfiled meetings' }));
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.historyTest.meetings().find((m) => m.title === 'Unfiled Elm')
            ?.folder ?? null,
      ),
    )
    .toBeNull();
  expect(await page.evaluate(() => window.historyTest.meetings().length)).toBe(
    6,
  );
});

test('date, archive, notes and search filters combine without treating transcript as notes', async ({
  page,
}) => {
  await openFictional(page);
  await page.getByRole('checkbox', { name: 'Has notes', exact: true }).check();
  await expect
    .poll(() => titles(page))
    .toEqual(['Visible Apple', 'Visible Damson', 'Garden Fig']);
  await page.getByRole('checkbox', { name: /Show archived/ }).check();
  await page.getByLabel('From date', { exact: true }).fill('2026-01-12');
  await page.getByLabel('To date', { exact: true }).fill('2026-01-14');
  await expect
    .poll(() => titles(page))
    .toEqual(['Archived Birch', 'Visible Damson']);
  await page
    .getByRole('searchbox', { name: 'Search meetings' })
    .fill('Visible');
  await expect.poll(() => titles(page)).toEqual(['Visible Damson']);
  await page.getByLabel('To date', { exact: true }).fill('2026-01-01');
  await expect(page.getByRole('alert')).toContainText(
    'From date must be on or before',
  );
  await expect(
    page.getByText('No meetings match these filters and search.'),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Clear filters', exact: true })
    .first()
    .click();
  await expect
    .poll(() => titles(page))
    .toEqual(['Visible Apple', 'Visible Damson']);
});

test('non-drag folder picker and reorder failure retain content, keyboard recovery and narrow access', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openFictional(page);
  await page
    .getByRole('combobox', { name: 'Folder for Unfiled Elm', exact: true })
    .selectOption('Garden');
  await expect(
    page.getByRole('combobox', { name: 'Folder for Unfiled Elm', exact: true }),
  ).toHaveValue('Garden');
  await page.evaluate(() =>
    window.historyTest.failNext('The fictional disk is full. Try again.'),
  );
  await page
    .getByRole('button', { name: 'Move Unfiled Elm up', exact: true })
    .click();
  await expect(page.getByRole('alert')).toContainText(
    'The fictional disk is full. Try again.',
  );
  await expect(
    page.getByRole('button', { name: 'Drag Unfiled Elm', exact: true }),
  ).toBeFocused();
  expect(await page.evaluate(() => window.historyTest.meetings().length)).toBe(
    6,
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
  const axe = await new AxeBuilder({ page }).include('.history').analyze();
  expect(axe.violations).toEqual([]);
});
