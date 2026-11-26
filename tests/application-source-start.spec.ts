import { expect, test, type Page } from '@playwright/test';
import type {} from './fixtures/native-microphone';

// Simplified zero-picker live session start: there is no Listen to selector or
// application picker in the notebook. On macOS, Start live session captures the
// microphone (You) and global system audio (Them) automatically; on Windows
// and Linux it captures the microphone only. The fixture stands in for the
// native side; no device, stream or permission is involved.

async function notebook(page: Page, query = '/?live&keys=set') {
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
  await page.goto(query);
}

const liveStarts = (page: Page) =>
  page.evaluate(() => window.captureTest.liveStarts);
const hostCalls = (page: Page) =>
  page.evaluate(() => window.captureTest.applicationAudio);
const start = (page: Page) =>
  page.getByRole('button', { name: 'Start live session', exact: true });

test('macOS has no app picker and Start live session discloses mic + system audio with headphone guidance', async ({
  page,
}) => {
  await notebook(page, '/?live&keys=set');
  await expect(page.getByRole('region', { name: 'Listen to' })).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'List applications' }),
  ).toHaveCount(0);
  await expect(page.locator('.session-start-disclosure')).toHaveText(
    'Starts immediately: sends your microphone and system audio to Deepgram and recent lines to Anthropic until you press Stop.',
  );
  await expect(page.getByRole('region', { name: 'Session' })).toContainText(
    'Use headphones if you can',
  );
  await expect(start(page)).toBeEnabled();
  await start(page).click();
  await expect.poll(() => liveStarts(page)).toEqual([{}]);
  expect(await hostCalls(page)).toEqual([]);
});

test('Windows and Linux disclose microphone-only start with no app picker', async ({
  page,
}) => {
  await notebook(page, '/?platform=windows&live&keys=set');
  await expect(page.getByRole('region', { name: 'Listen to' })).toHaveCount(0);
  await expect(page.locator('.session-start-disclosure')).toHaveText(
    'Starts immediately: sends your microphone to Deepgram and recent lines to Anthropic until you press Stop.',
  );
  await start(page).click();
  await expect.poll(() => liveStarts(page)).toEqual([{}]);
  expect(await hostCalls(page)).toEqual([]);
});
