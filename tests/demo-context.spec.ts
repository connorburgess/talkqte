import { expect, test, type Page } from '@playwright/test';
import context from '../src/demo-context.json' with { type: 'json' };
import phrased from '../src/demo-phrases.json' with { type: 'json' };

// The authored, phrase-timed run of the fictional demo (`?demo=context`).
// Times come from the fixtures, so re-timing the speech moves these checks
// with it. The preview adapter ticks every 200 ms.
const TICK = 200;
const arrival = (id: string) =>
  phrased.phrases.find((p) => p.id === id)!.endMs + phrased.deliveryDelayMs;
const text = (id: string) => phrased.phrases.find((p) => p.id === id)!.text;
const [draft, visitors, sign] = context.opportunities;
const [committee, schedule] = context.notes;
const { visibleMs, quietMs } = context.lifecycle;

const question = (page: Page) =>
  page.getByRole('region', { name: 'Suggested question' });
const panel = (page: Page) =>
  page.getByRole('region', { name: 'Prior context' });
/** Prior context is folded under a summary of how many notes are selected. */
async function openPanel(page: Page) {
  const summary = panel(page).locator('summary');
  if (
    !(await panel(page)
      .locator('details')
      .evaluate((d) => d.hasAttribute('open')))
  )
    await summary.click();
}
const transcript = (page: Page) =>
  page.getByRole('tabpanel', { name: /Transcript/ });
const button = (page: Page, name: string) =>
  page.getByRole('button', { name, exact: true });

/** Advances the paused test clock to a time on the demo clock. */
async function runTo(page: Page, ms: number) {
  const now = await page.evaluate(() => performance.now());
  const started = await page.evaluate(
    () => (window as unknown as { demoStart: number }).demoStart,
  );
  await page.clock.runFor(Math.max(0, started + ms - now));
}
async function start(page: Page, replay = false) {
  await button(page, replay ? 'Replay demo' : 'Try demo').click();
  await page.evaluate(() => {
    (window as unknown as { demoStart: number }).demoStart = performance.now();
  });
}

/** Loads the page, then stops the clock so only `runFor` moves time. */
async function open(page: Page, url: string) {
  await page.goto(url);
  await expect(button(page, 'Try demo')).toBeVisible();
  await page.clock.pauseAt(Date.now() + 60_000);
}

test.beforeEach(async ({ page }) => {
  await page.clock.install();
  await open(page, '/?demo=context');
});

test('fictional prior notes are already selected, labeled, and removable', async ({
  page,
}) => {
  await expect(panel(page).locator('summary')).toContainText(
    '2 notes selected',
  );
  await openPanel(page);
  const notes = panel(page).getByRole('listitem');
  await expect(notes).toHaveCount(2);
  await expect(notes.nth(0)).toContainText(committee.title);
  await expect(notes.nth(0)).toContainText('Sam offered to draft');
  await expect(notes.nth(1)).toContainText(schedule.title);
  for (const note of context.notes) expect(note.title).toMatch(/fictional/i);
  await button(page, `Remove ${schedule.title} (${schedule.date})`).click();
  await expect(notes).toHaveCount(1);
  await expect(panel(page)).not.toContainText(schedule.title);
});

test('the transcript arrives in phrases and a cue follows its phrase mid-turn', async ({
  page,
}) => {
  await start(page);
  // Just before the triggering phrase arrives: earlier phrases only, no cue.
  await runTo(page, arrival(draft.phraseId) - TICK);
  await expect(transcript(page)).toContainText(text('s2-p1'));
  await expect(transcript(page)).not.toContainText(text(draft.phraseId));
  await expect(question(page)).toHaveCount(0);
  // Once it has arrived, the cue is up while the turn is still unfinished.
  await runTo(page, arrival(draft.phraseId) + TICK);
  await expect(transcript(page)).toContainText(text(draft.phraseId));
  await expect(transcript(page)).not.toContainText(text('s2-p3'));
  await expect(
    question(page).getByRole('heading', { name: draft.cue }),
  ).toBeVisible();
  await expect(question(page)).toContainText(
    `From ${committee.title} · ${committee.date}`,
  );
  // The long third turn is delivered piece by piece, not at its end.
  await runTo(page, arrival('s3-p4') + TICK);
  await expect(transcript(page)).toContainText(text('s3-p4'));
  await expect(transcript(page)).not.toContainText(text('s3-p5'));
});

test('an untouched run shows the three authored cues and nothing from the phrase rules', async ({
  page,
}) => {
  await start(page);
  for (const [i, opportunity] of context.opportunities.entries()) {
    const at = arrival(opportunity.phraseId);
    await runTo(page, at - TICK);
    await expect(question(page)).toHaveCount(0);
    await runTo(page, at + TICK);
    await expect(
      question(page).getByRole('heading', { name: opportunity.cue }),
    ).toBeVisible();
    await expect(page.getByText('Keep this line')).toHaveCount(0);
    if (i === 2) break;
    // It leaves after the demo's stated time on screen.
    await runTo(page, at + visibleMs - 2 * TICK);
    await expect(question(page)).toBeVisible();
    await runTo(page, at + visibleMs + TICK);
    await expect(question(page)).toHaveCount(0);
  }
  await runTo(page, 64_000);
  await expect(button(page, 'Replay demo')).toBeVisible();
  await expect(question(page)).toHaveCount(0);
  await expect(transcript(page)).not.toContainText('Who will take');
});

test('Why? shows the spoken phrase and the prior note, and holds the cue in place', async ({
  page,
}) => {
  await start(page);
  await runTo(page, arrival(draft.phraseId) + TICK);
  await question(page).getByRole('button', { expanded: false }).click();
  const sources = question(page).getByRole('list', { name: 'Cue sources' });
  await expect(sources.getByRole('listitem')).toHaveCount(2);
  await expect(sources.getByRole('listitem').nth(0)).toContainText(
    /This conversation · 0:07 · Alex/,
  );
  await expect(sources.getByRole('listitem').nth(0)).toContainText(
    text(draft.phraseId),
  );
  await expect(sources.getByRole('listitem').nth(1)).toContainText(
    committee.title,
  );
  await expect(sources.getByRole('listitem').nth(1)).toContainText(
    `${committee.date} · prior note`,
  );
  await expect(sources.getByRole('listitem').nth(1)).toContainText(
    draft.support[0],
  );
  // Only the supporting words are quoted, not the whole note.
  await expect(question(page)).not.toContainText('council');
  await expect(question(page)).toContainText(
    'Prior notes are not from this conversation.',
  );
  // A held cue outlives its time and is not replaced by the next opportunity.
  await runTo(page, arrival(visitors.phraseId) + 2 * TICK);
  await expect(
    question(page).getByRole('heading', { name: draft.cue }),
  ).toBeVisible();
  await expect(question(page)).toContainText('Kept here until you dismiss it.');
  // Dismissing it does not bring back the opportunity it blocked.
  await button(page, 'Dismiss').click();
  await expect(question(page)).toHaveCount(0);
  await runTo(page, arrival(sign.phraseId) - TICK);
  await expect(question(page)).toHaveCount(0);
  await runTo(page, arrival(sign.phraseId) + TICK);
  await expect(
    question(page).getByRole('heading', { name: sign.cue }),
  ).toBeVisible();
});

test('Pause freezes the transcript and the cue; Resume continues both', async ({
  page,
}) => {
  await start(page);
  const at = arrival(draft.phraseId);
  await runTo(page, at + TICK);
  await button(page, 'Pause').click();
  const lines = await transcript(page).locator('article').count();
  await page.clock.runFor(30_000);
  await expect(question(page)).toBeVisible();
  await expect(transcript(page).locator('article')).toHaveCount(lines);
  await button(page, 'Resume').click();
  // Its time on screen is counted on the demo clock, not the wall clock.
  await page.clock.runFor(visibleMs - 3 * TICK);
  await expect(question(page)).toBeVisible();
  await expect(transcript(page)).toContainText(text('s3-p3'));
  await page.clock.runFor(5 * TICK);
  await expect(question(page)).toHaveCount(0);
});

test('a dismissed cue starts the pause, and an opportunity inside it is not queued', async ({
  page,
}) => {
  await start(page);
  await runTo(page, arrival(visitors.phraseId) + TICK);
  await expect(
    question(page).getByRole('heading', { name: visitors.cue }),
  ).toBeVisible();
  // Read it, then dismiss late enough that the third opportunity falls
  // inside the pause that follows.
  await question(page).getByRole('button', { expanded: false }).click();
  const dismissedAt = arrival(sign.phraseId) - quietMs + 1000;
  await runTo(page, dismissedAt);
  await button(page, 'Dismiss').click();
  await expect(question(page)).toHaveCount(0);
  await runTo(page, arrival(sign.phraseId) + TICK);
  await expect(transcript(page)).toContainText(text(sign.phraseId));
  await expect(question(page)).toHaveCount(0);
  // The pause has ended, and the skipped cue still does not appear.
  await runTo(page, dismissedAt + quietMs + 1000);
  await expect(question(page)).toHaveCount(0);
  await runTo(page, 64_000);
  await expect(question(page)).toHaveCount(0);
});

test('Replay starts the opportunities again from the first', async ({
  page,
}) => {
  await start(page);
  await runTo(page, arrival(draft.phraseId) + TICK);
  await button(page, 'Dismiss').click();
  await runTo(page, arrival(visitors.phraseId) + TICK);
  await expect(
    question(page).getByRole('heading', { name: visitors.cue }),
  ).toBeVisible();
  await button(page, 'End demo').click();
  await expect(question(page)).toHaveCount(0);
  await start(page, true);
  await expect(transcript(page).locator('article')).toHaveCount(0);
  await runTo(page, arrival(draft.phraseId) - TICK);
  await expect(question(page)).toHaveCount(0);
  await runTo(page, arrival(draft.phraseId) + TICK);
  await expect(
    question(page).getByRole('heading', { name: draft.cue }),
  ).toBeVisible();
});

test('a cue is not raised once its fictional note is removed, and a shown one is withdrawn', async ({
  page,
}) => {
  await openPanel(page);
  await button(page, `Remove ${schedule.title} (${schedule.date})`).click();
  await start(page);
  await runTo(page, arrival(draft.phraseId) + TICK);
  await expect(
    question(page).getByRole('heading', { name: draft.cue }),
  ).toBeVisible();
  // The visitor cue's note is gone: its phrase arrives and nothing shows.
  await runTo(page, arrival(visitors.phraseId) + TICK);
  await expect(transcript(page)).toContainText(text(visitors.phraseId));
  await expect(question(page)).toHaveCount(0);
  // Removing the note behind a held cue withdraws it.
  await runTo(page, arrival(sign.phraseId) + TICK);
  await question(page).getByRole('button', { expanded: false }).click();
  await expect(question(page)).toContainText(sign.support[0]);
  await button(page, `Remove ${committee.title} (${committee.date})`).click();
  await expect(question(page)).toHaveCount(0);
  await expect(page.getByText(sign.support[0])).toHaveCount(0);
  // Removed notes stay removed on replay, so no authored cue returns.
  await runTo(page, 64_000);
  await start(page, true);
  await expect(panel(page)).toContainText('No prior notes selected.');
  await runTo(page, arrival(draft.phraseId) + TICK);
  await expect(question(page)).toHaveCount(0);
});

test('imported notes neither feed the authored cues nor raise their own reminder', async ({
  page,
}) => {
  await openPanel(page);
  await button(page, 'Add notes from a file').click();
  const dialog = page.getByRole('dialog', { name: /Choose notes/ });
  await dialog.getByRole('checkbox', { name: /Garden welcome guide/ }).check();
  await dialog.getByRole('checkbox', { name: /Sign at the gate/ }).check();
  await dialog.getByRole('button', { name: 'Import 2 selected' }).click();
  const notes = panel(page).getByRole('listitem');
  await expect(notes).toHaveCount(4);
  // Removing an imported note leaves the demo's notes and cues alone.
  await button(page, 'Remove Sign at the gate (2026-11-05)').click();
  await expect(notes).toHaveCount(3);
  await button(page, `Remove ${committee.title} (${committee.date})`).click();
  await expect(notes).toHaveCount(2);
  await expect(panel(page)).toContainText('Garden welcome guide');
  await start(page);
  // The opening line names the imported note; the authored run stays silent,
  // and the imported note cannot stand in for the removed fictional one.
  await runTo(page, arrival(draft.phraseId) + TICK);
  await expect(transcript(page)).toContainText('welcome guide');
  await expect(question(page)).toHaveCount(0);
  await runTo(page, arrival(visitors.phraseId) + TICK);
  await expect(
    question(page).getByRole('heading', { name: visitors.cue }),
  ).toBeVisible();
  await runTo(page, arrival(sign.phraseId) + TICK);
  await expect(question(page)).toHaveCount(0);
});

test('the Quiet setting keeps its longer pause in the authored run', async ({
  page,
}) => {
  await button(page, 'Settings').click();
  await page
    .getByRole('combobox', { name: 'Question timing' })
    .selectOption('quiet');
  await button(page, 'Notebook').click();
  await start(page);
  await runTo(page, arrival(draft.phraseId) + TICK);
  await expect(question(page)).toBeVisible();
  // 30 s after the first cue left, the second opportunity is still inside it.
  await runTo(page, arrival(visitors.phraseId) + TICK);
  await expect(question(page)).toHaveCount(0);
  await runTo(page, arrival(sign.phraseId) + TICK);
  await expect(
    question(page).getByRole('heading', { name: sign.cue }),
  ).toBeVisible();
});

test('the export writes each turn as one line', async ({ page }) => {
  await start(page);
  await runTo(page, arrival('s2-p3') + TICK);
  await button(page, 'Export').click();
  const preview = page
    .getByRole('dialog', { name: 'Review your export' })
    .locator('pre');
  await expect(preview).toContainText(
    '**Alex:** Agreed. Someone can take the first draft of the welcome guide.',
  );
  await expect(preview).toContainText('Fictional demo transcript');
  await expect(preview).not.toContainText('Sam offered');
});

test('the default demo is unchanged: whole lines, phrase-rule cues, no bundled notes', async ({
  page,
}) => {
  await open(page, '/');
  await expect(panel(page)).toContainText('No prior notes selected.');
  await start(page);
  await runTo(page, 8200);
  await expect(transcript(page).locator('article')).toHaveCount(2);
  await expect(
    question(page).getByRole('heading', {
      name: 'Who will take the first draft?',
    }),
  ).toBeVisible();
});
