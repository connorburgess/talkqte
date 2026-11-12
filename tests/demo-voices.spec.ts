import { expect, test } from '@playwright/test';

const sound = (page: import('@playwright/test').Page) =>
  page.locator('audio').evaluate((node: HTMLAudioElement) => ({
    paused: node.paused,
    time: node.currentTime,
    muted: node.muted,
    duration: node.duration,
    source: node.currentSrc,
  }));

test('bundled voices follow Pause, Resume, mute, End and Replay without capture', async ({
  page,
}) => {
  const external: string[] = [];
  page.on('request', (request) => {
    if (
      !request.url().startsWith('http://127.0.0.1:') &&
      !request.url().startsWith('data:')
    )
      external.push(request.url());
  });
  await page.goto('/');
  await expect
    .poll(async () => (await sound(page)).duration)
    .toBeGreaterThan(62);
  await page.getByRole('button', { name: 'Try demo', exact: true }).click();
  await expect(page.getByRole('tab', { name: /Transcript/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect.poll(async () => (await sound(page)).time).toBeGreaterThan(0.5);
  await expect.poll(async () => (await sound(page)).paused).toBe(false);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect.poll(async () => (await sound(page)).paused).toBe(true);
  const paused = (await sound(page)).time;
  await page.waitForTimeout(300);
  expect((await sound(page)).time).toBeCloseTo(paused, 1);
  await page.getByRole('button', { name: 'Resume', exact: true }).click();
  await expect
    .poll(async () => (await sound(page)).time)
    .toBeGreaterThan(paused + 0.2);
  await page.getByRole('button', { name: 'Mute voices', exact: true }).click();
  await expect.poll(async () => (await sound(page)).muted).toBe(true);
  await page
    .getByRole('button', { name: 'Enable voices', exact: true })
    .click();
  await expect.poll(async () => (await sound(page)).paused).toBe(false);
  await page.getByRole('button', { name: 'End demo', exact: true }).click();
  await expect.poll(async () => (await sound(page)).paused).toBe(true);
  await page.getByRole('button', { name: 'Replay demo', exact: true }).click();
  await expect.poll(async () => (await sound(page)).time).toBeLessThan(0.5);
  expect(external).toEqual([]);
});

test('failed local audio leaves text playback and pause available', async ({
  page,
}) => {
  await page.route('**/demo/welcome.mp3', (route) => route.abort());
  await page.goto('/');
  await page.getByRole('button', { name: 'Try demo', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Voices could not play' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Pause', exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole('tabpanel', { name: /Transcript/ }),
  ).toBeVisible();
});

test('a late play promise cannot resume voices after Pause', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const original = HTMLMediaElement.prototype.play;
    (window as unknown as { releaseVoice?: () => void }).releaseVoice =
      undefined;
    HTMLMediaElement.prototype.play = function () {
      const player = this;
      return new Promise<void>((resolve, reject) => {
        (window as unknown as { releaseVoice: () => void }).releaseVoice =
          () => {
            void original.call(player).then(resolve, reject);
          };
      });
    };
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Try demo', exact: true }).click();
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await page.evaluate(() =>
    (window as unknown as { releaseVoice: () => void }).releaseVoice(),
  );
  await expect.poll(async () => (await sound(page)).paused).toBe(true);
  await expect(
    page.getByRole('button', { name: 'Resume', exact: true }),
  ).toBeEnabled();
});

test('the companion never loads a second copy of the demo voices', async ({
  page,
}) => {
  const voices: string[] = [];
  page.on('request', (r) => {
    if (r.url().endsWith('/demo/welcome.mp3')) voices.push(r.url());
  });
  await page.goto('/?window=cue');
  await expect(
    page.getByText('Start the demo or microphone from your notebook.'),
  ).toBeVisible();
  await expect(page.locator('audio')).toHaveCount(0);
  expect(voices).toEqual([]);
});
