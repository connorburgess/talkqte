import { expect, test } from '@playwright/test';
import { firstCue, firstLine, standIn } from './fixtures/stand-in';

// Settings → Diagnostics on the fictional native stand-in: the report holds
// versions, settings and fixed codes, and nothing from the meeting. Every
// value here is fictional.

const NOTE = 'Fictional note: the greenhouse keys are in the blue tin.';
const FOCUS = 'Agree the fictional potluck seating chart';
const NAME = 'Marisol';
const APPLICATION = 'Fictional Call';
const DEVICE = 'Fictional Studio Microphone';

test('diagnostics show codes and settings, never meeting content, and copy only after review', async ({
  page,
  context,
  browserName,
}) => {
  // Only Chromium lets a test read the clipboard back.
  const readable = browserName === 'chromium';
  if (readable)
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await standIn(page, '/?live');
  await page
    .getByRole('textbox', { name: 'Meeting notes', exact: true })
    .fill(NOTE);
  await page.evaluate(() => window.liveTest.start());
  await page.evaluate(
    ([line, question]) => window.liveTest.say(line, question),
    [firstLine, firstCue],
  );
  await page.evaluate(
    ({ application, focus, name, device }) =>
      window.liveTest.publish({
        focus: [focus],
        userName: name,
        sources: {
          microphone: true,
          application,
          applicationAttached: true,
          applicationEnded: 'network',
          echoDropped: 3,
          echoes: [
            { id: 'e1', atMs: 2_000, speaker: 'You', text: 'Fictional echo.' },
          ],
        },
        transcription: {
          provider: 'Deepgram',
          stopped: 'stalled',
          reconnects: 2,
          lostMs: 4_200,
        },
        // Not a field the report reads; checked in case one ever carries it.
        deviceName: device,
      } as never),
    { application: APPLICATION, focus: FOCUS, name: NAME, device: DEVICE },
  );

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const section = page.getByRole('region', { name: 'Diagnostics' });
  await expect(
    section.getByRole('button', { name: 'Copy diagnostics' }),
  ).toHaveCount(0);
  await section.getByRole('button', { name: 'Show diagnostics' }).click();
  const report = section.getByLabel('Diagnostics report');
  await expect(report).toBeFocused();
  const text = (await report.textContent()) ?? '';
  for (const expected of [
    'TalkQTE: 0.1 alpha',
    'Build: desktop',
    'Deepgram key: set',
    'ElevenLabs key: set',
    'Anthropic key: set',
    'OpenAI key: notSet',
    'Gemini key: notSet',
    'Transcription provider: deepgram',
    'Cue provider: anthropic',
    'Session: live',
    'Application source: yes',
    'Application stopped: network',
    'Echo lines marked: 3',
    'Transcription service: Deepgram',
    'Transcription stopped: stalled',
    'Transcription reconnects: 2',
    'Speech lost to reconnects (s): 4',
  ])
    expect(text).toContain(expected);
  for (const content of [
    NOTE,
    'greenhouse',
    FOCUS,
    'potluck',
    NAME,
    APPLICATION,
    DEVICE,
    firstLine,
    'welcome guide',
    firstCue,
    'Fictional echo',
    'fictional-initial',
    'sk-ant',
  ])
    expect(text, `the report holds "${content}"`).not.toContain(content);

  await section.getByRole('button', { name: 'Copy diagnostics' }).click();
  if (readable) {
    await expect(section.getByRole('status')).toHaveText(
      'Copied. Paste it into your report.',
    );
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      text,
    );
  } else {
    await expect(section.getByRole('status')).toHaveText(
      /^(Copied\. Paste it into your report\.|Could not copy\. Select the text above and copy it yourself\.)$/,
    );
  }
  // Nothing is kept by the page.
  expect(
    await page.evaluate(() => [
      Object.keys(localStorage).length,
      Object.keys(sessionStorage).length,
    ]),
  ).toEqual([0, 0]);
});
