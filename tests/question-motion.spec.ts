import { expect, test, type Locator, type Page } from '@playwright/test';
import type {} from './fixtures/native-microphone';

/** Starts the bundled demo and returns the first cue, 8.2 seconds in. */
async function firstCue(page: Page, surface: 'notebook' | 'companion') {
  await page.clock.install();
  if (surface === 'companion')
    await page.setViewportSize({ width: 420, height: 340 });
  await page.goto(surface === 'companion' ? '/?window=cue' : '/');
  await page.evaluate(() => {
    const events: string[] = [];
    Object.assign(window, { cueMotionEvents: events });
    document.addEventListener('animationstart', (event) => {
      if ((event.target as HTMLElement).matches('.cue-card'))
        events.push(event.animationName);
    });
  });
  await page.evaluate(async () => {
    const path = '/src/lib/preview.ts';
    const preview = await import(path);
    preview.command('start_demo');
  });
  const focusTarget =
    surface === 'companion'
      ? page.getByRole('button', { name: 'Pause demo', exact: true })
      : page.getByRole('textbox', { name: 'Meeting notes' });
  await focusTarget.focus();
  await page.clock.runFor(8_200);
  const question = page.getByRole('region', { name: 'Suggested question' });
  await expect(question.getByRole('heading')).toHaveText(
    'Who will take the first draft?',
  );
  return { question, focusTarget };
}

const events = (page: Page) =>
  page.evaluate(
    () =>
      (window as typeof window & { cueMotionEvents: string[] }).cueMotionEvents,
  );

for (const surface of ['notebook', 'companion'] as const) {
  test(`${surface} cues come in and open sideways once, briefly, without moving focus`, async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    const { question, focusTarget } = await firstCue(page, surface);
    await expect(focusTarget).toBeFocused();
    // Both parts of the arrival have begun once the card has opened.
    await expect
      .poll(() =>
        question.evaluate((card) =>
          card
            .getAnimations()
            .every((animation) => animation.playState === 'finished'),
        ),
      )
      .toBe(true);
    // The card opens sideways from its left edge: partway through, its
    // right side is still covered while its full height already shows, and
    // it ends fully open. Read from what is drawn at each moment.
    const drawn = (at: number | 'end') =>
      question.evaluate((card, time) => {
        for (const animation of card.getAnimations()) {
          animation.pause();
          if (time === 'end') animation.finish();
          else animation.currentTime = time;
        }
        const inset = getComputedStyle(card).clipPath.match(
          /inset\(([\d.]+)(?:px|%)? ([\d.]+)%? ([\d.]+)(?:px|%)? ([\d.]+)/,
        );
        return inset ? inset.slice(1, 5).map(Number) : null;
      }, at);
    const early = await drawn(80);
    expect(early).not.toBeNull();
    const [top, right, bottom, left] = early!;
    expect([top, bottom, left]).toEqual([0, 0, 0]);
    expect(right).toBeGreaterThan(20);
    expect((await drawn(300))![1]).toBeLessThan(right);
    expect((await drawn('end'))![1]).toBe(0);
    // The cue's words are there from the first frame, light but readable,
    // and darken in reading order within moments. The purpose and the line
    // the cue came from are at full strength throughout.
    const shades = (at: number | 'end') =>
      question.evaluate((card, time) => {
        for (const animation of card.getAnimations({ subtree: true })) {
          animation.pause();
          if (time === 'end') animation.finish();
          else animation.currentTime = time;
        }
        const strength = (selector: string) =>
          [...card.querySelectorAll<HTMLElement>(selector)].map((element) =>
            Number(getComputedStyle(element).opacity),
          );
        return {
          cue: strength('h2 .cue-word'),
          rest: strength('.cue-lead, blockquote'),
        };
      }, at);
    const first = await shades(0);
    expect(first.cue.length).toBeGreaterThan(3);
    for (const shade of first.cue) expect(shade).toBeGreaterThanOrEqual(0.55);
    expect(first.rest).toEqual([1, 1]);
    const during = await shades(200);
    expect(during.cue[0]).toBeGreaterThan(during.cue.at(-1)!);
    expect(during.rest).toEqual([1, 1]);
    expect((await shades(750)).cue.every((shade) => shade === 1)).toBe(true);
    await shades('end');
    // From here on nothing may start the arrival again. Forget the starts
    // this check caused by rewinding, once they have all been reported.
    await page.waitForTimeout(150);
    await page.evaluate(() => {
      (
        window as typeof window & { cueMotionEvents: string[] }
      ).cueMotionEvents.length = 0;
    });
    // Reading never waits long on the motion, and nothing loops.
    const motion = await question.evaluate((card) =>
      card.getAnimations({ subtree: true }).map((animation) => {
        const timing = animation.effect!.getComputedTiming();
        const target = (animation.effect as KeyframeEffect).target;
        return {
          ends: Number(timing.endTime),
          repeats: timing.iterations,
          spoken: !!target?.classList.contains('cue-spoken'),
        };
      }),
    );
    expect(motion.length).toBeGreaterThan(0);
    for (const { ends, repeats, spoken } of motion) {
      // The card, the cue and the time line settle within a second; only
      // the replay of spoken words runs on, and never past six and a half.
      expect(ends).toBeLessThanOrEqual(spoken ? 6_500 : 1_000);
      expect(repeats).toBe(1);
    }
    // The cue and its source are there from the first frame.
    await expect(question.getByText('You could ask')).toBeVisible();
    await expect(question.locator('blockquote')).toBeVisible();

    // Timer updates move the time line; they do not replay the arrival.
    await page.clock.runFor(2_000);
    expect(await events(page)).toEqual([]);

    // Holding from the keyboard keeps focus, and does not replay it either.
    await question.getByRole('button', { name: 'Hold', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(
      question.getByRole('button', { name: 'Held', exact: true }),
    ).toBeFocused();
    expect(await events(page)).toEqual([]);

    // Dismissing takes the cue away from readers and the keyboard at once;
    // the card itself folds away a moment later.
    await question
      .getByRole('button', { name: 'Dismiss', exact: true })
      .focus();
    await page.keyboard.press('Enter');
    await expect(question).toHaveCount(0);
    await expect(page.locator('.cue-card')).toHaveCount(0);
  });
}

/** When each word of a locator's text starts to darken, in milliseconds. */
const wordStarts = (words: Locator) =>
  words.evaluateAll((spans) =>
    spans.map((span) =>
      Number(span.getAnimations()[0].effect!.getComputedTiming().delay),
    ),
  );

test('a quoted line is replayed at about the pace it was said', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.clock.install();
  await page.goto('/');
  await page.getByRole('button', { name: 'Try demo', exact: true }).click();
  await page.clock.runFor(51_200);
  const heading = page
    .getByRole('region', { name: 'Suggested question' })
    .getByRole('heading');
  // Fifteen words, said in a little over three seconds in the demo.
  await expect(heading).toHaveText(
    "“Let's have it ready by Friday and try it with a few new visitors first.”",
  );
  const said = await wordStarts(heading.locator('span'));
  expect(said).toHaveLength(15);
  expect(said).toEqual([...said].sort((a, b) => a - b));
  expect(new Set(said).size).toBe(15);
  // A longer word ("Friday") holds the line longer than a short one ("a").
  expect(said[6] - said[5]).toBeGreaterThan(said[11] - said[10]);
  expect(said.at(-1)!).toBeGreaterThan(2_500);
  expect(said.at(-1)!).toBeLessThan(4_500);
  // While they wait, the words are readable, not hidden.
  expect(
    await heading.evaluate((element) => {
      for (const animation of element.getAnimations({ subtree: true })) {
        animation.pause();
        animation.currentTime = 0;
      }
      return [...element.querySelectorAll('span')].map((word) =>
        Number(getComputedStyle(word).opacity),
      );
    }),
  ).toEqual(Array(15).fill(0.55));
});

/** Opens the companion with the live-session stand-in, motion allowed. */
async function liveCompanion(page: Page, width: number) {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
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
  await page.setViewportSize({ width, height: 340 });
  await page.goto('/?window=cue');
  await page.waitForFunction(() => !!window.liveTest);
  await page.evaluate(() => window.liveTest.start());
  return page.getByRole('region', { name: 'Suggested question' });
}

const liveCue = {
  id: 'fictional-live',
  kind: 'Owner',
  question: 'Who will take the first draft of the welcome guide?',
  evidence: 'Someone can take the first draft of the welcome guide.',
  sourceId: 'transcript:fictional-1',
  remainingMs: 18_000,
  totalMs: 18_000,
  held: false,
  expanded: false,
  resolvedBy: null,
  note: null,
  aboutFocus: false,
};

test('a very long answer still finishes within about six seconds, and a cue first seen held does not replay', async ({
  page,
}) => {
  const question = await liveCompanion(page, 420);
  // The same cue shown already held, as after the companion is reopened.
  const held = { ...liveCue, id: 'fictional-held-first', held: true };
  await page.evaluate((value) => window.liveTest.setCue(value), held);
  await expect(
    question.getByRole('button', { name: 'Held', exact: true }),
  ).toBeVisible();
  expect(
    await question
      .getByRole('heading')
      .locator('span')
      .evaluateAll((spans) =>
        spans.every((span) => span.getAnimations().length === 0),
      ),
  ).toBe(true);

  // An answer that took about a minute to say arrives on it.
  await page.evaluate((value) => window.liveTest.setCue(value), {
    ...held,
    remainingMs: 0,
    resolvedBy: {
      sourceId: 'transcript:fictional-long',
      evidence: `${'We talked about the gate code, the tool shed, the accessible route past the herb beds and the rota for the open day. '.repeat(8)}Sam will take the first draft.`,
    },
  });
  const words = question.locator('.cue-answer blockquote span');
  await expect(words.first()).toBeVisible();
  const starts = await wordStarts(words);
  expect(starts.length).toBeGreaterThan(150);
  expect(starts).toEqual([...starts].sort((a, b) => a - b));
  expect(starts.at(-1)!).toBeLessThanOrEqual(6_260);
});

for (const [name, width, cue, needed] of [
  ['an ordinary cue at 420 px', 420, liveCue, 3],
  [
    // 16 px bold is not large text, so it needs the higher ratio.
    'a long cue at 360 px',
    360,
    {
      ...liveCue,
      id: 'fictional-live-long',
      question:
        'Who will take the first draft of the welcome guide with the map and the tool shed rules, and bring it to the next meeting so we can try it?',
    },
    4.5,
  ],
] as const)
  test(`${name} is readable while it arrives: every word meets ${needed}:1 from the first frame`, async ({
    page,
  }) => {
    const question = await liveCompanion(page, width);
    await page.evaluate((value) => window.liveTest.setCue(value), cue);
    await expect(question.getByRole('heading')).toHaveText(cue.question);
    // Contrast of each cue word against the card at a moment of the
    // arrival, from the colours and strengths actually drawn.
    const sample = (at: number) =>
      question.evaluate((card, time) => {
        for (const animation of card.getAnimations({ subtree: true })) {
          animation.pause();
          animation.currentTime = time;
        }
        const channels = (colour: string) =>
          colour
            .match(/[\d.]+/g)!
            .slice(0, 3)
            .map(Number);
        const luminance = (rgb: number[]) => {
          const [r, g, b] = rgb.map((value) => {
            const c = value / 255;
            return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
          });
          return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        };
        const heading = card.querySelector('h2')!;
        const surface = channels(getComputedStyle(card).backgroundColor);
        const ink = channels(getComputedStyle(heading).color);
        const size = parseFloat(getComputedStyle(heading).fontSize);
        const shown = Number(getComputedStyle(card).opacity);
        const ratios = [...heading.querySelectorAll('span')].map((word) => {
          const strength = Number(getComputedStyle(word).opacity);
          const drawn = ink.map(
            (value, index) =>
              value * strength + surface[index] * (1 - strength),
          );
          return (luminance(surface) + 0.05) / (luminance(drawn) + 0.05);
        });
        return { weakest: Math.min(...ratios), size, shown };
      }, at);
    const first = await sample(0);
    // Bold text counts as large from 18.66 px.
    expect(first.size >= 18.66 ? 3 : 4.5).toBe(needed);
    expect(first.weakest).toBeGreaterThanOrEqual(needed);
    // By 150 ms the card itself has finished fading in.
    const soon = await sample(150);
    expect(soon.shown).toBeGreaterThan(0.95);
    expect(soon.weakest).toBeGreaterThanOrEqual(needed);
  });

test('an answer to a held cue opens in place with a tick, keeps focus, and does not replay for a cue already answered', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
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
  await page.setViewportSize({ width: 420, height: 340 });
  await page.goto('/?window=cue');
  await page.waitForFunction(() => !!window.liveTest);
  await page.evaluate(() => window.liveTest.start());
  const held = {
    id: 'fictional-held',
    kind: 'Timing',
    question: 'What date should we aim for?',
    evidence:
      'We should have it ready soon, before the next group of visitors arrives.',
    sourceId: 'transcript:fictional-1',
    remainingMs: 9_000,
    totalMs: 18_000,
    held: true,
    expanded: false,
    resolvedBy: null,
    note: null,
    aboutFocus: false,
  };
  const answer = {
    sourceId: 'transcript:fictional-2',
    evidence: "Let's have it ready by Friday.",
  };
  await page.evaluate((value) => window.liveTest.setCue(value), held);
  const question = page.getByRole('region', { name: 'Suggested question' });
  const heldControl = question.getByRole('button', {
    name: 'Held',
    exact: true,
  });
  await heldControl.focus();
  await expect(question.locator('.cue-answer')).toHaveCount(0);

  // The conversation answers it. Hold the opening at its start to read it.
  await page.evaluate(() => {
    document.addEventListener('animationstart', (event) => {
      if (event.animationName !== 'cue-answer-open') return;
      for (const animation of (event.target as HTMLElement).getAnimations())
        animation.pause();
    });
  });
  await page.evaluate((value) => window.liveTest.setCue(value), {
    ...held,
    remainingMs: 0,
    resolvedBy: answer,
  });
  const block = question.locator('.cue-answer');
  await expect(block).toContainText('Answered later in the conversation');
  await expect(block.locator('blockquote')).toHaveText(
    "“Let's have it ready by Friday.”",
  );
  // It starts closed, so the words under it do not jump, and opens briefly.
  const opening = await block.evaluate((element) => {
    const [animation] = element.getAnimations();
    animation.pause();
    animation.currentTime = 0;
    return {
      height: element.getBoundingClientRect().height,
      ends: Number(animation.effect!.getComputedTiming().endTime),
    };
  });
  expect(opening.height).toBeLessThan(2);
  expect(opening.ends).toBeLessThanOrEqual(500);
  await block.evaluate((element) => {
    for (const animation of element.getAnimations({ subtree: true }))
      animation.finish();
  });
  expect((await block.boundingBox())!.height).toBeGreaterThan(40);
  await expect(block.locator('svg')).toBeVisible();
  // The cue is still whole and in view, and focus has not moved.
  await expect(question.getByRole('heading')).toBeInViewport({ ratio: 1 });
  await expect(heldControl).toBeFocused();
  expect(
    await page.evaluate(
      () => document.querySelector('main')!.scrollHeight <= innerHeight,
    ),
  ).toBe(true);

  // A cue first shown with its answer already there does not open again.
  await page.evaluate((value) => window.liveTest.setCue(value), {
    ...held,
    id: 'fictional-already-answered',
    remainingMs: 0,
    resolvedBy: answer,
  });
  await expect(block).toContainText('Answered later in the conversation');
  expect(
    await block.evaluate((element) => element.getAnimations().length),
  ).toBe(0);

  // With reduced motion an arriving answer is simply there.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.evaluate((value) => window.liveTest.setCue(value), {
    ...held,
    id: 'fictional-held-reduced',
  });
  await expect(block).toHaveCount(0);
  await page.evaluate((value) => window.liveTest.setCue(value), {
    ...held,
    id: 'fictional-held-reduced',
    remainingMs: 0,
    resolvedBy: answer,
  });
  await expect(block.locator('blockquote')).toBeVisible();
  expect(
    await question.evaluate(
      (card) => card.getAnimations({ subtree: true }).length,
    ),
  ).toBe(0);
  expect((await block.boundingBox())!.height).toBeGreaterThan(40);
});

test('a dismissed cue leaves with a short fold and cannot be used while it goes', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const { question } = await firstCue(page, 'notebook');
  // Hold the leaving animation at its start so the state can be read.
  await page.evaluate(() => {
    document.addEventListener('animationstart', (event) => {
      if (event.animationName !== 'cue-leave') return;
      for (const animation of (event.target as HTMLElement).getAnimations())
        animation.pause();
    });
  });
  await question.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await expect(question).toHaveCount(0);
  const leaving = page.locator('.cue-card.is-leaving');
  await expect(leaving).toHaveCount(1);
  await expect(leaving).toHaveAttribute('aria-hidden', 'true');
  await expect(leaving).toHaveAttribute('inert', '');
  expect(
    await leaving.evaluate(
      (card) => card.getAnimations()[0].effect!.getComputedTiming().endTime,
    ),
  ).toBeLessThanOrEqual(250);
  // The idle message waits for the card to finish going.
  await expect(page.getByText('A little room to think.')).toHaveCount(0);
  await leaving.evaluate((card) => {
    for (const animation of card.getAnimations()) animation.finish();
  });
  await expect(page.locator('.cue-card')).toHaveCount(0);
  await expect(page.getByText('A little room to think.')).toBeVisible();
});

test('reduced motion shows the complete cue and source without animation, and the time line moves in steps', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.clock.install();
  await page.goto('/');
  await page.getByRole('button', { name: 'Try demo', exact: true }).click();
  await page.clock.runFor(8_200);
  const question = page.getByRole('region', { name: 'Suggested question' });
  await expect(question.getByRole('heading')).toBeVisible();
  await expect(question.locator('blockquote')).toBeVisible();
  const animations = () =>
    question.evaluate(
      (element) => element.getAnimations({ subtree: true }).length,
    );
  expect(await animations()).toBe(0);
  // Every word is at full strength at once.
  expect(
    await question.evaluate((card) =>
      [...card.querySelectorAll('.cue-word')].every(
        (word) => getComputedStyle(word).opacity === '1',
      ),
    ),
  ).toBe(true);
  // The line shows the time left in quarters, with no gliding between them.
  const filled = () =>
    question.locator('.cue-track').evaluate((track) => {
      const fill = track.firstElementChild!.getBoundingClientRect().width;
      return fill / track.getBoundingClientRect().width;
    });
  expect(await filled()).toBeCloseTo(1, 2);
  await page.clock.runFor(6_000);
  expect(await filled()).toBeCloseTo(0.75, 2);
  expect(await animations()).toBe(0);
  await page.clock.runFor(1_000);
  expect(await filled()).toBeCloseTo(0.75, 2);
  await question.getByRole('button', { name: 'Hold', exact: true }).click();
  await expect(
    question.getByRole('button', { name: 'Held', exact: true }),
  ).toBeVisible();
  expect(await filled()).toBeCloseTo(1, 2);
  expect(await animations()).toBe(0);
  // Without motion the card goes at once.
  await question.getByRole('button', { name: 'Dismiss' }).click();
  await expect(page.locator('.cue-card')).toHaveCount(0);
});
