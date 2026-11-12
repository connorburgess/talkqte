import { expect, test } from '@playwright/test';

test('keyboard Dismiss returns to notes after removing a paused question', async ({
  page,
}) => {
  await page.clock.install();
  await page.goto('/');
  await page.getByRole('button', { name: 'Try demo', exact: true }).click();
  await page.clock.runFor(8_200);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  const question = page.getByRole('region', { name: 'Suggested question' });
  await page.getByRole('tab', { name: 'Notes', exact: true }).click();
  const notes = page.getByRole('textbox', { name: 'Meeting notes' });
  // Native Tab navigation is checked separately; begin at the control so
  // this regression does not depend on the browser's tab-to-buttons setting.
  await question.getByRole('button', { expanded: false }).focus();
  await page.keyboard.press('Enter');
  await expect(question.getByRole('button', { expanded: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(question.getByRole('button', { expanded: false })).toBeFocused();
  await expect(question.locator('blockquote')).toBeHidden();
  await question.getByRole('button', { name: 'Dismiss' }).focus();
  await expect(question.getByRole('button', { name: 'Dismiss' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(question).toHaveCount(0);
  await expect(notes).toBeFocused();
  await page.keyboard.type('Fictional follow-up note.');
  await expect(notes).toHaveValue('Fictional follow-up note.');
});

test('a transcript reader returns to the selected tab after dismissing a question', async ({
  page,
}) => {
  await page.clock.install();
  await page.goto('/');
  await page.getByRole('button', { name: 'Try demo', exact: true }).click();
  await page.clock.runFor(8_200);
  const transcript = page.getByRole('tab', { name: /Transcript/ });
  await transcript.click();
  const dismiss = page.getByRole('button', { name: 'Dismiss', exact: true });
  await dismiss.focus();
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('region', { name: 'Suggested question' }),
  ).toHaveCount(0);
  await expect(transcript).toBeFocused();
  await expect(transcript).toHaveAttribute('aria-selected', 'true');
  await expect(
    page.getByRole('tabpanel', { name: /Transcript/ }),
  ).toBeVisible();
});

test('timed expiry and a remote companion response leave the current notebook control focused', async ({
  page,
}) => {
  await page.clock.install();
  await page.goto('/');
  await page.getByRole('button', { name: 'Try demo', exact: true }).click();
  await page.clock.runFor(8_200);
  const search = page.getByRole('textbox', { name: 'Search meetings' });
  await search.focus();
  await page.clock.runFor(18_000);
  const question = page.getByRole('region', { name: 'Suggested question' });
  await expect(question).toHaveCount(0);
  await expect(search).toBeFocused();
  await page.clock.runFor(20_000);
  await expect(question).toBeVisible();
  await expect(search).toBeFocused();
  // A second window sends the same command without invoking the notebook's
  // response handler. The resulting shared snapshot must not move focus.
  await page.evaluate(async () => {
    const path = '/src/lib/preview.ts';
    const preview = await import(path);
    let id: string | undefined;
    const stop = preview.connect((state: { cue: { id: string } | null }) => {
      id = state.cue?.id;
    });
    stop();
    preview.command('respond_to_cue', { id, response: 'dismiss' });
  });
  await expect(question).toHaveCount(0);
  await expect(search).toBeFocused();
});

test('a delayed Dismiss acknowledgement does not take focus back from another notebook control', async ({
  page,
}) => {
  await page.clock.install();
  await page.route(/:\d+\/$/, async (route) => {
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
  await page.goto('/');
  await page.getByRole('button', { name: 'Try demo', exact: true }).click();
  await page.clock.runFor(8_200);
  await page.evaluate(() => window.questionTest.holdNextResponse());
  const question = page.getByRole('region', { name: 'Suggested question' });
  await question.getByRole('button', { name: 'Dismiss' }).focus();
  await page.keyboard.press('Enter');
  // The shared snapshot removes the card before the command acknowledges it.
  await expect(question).toHaveCount(0);
  await expect(page.getByText('Question dismissed.')).toBeHidden();
  const search = page.getByRole('textbox', { name: 'Search meetings' });
  await search.focus();
  await page.evaluate(() => window.questionTest.releaseResponse());
  await expect(page.getByText('Question dismissed.')).toBeVisible();
  await expect(search).toBeFocused();
  await page.keyboard.type('garden');
  await expect(search).toHaveValue('garden');
});

test('opening the source reveals it and keeps a question through later prompts and playback completion', async ({
  page,
}) => {
  await page.clock.install();
  await page.goto('/');
  await page.getByRole('button', { name: 'Try demo', exact: true }).click();
  await page.clock.runFor(8_200);
  const question = page.getByRole('region', { name: 'Suggested question' });
  const source = question.getByText(
    '“Agreed. Someone can take the first draft of the welcome guide.”',
  );
  await expect(source).toBeHidden();
  const disclosure = question.getByRole('button', {
    expanded: false,
  });
  await disclosure.focus();
  await page.keyboard.press('Enter');
  await expect(source).toBeVisible();
  await expect(question.getByRole('button', { expanded: true })).toBeFocused();
  await page.clock.runFor(75_000);
  await expect(question.getByRole('heading')).toHaveText(
    'Who will take the first draft?',
  );
  await expect(question).toContainText('Earlier in the demo.');
  await question.getByRole('button', { expanded: true }).click();
  await expect(source).toBeHidden();
  await page.clock.runFor(30_000);
  await expect(page.getByRole('button', { name: 'Replay demo' })).toBeVisible();
  await expect(question.getByRole('heading')).toHaveText(
    'Who will take the first draft?',
  );
  await question.getByRole('button', { name: 'Dismiss' }).click();
  await expect(question).toHaveCount(0);
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
  await page.clock.runFor(8_200);
  const question = page.getByRole('region', { name: 'Suggested question' });
  await expect(question.getByRole('heading')).toHaveCSS('font-size', '26px');
  await question.getByRole('button', { expanded: false }).click();
  await page.getByRole('button', { name: 'End demo' }).click();
  await expect(question).toHaveCount(0);
  await page.getByRole('button', { name: 'Replay demo' }).click();
  await page.clock.runFor(8_200);
  await expect(
    question.getByRole('button', { expanded: false }),
  ).toHaveAttribute('aria-expanded', 'false');
  await expect(question.getByRole('heading')).toHaveCSS('font-size', '26px');
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
    // The native companion's question height: 340 CSS px, 420 with large text.
    const height = size === 'large' ? 420 : 340;
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
    await page.clock.runFor(8_200);
    const question = page.getByRole('region', { name: 'Suggested question' });
    await expect(question.getByRole('heading')).toHaveText(
      'Who will take the first draft?',
    );
    expect(
      await page.evaluate(
        () => document.querySelector('main')!.scrollHeight <= innerHeight,
      ),
    ).toBe(true);
    await question.getByRole('button', { expanded: false }).click();
    // Context opens into a 460 px window (540 with large text), no longer 500.
    await page.setViewportSize({
      width: 420,
      height: size === 'large' ? 540 : 460,
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
