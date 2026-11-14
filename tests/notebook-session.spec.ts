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

test('before a session, a build without local transcription says plainly that it cannot show a cue', async ({
  page,
}) => {
  await standIn(page);
  await expect(title(page)).toHaveText('No session yet');
  await expect(session(page)).toContainText(
    'Nothing is being captured. Cues appear only during a live session. This build does not include local transcription.',
  );
  await expect(
    page.getByRole('button', { name: 'Start live session' }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('complementary', { name: 'Question companion' }),
  ).toContainText(
    'No cue yet.During a live session, one cue at a time appears here. Cues come from simple phrase rules on what is transcribed, not from AI.',
  );
  await page.getByRole('tab', { name: /Transcript/ }).click();
  await expect(page.getByRole('tabpanel')).toContainText(
    'No transcript yet.Nothing has been transcribed. Nothing is being captured.',
  );
  await expect(page.locator('.notebook-footer')).toHaveText(
    'Your notes stay in memory until you quit. Export anything you want to keep before closing.',
  );
  // No session clock and nothing fictional: this is the person's own notebook.
  await expect(page.locator('.session-clock')).toHaveCount(0);
  await expect(page.locator('.session-state .status-dot')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText(/demo|fictional/i);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.locator('body')).not.toContainText(/demo|fictional/i);
});

test('before a session, a build that needs its speech model points to setup', async ({
  page,
}) => {
  await standIn(page, '/?model');
  await expect(title(page)).toHaveText('No session yet');
  await expect(session(page)).toContainText(
    'Nothing is being captured. A live session needs the speech model first.',
  );
  await session(page)
    .getByRole('button', { name: 'Set up live session' })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Live transcription' }),
  ).toBeFocused();
});

test('a session runs from Start to Stop, and what remains afterwards is stated', async ({
  page,
}) => {
  await standIn(page, '/?live');
  await page
    .getByRole('textbox', { name: 'Meeting notes' })
    .fill('Fictional note: ask about the welcome guide.');
  await expect(session(page)).toContainText(
    'Nothing is being captured. Start a live session when your meeting begins.',
  );
  await session(page)
    .getByRole('button', { name: 'Start live session' })
    .click();
  await expect(title(page)).toHaveText('Live session in progress');
  await expect(session(page)).toContainText(
    'Your microphone · transcribed on this device · not saved',
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
    'Nothing was saved. Your notes and the transcript stay here until you start another session or quit.',
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
  // A live session is never exported, and a new one can be started.
  await expect(
    page.getByRole('button', { name: 'Export', exact: true }),
  ).toBeDisabled();
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

test('keeping a quoted line puts it in the notes with its time and lets the cue go', async ({
  page,
}) => {
  await standIn(page, '/?live');
  await startLive(page);
  await page
    .getByRole('textbox', { name: 'Meeting notes' })
    .fill('Fictional note.');
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
  await question.getByRole('button', { name: 'Keep this line' }).click();
  await expect(question).toHaveCount(0);
  await expect(
    page.getByRole('textbox', { name: 'Meeting notes' }),
  ).toHaveValue(
    "Fictional note.\n[00:01] Speaker: “Let's have it ready by Friday.”\n",
  );
  await expect(page.getByText('Line kept in your notes.')).toBeVisible();
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
