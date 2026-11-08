import { expect, test, type Page } from '@playwright/test';
import type { MicrophoneSnapshot } from '../src/lib/microphone';

async function nativePage(page: Page, query = '') {
  await page.clock.install();
  await page.route(
    /\/\?(?:window=cue|delay-microphone).*|:\d+\/$/,
    async (route) => {
      if (route.request().resourceType() !== 'document')
        return route.continue();
      const response = await route.fetch();
      await route.fulfill({
        response,
        body: (await response.text()).replace(
          '/src/main.tsx',
          '/tests/fixtures/native-microphone.ts',
        ),
      });
    },
  );
  await page.goto(`/${query}`);
}
async function signal(page: Page, state: Partial<MicrophoneSnapshot>) {
  await page.evaluate((value) => window.microphoneTest.send(value), state);
}

test('browser preview never asks for microphone access or invents activity', async ({
  page,
}) => {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = () => {
      throw new Error('Browser microphone must not be requested');
    };
  });
  await page.goto('/');
  const panel = page.getByRole('region', { name: 'Microphone', exact: true });
  await expect(panel).toContainText('Available in the macOS app');
  await expect(
    panel.getByRole('button', { name: 'Start microphone' }),
  ).toBeDisabled();
  await page.getByRole('button', { name: 'Try demo', exact: true }).click();
  await expect(panel).not.toContainText('Signal detected');
});

test('microphone requires explicit start and only native snapshots confirm activity and stop', async ({
  page,
}) => {
  await nativePage(page);
  const panel = page.getByRole('region', { name: 'Microphone', exact: true });
  await expect(panel.getByRole('status')).toHaveText('Off');
  expect(await page.evaluate(() => window.microphoneTest.calls)).not.toContain(
    'start_microphone',
  );
  await panel.getByRole('button', { name: 'Start microphone' }).click();
  await expect(panel.getByRole('status')).toHaveText('Starting…');
  await expect(panel).not.toContainText('Signal detected');
  await signal(page, {
    status: 'listening',
    activity: 'active',
    message: null,
  });
  await expect(panel).toContainText('Signal detected');
  await page.getByRole('button', { name: 'Try demo', exact: true }).click();
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(panel.getByRole('status')).toHaveText('On');
  expect(await page.evaluate(() => window.microphoneTest.calls)).not.toContain(
    'stop_microphone',
  );
  await page.getByRole('button', { name: 'End demo' }).click();
  await expect(panel.getByRole('status')).toHaveText('On');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText(
    'not derived from microphone audio',
  );
  await page.keyboard.press('Escape');
  await panel.getByRole('button', { name: 'Stop microphone' }).click();
  await expect(panel.getByRole('status')).toHaveText('Stopping…');
  await expect(panel.getByRole('button')).toBeDisabled();
  await signal(page, { status: 'off', canStart: true });
  await expect(panel.getByRole('status')).toHaveText('Off');
  await expect(
    panel.getByRole('button', { name: 'Start microphone' }),
  ).toBeEnabled();
});

test('permission errors remain visible and retry waits for device cleanup', async ({
  page,
}) => {
  await nativePage(page);
  const panel = page.getByRole('region', { name: 'Microphone', exact: true });
  await panel.getByRole('button', { name: 'Start microphone' }).click();
  await signal(page, {
    status: 'error',
    canStart: false,
    message: 'Check microphone permission in System Settings.',
  });
  await expect(panel.getByRole('alert')).toContainText('System Settings');
  await expect(panel.getByRole('button')).toBeDisabled();
  await signal(page, { status: 'error', canStart: true });
  await expect(
    panel.getByRole('button', { name: 'Start microphone' }),
  ).toBeEnabled();
  await panel.getByRole('button', { name: 'Start microphone' }).click();
  await expect(panel.getByRole('status')).toHaveText('Starting…');
  await panel.getByRole('button', { name: 'Stop microphone' }).click();
  await signal(page, { status: 'off', canStart: true, message: null });
  await expect(panel.getByRole('status')).toHaveText('Off');
});

test('a failed stop command never reports the microphone as off', async ({
  page,
}) => {
  await nativePage(page);
  const panel = page.getByRole('region', { name: 'Microphone', exact: true });
  await expect(panel.getByRole('status')).toHaveText('Off');
  await signal(page, { status: 'listening', canStart: false });
  await page.evaluate(() => window.microphoneTest.rejectNextStop());
  await panel.getByRole('button', { name: 'Stop microphone' }).click();
  await expect(panel.getByRole('alert')).toContainText(
    'Try Stop microphone again',
  );
  await expect(panel.getByRole('status')).toHaveText('On');
  await expect(
    panel.getByRole('button', { name: 'Stop microphone' }),
  ).toBeEnabled();
  await panel.getByRole('button', { name: 'Stop microphone' }).click();
  await expect(panel.getByRole('status')).toHaveText('Stopping…');
  await expect(panel.getByRole('alert')).toHaveCount(0);
});

test('a delayed initial snapshot and older events cannot overwrite the microphone state', async ({
  page,
}) => {
  await nativePage(page, '?delay-microphone');
  const panel = page.getByRole('region', { name: 'Microphone', exact: true });
  await expect(panel.getByRole('status')).toHaveText(
    'Checking microphone status…',
  );
  await signal(page, {
    revision: 8,
    status: 'listening',
    activity: 'active',
    canStart: false,
  });
  await expect(panel.getByRole('status')).toHaveText('On');
  await page.evaluate(() =>
    window.microphoneTest.resolveSnapshot({
      revision: 0,
      status: 'off',
      activity: 'quiet',
      canStart: true,
      message: null,
    }),
  );
  await expect(panel.getByRole('status')).toHaveText('On');
  await signal(page, { revision: 10, status: 'off', canStart: true });
  await signal(page, { revision: 9, status: 'listening', canStart: false });
  await expect(panel.getByRole('status')).toHaveText('Off');
});

test('compact companion can stop microphone activity without starting the demo', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 76 });
  await nativePage(page, '?window=cue');
  await signal(page, {
    status: 'listening',
    activity: 'active',
    canStart: false,
  });
  await expect(
    page.getByText('Microphone only', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pause demo' })).toHaveCount(0);
  for (const button of await page.getByRole('button').all()) {
    const bounds = await button.boundingBox();
    expect(bounds!.width).toBeGreaterThanOrEqual(44);
    expect(bounds!.height).toBeGreaterThanOrEqual(44);
  }
  expect(
    await page.locator('main').evaluate((element) => element.scrollHeight),
  ).toBeLessThanOrEqual(76);
  await page.getByRole('button', { name: 'Hide companion' }).click();
  await expect(
    page.getByRole('button', { name: 'Stop microphone' }),
  ).toHaveCount(0);
  expect(await page.evaluate(() => window.microphoneTest.calls)).not.toContain(
    'stop_microphone',
  );
  await page.evaluate(async () => {
    const path = '/src/lib/bridge.ts';
    const bridge = await import(path);
    await bridge.command('set_overlay', { enabled: true });
  });
  await expect(
    page.getByRole('button', { name: 'Stop microphone' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Stop microphone' }).click();
  await expect(
    page.getByRole('button', { name: 'Stop microphone' }),
  ).toBeDisabled();
  await expect(page.getByRole('status')).toContainText('Stopping');
  await signal(page, { status: 'off', canStart: true });
  await expect(
    page.getByRole('button', { name: 'Stop microphone' }),
  ).toHaveCount(0);
});
