// The bar above the cue in the companion window: what is being captured, as
// a glyph with a dot, and the few controls as quiet icons. Browser checks
// with the live-session stand-in and fictional cues only; they show that
// names, titles and keyboard reach are present, not how VoiceOver reads the
// native window, which is unverified.
import { expect, test, type Locator, type Page } from '@playwright/test';
import type {} from './fixtures/native-microphone';
import type { MicrophoneSnapshot } from '../src/lib/microphone';
import type { Cue } from '../src/lib/types';

const cue: Cue = {
  id: 'fictional-bar-cue',
  kind: 'Owner',
  question: 'Who will take the first draft of the welcome guide?',
  evidence: 'Someone can take the first draft of the welcome guide.',
  sourceId: 'transcript:fictional-1',
  remainingMs: 18_000,
  totalMs: 18_000,
  held: false,
  resolvedBy: null,
  note: null,
  aboutFocus: false,
};

async function companion(page: Page, live = true) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
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
  await page.goto('/?window=cue&live');
  await page.waitForFunction(() => !!window.liveTest);
  if (live) await page.evaluate(() => window.liveTest.start());
  return page.locator('header.companion-bar');
}

const microphone = (page: Page, state: Partial<MicrophoneSnapshot>) =>
  page.evaluate((value) => window.microphoneTest.send(value), state);

/** WCAG contrast of an element's colour against the bar it sits on. */
const contrast = (element: Locator) =>
  element.evaluate((node) => {
    const channels = (colour: string) =>
      colour
        .match(/[\d.]+/g)!
        .slice(0, 3)
        .map(Number);
    const luminance = (rgb: number[]) => {
      const [r, g, b] = rgb.map((value) => {
        const c = value / 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const bar = luminance(
      channels(
        getComputedStyle(node.closest('.companion-shell')!).backgroundColor,
      ),
    );
    const glyph = luminance(channels(getComputedStyle(node).color));
    return (Math.max(bar, glyph) + 0.05) / (Math.min(bar, glyph) + 0.05);
  });

for (const size of ['standard', 'large'] as const)
  test(`a live session's bar shows capture as a glyph and its controls as named icons, in ${size} text`, async ({
    page,
  }) => {
    const bar = await companion(page);
    await page.evaluate(
      (value) => window.liveTest.setQuestionSize(value),
      size,
    );
    await page.evaluate((value) => window.liveTest.setCue(value), cue);
    for (const width of [360, 420]) {
      await page.setViewportSize({
        width,
        height: size === 'large' ? 420 : 340,
      });
      // Capture is on: a microphone glyph with its dot, and no words.
      const dot = bar.getByRole('img', { name: 'Signal detected' });
      await expect(dot).toBeInViewport({ ratio: 1 });
      await expect(bar.locator('.companion-capture')).toHaveAttribute(
        'title',
        'Mic on · Local',
      );
      // The words stay for assistive technology, out of sight.
      const status = bar.getByRole('status');
      await expect(status).toHaveText('Mic on · Local');
      expect((await status.boundingBox())!.width).toBeLessThanOrEqual(1);
      await expect(bar).toHaveText('Mic on · Local');

      // Three controls, each an icon with a name and the same tooltip.
      const controls = bar.getByRole('button');
      await expect(controls).toHaveCount(3);
      for (const [name, title] of [
        ['Pause cues', 'Pause cues; microphone and transcript continue'],
        ['Stop live session', 'Stop live session'],
        ['Hide companion', 'Hide companion'],
      ]) {
        const control = bar.getByRole('button', { name, exact: true });
        await expect(control).toBeInViewport({ ratio: 1 });
        await expect(control).toHaveAttribute('title', title);
        await expect(control).toHaveText('');
        await expect(control.locator('svg')).toBeVisible();
        const box = (await control.boundingBox())!;
        expect(box.width, name).toBeGreaterThanOrEqual(44);
        expect(box.height, name).toBeGreaterThanOrEqual(44);
        // Quiet at rest, but never fainter than a glyph may be.
        expect(await contrast(control), name).toBeGreaterThanOrEqual(3);
      }
      expect(
        await contrast(bar.locator('.companion-capture')),
      ).toBeGreaterThanOrEqual(3);

      // The bar and the cue under it fit the window.
      expect(
        await page.evaluate(
          () =>
            document.querySelector('main')!.scrollHeight <= innerHeight &&
            document.documentElement.scrollWidth <= innerWidth,
        ),
        `${width} px`,
      ).toBe(true);
      await expect(
        page
          .getByRole('region', { name: 'Suggested question' })
          .getByRole('heading'),
      ).toBeInViewport({ ratio: 1 });
    }

    // Every control takes keyboard focus and works from it. (Tab order is
    // not driven here: WebKit skips buttons unless a system setting is on.)
    for (const name of ['Stop live session', 'Hide companion', 'Pause cues']) {
      const control = bar.getByRole('button', { name, exact: true });
      await control.focus();
      await expect(control).toBeFocused();
    }
    await page.keyboard.press('Enter');
    await expect(
      bar.getByRole('button', { name: 'Resume cues', exact: true }),
    ).toBeFocused();
    await page.keyboard.press('Enter');
    // Nothing on the bar moves under reduced motion.
    await bar.getByRole('button', { name: 'Hide companion' }).hover();
    expect(
      await bar.evaluate(
        (element) => element.getAnimations({ subtree: true }).length,
      ),
    ).toBe(0);
  });

test('the bar never shows capture that is not happening, and spells out any state the glyph cannot', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 76 });
  const bar = await companion(page);
  const status = bar.getByRole('status');
  const dot = bar.getByRole('img');

  // Cues paused: the microphone is still on, and the bar says both.
  await bar.getByRole('button', { name: 'Pause cues', exact: true }).click();
  await expect(bar.getByText('Cues off', { exact: true })).toBeVisible();
  await expect(dot).toBeVisible();
  await expect(status).toHaveText('Mic still on');
  await expect(
    bar.getByRole('button', { name: 'Stop live session' }),
  ).toBeVisible();
  await bar.getByRole('button', { name: 'Resume cues', exact: true }).click();
  await expect(bar.getByText('Cues off', { exact: true })).toHaveCount(0);

  // The microphone fails mid-session: no dot, and the words come back.
  await microphone(page, { status: 'error', canStart: true });
  await expect(dot).toHaveCount(0);
  await expect(status).toHaveText('Unavailable');
  await expect(status).toBeVisible();
  expect((await status.boundingBox())!.width).toBeGreaterThan(20);
  await expect(
    bar.getByRole('button', { name: 'Stop live session' }),
  ).toBeVisible();

  // A session fed by an application alone (development builds): its own
  // glyph and dot, never the microphone's.
  await microphone(page, { status: 'off', canStart: true });
  await page.evaluate(() => window.liveTest.setSourceSession(true));
  await expect(
    bar.getByRole('img', { name: 'Application audio on' }),
  ).toBeVisible();
  await expect(status).toHaveText('App audio · Local');
  await expect(
    bar.getByRole('img', { name: /Signal detected|Quiet input/ }),
  ).toHaveCount(0);
});

test('with nothing captured the bar shows no capture glyph, only what is running', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 76 });
  const bar = await companion(page, false);
  // The microphone check alone: on, and labelled as that.
  await microphone(page, {
    status: 'listening',
    activity: 'quiet',
    canStart: false,
  });
  await expect(bar.getByText('Mic only', { exact: true })).toBeVisible();
  await expect(bar.getByRole('img', { name: 'Quiet input' })).toBeVisible();
  const stop = bar.getByRole('button', { name: 'Stop microphone' });
  await expect(stop).toBeVisible();
  await expect(stop).toHaveAttribute('title', 'Stop microphone');
  await expect(bar.getByRole('button')).toHaveCount(2);
  expect(
    await page.locator('main').evaluate((element) => element.scrollHeight),
  ).toBeLessThanOrEqual(76);

  // The tests' simulated session captures nothing: no glyph, no dot, the
  // words say what it is, and there is no pause or stop to press.
  await microphone(page, { status: 'off', canStart: true });
  await page.evaluate(() => window.liveTest.simulate());
  await expect(bar.getByRole('status')).toHaveText(
    'Simulated session · Fictional',
  );
  await expect(bar.getByRole('status')).toBeVisible();
  await expect(bar.getByRole('status')).not.toHaveClass(/visually-hidden/);
  await expect(bar.getByRole('img')).toHaveCount(0);
  await expect(bar.locator('.companion-capture')).toHaveCount(0);
  await expect(bar.getByText(/Mic|Live/)).toHaveCount(0);
  await expect(bar.getByRole('button')).toHaveCount(1);
  await expect(
    bar.getByRole('button', { name: 'Hide companion', exact: true }),
  ).toBeVisible();
});

test('a model connection shows while lines may be sent, and why it stopped', async ({
  page,
}) => {
  const bar = await companion(page);
  await microphone(page, { status: 'listening', activity: 'quiet' });
  const publish = (value: Record<string, unknown>) =>
    page.evaluate((value) => window.liveTest.publish(value as never), value);
  // Lines may leave the device: the cloud shows, and "Local" is not said.
  await publish({ model: 'on' });
  await expect(
    bar.getByRole('img', { name: 'Model cues on: recent lines go to Claude' }),
  ).toBeVisible();
  await expect(bar.getByRole('status')).toHaveText(
    'Mic on · lines go to Claude',
  );
  await publish({ model: 'sending' });
  await expect(
    bar.getByRole('img', { name: 'Sending recent lines to Claude' }),
  ).toBeVisible();
  // A failure takes the cloud away and says why, for eyes and ears alike.
  await publish({ model: 'stopped', modelIssue: 'allowance' });
  await expect(bar.getByRole('img', { name: /recent lines/ })).toHaveCount(0);
  const off = bar.getByText('Cues off', { exact: false });
  await expect(off).toBeVisible();
  await expect(off).toContainText(
    'your Claude usage or rate limit was reached',
  );
  await expect(bar.getByRole('status')).toHaveText('Mic on · Local');
});
