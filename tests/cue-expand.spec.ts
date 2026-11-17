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
  await page.setViewportSize({ width: 420, height: 340 });
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
