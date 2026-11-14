import { expect, test, type Page } from '@playwright/test';

type Voices = {
  events: { kind: 'start' | 'stop'; offset?: number }[];
  live: number;
  decoded?: number;
  contexts: number;
  capture: number;
};

// Records what the page asks Web Audio to do. Audible output cannot be
// observed headlessly; when speech starts, from where, and when it stops can.
const instrument = (page: Page, init?: () => void) =>
  page.addInitScript(
    ([extra]) => {
      const log: Voices = { events: [], live: 0, contexts: 0, capture: 0 };
      (window as unknown as { voices: Voices }).voices = log;
      const Context = window.AudioContext;
      window.AudioContext = class extends Context {
        constructor(options?: AudioContextOptions) {
          super(options);
          log.contexts++;
        }
      } as typeof AudioContext;
      const decode = Context.prototype.decodeAudioData;
      Context.prototype.decodeAudioData = function (
        this: BaseAudioContext,
        data: ArrayBuffer,
      ) {
        return decode.call(this, data).then((buffer: AudioBuffer) => {
          log.decoded = buffer.duration;
          return buffer;
        });
      } as typeof decode;
      const start = AudioBufferSourceNode.prototype.start;
      AudioBufferSourceNode.prototype.start = function (
        when?: number,
        offset?: number,
        duration?: number,
      ) {
        log.events.push({ kind: 'start', offset });
        log.live++;
        return start.call(this, when, offset, duration);
      };
      const stop = AudioBufferSourceNode.prototype.stop;
      AudioBufferSourceNode.prototype.stop = function (when?: number) {
        log.events.push({ kind: 'stop' });
        log.live--;
        return stop.call(this, when);
      };
      const media = navigator.mediaDevices;
      if (media?.getUserMedia) {
        const original = media.getUserMedia.bind(media);
        media.getUserMedia = (constraints) => {
          log.capture++;
          return original(constraints);
        };
      }
      if (extra) new Function(extra)();
    },
    [init ? `(${init.toString()})()` : ''],
  );

const voices = (page: Page) =>
  page.evaluate(() => (window as unknown as { voices: Voices }).voices);
const lastStart = async (page: Page) =>
  (await voices(page)).events.filter((e) => e.kind === 'start').at(-1)
    ?.offset ?? -1;

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
  await instrument(page);
  await page.goto('/');
  await expect
    .poll(async () => (await voices(page)).decoded ?? 0)
    .toBeGreaterThan(62);
  await page.getByRole('button', { name: 'Try demo', exact: true }).click();
  await expect(page.getByRole('tab', { name: /Transcript/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect.poll(async () => (await voices(page)).live).toBe(1);
  expect(await lastStart(page)).toBeLessThan(0.5);
  await page.waitForTimeout(1200);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect.poll(async () => (await voices(page)).live).toBe(0);
  await page.getByRole('button', { name: 'Resume', exact: true }).click();
  await expect.poll(async () => (await voices(page)).live).toBe(1);
  expect(await lastStart(page)).toBeGreaterThan(0.8);
  await page.getByRole('button', { name: 'Mute voices', exact: true }).click();
  await expect.poll(async () => (await voices(page)).live).toBe(0);
  await page
    .getByRole('button', { name: 'Enable voices', exact: true })
    .click();
  await expect.poll(async () => (await voices(page)).live).toBe(1);
  await page.getByRole('button', { name: 'End demo', exact: true }).click();
  await expect.poll(async () => (await voices(page)).live).toBe(0);
  await page.getByRole('button', { name: 'Replay demo', exact: true }).click();
  await expect.poll(async () => (await voices(page)).live).toBe(1);
  expect(await lastStart(page)).toBeLessThan(0.5);
  const log = await voices(page);
  expect(log.capture).toBe(0);
  expect(external).toEqual([]);
});

test('speech keeps playing while it keeps pace with the demo clock', async ({
  page,
}) => {
  await instrument(page);
  await page.goto('/');
  await expect
    .poll(async () => (await voices(page)).decoded ?? 0)
    .toBeGreaterThan(62);
  await page.getByRole('button', { name: 'Try demo', exact: true }).click();
  await page.waitForTimeout(4000);
  const log = await voices(page);
  expect(log.events.filter((e) => e.kind === 'start')).toHaveLength(1);
  expect(log.live).toBe(1);
});

test('failed voices leave text playback and pause available', async ({
  page,
}) => {
  await instrument(page, () => {
    AudioContext.prototype.decodeAudioData = () =>
      Promise.reject(new DOMException('Unreadable fictional audio'));
  });
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
  expect((await voices(page)).live).toBe(0);
});

test('a late sound unlock cannot resume voices after Pause', async ({
  page,
}) => {
  await instrument(page, () => {
    const resume = AudioContext.prototype.resume;
    AudioContext.prototype.resume = function () {
      return new Promise<void>((resolve, reject) => {
        (window as unknown as { unlock: () => void }).unlock = () =>
          void resume.call(this).then(resolve, reject);
      });
    };
  });
  await page.goto('/');
  await expect
    .poll(async () => (await voices(page)).decoded ?? 0)
    .toBeGreaterThan(62);
  await page.getByRole('button', { name: 'Try demo', exact: true }).click();
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await page.evaluate(() =>
    (window as unknown as { unlock?: () => void }).unlock?.(),
  );
  await page.waitForTimeout(300);
  expect((await voices(page)).live).toBe(0);
  await expect(
    page.getByRole('button', { name: 'Resume', exact: true }),
  ).toBeEnabled();
});

test('the companion never loads a second copy of the demo voices', async ({
  page,
}) => {
  const loaded: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('welcome.mp3')) loaded.push(r.url());
  });
  await instrument(page);
  await page.goto('/?window=cue');
  await expect(
    page.getByText('Start the demo or microphone from your notebook.'),
  ).toBeVisible();
  expect((await voices(page)).contexts).toBe(0);
  expect(loaded).toEqual([]);
});
