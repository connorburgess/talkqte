import { expect, test } from '@playwright/test';
import {
  cue,
  firstCue,
  firstLine,
  liveCue,
  standIn,
  startLive,
} from './fixtures/stand-in';

// The notebook before, during and after a session, on the fictional native
// stand-in: no device, model or transcription is involved, so these establish
// what the notebook shows and offers, not capture.

const title = (page: import('@playwright/test').Page) =>
  page.getByRole('heading', { level: 1 });
const session = (page: import('@playwright/test').Page) =>
  page.getByRole('region', { name: 'Session', exact: true });

test('before a session, a build without live transcription says plainly that it cannot show a cue', async ({
  page,
}) => {
  await standIn(page);
  await expect(title(page)).toHaveText('No session yet');
  await expect(session(page)).toContainText(
    'Nothing is captured. This build has no live transcription.',
  );
  await expect(
    page.getByRole('button', { name: 'Start live session' }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('complementary', { name: 'Question companion' }),
  ).toContainText(
    'No cue yet.One cue at a time appears here during a live session (phrase rules only in this build).',
  );
  await page.getByRole('tab', { name: /Transcript/ }).click();
  await expect(page.getByRole('tabpanel')).toContainText(
    'No transcript yet.Lines appear here during a live session.',
  );
  await expect(page.locator('.notebook-footer')).toHaveText(
    'Notes stay in memory until you quit. Export before closing to keep them.',
  );
  // No session clock and nothing fictional: this is the person's own notebook.
  await expect(page.locator('.session-clock')).toHaveCount(0);
  await expect(page.locator('.session-state .status-dot')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText(/demo|fictional/i);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.locator('body')).not.toContainText(/demo|fictional/i);
});

test('before a session, the notebook never says nothing is captured while the microphone check or an application source is on', async ({
  page,
}) => {
  await standIn(page, '/?live');
  await expect(session(page)).toContainText(
    'Nothing is captured until you start a live session.',
  );
  await page.evaluate(() =>
    window.microphoneTest.send({
      status: 'listening',
      activity: 'active',
      canStart: false,
    }),
  );
  await expect(session(page)).toContainText(
    'No live session. Mic check is on; nothing is recorded or transcribed.',
  );
  await expect(session(page)).not.toContainText('Nothing is being captured');
  // A denied permission leaves the check failed and released: Settings
  // says Unavailable, and the notebook hides the active bar and must not call the check on.
  await page.evaluate(() =>
    window.microphoneTest.send({
      status: 'error',
      activity: 'quiet',
      canStart: true,
      message: 'Check microphone permission in System Settings.',
    }),
  );
  await expect(
    page.getByRole('region', { name: 'Microphone', exact: true }),
  ).toHaveCount(0);
  await expect(session(page)).toContainText(
    'Nothing is captured until you start a live session.',
  );
  await expect(session(page)).not.toContainText('microphone check above is on');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(
    page
      .getByRole('region', { name: 'Microphone', exact: true })
      .getByRole('status'),
  ).toHaveText('Unavailable');
  await page.getByRole('button', { name: 'Notebook', exact: true }).click();
  // While a failed device is still being released, it is not called off.
  await page.evaluate(() =>
    window.microphoneTest.send({ status: 'error', canStart: false }),
  );
  await expect(session(page)).toContainText(
    'No live session. Releasing microphone; see above.',
  );
  await expect(session(page)).not.toContainText('Nothing is being captured');
  await page.evaluate(() =>
    window.microphoneTest.send({
      status: 'off',
      canStart: true,
      message: null,
    }),
  );
  await expect(session(page)).toContainText(
    'Nothing is captured until you start a live session.',
  );
  await page.evaluate(() =>
    window.captureTest.send({
      source: {
        phase: 'stopping',
        mayBeCapturing: true,
        stalled: false,
        canRetry: false,
        application: 'Fictional player',
        problem: null,
        operation: 'fictional-operation',
        sourceSession: false,
      },
    }),
  );
  await expect(session(page)).toContainText(
    'No live session. Selected app audio may still be capturing; see Cue processing above.',
  );
  await expect(session(page)).not.toContainText('Nothing is being captured');
});

test('a session runs from Start to Stop, and what remains afterwards is stated', async ({
  page,
}) => {
  await standIn(page, '/?live');
  await page
    .getByRole('textbox', { name: 'Meeting notes' })
    .fill('Fictional note: ask about the welcome guide.');
  await expect(session(page)).toContainText(
    'Nothing is captured until you start a live session.',
  );
  await session(page)
    .getByRole('button', { name: 'Start live session' })
    .click();
  await expect(title(page)).toHaveText('Live session in progress');
  await expect(session(page)).toContainText(
    'Your microphone · audio not recorded',
  );
  await expect(
    session(page).getByRole('button', { name: 'Start live session' }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Export', exact: true }),
  ).toBeDisabled();
  await page.evaluate(
    ([text, question]) => window.liveTest.say(text, question),
    [firstLine, firstCue],
  );
  await expect(page.getByRole('heading', { name: firstCue })).toBeVisible();
  // Notes written before the session are still there during it.
  await expect(
    page.getByRole('textbox', { name: 'Meeting notes' }),
  ).toHaveValue('Fictional note: ask about the welcome guide.');
  await page
    .getByRole('button', { name: 'Stop live session', exact: true })
    .first()
    .click();
  await page.evaluate(() => window.captureTest.finishStop());
  await expect(title(page)).toHaveText('Live session ended');
  await expect(session(page)).toContainText(
    'Saved to Meetings. Notes stay here until you start another session or quit.',
  );
  await expect(page.getByRole('heading', { name: firstCue })).toHaveCount(0);
  await expect(
    page.getByRole('complementary', { name: 'Question companion' }),
  ).toContainText('Cues have stopped.');
  await page.getByRole('tab', { name: /Transcript/ }).click();
  await expect(page.getByRole('tabpanel')).toContainText(firstLine);
  await expect(
    page.getByRole('textbox', { name: 'Meeting notes' }),
  ).toHaveCount(0);
  await page.getByRole('tab', { name: 'Notes', exact: true }).click();
  await expect(
    page.getByRole('textbox', { name: 'Meeting notes' }),
  ).toHaveValue('Fictional note: ask about the welcome guide.');
  // After Stop the notes can be exported; the transcript never is.
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const review = page.getByRole('dialog', { name: 'Review your export' });
  await expect(review.locator('pre')).toHaveText(
    '# TalkQTE notes\n\nFictional note: ask about the welcome guide.\n',
    { useInnerText: true },
  );
  await expect(review).not.toContainText('first draft');
  await page.keyboard.press('Escape');
  await expect(page.locator('.notebook-footer')).toHaveText(
    'Saved in Meetings on this Mac. Only leaves if you generate meeting notes or export.',
  );
  // A new session can be started.
  await expect(
    session(page).getByRole('button', { name: 'Start live session' }),
  ).toBeEnabled();
});

test('a cue is dismissed without any way to save it', async ({ page }) => {
  await standIn(page, '/?live');
  await liveCue(page);
  await expect(page.getByRole('heading', { name: firstCue })).toBeVisible();
  await expect(page.getByRole('button', { name: /Save/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await expect(
    page.getByRole('region', { name: 'Suggested question' }),
  ).toHaveCount(0);
  await expect(page.getByText('Question dismissed.')).toBeVisible();
});

test('a quoted line shows as a cue and leaves the notes alone', async ({
  page,
}) => {
  await standIn(page, '/?live');
  await startLive(page);
  const line = "A single page sounds right. Let's have it ready by Friday.";
  await page.evaluate((text) => window.liveTest.say(text), line);
  await page.evaluate(
    (value) => window.liveTest.setCue(value),
    cue({
      kind: 'Said',
      question: "Let's have it ready by Friday.",
      evidence: line,
    }),
  );
  const question = page.getByRole('region', { name: 'Suggested question' });
  await expect(question).toContainText('Just said');
  await expect(question.getByRole('heading')).toHaveText(
    "“Let's have it ready by Friday.”",
  );
  // The card offers no way to save the line: the cue is for the moment.
  await expect(question.getByRole('button')).toHaveCount(2);
  await question.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await expect(
    page.getByRole('textbox', { name: 'Meeting notes' }),
  ).toHaveValue('');
});

for (const width of [320, 390, 880]) {
  test(`session and cue controls stay readable and comfortably sized at ${width}px with reduced motion`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await standIn(page, '/?live');
    await liveCue(page);
    await expect(page.getByRole('heading', { name: firstCue })).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    for (const name of [
      'Export',
      'Pause cues',
      'Stop live session',
      'Dismiss',
    ]) {
      const button = page.getByRole('button', { name, exact: true }).first();
      const bounds = await button.boundingBox();
      expect(bounds!.width, name).toBeGreaterThanOrEqual(44);
      expect(bounds!.height, name).toBeGreaterThanOrEqual(44);
      expect(
        await button.evaluate((el) => el.scrollWidth <= el.clientWidth),
        name,
      ).toBe(true);
    }
    const dismiss = page.getByRole('button', { name: 'Dismiss', exact: true });
    await expect(dismiss).toHaveCSS('transition-duration', '0s');
    await dismiss.click();
    await expect(
      page.getByRole('region', { name: 'Suggested question' }),
    ).toHaveCount(0);
  });
}

test('a simulated replay is labelled in the app’s own words and never as live or as a microphone', async ({
  page,
}) => {
  await standIn(page);
  await page.evaluate(() =>
    window.liveTest.simulate({ title: 'Fictional stand-up' }),
  );
  await expect(title(page)).toHaveText('Simulated session');
  await expect(session(page)).toContainText(
    'Fictional replay · nothing is captured',
  );
  await expect(session(page)).not.toContainText(/Live|microphone|Mic on/);
  await expect(
    page.getByRole('button', { name: 'Start live session' }),
  ).toHaveCount(0);
  await page.evaluate(
    (value) => window.liveTest.setCue(value),
    cue({ kind: 'Owner', question: firstCue, evidence: firstLine }),
  );
  await expect(page.getByRole('heading', { name: firstCue })).toBeVisible();

  const companion = await page.context().newPage();
  await standIn(companion, '/?window=cue');
  await companion.evaluate(() => window.liveTest.simulate());
  await expect(companion.getByRole('status')).toHaveText(
    'Simulated session · Fictional',
  );
  await expect(companion.getByText(/Mic on|Live/)).toHaveCount(0);
  await expect(
    companion.getByRole('button', { name: /Pause|Resume|Stop/ }),
  ).toHaveCount(0);
});

test('with cloud transcription, the notebook names the service, and says plainly when it stopped', async ({
  page,
}) => {
  await standIn(page, '/?live');
  await startLive(page);
  const publish = (value: Record<string, unknown>) =>
    page.evaluate((value) => window.liveTest.publish(value as never), value);
  await publish({ transcription: { provider: 'Deepgram' } });
  await expect(session(page)).toContainText(
    'Your microphone · audio not recorded',
  );
  await expect(page.getByRole('region', { name: 'Microphone' })).toContainText(
    'Your microphone is sent to Deepgram for transcription. TalkQTE does not record audio.',
  );
  await expect(page.locator('body')).not.toContainText('on this device');
  await publish({
    status: 'ended',
    transcription: { provider: 'Deepgram', stopped: 'withdrawn' },
  });
  await expect(session(page).getByRole('alert')).toHaveText(
    'Transcription by Deepgram stopped: cue processing was turned off, so audio stopped being sent. The live session ended; nothing fell back to another transcription service.',
  );
});

test("each way transcription can stop with the person's own key says what happened and what to do", async ({
  page,
}) => {
  await standIn(page, '/?live');
  await startLive(page);
  for (const [stopped, said] of [
    [
      'auth',
      'the service refused the API key or credential. Replace the key in Settings.',
    ],
    [
      'key_unavailable',
      'your Deepgram key could not be read from the Keychain, or it was removed. Check it in Settings.',
    ],
    [
      'quota',
      'the account cannot pay for more audio. Add credit in your Deepgram account.',
    ],
    ['rate_limited', 'the service is limiting requests. Wait a minute.'],
    [
      'network',
      'the connection failed or was lost. Check your internet connection.',
    ],
    ['unavailable', 'the service is having a problem on its side.'],
    ['cap_reached', 'the transcription minute limit was reached.'],
  ]) {
    await page.evaluate(
      (stopped) =>
        window.liveTest.publish({
          status: 'ended',
          transcription: { provider: 'Deepgram', stopped },
        } as never),
      stopped,
    );
    await expect(session(page).getByRole('alert')).toHaveText(
      `Transcription by Deepgram stopped: ${said} The live session ended; nothing fell back to another transcription service.`,
    );
  }
});

test('the notebook says the transcription cap is near before the session ends on it, and announces it once', async ({
  page,
}) => {
  await standIn(page, '/?live');
  await startLive(page);
  const publish = (minutesLeft: number) =>
    page.evaluate(
      (minutesLeft) =>
        window.liveTest.publish({
          transcription: { provider: 'Deepgram', minutesLeft },
        } as never),
      minutesLeft,
    );
  await publish(10);
  const said =
    "About 10 minutes of transcription are left before this session's 120-minute cap; then the session ends.";
  await expect(session(page)).toContainText(said);
  const notice = page.getByRole('status').filter({ hasText: 'cap; then' });
  await expect(notice).toContainText(said);
  await publish(1);
  await expect(session(page)).toContainText(
    "About 1 minute of transcription is left before this session's 120-minute cap",
  );
  // The countdown is shown, not read out again each minute.
  await expect(notice).toContainText('About 10 minutes');
});

test('a live launch says where audio goes in Settings, offers no speech model, and says when a lab run ended or audio was dropped', async ({
  page,
}) => {
  await standIn(page, '/?cloud&model');
  // No speech model is offered or needed for a cloud launch.
  await expect(
    page.getByRole('button', { name: 'Start live session' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.locator('#live-transcription').locator('..');
  await expect(settings).toContainText(
    'TalkQTE does not transcribe on this device. Pressing Start live session sends audio (from your mic and, on macOS 14.2+, system audio) to Deepgram and recent lines to Anthropic with your keys until you stop or turn off processing.',
  );
  await expect(settings.getByRole('status')).toHaveText(
    'Ready. Pressing Start live session sends audio to Deepgram and recent lines to Anthropic until you stop.',
  );
  await expect(page.locator('body')).not.toContainText('Ready on this device');
  await expect(
    page.getByRole('button', { name: 'Download speech model' }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Notebook', exact: true }).click();
  await startLive(page);
  const publish = (value: Record<string, unknown>) =>
    page.evaluate((value) => window.liveTest.publish(value as never), value);
  await publish({
    transcription: { provider: 'Deepgram', droppedAudio: true },
  });
  await expect(session(page)).toContainText(
    'Some audio was not sent to Deepgram because the connection fell behind; lines from it are missing.',
  );
  await publish({
    status: 'ended',
    transcription: { provider: 'Deepgram', stopped: 'lab_ended' },
  });
  await expect(session(page).getByRole('alert')).toHaveText(
    'Transcription by Deepgram stopped: the lab run ended, so audio stopped being sent. The live session ended; nothing fell back to another transcription service.',
  );
  await publish({
    status: 'ended',
    transcription: { provider: 'Deepgram', stopped: 'stalled' },
  });
  await expect(session(page).getByRole('alert')).toHaveText(
    'Transcription by Deepgram stopped: the connection stopped responding. The live session ended; nothing fell back to another transcription service.',
  );
});

test('a continued cloud session discloses reconnect loss until the session stops', async ({
  page,
}) => {
  await standIn(page, '/?cloud&model');
  await startLive(page);
  const publish = (value: Record<string, unknown>) =>
    page.evaluate((value) => window.liveTest.publish(value as never), value);
  await publish({
    transcription: { provider: 'Deepgram', reconnects: 1, lostMs: 2_400 },
  });
  await expect(session(page)).toContainText(
    'Transcription by Deepgram reconnected once after a connection problem. About 2 s of speech was not transcribed.',
  );
  await publish({
    transcription: { provider: 'Deepgram', reconnects: 1, lostMs: 250 },
  });
  await expect(session(page)).toContainText(
    'Less than 1 s of speech was not transcribed.',
  );
  await publish({
    transcription: { provider: 'Deepgram', reconnects: 1, lostMs: 0 },
  });
  await expect(session(page)).toContainText(
    'The amount of speech not transcribed is unknown.',
  );
  await publish({
    status: 'ended',
    transcription: {
      provider: 'Deepgram',
      reconnects: 1,
      lostMs: 2_400,
      stopped: 'withdrawn',
    },
  });
  await expect(session(page).getByRole('alert')).toContainText(
    'Transcription by Deepgram stopped: cue processing was turned off',
  );
  await expect(session(page)).not.toContainText('reconnected');
});

test('ElevenLabs transcription names ElevenLabs in active, stop, and failure messages', async ({
  page,
}) => {
  await standIn(page, '/?live');
  await startLive(page);
  const publish = (value: Record<string, unknown>) =>
    page.evaluate((value) => window.liveTest.publish(value as never), value);
  await publish({
    transcription: { provider: 'ElevenLabs' },
  });
  await expect(page.getByRole('region', { name: 'Microphone' })).toContainText(
    'Your microphone is sent to ElevenLabs for transcription. TalkQTE does not record audio.',
  );
  await publish({
    transcription: { provider: 'ElevenLabs', reconnects: 1, lostMs: 1_500 },
  });
  await expect(session(page)).toContainText(
    'Transcription by ElevenLabs reconnected once after a connection problem. About 2 s of speech was not transcribed.',
  );
  await publish({
    transcription: { provider: 'ElevenLabs', droppedAudio: true },
  });
  await expect(session(page)).toContainText(
    'Some audio was not sent to ElevenLabs because the connection fell behind; lines from it are missing.',
  );
  await publish({
    status: 'ended',
    transcription: {
      provider: 'ElevenLabs',
      stopped: 'key_unavailable',
    },
  });
  await expect(session(page).getByRole('alert')).toHaveText(
    'Transcription by ElevenLabs stopped: your ElevenLabs key could not be read from the Keychain, or it was removed. Check it in Settings. The live session ended; nothing fell back to another transcription service.',
  );
  await publish({
    status: 'ended',
    transcription: {
      provider: 'ElevenLabs',
      stopped: 'quota',
    },
  });
  await expect(session(page).getByRole('alert')).toHaveText(
    'Transcription by ElevenLabs stopped: the account cannot pay for more audio. Add credit in your ElevenLabs account. The live session ended; nothing fell back to another transcription service.',
  );
});
