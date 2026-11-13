import { expect, test, type Page } from '@playwright/test';
import type { Cue, Snapshot } from '../src/lib/types';
import { mixedCue } from './fixtures/evaluator-cue';
import type {} from './fixtures/native-microphone';

// The live layout preview shows the live session's cue read-only, apart from
// its simulated example cue. The fixture stands in for the native side: no
// device, model, transcription or cue processor is involved. Nothing in the
// app produces a Suggestion cue today, so those checks use a fixture cue.

async function native(page: Page, query = '?live') {
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
  await page.goto(`/${query}`);
}

async function startLive(page: Page) {
  await page
    .getByRole('button', { name: 'Start live session', exact: true })
    .press('Enter');
  await expect(
    page.getByRole('button', { name: 'Stop live session', exact: true }),
  ).toBeEnabled();
}

async function openPreview(page: Page) {
  await page
    .getByRole('group', { name: 'Layout', exact: true })
    .getByRole('button', { name: 'Layout preview', exact: true })
    .press('Enter');
  const preview = page.getByRole('region', {
    name: 'Live session layout preview',
  });
  return {
    preview,
    picker: preview.getByLabel('Preview a state'),
    real: preview.getByRole('region', { name: 'Real Cue', exact: true }),
    example: preview.getByRole('region', {
      name: 'Simulated Example cue',
      exact: true,
    }),
  };
}

const setCue = (page: Page, cue: Cue | null) =>
  page.evaluate((value) => window.liveTest.setCue(value), cue);

const ruleCue = (kind: string, question: string, evidence: string): Cue => ({
  id: `fictional-${kind}`,
  kind,
  question,
  evidence,
  sourceId: 'line-1',
  remainingMs: 18_000,
  totalMs: 18_000,
  held: false,
  expanded: false,
  resolvedBy: null,
  note: null,
  aboutFocus: false,
});

/** Sends a session snapshot through the mocked event channel. */
async function sendSession(page: Page, value: Partial<Snapshot>) {
  await page.evaluate(async (change) => {
    const internals = (
      window as unknown as {
        __TAURI_INTERNALS__: {
          invoke: (command: string, args?: unknown) => Promise<unknown>;
        };
      }
    ).__TAURI_INTERNALS__;
    const current = (await internals.invoke('snapshot')) as Snapshot;
    await internals.invoke('plugin:event|emit', {
      event: 'session:changed',
      payload: { ...current, ...change, revision: current.revision + 1 },
    });
  }, value);
}

test('the browser preview shows no real cue, even while the demo shows one', async ({
  page,
}) => {
  await page.clock.install();
  await page.goto('/');
  await page.getByRole('button', { name: 'Try demo', exact: true }).click();
  await page.clock.runFor(5_200);
  const demoQuestion = await page
    .getByRole('region', { name: 'Suggested question' })
    .getByRole('heading')
    .innerText();
  const { real } = await openPreview(page);
  await expect(real).toContainText(
    'None. This browser preview has no live session.',
  );
  await expect(real).not.toContainText(demoQuestion);
});

test('on the desktop, the demo’s cue is never shown as real', async ({
  page,
}) => {
  await native(page, '');
  await expect(
    page.getByRole('button', { name: 'Try demo', exact: true }),
  ).toBeVisible();
  await sendSession(page, {
    live: false,
    status: 'running',
    cue: ruleCue(
      'Owner',
      'Who will take the first draft?',
      'Someone can take the fictional draft.',
    ),
  });
  const { real } = await openPreview(page);
  await expect(real).toContainText(
    'None. The demo’s cues come from a fictional script and are not shown here.',
  );
  await expect(real).not.toContainText('Who will take the first draft?');
});

test('a live cue appears read-only with its phrase rule and source, apart from the example cue', async ({
  page,
}) => {
  await native(page);
  await startLive(page);
  const { preview, picker, real, example } = await openPreview(page);
  await expect(real).toHaveText('Real CueNone.');
  await page.evaluate(() =>
    window.liveTest.say(
      'Someone can take the fictional draft.',
      'Who will take the first draft?',
    ),
  );
  await expect(real).toContainText('Who will take the first draft?');
  await expect(real).toContainText(
    'Phrase rule: the line said “someone can”, “someone should” or “someone could”.',
  );
  await expect(real.getByRole('list', { name: 'Real cue sources' })).toHaveText(
    'From the live transcript: “Someone can take the fictional draft.”',
  );
  await expect(real).toContainText(
    'Why? and Dismiss for this cue are in the notebook, and in the companion when it is shown; the layout only shows it.',
  );
  // Read-only: the real cue offers no control, and says nothing of AI.
  await expect(real.getByRole('button')).toHaveCount(0);
  await expect(real).not.toContainText(/\bAI\b|model|understand/i);
  // The example cue is separate, under its own heading.
  await picker.selectOption('cue');
  await expect(example).toContainText(
    'Example cue · written by hand, not generated by AI',
  );
  await expect(real).not.toContainText('Robin offered');
  await expect(example).not.toContainText('Who will take the first draft?');
  // The real cue sits before the fictional conversation heading.
  const before = await preview.evaluate((root) => {
    const cue = root.querySelector('#real-cue-title')!;
    const fictional = [...root.querySelectorAll('h2')].find((heading) =>
      heading.textContent?.includes('Fictional planning conversation'),
    )!;
    return !!(
      cue.compareDocumentPosition(fictional) & Node.DOCUMENT_POSITION_FOLLOWING
    );
  });
  expect(before).toBe(true);
  await expect(
    preview.getByRole('heading', { name: 'Real Cue', exact: true, level: 2 }),
  ).toBeVisible();

  // Dismissed in the notebook, it leaves the layout too.
  await page.getByRole('button', { name: 'Notebook', exact: true }).click();
  await page
    .getByRole('region', { name: 'Suggested question' })
    .getByRole('button', { name: 'Dismiss' })
    .click();
  await page
    .getByRole('group', { name: 'Layout', exact: true })
    .getByRole('button', { name: 'Layout preview', exact: true })
    .click();
  await expect(real).toHaveText('Real CueNone.');
});

test('every rule kind names its origin in plain words', async ({ page }) => {
  await native(page);
  await startLive(page);
  const { real } = await openPreview(page);
  const kinds: [string, string, string][] = [
    [
      'Timing',
      'What date should we aim for?',
      'Phrase rule: the line used the word “soon”.',
    ],
    [
      'Decision',
      'How will we choose between those options?',
      'Phrase rule: the line said “either” and later “or”.',
    ],
    [
      'Open question',
      'Does anyone have time this week?',
      'Phrase rule: the line asked the group a question in a set form, such as “Does anyone…?”',
    ],
    [
      'Asked you',
      'Sam, can you take the draft?',
      'Phrase rule: the line put a question to you by the name you entered, such as “Sam, can you…?”',
    ],
    [
      'Still open',
      'Still open: the gate code',
      'Phrase rule: a line began with a wrap-up phrase such as “before we go”, and no line so far had used enough words from these focus lines.',
    ],
    [
      'Unlisted',
      'A fictional question',
      'Cue kind “Unlisted”; its origin is not described here.',
    ],
  ];
  for (const [kind, question, origin] of kinds) {
    await setCue(page, ruleCue(kind, question, 'A fictional spoken line.'));
    await expect(real).toContainText(question);
    await expect(real).toContainText(origin);
    await expect(real).not.toContainText(/\bAI\b|model/i);
  }
  // A quoted line is shown in quotation marks.
  await setCue(
    page,
    ruleCue('Said', 'We will post it by Friday.', 'We will post it by Friday.'),
  );
  await expect(real).toContainText('“We will post it by Friday.”');
  await expect(real).toContainText(
    'Phrase rule: the line named a time together with a commitment word, such as “ready by Friday”, so it is quoted word for word.',
  );
  await expect(real).toContainText(
    'Why?, Dismiss and Keep this line for this cue are in the notebook, and in the companion when it is shown; the layout only shows it.',
  );
  // A line that also matched a focus line says so.
  await setCue(page, {
    ...ruleCue('Timing', 'What date should we aim for?', 'Soon, for the gate.'),
    aboutFocus: true,
  });
  await expect(real).toContainText(
    'Phrase rule: the line used the word “soon”. The line also used words from your focus list.',
  );
});

test('a note reminder names the note title match and the note, not this conversation', async ({
  page,
}) => {
  await native(page);
  await startLive(page);
  const { real } = await openPreview(page);
  await setCue(page, {
    ...ruleCue(
      'Context',
      'Garden gate rota',
      'Robin keeps the fictional gate key.',
    ),
    note: {
      title: 'Garden gate rota',
      sourceDate: '2026-11-03',
      provider: 'file',
    },
    held: true,
  });
  await expect(real).toContainText(
    'Note title match: the line used distinctive words from the title of an imported note.',
  );
  await expect(real.getByRole('list', { name: 'Real cue sources' })).toHaveText(
    'Prior note, not from this conversation · Garden gate rota · 2026-11-03: “Robin keeps the fictional gate key.”',
  );
  await expect(real).toContainText(
    'Kept until you dismiss it in the notebook, and in the companion when it is shown.',
  );
  // An unconfirmed copy carries the same warning as the notebook card.
  await setCue(page, {
    ...ruleCue(
      'Context',
      'Garden gate rota',
      'Robin keeps the fictional gate key.',
    ),
    note: {
      title: 'Garden gate rota',
      sourceDate: '2026-11-03',
      provider: 'granola',
      unconfirmed: { lastConfirmedMs: null },
    },
  });
  await expect(real.getByRole('list', { name: 'Real cue sources' })).toHaveText(
    'Prior note, not from this conversation · Garden gate rota · 2026-11-03 · not verified · never confirmed: “Robin keeps the fictional gate key.”',
  );
  await setCue(page, {
    ...ruleCue(
      'Owner',
      'Who will take the first draft?',
      'Someone can take it.',
    ),
    held: true,
    resolvedBy: { sourceId: 'line-2', evidence: 'Robin will take it.' },
  });
  await expect(real).toContainText(
    'Answered later in the conversation, in the line below. Kept until you dismiss it in the notebook, and in the companion when it is shown.',
  );
  await expect(
    real.getByRole('list', { name: 'Real cue resolution' }),
  ).toHaveText('From the live transcript: “Robin will take it.”');
  // A resolution from prior notes lists those notes.
  await setCue(page, {
    ...mixedCue,
    held: true,
    resolvedBy: {
      sourceId: 'prior:file:print',
      evidence: 'Leave one day for printing.',
      sources: [mixedCue.sources![2]],
    },
  });
  await expect(real).toContainText(
    'Marked resolved from the sources below. Kept until you dismiss it in the notebook, and in the companion when it is shown.',
  );
  await expect(
    real.getByRole('list', { name: 'Real cue resolution' }),
  ).toHaveText(
    'Prior note, not from this conversation · Printing plan · 2026-11-02: “Leave one day for printing.”',
  );
  // Both lists keep their list role in WebKit, where list-style none drops it.
  for (const name of ['Real cue sources', 'Real cue resolution'])
    await expect(real.getByLabel(name)).toHaveAttribute('role', 'list');
});

for (const hosted of [false, true]) {
  test(`a fixture Suggestion names the approved processor the way the review does${
    hosted ? ', hosted' : ', on this device'
  }`, async ({ page }) => {
    await native(page, hosted ? '?live&processor&hosted' : '?live&processor');
    await startLive(page);
    const { real } = await openPreview(page);
    await setCue(page, mixedCue);
    await expect(real).toContainText('Will the draft be ready Tuesday?');
    await expect(real).toContainText(
      `Proposed by Garden evaluator · Fictional model, the cue processing approved for this session, ${
        hosted ? 'hosted by Example service' : 'which runs on this device'
      }. TalkQTE checks only that the cited sources were supplied, not that the proposal is right.`,
    );
    await expect(
      real
        .getByRole('list', { name: 'Real cue sources' })
        .getByRole('listitem'),
    ).toHaveText([
      'This conversation · 1:02 · Maya: “Can we send the garden guide on Friday?”',
      'Prior note, not from this conversation · Garden guide review · 2026-11-01: “Legal review takes two days.”',
      'Prior note, not from this conversation · Printing plan · 2026-11-02: “Leave one day for printing.”',
    ]);
  });
}

test('without processor details a Suggestion still says a model proposed it', async ({
  page,
}) => {
  await native(page);
  await startLive(page);
  const { real } = await openPreview(page);
  await setCue(page, mixedCue);
  await expect(real).toContainText(
    'Proposed by a model through the cue processing approved for this session; its details are not available here. TalkQTE checks only that the cited sources were supplied, not that the proposal is right.',
  );
});

test('paused cues and an ended session show no real cue', async ({ page }) => {
  await native(page);
  await startLive(page);
  await page
    .getByRole('button', { name: 'Pause cues', exact: true })
    .first()
    .click();
  const { real } = await openPreview(page);
  await expect(real).toHaveText(
    'Real CueNone. Cues are paused; the microphone and transcript continue.',
  );
  await page.getByRole('button', { name: 'Notebook', exact: true }).click();
  await page
    .getByRole('button', { name: 'Resume cues', exact: true })
    .first()
    .click();
  await setCue(
    page,
    ruleCue('Timing', 'What date should we aim for?', 'We can do it soon.'),
  );
  await page
    .getByRole('button', { name: 'Stop live session', exact: true })
    .click();
  await page
    .getByRole('group', { name: 'Layout', exact: true })
    .getByRole('button', { name: 'Layout preview', exact: true })
    .click();
  await expect(real).toHaveText('Real CueNone.');
});

test('a real cue fits a 480 pixel window', async ({ page }) => {
  await page.setViewportSize({ width: 480, height: 800 });
  await native(page);
  await startLive(page);
  const { real } = await openPreview(page);
  await setCue(page, mixedCue);
  await expect(real).toContainText('Will the draft be ready Tuesday?');
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(480);
});
