import { expect, test, type Page } from '@playwright/test';

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
    // Its words are there from the first frame, light, and darken in
    // reading order: the purpose first, the quoted line last.
    const shades = (at: number | 'end') =>
      question.evaluate((card, time) => {
        for (const animation of card.getAnimations({ subtree: true })) {
          animation.pause();
          if (time === 'end') animation.finish();
          else animation.currentTime = time;
        }
        const shade = (selector: string) =>
          [...card.querySelectorAll<HTMLElement>(selector)].map((word) =>
            Number(getComputedStyle(word).opacity),
          );
        return {
          cue: shade('.cue-line .cue-word'),
          quote: shade('blockquote .cue-word'),
        };
      }, at);
    const first = await shades(0);
    for (const shade of [...first.cue, ...first.quote])
      expect(shade).toBeGreaterThan(0.2);
    const during = await shades(200);
    expect(during.cue[0]).toBeGreaterThan(during.cue.at(-1)!);
    expect(during.cue.at(-1)!).toBeGreaterThanOrEqual(during.quote.at(-1)!);
    expect(during.quote.at(-1)!).toBeLessThan(0.5);
    const after = await shades('end');
    expect([...after.cue, ...after.quote].every((shade) => shade === 1)).toBe(
      true,
    );
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
          cue: !!target?.closest('.cue-line'),
        };
      }),
    );
    expect(motion.length).toBeGreaterThan(0);
    for (const { ends, repeats, cue } of motion) {
      // The cue itself is fully dark within three quarters of a second;
      // the quoted line and the time line within a second and a half.
      expect(ends).toBeLessThanOrEqual(cue ? 750 : 1500);
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
