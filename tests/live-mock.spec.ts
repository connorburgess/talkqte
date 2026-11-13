import { expect, test } from '@playwright/test';

test('fictional layout states are inspectable without starting capture', async ({
  page,
}, testInfo) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Live layout preview' }).click();
  const mock = page.getByRole('region', {
    name: 'Live session layout preview',
  });
  await expect(mock).toContainText('does not capture audio');
  const states = mock.getByLabel('Preview a state');
  for (const state of ['starting', 'listening', 'cue', 'paused']) {
    await states.selectOption(state);
    await expect(
      mock.getByRole('button', { name: 'Stop preview' }),
    ).toBeVisible();
  }
  await states.selectOption('cue');
  await expect(
    mock.getByRole('heading', { name: 'Example context reminder' }),
  ).toBeVisible();
  await mock.getByText('Why this example?').press('Enter');
  await expect(mock).toContainText('fictional prior note');
  await mock.getByRole('button', { name: 'Dismiss example' }).click();
  await expect(states).toHaveValue('listening');
  await expect(states).toBeFocused();
  if (testInfo.project.name === 'chromium') await page.keyboard.press('Tab');
  else await mock.getByRole('button', { name: 'Stop preview' }).focus();
  await expect(
    mock.getByRole('button', { name: 'Stop preview' }),
  ).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(states).toHaveValue('stopped');
  await expect(states).toBeFocused();
  await states.selectOption('failed');
  await expect(mock).toContainText('Fictional connection failed');
  await page.getByRole('button', { name: 'Notebook', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Try demo', exact: true }),
  ).toBeVisible();
});

test('preview remains operable at narrow width with a keyboard', async ({
  page,
}) => {
  await page.setViewportSize({ width: 480, height: 800 });
  await page.goto('/');
  const link = page.getByRole('button', { name: 'Live layout preview' });
  await link.focus();
  await page.keyboard.press('Enter');
  const select = page.getByLabel('Preview a state');
  await select.focus();
  await select.selectOption('starting');
  const stop = page.getByRole('button', { name: 'Stop preview' });
  await stop.focus();
  await page.keyboard.press('Enter');
  await expect(select).toHaveValue('stopped');
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test('real session Stop remains separate from the fictional preview', async ({
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
    .click();
  await page.getByRole('button', { name: 'Live layout preview' }).click();
  const realStop = page.getByRole('button', {
    name: 'Stop live session',
    exact: true,
  });
  await expect(realStop).toBeEnabled();
  await page.getByLabel('Preview a state').selectOption('listening');
  await page.getByRole('button', { name: 'Stop preview', exact: true }).click();
  await expect(realStop).toBeEnabled();
  await realStop.click();
  await expect(realStop).toHaveCount(0);
});
