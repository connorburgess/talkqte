import { expect, test } from '@playwright/test';

for (const surface of ['notebook', 'companion'] as const) {
  test(`${surface} questions enter once without moving focus and can be dismissed during disclosure`, async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.clock.install();
    if (surface === 'companion') {
      await page.setViewportSize({ width: 420, height: 500 });
    }
    await page.goto(surface === 'companion' ? '/?window=cue' : '/');
    await page.evaluate(() => {
      const events: string[] = [];
      Object.assign(window, { questionMotionEvents: events });
      document.addEventListener('animationstart', (event) => {
        const target = event.target as HTMLElement;
        if (target.matches('.question, .question-context')) {
          events.push(
            target.classList.contains('question') ? 'arrival' : 'source',
          );
          if (target.classList.contains('question-context')) {
            // Keep the reveal unfinished to exercise keyboard interruption.
            for (const animation of target.getAnimations()) {
              animation.pause();
              animation.currentTime = 60;
            }
          }
        }
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
    await expect(focusTarget).toBeFocused();
    const events = () =>
      page.evaluate(
        () =>
          (window as typeof window & { questionMotionEvents: string[] })
            .questionMotionEvents,
      );
    await expect.poll(events).toEqual(['arrival']);
    await page.clock.runFor(2_000);
    await expect.poll(events).toEqual(['arrival']);
    const disclosure = question.getByRole('button', {
      expanded: false,
    });
    await disclosure.focus();
    await page.keyboard.press('Enter');
    await expect(question.locator('blockquote')).toBeVisible();
    await expect.poll(events).toEqual(['arrival', 'source']);
    await expect(
      question.getByRole('button', { expanded: true }),
    ).toBeFocused();
    // Actions must remain available before the reveal's animationend.
    expect(
      await question
        .locator('.question-context')
        .evaluate((element) =>
          element
            .getAnimations()
            .some((animation) => animation.playState === 'paused'),
        ),
    ).toBe(true);
    await question
      .getByRole('button', { name: 'Dismiss', exact: true })
      .focus();
    await page.keyboard.press('Enter');
    await expect(question).toHaveCount(0);
  });
}

test('reduced motion shows the complete question and source without animation', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.clock.install();
  await page.goto('/');
  await page.getByRole('button', { name: 'Try demo', exact: true }).click();
  await page.clock.runFor(8_200);
  const question = page.getByRole('region', { name: 'Suggested question' });
  await expect(question.getByRole('heading')).toBeVisible();
  expect(
    await question.evaluate((element) => element.getAnimations().length),
  ).toBe(0);
  await question.getByRole('button', { expanded: false }).click();
  await expect(question.locator('blockquote')).toBeVisible();
  expect(
    await question.evaluate(
      (element) => element.getAnimations({ subtree: true }).length,
    ),
  ).toBe(0);
  await question.getByRole('button', { expanded: true }).click();
  await expect(question.locator('blockquote')).toBeHidden();
  await question.getByRole('button', { name: 'Dismiss' }).click();
  await expect(question).toHaveCount(0);
});
