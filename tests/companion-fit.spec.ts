// Every cue kind the companion shows, in the native window's sizes
// (src-tauri/src/companion.rs): 360 px wide on a small display, 420
// otherwise; 280 px tall for a question, 420 with its context open, and 60
// more of each with large text. Fictional cues only. Local macOS fonts wrap
// differently from the Linux fonts in CI, so CI is the check that counts.
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
  if (cue.expanded)
    await expect(question.locator('blockquote').first()).toBeVisible();
  return question;
}

const height = (open: boolean, size: 'standard' | 'large') =>
  (open ? 420 : 280) + (size === 'large' ? 60 : 0);

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
  const card = await question.evaluate((element) => ({
    content: element.scrollHeight,
    shown: element.clientHeight,
  }));
  expect(card.content, `${label}: card content`).toBeLessThanOrEqual(
    card.shown,
  );
}

async function expectControls(page: Page, question: Locator, open: boolean) {
  await expect(
    page.getByRole('button', { name: 'Stop live session' }),
  ).toBeInViewport({ ratio: 1 });
  await expect(
    question.getByRole('button', { name: 'Dismiss', exact: true }),
  ).toBeInViewport({ ratio: 1 });
  // The source line opens and closes the context.
  await expect(question.getByRole('button', { expanded: open })).toBeInViewport(
    { ratio: 1 },
  );
}

/** Keys pressed on the open source line scroll the card to its last line. */
async function expectEndReachable(page: Page, question: Locator) {
  const hide = question.getByRole('button', { expanded: true });
  await hide.focus();
  await page.keyboard.press('End');
  const last = question.getByText('Kept here until you dismiss it.');
  await expect(last).toBeInViewport({ ratio: 1 });
  await expect(hide).toBeFocused();
}

for (const [kind, cue] of Object.entries(cues))
  for (const size of ['standard', 'large'] as const)
    test(`a ${kind} fits the companion in ${size} text, collapsed and open`, async ({
      page,
    }) => {
      await companion(page, size);
      for (const width of [360, 420]) {
        // A display's width does not change during one cue: each width
        // shows its own, as a new cue starts unscrolled.
        const shown = { ...cue, id: `${cue.id}-${width}` };
        await page.setViewportSize({ width, height: height(false, size) });
        let question = await show(page, shown);
        let label = `${width} px, collapsed`;
        await expectWindowFits(page, label);
        await expectCardComplete(question, label);
        await expectControls(page, question, false);

        // Opening the source line keeps the cue for reading: the native window grows and the
        // engine holds it. A longer source scrolls inside the card, never
        // the window, and nothing of it is cut off.
        await page.setViewportSize({ width, height: height(true, size) });
        question = await show(page, { ...shown, expanded: true, held: true });
        label = `${width} px, open`;
        await expectWindowFits(page, label);
        await expectControls(page, question, true);
        await expect(question.locator('blockquote')).toHaveText(
          `“${cue.evidence}”`,
        );
        await expectEndReachable(page, question);
      }
    });

for (const size of ['standard', 'large'] as const)
  test(`the longest cue and source stay complete and reachable in ${size} text at 360px`, async ({
    page,
  }) => {
    await companion(page, size);
    for (const [kind, cue] of Object.entries(longest)) {
      await page.setViewportSize({ width: 360, height: height(false, size) });
      let question = await show(page, cue);
      await expectWindowFits(page, `${kind}, collapsed`);
      await expect(question.getByRole('heading')).toHaveText(cue.question);
      await expect(
        page.getByRole('button', { name: 'Stop live session' }),
      ).toBeInViewport({ ratio: 1 });
      // A question longer than the window scrolls in the card; moving
      // focus to the source line brings it into view (allowing for subpixel
      // rounding).
      const why = question.getByRole('button', { expanded: false });
      await why.focus();
      await expect(why).toBeInViewport({ ratio: 0.95 });

      await page.setViewportSize({ width: 360, height: height(true, size) });
      question = await show(page, { ...cue, expanded: true, held: true });
      await expectWindowFits(page, `${kind}, open`);
      await expect(
        page.getByRole('button', { name: 'Stop live session' }),
      ).toBeInViewport({ ratio: 1 });
      await expect(question.locator('blockquote')).toHaveText(
        `“${cue.evidence}”`,
      );
      await expectEndReachable(page, question);
      await expect(
        question.locator('blockquote').getByText(cue.evidence.slice(-30)),
      ).toBeInViewport();
    }
  });
