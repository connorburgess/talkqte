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

test('a line suppressed as a likely echo stays visible, marked, with Keep and Remove', async ({
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
});
