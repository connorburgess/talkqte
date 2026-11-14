import { expect, test, type Page } from '@playwright/test';
import type {} from './fixtures/native-microphone';

const field = (page: Page) =>
  page.getByLabel('Focus · optional', { exact: true });
async function open(page: Page) {
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
  await page.goto('/?granola');
  await page.locator('.context-disclosure > summary').press('Enter');
  await page.locator('.focus-disclosure > summary').press('Enter');
  await expect(field(page)).toBeVisible();
}
async function submit(page: Page, value: string) {
  await field(page).fill(value);
  await field(page).press('Tab');
}
async function saved(page: Page, lines: string[]) {
  await expect
    .poll(() => page.evaluate(() => window.focusTest.current()))
    .toEqual(lines);
}
async function pending(page: Page, value = 'Garden access') {
  await page.evaluate(() => window.focusTest.hold());
  await submit(page, value);
  await expect
    .poll(() => page.evaluate(() => window.focusTest.submissions.at(-1)))
    .toEqual([value]);
}

test('later Focus submissions survive an earlier pending save', async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await open(page);
  await pending(page);
  await submit(page, 'Newsletter launch');
  await page.evaluate(() => window.focusTest.release());
  await expect
    .poll(() => page.evaluate(() => window.focusTest.completed()))
    .toBeGreaterThanOrEqual(1);
  await saved(page, ['Newsletter launch']);
  await page.getByRole('region', { name: 'This meeting' }).screenshot({
    path: testInfo.outputPath('focus-save.png'),
    animations: 'disabled',
  });
  await expect(field(page)).toHaveValue('Newsletter launch');
  expect(await page.evaluate(() => window.focusTest.submissions)).toEqual([
    ['Garden access'],
    ['Newsletter launch'],
  ]);
});

for (const first of ['Garden access', 'Team sync']) {
  test(`a delayed ${first === 'Garden access' ? 'success' : 'rejection'} preserves an unsubmitted draft`, async ({
    page,
  }) => {
    await open(page);
    await pending(page, first);
    await field(page).fill('Newsletter launch');
    await page.evaluate(() => window.focusTest.release());
    await expect
      .poll(() => page.evaluate(() => window.focusTest.completed()))
      .toBe(1);
    if (first === 'Team sync')
      await expect(page.getByRole('alert')).toContainText(
        'needs a few specific words',
      );
    await expect(field(page)).toHaveValue('Newsletter launch');
    await expect(field(page)).toBeFocused();
    expect(await page.evaluate(() => window.focusTest.submissions)).toEqual([
      [first],
    ]);
    await field(page).press('Tab');
    await saved(page, ['Newsletter launch']);
    await expect(page.getByRole('alert')).toHaveCount(0);
  });
}

test('a newer valid save supersedes a pending rejection and duplicate blurs', async ({
  page,
}) => {
  await open(page);
  await pending(page, 'Team sync');
  await submit(page, 'Newsletter launch');
  await submit(page, '  Newsletter launch  \n');
  await page.evaluate(() => window.focusTest.release());
  await saved(page, ['Newsletter launch']);
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(await page.evaluate(() => window.focusTest.submissions)).toEqual([
    ['Team sync'],
    ['Newsletter launch'],
  ]);
});

for (const last of ['', 'Garden access']) {
  test(`a pending save does not undo ${last ? 'returning to earlier Focus' : 'removing every Focus line'}`, async ({
    page,
  }) => {
    await open(page);
    await submit(page, 'Garden access');
    await saved(page, ['Garden access']);
    await pending(page, 'Newsletter launch');
    await submit(page, last);
    await page.evaluate(() => window.focusTest.release());
    await expect
      .poll(() => page.evaluate(() => window.focusTest.completed()))
      .toBe(3);
    await saved(page, last ? [last] : []);
    await expect(field(page)).toHaveValue(last);
  });
}

test('Clear supersedes a pending rejection without saving the draft again', async ({
  page,
}) => {
  await open(page);
  await pending(page, 'Team sync');
  await field(page).fill('Newsletter launch');
  const clear = page
    .getByRole('region', { name: 'This meeting' })
    .getByRole('button', { name: 'Clear', exact: true });
  await clear.focus();
  await clear.press('Enter');
  await page.evaluate(() => window.focusTest.release());
  await expect
    .poll(() => page.evaluate(() => window.focusTest.completed()))
    .toBe(2);
  await saved(page, []);
  await expect(field(page)).toHaveValue('');
  await expect(field(page)).toBeFocused();
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(await page.evaluate(() => window.focusTest.submissions)).toEqual([
    ['Team sync'],
    [],
  ]);
});

test('a rejected latest Focus stays editable with inline recovery', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 600, height: 700 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await open(page);
  await pending(page);
  await submit(page, 'Team sync');
  const outside = page.getByRole('button', { name: 'Notebook', exact: true });
  await outside.focus();
  await page.evaluate(() => window.focusTest.release());
  await expect(page.getByRole('alert')).toContainText("Focus wasn't applied");
  await expect(field(page)).toHaveValue('Team sync');
  await saved(page, ['Garden access']);
  await expect(outside).toBeFocused();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(600);
  await page
    .getByRole('region', { name: 'This meeting' })
    .screenshot({ path: testInfo.outputPath('focus-save-error.png') });
  await submit(page, 'Newsletter launch');
  await saved(page, ['Newsletter launch']);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

async function acceptPendingSuggestion(page: Page) {
  await page
    .getByRole('button', { name: 'Connect Granola', exact: true })
    .press('Enter');
  await page
    .getByRole('button', { name: 'Suggest from Granola', exact: true })
    .press('Enter');
  await page.evaluate(() =>
    window.granolaTest.releaseSuggestion(0, ['Newsletter launch']),
  );
  const group = page.getByRole('group', { name: /Granola suggests/ });
  await group
    .getByRole('checkbox', { name: 'Newsletter launch', exact: true })
    .press('Space');
  await page.evaluate(() => window.focusTest.hold());
  await group
    .getByRole('button', { name: 'Add 1 to the focus' })
    .press('Enter');
  await expect
    .poll(() => page.evaluate(() => window.focusTest.submissions))
    .toEqual([['Newsletter launch']]);
}

test('a delayed accepted suggestion cannot replace a later typed submission', async ({
  page,
}) => {
  await open(page);
  await acceptPendingSuggestion(page);
  await submit(page, 'Volunteer welcome');
  await page.evaluate(() => window.focusTest.release());
  await saved(page, ['Volunteer welcome']);
  await expect(field(page)).toHaveValue('Volunteer welcome');
  expect(await page.evaluate(() => window.focusTest.submissions)).toEqual([
    ['Newsletter launch'],
    ['Volunteer welcome'],
  ]);
});

test('accepted suggestions do not take focus back from another control', async ({
  page,
}) => {
  await open(page);
  await acceptPendingSuggestion(page);
  const outside = page.getByRole('button', { name: 'Notebook', exact: true });
  await outside.focus();
  await page.evaluate(() => window.focusTest.release());
  await saved(page, ['Newsletter launch']);
  await expect(field(page)).toHaveValue('Newsletter launch');
  await expect(
    page.getByRole('group', { name: /Granola suggests/ }),
  ).toHaveCount(0);
  await expect(outside).toBeFocused();
});

test('resubmitting the unchanged draft supersedes a pending accepted suggestion', async ({
  page,
}) => {
  await open(page);
  await acceptPendingSuggestion(page);
  await field(page).focus();
  await field(page).press('Tab');
  await page.evaluate(() => window.focusTest.release());
  await expect
    .poll(() => page.evaluate(() => window.focusTest.completed()))
    .toBe(2);
  await expect(
    page.getByRole('button', { name: 'Add 1 to the focus' }),
  ).toBeEnabled();
  await saved(page, []);
  await expect(field(page)).toHaveValue('');
});
