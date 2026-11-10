import { expect, test, type Page } from '@playwright/test';
import type { MicrophoneSnapshot } from '../src/lib/microphone';

async function nativePage(page: Page, query = '') {
  await page.clock.install();
  await page.route(
    /\/\?(?:window=cue|delay-microphone|live|model).*|:\d+\/$/,
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

test('a queued stop acknowledges the request without claiming native cleanup has started', async ({
  page,
}) => {
  await nativePage(page);
  const panel = page.getByRole('region', { name: 'Microphone', exact: true });
  await panel.getByRole('button', { name: 'Start microphone' }).click();
  await page.evaluate(() => window.microphoneTest.holdNextStop());
  await panel.getByRole('button', { name: 'Stop microphone' }).click();
  await expect(panel).toContainText('Stop requested… waiting for microphone.');
  await expect(panel.getByRole('status')).toHaveText('Starting…');
  await expect(panel.getByRole('button')).toBeDisabled();
  await page.evaluate(() => window.microphoneTest.releaseStop());
  await expect(panel.getByRole('status')).toHaveText('Stopping…');
  await expect(panel).not.toContainText('Stop requested…');
  await signal(page, { status: 'off', canStart: true, message: null });
  await expect(panel.getByRole('status')).toHaveText('Off');
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
  for (const [state, label] of [
    [{ status: 'starting', canStart: false }, 'Starting…'],
    [{ status: 'error', canStart: false }, 'Releasing…'],
    [{ status: 'error', canStart: true }, 'Unavailable'],
    [{ status: 'listening', activity: 'quiet', canStart: false }, 'On'],
  ] as const) {
    await signal(page, state);
    await expect(page.getByRole('status')).toHaveText(label);
    expect(
      await page.locator('main').evaluate((element) => ({
        width: element.scrollWidth,
        height: element.scrollHeight,
      })),
    ).toEqual({ width: 320, height: 76 });
  }
  await signal(page, {
    status: 'listening',
    activity: 'active',
    canStart: false,
  });
  await expect(page.getByText('Mic only', { exact: true })).toBeVisible();
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
  await page.evaluate(() => window.microphoneTest.holdNextStop());
  await page.getByRole('button', { name: 'Stop microphone' }).click();
  await expect(page.getByRole('status')).toHaveText('Stop requested…');
  expect(
    await page.locator('main').evaluate((element) => element.scrollHeight),
  ).toBeLessThanOrEqual(76);
  await page.evaluate(() => window.microphoneTest.releaseStop());
  await expect(
    page.getByRole('button', { name: 'Stop microphone' }),
  ).toBeDisabled();
  await expect(page.getByRole('status')).toContainText('Stopping');
  await signal(page, { status: 'off', canStart: true });
  await expect(
    page.getByRole('button', { name: 'Stop microphone' }),
  ).toHaveCount(0);
});

test('a live session is labelled live, has no end time, and cannot be exported', async ({
  page,
}) => {
  await nativePage(page, '?live');
  await page.getByRole('button', { name: 'Start live session' }).click();
  const strip = page.getByRole('region', { name: 'Live session controls' });
  await expect(strip).toContainText('Live session in progress');
  await expect(strip).not.toContainText('/');
  await expect(
    page.getByRole('button', { name: 'Pause', exact: true }),
  ).toHaveCount(0);
  const panel = page.getByRole('region', { name: 'Microphone', exact: true });
  await expect(panel).toContainText('transcribed on this device');
  await expect(panel).not.toContainText('Activity check only');
  await expect(
    page.getByRole('button', { name: 'Export', exact: true }),
  ).toBeDisabled();
  await page.evaluate(() =>
    window.liveTest.say(
      'Someone can take the first draft.',
      'Who will take the first draft?',
    ),
  );
  const question = page.getByRole('region', { name: 'Suggested question' });
  await expect(question).toContainText('Live question · Owner');
  await question.getByRole('button', { name: 'Why?' }).click();
  await expect(question).toContainText('From the live transcript');
  await expect(question).not.toContainText('fictional');
  await page.getByRole('tab', { name: /Transcript/ }).click();
  const transcript = page.getByRole('tabpanel');
  await expect(transcript).toContainText('Someone can take the first draft.');
  await expect(transcript).not.toContainText('Scripted');
  await page.getByRole('button', { name: 'Stop live session' }).click();
  await expect(strip).toContainText('Live session ended');
  await expect(
    page.getByRole('button', { name: 'Try demo', exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => window.microphoneTest.calls)).toContain(
    'stop_live_session',
  );
});

test('without local transcription, the notebook offers no live session and says why', async ({
  page,
}) => {
  await nativePage(page);
  await expect(
    page.getByRole('button', { name: 'Try demo', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Start live session' }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(
    page.getByText('This build does not include local transcription.'),
  ).toBeVisible();
});

test('live cues pause independently of the microphone and transcript', async ({
  page,
}) => {
  await nativePage(page, '?live');
  await page
    .getByRole('button', { name: 'Start live session', exact: true })
    .click();
  await page.evaluate(() =>
    window.liveTest.say(
      'Someone should send the checklist.',
      'Who will send the checklist?',
    ),
  );
  const question = page.getByRole('region', { name: 'Suggested question' });
  await expect(question).toBeVisible();
  await page.getByRole('button', { name: 'Pause cues', exact: true }).focus();
  await page.keyboard.press('Enter');
  const strip = page.getByRole('region', { name: 'Live session controls' });
  await expect(strip).toContainText('Cues paused · session continues');
  await expect(strip).toContainText('Microphone and transcript continue');
  await expect(question).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Resume cues' })).toBeFocused();
  await expect(
    page.getByRole('region', { name: 'Microphone', exact: true }),
  ).toContainText('On');
  await page.evaluate(() =>
    window.liveTest.say('The garden gate is open.', 'A paused suggestion'),
  );
  await page.getByRole('tab', { name: /Transcript/ }).click();
  await expect(page.getByRole('tabpanel')).toContainText(
    'The garden gate is open.',
  );
  await expect(strip).toContainText('0:02');
  await expect(question).toHaveCount(0);
  await page.getByRole('button', { name: 'Resume cues' }).click();
  await expect(strip).toContainText('Live session in progress');
  await expect(question).toHaveCount(0);
  expect(await page.evaluate(() => window.microphoneTest.calls)).not.toContain(
    'stop_live_session',
  );
  expect(await page.evaluate(() => window.microphoneTest.calls)).not.toContain(
    'stop_microphone',
  );
  await page.getByRole('button', { name: 'Pause cues' }).click();
  await page.getByRole('button', { name: 'Stop live session' }).click();
  await expect(strip).toContainText('Live session ended');
  await expect(page.getByRole('button', { name: 'Resume cues' })).toHaveCount(
    0,
  );
});

test('a rejected cue pause stays live and narrow controls remain usable', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await nativePage(page, '?live');
  await page
    .getByRole('button', { name: 'Start live session', exact: true })
    .click();
  await page.evaluate(() => window.liveTest.rejectNextPause());
  await page.getByRole('button', { name: 'Pause cues' }).click();
  await expect(page.getByRole('alert')).toContainText(
    'Could not pause cues. Try again.',
  );
  await expect(page.getByRole('button', { name: 'Pause cues' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Resume cues' })).toHaveCount(
    0,
  );
  await page.getByRole('button', { name: 'Pause cues' }).click();
  for (const name of ['Resume cues', 'Stop live session']) {
    const box = await page
      .getByRole('button', { name, exact: true })
      .boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    expect(box!.height).toBeGreaterThanOrEqual(44);
  }
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
});

test('the compact companion can pause cues without hiding microphone state or Stop', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 76 });
  await nativePage(page, '?window=cue&live');
  await page.evaluate(() => window.liveTest.start());
  await page.getByRole('button', { name: 'Pause cues', exact: true }).click();
  await expect(page.getByText('Cues off', { exact: true })).toBeVisible();
  await expect(page.getByRole('status')).toHaveText('Mic still on');
  for (const name of ['Resume cues', 'Stop live session', 'Hide companion']) {
    const box = await page
      .getByRole('button', { name, exact: true })
      .boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(320);
    expect(box!.height).toBeGreaterThanOrEqual(44);
  }
  for (const selector of [
    '.companion-title',
    '.companion-status > [role=status]',
  ]) {
    const fits = await page
      .locator(selector)
      .evaluate((el) => el.scrollWidth <= el.clientWidth);
    expect(fits, selector).toBe(true);
  }
  await page.getByRole('button', { name: 'Resume cues' }).click();
  await expect(page.getByRole('status')).toHaveText('Mic on · Local');
  await page.getByRole('button', { name: 'Stop live session' }).click();
  expect(await page.evaluate(() => window.microphoneTest.calls)).toContain(
    'stop_live_session',
  );
});

test('the companion labels a live session and its Stop ends the session', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 76 });
  await nativePage(page, '?window=cue&live');
  await page.evaluate(() => window.liveTest.start());
  await expect(page.getByText('Live', { exact: true })).toBeVisible();
  await expect(page.getByRole('status')).toHaveText('Mic on · Local');
  await expect(page.getByRole('button', { name: 'Pause demo' })).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Stop microphone' }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Stop live session' }).click();
  expect(await page.evaluate(() => window.microphoneTest.calls)).toContain(
    'stop_live_session',
  );
});

test('your name is applied when you leave the field, and a rejected name explains why', async ({
  page,
}) => {
  await nativePage(page, '?live');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const name = page.getByRole('textbox', { name: 'Name' });
  // Wide and tall enough to read and tap, not a checkbox-sized box.
  const box = (await name.boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(160);
  expect(box.height).toBeGreaterThanOrEqual(44);
  await name.fill('  Sam ');
  await name.press('Enter');
  await expect(name).toHaveValue('Sam');
  await expect(name).toBeFocused();
  await name.fill('Sam <b>');
  await name.press('Enter');
  await expect(page.getByRole('alert')).toContainText(
    'Use letters, spaces, apostrophes, or hyphens',
  );
  // The field shows the name still in effect, not the rejected one.
  await expect(name).toHaveValue('Sam');
});

test('the speech model downloads only when chosen, shows progress, and can be cancelled or removed', async ({
  page,
}) => {
  await nativePage(page, '?model');
  await expect(
    page.getByRole('button', { name: 'Start live session' }),
  ).toHaveCount(0);
  // The notebook points to setup instead of hiding live sessions entirely,
  // and takes keyboard focus to that section.
  await page.getByRole('button', { name: 'Set up live session' }).click();
  const heading = page.getByRole('heading', { name: 'Live transcription' });
  await expect(heading).toBeFocused();
  await expect(heading).toBeInViewport();
  const section = page.locator('.model-download');
  await expect(section).toContainText('78 MB');
  await expect(section).toContainText('see your IP address');
  expect(await page.evaluate(() => window.microphoneTest.calls)).not.toContain(
    'download_model',
  );
  await page.getByRole('button', { name: 'Download speech model' }).click();
  await expect(
    page.getByRole('progressbar', { name: 'Model download' }),
  ).toBeVisible();
  // While it downloads, the notebook link leads back to the progress.
  await page.getByRole('button', { name: 'Notebook', exact: true }).click();
  await page.getByRole('button', { name: 'View download progress' }).click();
  await expect(
    page.getByRole('progressbar', { name: 'Model download' }),
  ).toBeInViewport();
  await page.getByRole('button', { name: 'Cancel download' }).click();
  await expect(section.getByRole('alert')).toHaveText(
    'Download cancelled. Nothing was installed.',
  );
  await page.getByRole('button', { name: 'Download speech model' }).click();
  await page.evaluate(() => window.modelTest.finish());
  await expect(section).toContainText('is installed on this device');
  await expect(page.getByText('Ready on this device.')).toBeVisible();
  await page.getByRole('button', { name: 'Notebook', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Start live session' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Set up live session' }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Remove model' }).click();
  await expect(
    page.getByRole('button', { name: 'Download speech model' }),
  ).toBeVisible();
});

test('with a model to install, the setup card keeps a speech-model step that leads to Settings', async ({
  page,
}) => {
  await nativePage(page, '?model');
  const card = page.getByRole('region', { name: 'Before your first meeting' });
  await expect(card.getByRole('listitem')).toHaveCount(4);
  await expect(card).toContainText('Speech model, to do');
  await card.getByRole('button', { name: 'Set up the speech model' }).click();
  await expect(
    page.getByRole('heading', { name: 'Live transcription' }),
  ).toBeFocused();
  await expect(
    page.getByRole('button', { name: 'Download speech model' }),
  ).toBeVisible();
});

test('the live setup link fits narrow windows', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await nativePage(page, '?model');
  await page.getByRole('button', { name: 'Set up live session' }).waitFor();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(320);
});
