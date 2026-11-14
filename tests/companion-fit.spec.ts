// Every cue kind the companion shows, in the native window's sizes
// (src-tauri/src/companion.rs): 360 px wide on a small display, 420
// otherwise; 340 px tall for a cue, and 80 more with large text. The card
// says what the cue is and where it came from without a click, and keeps
// one height whether or not it is held. Fictional cues only. Local macOS
// fonts wrap differently from the Linux fonts in CI, so CI is the check
// that counts.
import { expect, test, type Locator, type Page } from '@playwright/test';
import type {} from './fixtures/native-microphone';
import type { Cue } from '../src/lib/types';

const base = {
  remainingMs: 18_000,
  totalMs: 18_000,
  held: false,
  expanded: false,
  resolvedBy: null,
  aboutFocus: false,
  sourceId: 'transcript:fictional-1',
  note: null,
} satisfies Partial<Cue>;
const noteTitle = 'Garden welcome guide and the open day';
const note = {
  title: noteTitle,
  sourceDate: '2026-11-02',
  provider: 'granola',
};

// The longest wording each kind plausibly takes in a meeting.
const cues = {
  question: {
    ...base,
    id: 'fictional-question',
    kind: 'Owner',
    question: 'Who will take the first draft of the welcome guide?',
    evidence:
      "Let's make a first visit to the garden feel a little easier. A short welcome guide could help, so who will take the first draft of the welcome guide?",
  },
  'Said quote': {
    ...base,
    id: 'fictional-said',
    kind: 'Said',
    question:
      "Let's have it ready by Friday and try it with a few new visitors first.",
    evidence:
      "A single page sounds right. Let's have it ready by Friday and try it with a few new visitors first.",
  },
  'Asked you': {
    ...base,
    id: 'fictional-asked',
    kind: 'Asked you',
    question: 'Robin, could you take the first draft of the welcome guide?',
    evidence:
      'It should cover the tools, the seedlings and who to ask for help. Robin, could you take the first draft of the welcome guide?',
  },
  'note reminder': {
    ...base,
    id: 'fictional-reminder',
    kind: 'Context',
    question: noteTitle,
    evidence:
      'Robin will label the watering cans before the open day. Sam is checking whether the side gate can stay open until four.',
    sourceId: 'granola:garden-0',
    note,
  },
} satisfies Record<string, Cue>;

// What each kind says at a glance: its purpose, where it came from, and
// the quoted line or note. A Said cue is its line, so nothing is quoted
// under it; a question put to you shows only the rest of its line.
const glance: Record<
  keyof typeof cues,
  { lead: string; source: string; quote: string | null }
> = {
  question: {
    lead: 'You could ask',
    source: 'From this conversation',
    quote: cues.question.evidence,
  },
  'Said quote': {
    lead: 'Just said',
    source: 'From this conversation',
    quote: null,
  },
  'Asked you': {
    lead: 'Asked you',
    source: 'From this conversation',
    quote:
      'It should cover the tools, the seedlings and who to ask for help. …',
  },
  'note reminder': {
    lead: 'From your notes',
    source: 'Its title came up · imported note, 2026-11-02',
    quote: cues['note reminder'].evidence,
  },
};

// Imported notes keep up to 2,000 characters and 200 for a title; a spoken
// line keeps up to 1,000 and a question up to 200.
const longest: Record<string, Cue> = {
  'note reminder': {
    ...cues['note reminder'],
    id: 'fictional-long-reminder',
    question: `${noteTitle}: signs, accessible paths, the tool shed and who to ask on the day`,
    evidence:
      `${'Robin will label the watering cans before the open day and check the accessible path by the herb beds. Sam asked for a one-page guide with a map. '.repeat(14)}The last line says the side gate stays open until four.`.slice(
        -2_000,
      ),
  },
  question: {
    ...cues.question,
    id: 'fictional-long-question',
    question:
      'Who will take the first draft of the welcome guide, with the map, the tool shed rules and the rota, and bring it to the next meeting so we can try it?',
    evidence:
      `${'We talked about the gate code, the tool shed, the accessible route past the herb beds and the rota for the open day. '.repeat(7)}The last part asks who will take the first draft.`.slice(
        -1_000,
      ),
  },
};

async function companion(page: Page, size: 'standard' | 'large') {
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
  await page.goto('/?window=cue');
  await page.waitForFunction(() => !!window.liveTest);
  await page.evaluate(() => window.liveTest.start());
  await page.evaluate((value) => window.liveTest.setQuestionSize(value), size);
}

async function show(page: Page, cue: Cue) {
  await page.evaluate((value) => window.liveTest.setCue(value), cue);
  const question = page.getByRole('region', { name: 'Suggested question' });
  await expect(question.getByRole('heading')).toContainText(
    cue.question.slice(0, 20),
  );
  return question;
}

const height = (size: 'standard' | 'large') =>
  340 + (size === 'large' ? 80 : 0);

/** The window itself never scrolls, in either direction. */
async function expectWindowFits(page: Page, label: string) {
  const sizes = await page.evaluate(() => ({
    height: document.querySelector('main')!.scrollHeight,
    width: document.documentElement.scrollWidth,
    innerHeight,
    innerWidth,
  }));
  expect(sizes.height, `${label}: window height`).toBeLessThanOrEqual(
    sizes.innerHeight,
  );
  expect(sizes.width, `${label}: window width`).toBeLessThanOrEqual(
    sizes.innerWidth,
  );
}

/** The card shows all of its content without scrolling. */
async function expectCardComplete(question: Locator, label: string) {
  const card = await question.locator('.cue-scroll').evaluate((element) => ({
    content: element.scrollHeight,
    shown: element.clientHeight,
  }));
  expect(card.content, `${label}: card content`).toBeLessThanOrEqual(
    card.shown,
  );
}

async function expectControls(page: Page, question: Locator, held: boolean) {
  await expect(
    page.getByRole('button', { name: 'Stop live session' }),
  ).toBeInViewport({ ratio: 1 });
  await expect(
    question.getByRole('button', { name: 'Dismiss', exact: true }),
  ).toBeInViewport({ ratio: 1 });
  await expect(
    question.getByRole('button', {
      name: held ? 'Held' : 'Hold',
      exact: true,
    }),
  ).toBeInViewport({ ratio: 1 });
  // Nothing is left to open: there is no disclosure on the card.
  await expect(question.locator('[aria-expanded]')).toHaveCount(0);
}

/** The last line of a block of text is inside the window. */
async function expectEndInView(text: Locator) {
  await expect
    .poll(() =>
      text.evaluate((element) => {
        const { bottom } = element.getBoundingClientRect();
        return bottom > 0 && bottom <= innerHeight + 1;
      }),
    )
    .toBe(true);
}

/** Keys pressed on the card's Hold control scroll it to its last line. */
async function expectEndReachable(
  page: Page,
  question: Locator,
  last: Locator,
) {
  const hold = question.getByRole('button', { name: /^(Hold|Held)$/ });
  await hold.focus();
  await page.keyboard.press('End');
  await expectEndInView(last);
  await expect(hold).toBeFocused();
}

for (const [kind, cue] of Object.entries(cues) as [keyof typeof cues, Cue][])
  for (const size of ['standard', 'large'] as const)
    test(`a ${kind} says what it is and where it came from in ${size} text, at one height`, async ({
      page,
    }) => {
      await companion(page, size);
      for (const width of [360, 420]) {
        // A display's width does not change during one cue: each width
        // shows its own, as a new cue starts unscrolled.
        const shown = { ...cue, id: `${cue.id}-${width}` };
        await page.setViewportSize({ width, height: height(size) });
        let question = await show(page, shown);
        let label = `${width} px`;
        await expectWindowFits(page, label);
        await expectCardComplete(question, label);
        await expectControls(page, question, false);

        // Purpose and source, in view with nothing pressed.
        await expect(question.getByText(glance[kind].lead)).toBeInViewport({
          ratio: 1,
        });
        await expect(
          question.getByText(glance[kind].source, { exact: true }),
        ).toBeInViewport({ ratio: 1 });
        const quote = question.locator('blockquote');
        const quoted = glance[kind].quote;
        if (quoted === null) await expect(quote).toHaveCount(0);
        else {
          await expect(quote).toHaveText(`“${quoted}”`);
          await expect(quote).toBeInViewport({ ratio: 1 });
        }
        // No control on the card but Hold and Dismiss.
        await expect(question.getByRole('button')).toHaveCount(2);

        // Holding the cue moves nothing: the cue and its source stay where
        // they were being read.
        const places = async () => [
          await question.getByRole('heading').boundingBox(),
          await question
            .getByText(glance[kind].source, { exact: true })
            .boundingBox(),
        ];
        const before = await places();
        question = await show(page, { ...shown, held: true });
        label = `${width} px, held`;
        expect(await places(), label).toEqual(before);
        await expectWindowFits(page, label);
        await expectCardComplete(question, label);
        await expectControls(page, question, true);
      }
    });

test('an Asked you question shows no countdown, and other cues show the time they have left', async ({
  page,
}) => {
  await companion(page, 'standard');
  await page.setViewportSize({ width: 420, height: height('standard') });
  // The share of the line still filled, as drawn.
  const filled = (question: Locator) =>
    question.locator('.cue-track').evaluate((track) => {
      const fill = track.firstElementChild!.getBoundingClientRect().width;
      return fill / track.getBoundingClientRect().width;
    });
  let question = await show(page, {
    ...cues.question,
    remainingMs: 9_000,
    totalMs: 18_000,
  });
  expect(await filled(question)).toBeCloseTo(0.5, 1);
  await expect(question).not.toContainText(/\d+\s?s\b/);
  // Held: the line is full and no longer runs down.
  question = await show(page, {
    ...cues.question,
    remainingMs: 2_000,
    held: true,
  });
  expect(await filled(question)).toBeCloseTo(1, 1);

  question = await show(page, {
    ...cues['Asked you'],
    remainingMs: 20_000,
    totalMs: 45_000,
  });
  await expect(question.locator('.cue-track')).toHaveCount(0);
  await expect(question).toContainText('Stays longer · no countdown');
  await expect(question).not.toContainText(/\d+\s?s\b/);
});

test('a held question that is answered shows the answer first and every line stays reachable', async ({
  page,
}) => {
  await companion(page, 'standard');
  for (const width of [360, 420]) {
    await page.setViewportSize({ width, height: height('standard') });
    const held = { ...cues.question, id: `answered-${width}`, held: true };
    let question = await show(page, held);
    const answer =
      'Sam will take the first draft and bring it to the next garden meeting.';
    question = await show(page, {
      ...held,
      remainingMs: 0,
      resolvedBy: { sourceId: 'transcript:fictional-2', evidence: answer },
    });
    await expect(question).toContainText('Answered later in the conversation');
    await expect(question.locator('blockquote').first()).toHaveText(
      `“${answer}”`,
    );
    await expect(question.locator('blockquote').first()).toBeInViewport({
      ratio: 1,
    });
    await expectWindowFits(page, `${width} px, answered`);
    await expectControls(page, question, true);
    await expectEndReachable(
      page,
      question,
      question.locator('blockquote').last(),
    );
  }
});

// A model's suggestion can run long and cite more than one line.
const longSuggestion: Cue = {
  ...base,
  id: 'fictional-long-suggestion',
  kind: 'Suggestion',
  // Twenty-five words.
  question:
    'Who will take the first draft of the welcome guide with the map and the tool shed rules, and bring it to the next meeting?',
  evidence: '',
  sourceId: 'transcript:fictional-30',
  sources: [
    {
      id: 'transcript:fictional-30',
      revision: 0,
      text: 'A short welcome guide could help, but the tool shed rules changed last week and nobody has written them down.',
      provenance: { kind: 'transcript', atMs: 30_000, speaker: 'Speaker' },
    },
    {
      id: 'transcript:fictional-37',
      revision: 0,
      text: 'Someone should bring a draft to the next meeting so we can try it with new visitors.',
      provenance: { kind: 'transcript', atMs: 37_000, speaker: 'Speaker' },
    },
  ],
};

/** Whether the card fades its lower edge, as it must when more lies below. */
const fadesAtEnd = (question: Locator) =>
  question.evaluate(
    (card) => getComputedStyle(card, '::after').opacity === '1',
  );

for (const size of ['standard', 'large'] as const)
  test(`a long cue with two sources is never cut off in ${size} text: it is whole, and what does not fit fades and scrolls`, async ({
    page,
  }) => {
    await companion(page, size);
    for (const width of [360, 420]) {
      await page.setViewportSize({ width, height: height(size) });
      const question = await show(page, {
        ...longSuggestion,
        id: `${longSuggestion.id}-${width}`,
      });
      const label = `${width} px`;
      await expectWindowFits(page, label);
      await expectControls(page, question, false);
      // The whole cue shows, and the first line it came from begins.
      await expect(question.getByRole('heading')).toHaveText(
        longSuggestion.question,
      );
      await expect(question.getByRole('heading')).toBeInViewport({ ratio: 1 });
      await expect(
        question.getByText('This conversation · 0:30 · Speaker'),
      ).toBeInViewport({ ratio: 1 });
      // What does not fit is not sliced by the card's edge: it fades.
      const hidden = await question
        .locator('.cue-scroll')
        .evaluate((words) => words.scrollHeight - words.clientHeight);
      await expect.poll(() => fadesAtEnd(question), label).toBe(hidden > 1);
      // Every source stays there to read, to its last word.
      await expect(
        page.getByRole('list', { name: 'Cue sources' }).getByRole('listitem'),
      ).toHaveCount(2);
      await expectEndReachable(
        page,
        question,
        question.locator('blockquote').last(),
      );
      await expect
        .poll(() => fadesAtEnd(question), `${label}, at the end`)
        .toBe(false);
      // Dismiss stays in its corner however far the words are scrolled.
      await expect(
        question.getByRole('button', { name: 'Dismiss', exact: true }),
      ).toBeInViewport({ ratio: 1 });

      // The longest cue the engine allows, 200 characters, is still whole.
      const longest =
        `${'Who will take the first draft of the welcome guide, the map and the tool shed rules, '.repeat(3)}and when?`
          .slice(0, 200)
          .trim();
      const full = await show(page, {
        ...cues.question,
        id: `fictional-200-${width}`,
        question: longest,
      });
      await expect(full.getByRole('heading')).toHaveText(longest);
      await expect(full.getByRole('heading')).toBeInViewport({ ratio: 1 });
      await expectWindowFits(page, `${label}, 200 characters`);
    }
  });

for (const size of ['standard', 'large'] as const)
  test(`the longest cue and source stay complete and reachable in ${size} text at 360px`, async ({
    page,
  }) => {
    await companion(page, size);
    for (const [kind, cue] of Object.entries(longest)) {
      await page.setViewportSize({ width: 360, height: height(size) });
      const question = await show(page, cue);
      await expectWindowFits(page, kind);
      await expect(question.getByRole('heading')).toHaveText(cue.question);
      await expect(
        page.getByRole('button', { name: 'Stop live session' }),
      ).toBeInViewport({ ratio: 1 });
      // A cue longer than the window scrolls in the card; moving focus to
      // Hold brings it into view (allowing for subpixel rounding).
      const hold = question.getByRole('button', { name: 'Hold', exact: true });
      await hold.focus();
      await expect(hold).toBeInViewport({ ratio: 0.95 });
      // Nothing is shortened: the whole source is there, and its last
      // words are reached from the keyboard.
      await expect(question.locator('blockquote')).toHaveText(
        `“${cue.evidence}”`,
      );
      await page.keyboard.press('End');
      await expectEndInView(question.locator('blockquote'));
      await expect(hold).toBeFocused();
    }
  });
