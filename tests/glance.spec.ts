import { expect, test } from '@playwright/test';

test('Why reveals the source and keeps a question through later prompts and playback completion', async ({
  page,
}) => {
  await page.clock.install();
  await page.goto('/');
  await page.getByRole('button', { name: 'Try demo', exact: true }).click();
  await page.clock.runFor(5_200);
  const question = page.getByRole('region', { name: 'Suggested question' });
  const source = question.getByText(
    '“Agreed. Someone can take the first draft of the welcome guide.”',
  );
  await expect(source).toBeHidden();
  const disclosure = question.getByRole('button', {
    name: 'Why?',
    exact: true,
  });
  await disclosure.focus();
  await page.keyboard.press('Enter');
  await expect(source).toBeVisible();
  await expect(
    question.getByRole('button', { name: 'Hide context' }),
  ).toBeFocused();
  await page.clock.runFor(75_000);
  await expect(question.getByRole('heading')).toHaveText(
    'Who will take the first draft?',
  );
  await expect(question).toContainText('Earlier in the demo.');
  await question.getByRole('button', { name: 'Hide context' }).click();
  await expect(source).toBeHidden();
  await page.clock.runFor(30_000);
  await expect(page.getByRole('button', { name: 'Replay demo' })).toBeVisible();
  await expect(question.getByRole('heading')).toHaveText(
    'Who will take the first draft?',
  );
  await question.getByRole('button', { name: 'Save question' }).click();
  await expect(question).toHaveCount(0);
  await expect(page.locator('.saved-question')).toContainText(
    'Who will take the first draft?',
  );
});

test('appearance controls are discoverable, apply to questions, and survive demo replay', async ({
  page,
}) => {
  await page.clock.install();
  await page.goto('/');
  await page
    .getByRole('button', { name: 'Question appearance & timing' })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Glance view' }),
  ).toBeVisible();
  await expect(page.getByLabel('Question text')).toHaveValue('standard');
  await expect(page.getByLabel('Position', { exact: true })).toHaveValue(
    'bottomRight',
  );
  await page.getByLabel('Question text').selectOption('large');
  await page.getByLabel('Position', { exact: true }).selectOption('topCenter');
  await page.getByRole('button', { name: 'Notebook', exact: true }).click();
  await page.getByRole('button', { name: 'Try demo', exact: true }).click();
  await page.clock.runFor(5_200);
  const question = page.getByRole('region', { name: 'Suggested question' });
  await expect(question.getByRole('heading')).toHaveCSS('font-size', '30px');
  await question.getByRole('button', { name: 'Why?' }).click();
  await page.getByRole('button', { name: 'End demo' }).click();
  await expect(question).toHaveCount(0);
  await page.getByRole('button', { name: 'Replay demo' }).click();
  await page.clock.runFor(5_200);
  await expect(question.getByRole('button', { name: 'Why?' })).toHaveAttribute(
    'aria-expanded',
    'false',
  );
  await expect(question.getByRole('heading')).toHaveCSS('font-size', '30px');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByLabel('Position', { exact: true })).toHaveValue(
    'topCenter',
  );
  await page.setViewportSize({ width: 320, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

for (const size of ['standard', 'large'] as const) {
  test(`companion fits ${size} text and keeps controls usable with custom spacing`, async ({
    page,
  }) => {
    await page.clock.install();
    const height = size === 'large' ? 400 : 340;
    await page.setViewportSize({ width: 420, height });
    await page.goto('/?window=cue');
    await expect(
      page.getByText('Start the demo or microphone from your notebook.'),
    ).toBeVisible();
    await page.evaluate(async (value) => {
      const path = '/src/lib/preview.ts';
      const preview = await import(path);
      preview.command('set_question_size', { value });
      preview.command('start_demo');
    }, size);
    await page.clock.runFor(72_000);
    const question = page.getByRole('region', { name: 'Suggested question' });
    await expect(question.getByRole('heading')).toHaveText(
      'How will we choose between those options?',
    );
    expect(
      await page.evaluate(
        () => document.querySelector('main')!.scrollHeight <= innerHeight,
      ),
    ).toBe(true);
    await question.getByRole('button', { name: 'Why?' }).click();
    await page.setViewportSize({
      width: 420,
      height: size === 'large' ? 560 : 500,
    });
    await expect(question.locator('blockquote')).toBeVisible();
    expect(
      await page.evaluate(
        () => document.querySelector('main')!.scrollHeight <= innerHeight,
      ),
    ).toBe(true);
    await page.addStyleTag({
      content:
        '.question { line-height: 1.5; letter-spacing: .12em; word-spacing: .16em }',
    });
    await page.setViewportSize({ width: 280, height: 240 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await question
      .getByRole('button', { name: 'Dismiss', exact: true })
      .click();
    await expect(question).toHaveCount(0);
  });
}
