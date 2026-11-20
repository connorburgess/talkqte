import { expect, test, type Locator, type Page } from '@playwright/test';
import { cue, standIn } from './fixtures/stand-in';

// The companion's cue grows out of its bar and folds back into it. These
// checks run on the browser preview of the companion window at the size the
// native window takes for a cue; the native frame change itself is not
// shown here.

const first = cue({
  id: 'fictional-expand-1',
  kind: 'Owner',
  question: 'Who will take the first draft of the welcome guide?',
  evidence: 'Someone can take the first draft of the welcome guide.',
});
const second = cue({
  id: 'fictional-expand-2',
  kind: 'Timing',
  question: 'When should the welcome guide be ready?',
  evidence: 'The welcome guide should be ready before the open day.',
});

async function companion(
  page: Page,
  reducedMotion: 'reduce' | 'no-preference',
) {
  await page.emulateMedia({ reducedMotion });
  await page.setViewportSize({ width: 320, height: 232 });
  await standIn(page, '/?window=cue');
  await page.evaluate(() => window.liveTest.start());
  // Keep a leaving card at the start of its fold, so its state can be read.
  await page.evaluate(() => {
    document.addEventListener('animationstart', (event) => {
      if (event.animationName === 'cue-collapse')
        for (const animation of (event.target as Element).getAnimations())
          animation.pause();
    });
  });
  return {
    // With no cue the bar fills the browser's window (the native one shrinks
    // to it), so where its controls sit is what must not move.
    bar: page.getByRole('button', { name: 'Stop live session' }),
    question: page.getByRole('region', { name: 'Suggested question' }),
  };
}

const show = (page: Page, value: typeof first) =>
  page.evaluate((next) => window.liveTest.setCue(next), value);

/** Lets the arrival finish, as it would on screen. */
const arrived = (card: Locator) =>
  expect
    .poll(() =>
      card.evaluate((element) =>
        element
          .getAnimations({ subtree: true })
          .every(
            (animation) =>
              animation.playState === 'finished' ||
              (animation.effect as KeyframeEffect).target !== element,
          ),
      ),
    )
    .toBe(true);

/** The window never scrolls, so nothing in it moves while a card goes. */
const scrolls = (page: Page) =>
  page.evaluate(() => {
    const surface = document.querySelector('.floating-surface')!;
    return (
      surface.scrollHeight > surface.clientHeight ||
      document.documentElement.scrollHeight >
        document.documentElement.clientHeight
    );
  });

for (const [way, goes] of [
  [
    'dismissed with its cross',
    (question: Locator) =>
      question.getByRole('button', { name: 'Dismiss', exact: true }).click(),
  ],
  [
    'taken away by the session (expired, withdrawn or answered)',
    (question: Locator) =>
      question.page().evaluate(() => window.liveTest.setCue(null)),
  ],
] as const)
  test(`a cue ${way} folds back up into the bar, whose controls stay where they are`, async ({
    page,
  }) => {
    const { bar, question } = await companion(page, 'no-preference');
    await show(page, first);
    await arrived(question);
    const resting = await bar.boundingBox();
    await goes(question);

    // The cue has gone for readers and the keyboard at once.
    await expect(question).toHaveCount(0);
    const leaving = page.locator('.cue-card.is-leaving');
    await expect(leaving).toHaveCount(1);
    await expect(leaving).toHaveAttribute('inert', '');
    await expect(leaving).toHaveAttribute('aria-hidden', 'true');
    const fold = await leaving.evaluate((card) => {
      const [animation] = card.getAnimations();
      return {
        name: (animation as CSSAnimation).animationName,
        ends: Number(animation.effect!.getComputedTiming().endTime),
      };
    });
    // Brief, and within the 220 ms the native window keeps the cue's size.
    expect(fold.name).toBe('cue-collapse');
    expect(fold.ends).toBeGreaterThanOrEqual(150);
    expect(fold.ends).toBeLessThanOrEqual(220);

    // Its lower edge rises toward the bar while its top stays under it.
    const at = (time: number) =>
      leaving.evaluate((card, ms) => {
        for (const animation of card.getAnimations()) {
          animation.pause();
          animation.currentTime = ms;
        }
        return {
          covered:
            window.cueInset(card)[2] / card.getBoundingClientRect().height,
          top: card.getBoundingClientRect().top,
        };
      }, time);
    const start = await at(0);
    const middle = await at(fold.ends / 2);
    // A millisecond short of the end: at the end itself the card is removed.
    const end = await at(fold.ends - 1);
    expect(start.covered).toBe(0);
    expect(middle.covered).toBeGreaterThan(0);
    expect(end.covered).toBeGreaterThan(0.95);
    expect(end.top).toBe(start.top);
    expect(await bar.boundingBox()).toEqual(resting);
    expect(await scrolls(page)).toBe(false);

    await leaving.evaluate((card) => {
      for (const animation of card.getAnimations()) animation.finish();
    });
    await expect(page.locator('.cue-card')).toHaveCount(0);
    // Then the native window returns to its bar, so only the height of
    // the browser's window decides where the bar sits; not its side.
    expect((await bar.boundingBox())!.x).toBe(resting!.x);
  });

test('with reduced motion a cue arrives and goes at once, with nothing moving', async ({
  page,
}) => {
  const { bar, question } = await companion(page, 'reduce');
  await show(page, first);
  await expect(question.getByRole('heading')).toHaveText(first.question);
  const resting = await bar.boundingBox();
  expect(
    await question.evaluate(
      (card) => card.getAnimations({ subtree: true }).length,
    ),
  ).toBe(0);
  expect(
    await page.evaluate(() =>
      window.cueInset(document.querySelector('.cue-card')!),
    ),
  ).toEqual([0, 0, 0, 0]);
  await page.evaluate(() => {
    const seen = { leaving: false };
    Object.assign(window, { leavingSeen: seen });
    new MutationObserver(() => {
      if (document.querySelector('.cue-card.is-leaving')) seen.leaving = true;
    }).observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
    });
  });
  await question.getByRole('button', { name: 'Dismiss', exact: true }).click();
  // No card is left behind to fold: the bar is all there is, at once.
  await expect(page.locator('.cue-card')).toHaveCount(0);
  expect(
    await page.evaluate(
      () =>
        (window as typeof window & { leavingSeen: { leaving: boolean } })
          .leavingSeen.leaving,
    ),
  ).toBe(false);
  expect((await bar.boundingBox())!.x).toBe(resting!.x);
  expect(await scrolls(page)).toBe(false);
});

test('a cue that arrives while the last one is folding away is shown at once and can be used', async ({
  page,
}) => {
  const { question } = await companion(page, 'no-preference');
  await show(page, first);
  await arrived(question);
  await question.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await expect(page.locator('.cue-card.is-leaving')).toHaveCount(1);

  // The next cue does not wait for the fold: the old card goes at once and
  // the new one grows in its place, so the two never overlap.
  await show(page, second);
  await expect(page.locator('.cue-card')).toHaveCount(1);
  await expect(page.locator('.cue-card.is-leaving')).toHaveCount(0);
  await expect(question.getByRole('heading')).toHaveText(second.question);
  expect(
    await question.evaluate((card) =>
      card
        .getAnimations()
        .map((animation) => (animation as CSSAnimation).animationName),
    ),
  ).toContain('cue-expand');
  expect(await question.getAttribute('inert')).toBeNull();

  // It takes input while it is still arriving.
  await question.getByRole('button', { name: 'Hold', exact: true }).click();
  await expect(
    question.getByRole('button', { name: 'Held', exact: true }),
  ).toBeVisible();
  await expect(question.getByRole('heading')).toHaveText(second.question);
});

test('a question put to you by name is told apart from other cues without relying on colour', async ({
  page,
}) => {
  const { question } = await companion(page, 'reduce');
  const asked = cue({
    id: 'fictional-asked',
    kind: 'Asked you',
    question: 'Sam, could you take the first draft?',
  });
  const marks = () =>
    question.evaluate((card) => {
      const edge = card.querySelector<HTMLElement>('.cue-edge');
      const box = card.getBoundingClientRect();
      const drawn = edge?.getBoundingClientRect();
      return {
        mark: !!card.querySelector('.cue-lead svg'),
        edge: drawn
          ? {
              width: drawn.width,
              tall: drawn.height / box.height,
              fill: getComputedStyle(edge!).backgroundColor,
              card: getComputedStyle(card).backgroundColor,
            }
          : null,
      };
    });

  await show(page, asked);
  await expect(question.getByText('Asked you', { exact: true })).toBeVisible();
  const told = await marks();
  // A mark before its label and an edge down the whole left side: a shape,
  // not only a colour, and at least 3:1 against the card where colour shows.
  expect(told.mark).toBe(true);
  expect(told.edge).not.toBeNull();
  expect(told.edge!.width).toBeGreaterThanOrEqual(4);
  expect(told.edge!.tall).toBeCloseTo(1, 2);
  expect(contrast(told.edge!.fill, told.edge!.card)).toBeGreaterThanOrEqual(3);
  // The mark and the edge are drawing only; the label says it.
  await expect(question.locator('.cue-edge')).toHaveAttribute(
    'aria-hidden',
    'true',
  );

  // Every other kind keeps the calm default.
  for (const kind of ['Owner', 'Suggestion', 'Open question', 'Said']) {
    await show(
      page,
      cue({
        id: `fictional-${kind}`,
        kind,
        question: 'Who will take the first draft?',
      }),
    );
    await expect(question.getByRole('heading')).toContainText('first draft');
    expect(await marks(), kind).toEqual({ mark: false, edge: null });
  }

  // With forced colours the edge is still drawn, in the system's text colour.
  await page.emulateMedia({ forcedColors: 'active' });
  await show(page, asked);
  const forced = await marks();
  expect(forced.edge).not.toBeNull();
  expect(contrast(forced.edge!.fill, forced.edge!.card)).toBeGreaterThanOrEqual(
    3,
  );
});

function contrast(one: string, two: string) {
  const luminance = (value: string) => {
    const [r, g, b] = value
      .match(/[\d.]+/g)!
      .slice(0, 3)
      .map(Number);
    const channel = (c: number) => {
      const v = c / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  };
  const [light, dark] = [luminance(one), luminance(two)].sort((a, b) => b - a);
  return (light + 0.05) / (dark + 0.05);
}

test('kept by its bottom edge, the window has its bar at the bottom and the cue grows up out of it', async ({
  page,
}) => {
  const { bar, question } = await companion(page, 'no-preference');
  await expect(bar).toBeVisible();
  // The default bottom-right placement, as the native side reports it.
  await page.evaluate(() => window.liveTest.anchor('bottom'));
  const edge = () =>
    page.evaluate(() => {
      const bar = document.querySelector('.companion-bar')!;
      return innerHeight - bar.getBoundingClientRect().bottom;
    });
  // The bar alone fills the window; with a cue it stays on the same edge.
  const resting = await edge();
  await show(page, first);
  await expect(question.getByRole('heading')).toHaveText(first.question);
  expect(await edge()).toBe(resting);
  expect((await question.boundingBox())!.y).toBeLessThan(
    (await bar.boundingBox())!.y,
  );
  // It opens from its lower edge, by the bar, and its words ride up with
  // its top edge, so the cue is uncovered from the first frame.
  const at = (time: number) =>
    question.evaluate((card, ms) => {
      for (const animation of card.getAnimations({ subtree: true })) {
        animation.pause();
        animation.currentTime = ms;
      }
      const [top, , bottom] = window.cueInset(card);
      const open = card.getBoundingClientRect().top + top;
      const covered = [...card.querySelectorAll('h2 span')].filter(
        (word) => word.getBoundingClientRect().top < open - 0.5,
      ).length;
      return { top, bottom, covered };
    }, time);
  const early = await at(20);
  expect(early.bottom).toBe(0);
  expect(early.top).toBeGreaterThan(20);
  for (const time of [0, 16, 50, 100])
    expect((await at(time)).covered, `${time} ms`).toBe(0);
  expect((await at(400)).top).toBe(0);
  await question.evaluate((card) => {
    for (const animation of card.getAnimations({ subtree: true }))
      animation.finish();
  });

  // Going, it folds back down into the bar.
  await question.getByRole('button', { name: 'Dismiss', exact: true }).click();
  const leaving = page.locator('.cue-card.is-leaving');
  await expect(leaving).toHaveCount(1);
  expect(
    await leaving.evaluate(
      (card) => (card.getAnimations()[0] as CSSAnimation).animationName,
    ),
  ).toBe('cue-collapse-down');
  expect(await edge()).toBe(resting);
  await leaving.evaluate((card) => {
    for (const animation of card.getAnimations()) animation.finish();
  });
  await expect(page.locator('.cue-card')).toHaveCount(0);
  expect(await edge()).toBe(resting);
  expect(await bar.boundingBox()).not.toBeNull();
});

for (const edge of ['top', 'bottom'] as const)
  test(`no words overlap at any moment of the arrival, with the bar at the ${edge}`, async ({
    page,
  }) => {
    const { question } = await companion(page, 'no-preference');
    await page.evaluate((value) => window.liveTest.anchor(value), edge);
    for (const value of [
      first,
      cue({
        id: 'fictional-overlap-asked',
        kind: 'Asked you',
        question: 'Sam, could you take the first draft?',
      }),
    ]) {
      await show(page, value);
      await expect(question.getByRole('heading')).toHaveText(value.question);
      for (let time = 0; time <= 480; time += 16) {
        const overlaps = await question.evaluate((card, ms) => {
          for (const animation of card.getAnimations({ subtree: true })) {
            animation.pause();
            animation.currentTime = ms;
          }
          // Each block of words that is drawn: the cue, the time line's
          // words, the source's label and quote. The Hold control's 44 px
          // target reaches over its neighbours by design, so it is
          // measured by its words, not its box.
          const blocks = [
            ...card.querySelectorAll(
              '.cue-line, .cue-stays, .cue-hold, .cue-source-label, .cue-quote',
            ),
          ]
            .filter((block) => {
              const style = getComputedStyle(block);
              return (
                parseFloat(style.fontSize) > 0 && Number(style.opacity) > 0
              );
            })
            .map((block) => block.getBoundingClientRect())
            .filter((box) => box.height > 0);
          const found: number[][] = [];
          blocks.forEach((a, i) =>
            blocks.slice(i + 1).forEach((b, j) => {
              const across =
                Math.min(a.right, b.right) - Math.max(a.left, b.left);
              const down =
                Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
              if (across > 0.5 && down > 0.5) found.push([i, i + 1 + j, down]);
            }),
          );
          return found;
        }, time);
        expect(overlaps, `${value.kind} at ${time} ms`).toEqual([]);
      }
    }
  });

test('the small card shows one cited line of at most two lines, and an Asked you question no countdown words', async ({
  page,
}) => {
  const { question } = await companion(page, 'reduce');
  const source = (id: string, atMs: number, text: string) => ({
    id,
    revision: 1,
    text,
    provenance: { kind: 'transcript' as const, atMs, speaker: 'Speaker' },
  });
  await show(page, {
    ...cue({
      id: 'fictional-compact',
      kind: 'Suggestion',
      question: 'Did you run the raffle booth before?',
    }),
    sources: [
      source(
        's1',
        50_000,
        'It sells better at the front, and someone who ran the raffle booth last spring said the queue moved faster with two tables and a float.',
      ),
      source('s2', 64_000, 'She sent the poster this morning.'),
    ],
  });
  const quotes = question.locator('blockquote');
  await expect(quotes).toHaveCount(1);
  await expect(quotes).toContainText('It sells better at the front');
  const lines = await quotes.evaluate((quote) => {
    const style = getComputedStyle(quote);
    return quote.getBoundingClientRect().height / parseFloat(style.lineHeight);
  });
  expect(lines).toBeLessThanOrEqual(2.05);
  await expect(question.getByText('She sent the poster')).toHaveCount(0);

  await show(
    page,
    cue({
      id: 'fictional-compact-asked',
      kind: 'Asked you',
      question: 'Sam, could you take the first draft?',
    }),
  );
  // The words give way to a plain rule; Hold still says it, to assistive
  // technology.
  const hold = question.getByRole('button', { name: 'Hold', exact: true });
  await expect(hold).toHaveAccessibleDescription('Stays longer · no countdown');
  expect(
    await question
      .locator('.cue-stays')
      .evaluate((words) => getComputedStyle(words).fontSize),
  ).toBe('0px');
});

test('a question put to you has a faint warm card on which every text colour keeps 4.5:1', async ({
  page,
}) => {
  const { question } = await companion(page, 'reduce');
  const surface = () =>
    question.evaluate((card) => getComputedStyle(card).backgroundColor);
  await show(page, first);
  const calm = await surface();
  await show(
    page,
    cue({
      id: 'fictional-tint',
      kind: 'Asked you',
      question: 'Sam, could you take the first draft?',
    }),
  );
  await expect(question.getByText('Asked you', { exact: true })).toBeVisible();
  const warm = await surface();
  expect(warm).not.toBe(calm);
  const inks = await question.evaluate((card) =>
    [
      ...card.querySelectorAll(
        '.cue-lead, h2, .cue-source-label, .cue-hold, .dismiss-question',
      ),
    ].map((element) => getComputedStyle(element).color),
  );
  for (const ink of inks)
    expect(contrast(ink, warm), ink).toBeGreaterThanOrEqual(4.5);
});

test('a companion that loads while kept by its bottom edge has its bar at the bottom at once, before any move', async ({
  page,
}) => {
  // A reload with a cue showing: no move follows, so the page must ask.
  await page.addInitScript(() =>
    Object.assign(window, { standInEdge: 'bottom' }),
  );
  const { bar, question } = await companion(page, 'reduce');
  await show(page, first);
  await expect(question.getByRole('heading')).toHaveText(first.question);
  const card = (await question.boundingBox())!;
  const below = (await bar.boundingBox())!;
  expect(card.y + card.height).toBeLessThanOrEqual(below.y);
});

test('a move reported while the page is still reading the edge wins over the older answer', async ({
  page,
}) => {
  await page.addInitScript(() =>
    Object.assign(window, { standInEdgeReply: 'hold' }),
  );
  const { bar, question } = await companion(page, 'reduce');
  await expect
    .poll(() => page.evaluate(() => window.liveTest.edgePending()))
    .toBe(true);
  // The window moves and keeps its bottom edge; then the read answers with
  // what was true before the move.
  await page.evaluate(() => window.liveTest.anchor('bottom'));
  await page.evaluate(() => window.liveTest.releaseEdge('top'));
  await show(page, first);
  await expect(question.getByRole('heading')).toHaveText(first.question);
  const card = (await question.boundingBox())!;
  expect(card.y + card.height).toBeLessThanOrEqual(
    (await bar.boundingBox())!.y,
  );
});

test('when the page cannot read the edge it still follows the next move', async ({
  page,
}) => {
  await page.addInitScript(() =>
    Object.assign(window, { standInEdgeReply: 'fail' }),
  );
  const { bar, question } = await companion(page, 'reduce');
  // The read has failed; the window moves afterwards.
  await expect
    .poll(() => page.evaluate(() => window.liveTest.edgeAsked()))
    .toBe(true);
  await page.evaluate(() => window.liveTest.anchor('bottom'));
  await show(page, first);
  await expect(question.getByRole('heading')).toHaveText(first.question);
  const card = (await question.boundingBox())!;
  expect(card.y + card.height).toBeLessThanOrEqual(
    (await bar.boundingBox())!.y,
  );
});
