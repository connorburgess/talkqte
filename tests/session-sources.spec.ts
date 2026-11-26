import { expect, test, type Page } from '@playwright/test';
import type {} from './fixtures/native-microphone';

// A live session with the microphone and one application: lines carry the
// source they were heard from, the echo guard's count is shown, and the
// session says when the application is no longer heard. The fixture stands
// in for the native side; no device, stream or permission is involved.

async function notebook(page: Page) {
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
  await page.goto('/?keys=set');
  await page.evaluate(() => window.liveTest.start());
}

const both = {
  microphone: true,
  application: 'Fictional Call',
  applicationAttached: true,
};

test('a session with both sources labels lines by source, not by speaker', async ({
  page,
}) => {
  await notebook(page);
  await page.evaluate(
    (sources) =>
      window.liveTest.publish({
        sources,
        transcript: [
          {
            id: 'c1-1-1',
            atMs: 1_000,
            speaker: 'Them',
            text: 'Can you send the fictional budget?',
          },
          {
            id: 'c1-0-1',
            atMs: 2_000,
            speaker: 'You',
            text: 'Yes, by Friday.',
          },
        ],
      }),
    both,
  );
  await page.getByRole('tab', { name: /Transcript/ }).click();
  const transcript = page.locator('#transcript-panel');
  await expect(transcript).toContainText(
    'You: your microphone · Them: audio from Fictional Call',
  );
  await expect(transcript).toContainText(
    'The labels say where a line was heard, not who said it.',
  );
  await expect(transcript.locator('.transcript-segment strong')).toHaveText([
    'Them',
    'You',
  ]);
});

test('dropped echoes are counted and a stopped application is said plainly', async ({
  page,
}) => {
  await notebook(page);
  await page.evaluate(
    (sources) =>
      window.liveTest.publish({ sources: { ...sources, echoDropped: 2 } }),
    both,
  );
  await expect(
    page
      .getByRole('region', { name: 'Session' })
      .getByText(
        "2 microphone lines look like a repeat of Fictional Call's sound through your speakers. They are marked in the transcript, not used for cues; keep or remove each there. Headphones avoid this.",
      ),
  ).toBeVisible();
  await page.evaluate(
    (sources) =>
      window.liveTest.publish({
        sources: { ...sources, applicationEnded: 'network' },
      }),
    both,
  );
  await expect(page.getByRole('alert')).toContainText(
    'Audio from Fictional Call stopped: the connection failed or was lost. Check your internet connection. Only your microphone is heard now',
  );
  await page.evaluate(
    (sources) =>
      window.liveTest.publish({
        sources: {
          ...sources,
          applicationAttached: false,
          applicationEnded: 'not_started',
        },
      }),
    both,
  );
  await expect(page.getByRole('alert')).toContainText(
    'Audio from Fictional Call did not start.',
  );
});

test('system audio tap labels You/Them, counts echoes, and falls back calmly when denied or unsupported', async ({
  page,
}) => {
  await notebook(page);
  const systemAudio = {
    microphone: true,
    application: 'System audio',
    applicationAttached: true,
  };
  await page.evaluate(
    (sources) =>
      window.liveTest.publish({
        sources,
        transcript: [
          {
            id: 'c1-1-1',
            atMs: 1_000,
            speaker: 'Them',
            text: 'Can we move the review to Friday?',
          },
          {
            id: 'c1-0-1',
            atMs: 2_000,
            speaker: 'You',
            text: 'Yes, Friday afternoon works.',
          },
        ],
      }),
    systemAudio,
  );
  await expect(
    page.getByRole('region', { name: 'Session', exact: true }),
  ).toContainText('Your microphone and system audio · audio not recorded');
  await page.getByRole('tab', { name: /Transcript/ }).click();
  const transcript = page.locator('#transcript-panel');
  await expect(transcript).toContainText(
    'You: your microphone · Them: system audio · transcribed by Deepgram',
  );

  // Echo notice mentions system audio and headphones.
  await page.evaluate(
    (sources) =>
      window.liveTest.publish({ sources: { ...sources, echoDropped: 1 } }),
    systemAudio,
  );
  await expect(
    page
      .getByRole('region', { name: 'Session' })
      .getByText(
        '1 microphone line looks like a repeat of system audio through your speakers. They are marked in the transcript, not used for cues; keep or remove each there. Headphones avoid this.',
      ),
  ).toBeVisible();

  // Graceful fallback on macOS < 14.2.
  await page.evaluate(
    (sources) =>
      window.liveTest.publish({
        sources: {
          ...sources,
          applicationAttached: false,
          applicationEnded: 'unsupported',
        },
      }),
    systemAudio,
  );
  await expect(page.getByRole('alert')).toContainText(
    'System audio requires macOS 14.2 or later. Only your microphone is heard now.',
  );

  // Graceful fallback on denied System Audio Recording Only permission.
  await page.evaluate(
    (sources) =>
      window.liveTest.publish({
        sources: {
          ...sources,
          applicationAttached: false,
          applicationEnded: 'permission_denied',
        },
      }),
    systemAudio,
  );
  await expect(page.getByRole('alert')).toContainText(
    'System audio permission was not allowed. Check System Audio Recording Only for TalkQTE in System Settings → Privacy & Security. Only your microphone is heard now.',
  );
});

test('a microphone-only session keeps its plain wording', async ({ page }) => {
  await notebook(page);
  await page.evaluate(() =>
    window.liveTest.publish({ sources: { microphone: true } }),
  );
  await page.getByRole('tab', { name: /Transcript/ }).click();
  await expect(page.locator('#transcript-panel')).toContainText(
    'Your microphone · transcribed by Deepgram',
  );
  await expect(page.locator('#transcript-panel')).not.toContainText('Them');
});

test('a line suppressed as a likely echo is hidden by default behind a toggle, with Keep and Remove', async ({
  page,
}) => {
  await notebook(page);
  await page.evaluate(
    (sources) =>
      window.liveTest.publish({
        sources: {
          ...sources,
          echoDropped: 1,
          echoes: [
            {
              id: 'c1-0-2',
              atMs: 1_300,
              speaker: 'You',
              text: 'Can you send the revised fictional budget?',
            },
          ],
        },
        transcript: [
          {
            id: 'c1-1-1',
            atMs: 1_000,
            speaker: 'Them',
            text: 'Can you send the revised fictional budget?',
          },
          {
            id: 'c1-0-3',
            atMs: 2_000,
            speaker: 'You',
            text: 'Yes, by Friday.',
          },
        ],
      }),
    both,
  );
  await page.getByRole('tab', { name: /Transcript/ }).click();
  const transcript = page.locator('#transcript-panel');
  const lines = transcript.locator('.transcript-segment');
  // By default, flagged echoes are collapsed so speaker-mode calls do not double lines.
  await expect(lines).toHaveCount(2);
  await expect(
    transcript.getByText('Likely an echo of Them · not used for cues'),
  ).toHaveCount(0);
  const toggle = transcript.getByRole('button', {
    name: 'Show 1 likely echo line',
  });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  const hideToggle = transcript.getByRole('button', {
    name: 'Hide 1 likely echo line',
  });
  await expect(hideToggle).toHaveAttribute('aria-expanded', 'true');
  await expect(lines).toHaveCount(3);
  // In time order, the echo between the two ordinary lines.
  await expect(lines.nth(1)).toContainText(
    'Likely an echo of Them · not used for cues',
  );
  await lines.nth(1).getByRole('button', { name: 'It was me' }).click();
  await lines.nth(1).getByRole('button', { name: 'Remove' }).click();
  expect(await page.evaluate(() => window.captureTest.echoAnswers)).toEqual([
    { id: 'c1-0-2', keep: true },
    { id: 'c1-0-2', keep: false },
  ]);
  await hideToggle.click();
  await expect(lines).toHaveCount(2);
});

test('a long meeting transcript past 400 lines renders all lines in the live notebook', async ({
  page,
}) => {
  await notebook(page);
  const longTranscript = Array.from({ length: 450 }, (_, index) => ({
    id: `c1-0-${index + 1}`,
    atMs: (index + 1) * 1_000,
    speaker: index % 2 === 0 ? 'Them' : 'You',
    text: `Fictional long meeting line ${index + 1}.`,
  }));
  await page.evaluate(
    ([sources, transcript]) => window.liveTest.publish({ sources, transcript }),
    [both, longTranscript] as const,
  );
  await page.getByRole('tab', { name: /Transcript/ }).click();
  const transcript = page.locator('#transcript-panel');
  await expect(transcript.locator('.transcript-segment')).toHaveCount(450);
  await expect(transcript).toContainText('Fictional long meeting line 1.');
  await expect(transcript).toContainText('Fictional long meeting line 450.');
});

test('diarized remote speakers surface as Speaker 1, Speaker 2, fall back to Them, and rename inline', async ({
  page,
}) => {
  await notebook(page);
  await page.evaluate(
    (sources) =>
      window.liveTest.publish({
        sources,
        transcript: [
          {
            id: 'c1-1-1',
            atMs: 1_000,
            speaker: 'Speaker 1',
            speakerId: 0,
            text: 'Can we finalize the fictional budget?',
          },
          {
            id: 'c1-1-2',
            atMs: 2_000,
            speaker: 'Speaker 2',
            speakerId: 1,
            text: 'Yes, let us review Friday.',
          },
          {
            id: 'c1-1-3',
            atMs: 3_000,
            speaker: 'Speaker 1',
            speakerId: 0,
            text: 'I will send the updated sheet.',
          },
          {
            id: 'c1-1-4',
            atMs: 4_000,
            speaker: 'Them',
            text: 'Sounds good.',
          },
          {
            id: 'c1-0-1',
            atMs: 5_000,
            speaker: 'You',
            text: 'Thanks both.',
          },
        ],
      }),
    both,
  );
  await page.getByRole('tab', { name: /Transcript/ }).click();
  const transcript = page.locator('#transcript-panel');
  await expect(transcript).toContainText(
    'You: your microphone · Remote speakers: audio from Fictional Call (click a speaker name to rename)',
  );
  await expect(transcript.locator('.transcript-segment strong')).toHaveText([
    'Speaker 1',
    'Speaker 2',
    'Speaker 1',
    'Them',
    'You',
  ]);

  // Escape cancels without renaming.
  await transcript
    .locator('.transcript-segment')
    .nth(0)
    .getByRole('button', { name: 'Rename Speaker 1' })
    .click();
  const escapeInput = transcript.getByRole('textbox', {
    name: 'Speaker 1 name',
  });
  await expect(escapeInput).toBeFocused();
  await escapeInput.fill('Should not save');
  await escapeInput.press('Escape');
  await expect(transcript.locator('.transcript-segment strong')).toHaveText([
    'Speaker 1',
    'Speaker 2',
    'Speaker 1',
    'Them',
    'You',
  ]);

  // Clicking Speaker 1 and submitting updates all lines from Speaker 1 immediately.
  await transcript
    .locator('.transcript-segment')
    .nth(0)
    .getByRole('button', { name: 'Rename Speaker 1' })
    .click();
  const renameInput = transcript.getByRole('textbox', {
    name: 'Speaker 1 name',
  });
  await renameInput.fill('Priya Patel');
  await renameInput.press('Enter');
  await expect(transcript.locator('.transcript-segment strong')).toHaveText([
    'Priya Patel',
    'Speaker 2',
    'Priya Patel',
    'Them',
    'You',
  ]);
});
