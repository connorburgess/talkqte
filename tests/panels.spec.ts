import { expect, test, type Locator, type Page } from '@playwright/test';

const size = async (locator: Locator) => (await locator.boundingBox())!.width;

async function drag(page: Page, divider: Locator, distance: number) {
  await divider.scrollIntoViewIfNeeded();
  const box = (await divider.boundingBox())!;
  await page.mouse.move(
    box.x + box.width / 2,
    box.y + Math.min(100, box.height / 2),
  );
  await page.mouse.down();
  await page.mouse.move(
    box.x + box.width / 2 + distance,
    box.y + Math.min(100, box.height / 2),
    { steps: 6 },
  );
}

async function noOverflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(
    page.getByRole('button', { name: 'Try demo', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('separator', { name: 'Meeting list', exact: true }),
  ).toBeVisible();
});

test('dragging the notebook boundary changes width without losing notes', async ({
  page,
}) => {
  const list = page.getByRole('complementary', { name: 'Meeting list' });
  const notes = page.locator('#notes-panel textarea');
  await notes.fill('Fictional garden meeting: confirm the seed delivery.');
  const before = await size(list);
  await drag(
    page,
    page.getByRole('separator', { name: 'Meeting list', exact: true }),
    64,
  );
  await page.mouse.up();
  await expect.poll(() => size(list)).toBe(before + 64);
  await expect(notes).toHaveValue(
    'Fictional garden meeting: confirm the seed delivery.',
  );
  await noOverflow(page);
});

test('notes and cue widths share available space and stop at readable limits', async ({
  page,
}) => {
  const divider = page.getByRole('separator', {
    name: 'Notes and transcript',
    exact: true,
  });
  const notes = page.locator('#meeting-editor');
  const cue = page.getByRole('complementary', { name: 'Question companion' });
  const before = await size(notes);
  const cueBefore = await size(cue);
  await drag(page, divider, 54);
  await page.mouse.up();
  await expect.poll(() => size(notes)).toBe(before + 54);
  expect(await size(cue)).toBeCloseTo(cueBefore - 54, 0);
  await drag(page, divider, 600);
  await page.mouse.up();
  expect(await size(cue)).toBeGreaterThanOrEqual(290);
  await drag(page, divider, -900);
  await page.mouse.up();
  expect(await size(notes)).toBe(260);
  await noOverflow(page);
});

test('keyboard resizing exposes the current width and limits', async ({
  page,
}) => {
  for (const name of ['Meeting list', 'Notes and transcript']) {
    const divider = page.getByRole('separator', { name, exact: true });
    await divider.focus();
    const initial = Number(await divider.getAttribute('aria-valuenow'));
    const maximum = Number(await divider.getAttribute('aria-valuemax'));
    await divider.press('ArrowRight');
    await expect(divider).toHaveAttribute(
      'aria-valuenow',
      String(Math.min(initial + 16, maximum)),
    );
    await divider.press('Home');
    await expect(divider).toHaveAttribute(
      'aria-valuenow',
      (await divider.getAttribute('aria-valuemin'))!,
    );
    await divider.press('End');
    await expect(divider).toHaveAttribute(
      'aria-valuenow',
      (await divider.getAttribute('aria-valuemax'))!,
    );
    await expect(divider).toBeFocused();
  }
  await noOverflow(page);
});

test('Escape cancels a drag and a released pointer cannot keep resizing', async ({
  page,
}) => {
  const divider = page.getByRole('separator', {
    name: 'Meeting list',
    exact: true,
  });
  const list = page.getByRole('complementary', { name: 'Meeting list' });
  const before = await size(list);
  await drag(page, divider, 80);
  await expect.poll(() => size(list)).toBe(before + 80);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect.poll(() => size(list)).toBe(before);
  await page.mouse.move(900, 150);
  expect(await size(list)).toBe(before);
});

test('a cancelled pointer restores the width and releases the drag', async ({
  page,
}) => {
  const divider = page.getByRole('separator', {
    name: 'Meeting list',
    exact: true,
  });
  await divider.evaluate((el) =>
    el.addEventListener(
      'pointerdown',
      (event) => {
        el.setAttribute(
          'data-test-pointer-id',
          String((event as PointerEvent).pointerId),
        );
      },
      { once: true },
    ),
  );
  const before = await divider.getAttribute('aria-valuenow');
  await drag(page, divider, 60);
  const pointerId = Number(await divider.getAttribute('data-test-pointer-id'));
  await divider.dispatchEvent('pointercancel', { pointerId });
  await expect(divider).toHaveAttribute('aria-valuenow', before!);
  await page.mouse.move(900, 150);
  await page.mouse.up();
  await expect(divider).toHaveAttribute('aria-valuenow', before!);
});

test('clickable sliders and reset work and widths survive Settings navigation only for the session', async ({
  page,
}) => {
  const divider = page.getByRole('separator', {
    name: 'Meeting list',
    exact: true,
  });
  await divider.press('End');
  await page
    .getByRole('button', { name: 'Settings', exact: true })
    .press('Enter');
  await expect(page.getByRole('separator')).toHaveCount(0);
  await page
    .getByRole('button', { name: 'Notebook', exact: true })
    .press('Enter');
  await expect(divider).toHaveAttribute('aria-valuenow', '400');
  await page.locator('.layout-controls summary').press('Enter');
  const slider = page.getByRole('slider', {
    name: 'Notebook width',
    exact: true,
  });
  const box = (await slider.boundingBox())!;
  await page.mouse.click(box.x + box.width / 4, box.y + box.height / 2);
  await expect
    .poll(async () => Number(await divider.getAttribute('aria-valuenow')))
    .toBeLessThan(300);
  await page.getByRole('button', { name: 'Reset panel sizes' }).press('Enter');
  await expect(divider).toHaveAttribute('aria-valuenow', '248');
  await slider.press('Escape');
  await expect(page.locator('.layout-controls summary')).toBeFocused();
  await expect(slider).not.toBeVisible();
  await divider.press('End');
  await page.reload();
  await expect(divider).toHaveAttribute('aria-valuenow', '248');
});

test('narrow windows stack panels without overflow and restore preferred widths when widened', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const listDivider = page.getByRole('separator', {
    name: 'Meeting list',
    exact: true,
  });
  await listDivider.press('End');
  const notes = page.locator('#notes-panel textarea');
  await notes.fill('Fictional note stays while arranging the notebook.');
  for (const width of [1150, 1000, 880, 600, 375]) {
    await page.setViewportSize({ width, height: 800 });
    if (width < 1000) await expect(page.getByRole('separator')).toHaveCount(0);
    await noOverflow(page);
    await expect(notes).toHaveValue(
      'Fictional note stays while arranging the notebook.',
    );
  }
  await page.setViewportSize({ width: 1320, height: 880 });
  await expect(listDivider).toHaveAttribute('aria-valuenow', '400');
  await expect(
    page.getByRole('separator', { name: 'Notes and transcript' }),
  ).toBeVisible();
  await noOverflow(page);
});
