import { expect, test, type Locator, type Page } from '@playwright/test';

async function activate(control: Locator) {
  await expect(control).toBeEnabled();
  await control.focus();
  await control.press('Enter');
}

async function modelPage(page: Page) {
  await page.route(/\/\?model$/, async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      body: (await response.text()).replace(
        '/src/main.tsx',
        '/tests/fixtures/native-microphone.ts',
      ),
    });
  });
  await page.goto('/?model');
  await activate(page.getByRole('button', { name: 'Set up live session' }));
  await expect(
    page.getByText('The local speech model is not installed.'),
  ).toBeVisible();
}

async function heldStatus(page: Page) {
  await expect
    .poll(() => page.evaluate(() => window.modelTest.pendingStatuses()))
    .toBe(1);
}

for (const failure of [false, true]) {
  test(`a retired ${failure ? 'failed' : 'missing-model'} check cannot hide an installed model's live session`, async ({
    page,
  }, testInfo) => {
    await modelPage(page);
    await page.evaluate(() => window.modelTest.holdNextStatus());
    await activate(page.getByRole('button', { name: 'Download speech model' }));
    await heldStatus(page);
    await page.evaluate(() => window.modelTest.finish());
    await expect(page.getByText('Ready on this device.')).toBeVisible();
    await page.evaluate(
      (fail) => window.modelTest.releaseStatus(fail),
      failure,
    );
    // Flush the released IPC promise and React render before negative checks.
    await page.evaluate(() => new Promise(requestAnimationFrame));
    await page
      .getByRole('heading', { name: 'Live transcription', exact: true })
      .locator('..')
      .screenshot({
        path: testInfo.outputPath('model-installed-readiness.png'),
      });
    await expect(page.getByText('Ready on this device.')).toBeVisible();
    await activate(page.getByRole('button', { name: 'Notebook', exact: true }));
    await expect(
      page.getByRole('button', { name: 'Start live session' }),
    ).toBeEnabled();
    expect(
      await page.evaluate(() => window.microphoneTest.calls),
    ).not.toContain('start_live_session');
  });
}

test('a retired ready check cannot offer a live session after model removal', async ({
  page,
}) => {
  await modelPage(page);
  await activate(page.getByRole('button', { name: 'Download speech model' }));
  await page.evaluate(() => window.modelTest.holdNextStatus());
  await page.evaluate(() => window.modelTest.finish());
  await heldStatus(page);
  await activate(page.getByRole('button', { name: 'Remove model' }));
  await expect(
    page.getByText('The local speech model is not installed.'),
  ).toBeVisible();
  await page.evaluate(() => window.modelTest.releaseStatus());
  await page.evaluate(() => new Promise(requestAnimationFrame));
  await expect(
    page.getByText('The local speech model is not installed.'),
  ).toBeVisible();
  await activate(page.getByRole('button', { name: 'Notebook', exact: true }));
  await expect(
    page.getByRole('button', { name: 'Start live session' }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Set up live session' }),
  ).toBeVisible();
});

test('removing the model clears readiness while its replacement check is pending', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 600, height: 700 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await modelPage(page);
  await activate(page.getByRole('button', { name: 'Download speech model' }));
  await page.evaluate(() => window.modelTest.finish());
  await expect(page.getByText('Ready on this device.')).toBeVisible();
  await page.evaluate(() => window.modelTest.holdNextStatus());
  await activate(page.getByRole('button', { name: 'Remove model' }));
  await heldStatus(page);
  const section = page
    .getByRole('heading', { name: 'Live transcription', exact: true })
    .locator('..');
  await section.screenshot({
    path: testInfo.outputPath('model-removed-checking.png'),
  });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(600);
  await expect(page.getByText('Ready on this device.')).toHaveCount(0);
  await expect(section.getByText('Checking…', { exact: true })).toBeVisible();
  await activate(page.getByRole('button', { name: 'Notebook', exact: true }));
  await expect(
    page.getByRole('button', { name: 'Start live session' }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Set up live session' }),
  ).toBeVisible();
  await page.evaluate(() => window.modelTest.releaseStatus());
  await page.evaluate(() => new Promise(requestAnimationFrame));
  await expect(
    page.getByRole('button', { name: 'Notebook', exact: true }),
  ).toBeFocused();
  await activate(page.getByRole('button', { name: 'Set up live session' }));
  await expect(
    page.getByRole('heading', { name: 'Live transcription', exact: true }),
  ).toBeFocused();
  await expect(
    page.getByText('The local speech model is not installed.'),
  ).toBeVisible();
});
