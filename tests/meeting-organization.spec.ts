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
  await page.getByRole('button', { name: /^Filters/ }).click();
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
  await page.getByRole('button', { name: /^Filters/ }).click();
  await page.getByRole('checkbox', { name: 'Has notes', exact: true }).check();
  await expect(page.getByRole('button', { name: 'Filters (1)' })).toBeVisible();
  await expect
    .poll(() => titles(page))
    .toEqual(['Visible Apple', 'Visible Damson', 'Garden Fig']);
  await page.getByRole('checkbox', { name: /Show archived/ }).check();
  await page.getByLabel('From date', { exact: true }).fill('2026-01-12');
  await page.getByLabel('To date', { exact: true }).fill('2026-01-14');
  await expect(page.getByRole('button', { name: 'Filters (4)' })).toBeVisible();
  // Closing Filters keeps active filter chips and Clear filters visible.
  await page.getByRole('button', { name: 'Filters (4)' }).click();
  await expect(
    page.getByRole('region', { name: 'Active meeting filters' }),
  ).toContainText('Has notes');
  await page.getByRole('button', { name: 'Filters (4)' }).click();
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

test('collapsed Filters chips restore unfiltered results on clear, Escape returns focus, and resting row tools keep readable contrast', async ({
  page,
}) => {
  await openFictional(page);

  const filtersButton = page.getByRole('button', { name: /^Filters/ });
  await filtersButton.click();
  await page.getByRole('checkbox', { name: 'Has notes', exact: true }).check();
  await page.getByRole('checkbox', { name: /Show archived/ }).check();
  await expect(page.getByRole('button', { name: 'Filters (2)' })).toBeVisible();

  // Escape closes the filter panel and returns keyboard focus to Filters.
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Filters (2)' })).toBeFocused();
  await expect(
    page.getByRole('checkbox', { name: 'Has notes', exact: true }),
  ).toHaveCount(0);

  // Active filter chips stay visible while collapsed and reflect filtered results.
  const activeRegion = page.getByRole('region', {
    name: 'Active meeting filters',
  });
  await expect(activeRegion).toBeVisible();
  await expect(activeRegion).toContainText('Has notes');
  await expect(activeRegion).toContainText('Including archived');
  await expect
    .poll(() => titles(page))
    .toEqual([
      'Visible Apple',
      'Archived Birch',
      'Visible Damson',
      'Garden Fig',
    ]);

  // Clear filters from the collapsed chips bar restores the full active list.
  await activeRegion.getByRole('button', { name: 'Clear filters' }).click();
  await expect(activeRegion).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Filters', exact: true }),
  ).toBeVisible();
  await expect
    .poll(() => titles(page))
    .toEqual([
      'Unfiled Elm',
      'Visible Apple',
      'Hidden Cedar',
      'Visible Damson',
      'Garden Fig',
    ]);

  // Verify computed opacity and WCAG contrast of enabled row controls at rest, hover, and focus,
  // while truly disabled Move up retains clear visual distinction.
  const contrastReport = await page.evaluate(() => {
    const parseRgb = (css: string): [number, number, number] => {
      const m = css.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      if (!m) throw new Error(`Unexpected color: ${css}`);
      return [Number(m[1]), Number(m[2]), Number(m[3])];
    };
    const relLum = ([r, g, b]: [number, number, number]) => {
      const c = [r, g, b].map((v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    };
    const ratio = (fg: string, bg: string) => {
      const l1 = relLum(parseRgb(fg));
      const l2 = relLum(parseRgb(bg));
      return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    };
    const effectiveBg = (el: Element): string => {
      let cur: Element | null = el;
      while (cur) {
        const bg = getComputedStyle(cur).backgroundColor;
        if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') return bg;
        cur = cur.parentElement;
      }
      return 'rgb(255, 255, 255)';
    };
    const measure = (el: Element) => {
      const cs = getComputedStyle(el);
      const bg = effectiveBg(el);
      return {
        opacity: Number(cs.opacity),
        color: cs.color,
        bg,
        contrast: ratio(cs.color, bg),
      };
    };

    const row = Array.from(document.querySelectorAll('.history-row')).find(
      (el) => el.textContent?.includes('Visible Apple'),
    )!;
    const tools = row.querySelector('.history-row-tools')!;
    const folder = row.querySelector('.history-row-folder')!;
    const archive = row.querySelector('.history-archive-button')!;
    const moveUp = row.querySelector(
      'button[aria-label="Move Visible Apple up"]',
    )!;
    const moveDown = row.querySelector(
      'button[aria-label="Move Visible Apple down"]',
    )!;
    return {
      toolsOpacity: Number(getComputedStyle(tools).opacity),
      folderRest: measure(folder),
      archiveRest: measure(archive),
      moveDownRest: measure(moveDown),
      moveUpDisabledOpacity: Number(getComputedStyle(moveUp).opacity),
      moveUpDisabled: (moveUp as HTMLButtonElement).disabled,
    };
  });

  expect(contrastReport.toolsOpacity).toBe(1);
  expect(contrastReport.folderRest.opacity).toBe(1);
  expect(contrastReport.folderRest.contrast).toBeGreaterThanOrEqual(4.5);
  expect(contrastReport.archiveRest.opacity).toBe(1);
  expect(contrastReport.archiveRest.contrast).toBeGreaterThanOrEqual(4.5);
  expect(contrastReport.moveDownRest.opacity).toBe(1);
  expect(contrastReport.moveDownRest.contrast).toBeGreaterThanOrEqual(4.5);
  expect(contrastReport.moveUpDisabled).toBe(true);
  expect(contrastReport.moveUpDisabledOpacity).toBeLessThan(0.5);

  // Hover & focus brighten enabled controls to full ink contrast.
  const visibleRow = page.locator('.history-row', {
    hasText: 'Visible Apple',
  });
  const archiveBtn = visibleRow.locator('.history-archive-button');
  await archiveBtn.hover();
  const hoverContrast = await archiveBtn.evaluate((el) => {
    const parse = (css: string) =>
      css
        .match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/)!
        .slice(1, 4)
        .map(Number);
    const lum = ([r, g, b]: number[]) => {
      const c = [r, g, b].map((v) =>
        v / 255 <= 0.03928
          ? v / 255 / 12.92
          : Math.pow((v / 255 + 0.055) / 1.055, 2.4),
      );
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    };
    const fg = getComputedStyle(el).color;
    let cur: Element | null = el;
    let bg = 'rgb(255, 255, 255)';
    while (cur) {
      const c = getComputedStyle(cur).backgroundColor;
      if (c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') {
        bg = c;
        break;
      }
      cur = cur.parentElement;
    }
    const l1 = lum(parse(fg));
    const l2 = lum(parse(bg));
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  });
  expect(hoverContrast).toBeGreaterThanOrEqual(10);

  const folderSelect = visibleRow.locator('.history-row-folder');
  await folderSelect.focus();
  await expect(folderSelect).toBeFocused();
  const focusContrast = await folderSelect.evaluate((el) => {
    const parse = (css: string) =>
      css
        .match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/)!
        .slice(1, 4)
        .map(Number);
    const lum = ([r, g, b]: number[]) => {
      const c = [r, g, b].map((v) =>
        v / 255 <= 0.03928
          ? v / 255 / 12.92
          : Math.pow((v / 255 + 0.055) / 1.055, 2.4),
      );
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    };
    const fg = getComputedStyle(el).color;
    const bg = getComputedStyle(el).backgroundColor;
    const l1 = lum(parse(fg));
    const l2 = lum(parse(bg));
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  });
  expect(focusContrast).toBeGreaterThanOrEqual(4.5);
});
