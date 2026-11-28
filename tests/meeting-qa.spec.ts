import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import type {} from './fixtures/native-microphone';
import type {} from './fixtures/native-meeting-qa';
async function open(page: Page, count = 2) {
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
  await page.goto('/');
  await page.evaluate(
    (count) =>
      window.liveTest.publish({
        live: true,
        status: 'running',
        transcript: Array.from({ length: count }, (_, i) => ({
          id: `qa-${i}`,
          atMs: i * 1000,
          speaker: 'Speaker',
          text:
            i === 1
              ? 'We chose a Saturday greenhouse check.'
              : `Fictional greenhouse discussion ${i}.`,
        })),
      }),
    count,
  );
  await page.getByRole('tab', { name: 'Ask', exact: true }).click();
}
const input = (page: Page) =>
  page.getByRole('textbox', { name: 'Your question' });
const send = (page: Page) =>
  page.getByRole('button', { name: 'Send', exact: true });
test('opening is free of sends; inline Send authorizes the displayed excerpt and citations navigate', async ({
  page,
}) => {
  await open(page);
  await expect(
    page.getByText('Send to Anthropic · fictional-model.'),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        window.qaTest.calls.filter((c) => c.command === 'ask_question').length,
    ),
  ).toBe(0);
  await input(page).fill('What did we choose?');
  await send(page).click();
  await expect(
    page.getByText('The team chose a Saturday greenhouse check.'),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Transcript 0:01', exact: true })
    .click();
  await expect(page.getByRole('tab', { name: /Transcript/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.locator('#transcript-line-qa-1')).toBeFocused();
});
test('whole transcript includes the beginning and its exact citation remains navigable after grouping', async ({
  page,
}) => {
  await open(page, 236);
  await page.getByText('Transcript scope and cost').click();
  await expect(
    page.getByText(/Uses all 236 available transcript lines/),
  ).toBeVisible();
  await expect(page.getByText(/No tail-only fallback/)).toBeVisible();
  await page.evaluate(() =>
    window.qaTest.answer({
      answer: 'The greenhouse discussion began with the opening check.',
      insufficient: false,
      citations: ['qa-0'],
    }),
  );
  await input(page).fill('What was discussed at the beginning?');
  await send(page).click();
  await expect(page.locator('.ask-entry')).toHaveCount(1);
  await page
    .getByRole('button', { name: 'Transcript 0:00', exact: true })
    .click();
  await expect(page.locator('#transcript-line-qa-0')).toBeFocused();
});
test('follow-up scope discloses prior exchanges and whole-pair omission; clear never sends', async ({
  page,
}) => {
  await open(page);
  for (let i = 0; i < 4; i++) {
    await input(page).fill(
      i === 0 ? 'What was chosen?' : `Explain that choice ${i}.`,
    );
    await send(page).click();
    await expect(page.locator('.ask-entry')).toHaveCount(i + 1);
    await expect(
      page.getByText(new RegExp(`plus ${Math.min(i + 1, 3)} prior exchanges?`)),
    ).toBeVisible();
  }
  await page.getByText('Transcript scope and cost').click();
  await expect(page.getByText(/1 earlier exchange is excluded/)).toBeVisible();
  await expect(
    page.getByText(/only transcript lines are evidence/),
  ).toBeVisible();
  const before = await page.evaluate(
    () =>
      window.qaTest.calls.filter((c) => c.command === 'ask_question').length,
  );
  await page.getByRole('button', { name: 'Clear conversation' }).click();
  await expect(page.locator('.ask-entry')).toHaveCount(0);
  await expect(page.getByText(/budget allowances are unchanged/)).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        window.qaTest.calls.filter((c) => c.command === 'ask_question').length,
    ),
  ).toBe(before);
});
test('held answer can be cancelled; errors retain the question for retry', async ({
  page,
}) => {
  await open(page);
  await page.evaluate(() => window.qaTest.hold());
  await input(page).fill('What was chosen?');
  await send(page).click();
  await expect(
    page.getByRole('button', { name: 'Cancel answer' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Cancel answer' }).click();
  await expect(input(page)).toHaveValue('What was chosen?');
  await expect(
    page.getByRole('status').filter({ hasText: 'Stopped waiting' }),
  ).toBeVisible();
  await page.evaluate(() =>
    window.qaTest.fail('The provider is offline. Retry when connected.'),
  );
  await send(page).click();
  await expect(
    page.getByText('The provider is offline. Retry when connected.'),
  ).toBeVisible();
  await expect(input(page)).toHaveValue('What was chosen?');
  await send(page).click();
  await expect(
    page.getByText('The team chose a Saturday greenhouse check.'),
  ).toBeVisible();
});
test('IME Enter does not submit; modifier Enter sends; long narrow answer remains accessible', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  await page.evaluate(() =>
    window.qaTest.answer({
      answer: 'The fictional team compared the greenhouse options. '.repeat(35),
      insufficient: false,
      citations: ['qa-1'],
    }),
  );
  await input(page).fill('Summarize the tradeoff.');
  await input(page).dispatchEvent('keydown', {
    key: 'Enter',
    ctrlKey: true,
    isComposing: true,
  });
  expect(
    await page.evaluate(
      () =>
        window.qaTest.calls.filter((c) => c.command === 'ask_question').length,
    ),
  ).toBe(0);
  await input(page).press('Control+Enter');
  await expect(page.locator('.ask-entry')).toHaveCount(1);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  const audit = await new AxeBuilder({ page })
    .include('.meeting-ask')
    .analyze();
  expect(audit.violations).toEqual([]);
});
test('new speech preserves scroll position while reading earlier transcript', async ({
  page,
}) => {
  await open(page, 100);
  await page.getByRole('tab', { name: /Transcript/ }).click();
  await page.locator('#transcript-line-qa-20').scrollIntoViewIfNeeded();
  const before = await page
    .locator('#transcript-line-qa-20')
    .evaluate((el) => el.getBoundingClientRect().top);
  await page.evaluate(() =>
    window.liveTest.publish({
      transcript: Array.from({ length: 110 }, (_, i) => ({
        id: `qa-${i}`,
        atMs: i * 1000,
        speaker: 'Speaker',
        text:
          i === 1
            ? 'We chose a Saturday greenhouse check.'
            : `Fictional greenhouse discussion ${i}.`,
      })),
    }),
  );
  const after = await page
    .locator('#transcript-line-qa-20')
    .evaluate((el) => el.getBoundingClientRect().top);
  expect(Math.abs(after - before)).toBeLessThan(3);
});

test('explicit dock launcher opens notebook scope only; a main navigation event focuses Ask without sending', async ({
  page,
}) => {
  await open(page);
  await page.getByRole('tab', { name: 'Notes', exact: true }).click();
  await page.evaluate(() => window.qaTest.openPanel('ask'));
  await expect(input(page)).toBeFocused();
  expect(
    await page.evaluate(
      () =>
        window.qaTest.calls.filter((c) => c.command === 'ask_question').length,
    ),
  ).toBe(0);
  await page.goto('/?window=cue&live');
  await page.evaluate(() => window.liveTest.start());
  await page.setViewportSize({ width: 320, height: 76 });
  const launcher = page.getByRole('button', {
    name: 'Transcript and Ask',
    exact: true,
  });
  await expect(launcher).toBeInViewport({ ratio: 1 });
  const box = await launcher.boundingBox();
  expect(box!.width).toBeGreaterThanOrEqual(44);
  expect(box!.height).toBeGreaterThanOrEqual(44);
  await launcher.click();
  expect(
    await page.evaluate(
      () =>
        window.qaTest.calls
          .filter((c) => c.command === 'open_meeting_panel')
          .at(-1)?.args,
    ),
  ).toEqual({ panel: 'transcript' });
  expect(
    await page.evaluate(
      () =>
        window.qaTest.calls.filter((c) => c.command === 'ask_question').length,
    ),
  ).toBe(0);
});

test('answers follow only while the history reader stays at the end', async ({
  page,
}) => {
  await open(page);
  await page.evaluate(() =>
    window.qaTest.answer({
      answer: 'The fictional greenhouse team compared two options. '.repeat(36),
      insufficient: false,
      citations: ['qa-1'],
    }),
  );
  await input(page).fill('Explain the options.');
  await send(page).click();
  const history = page.locator('.ask-history');
  await expect
    .poll(() => history.evaluate((el) => el.scrollTop))
    .toBeGreaterThan(0);
  await page.evaluate(() => window.qaTest.hold());
  await input(page).fill('What remains uncertain?');
  await send(page).click();
  await history.evaluate((el) => {
    el.scrollTop = 0;
    el.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
  await page.evaluate(() => window.qaTest.release());
  await expect(page.locator('.ask-entry')).toHaveCount(2);
  expect(await history.evaluate((el) => el.scrollTop)).toBeLessThan(2);
});

async function savedMeeting(page: Page) {
  await open(page);
  const id = await page.evaluate(() =>
    window.historyTest.add({
      title: 'Fictional greenhouse review',
      startedAtMs: Date.UTC(2026, 0, 3),
      durationMs: 236000,
      sources: 'both',
      notes: 'Excluded private-for-fixture notes',
      cues: [],
      transcript: Array.from({ length: 236 }, (_, i) => ({
        atMs: i * 1000,
        label: 'them' as const,
        echo: i === 0,
        text: `Fictional greenhouse observation ${i}.`,
      })),
    }),
  );
  await page.getByRole('button', { name: 'Meetings', exact: true }).click();
  await page
    .locator('.history-item')
    .filter({ hasText: 'Fictional greenhouse review' })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Ask about this meeting' }),
  ).toBeVisible();
  return id;
}
test('saved whole scope sends exact ID/revision and an echo citation reveals the original grouped line', async ({
  page,
}) => {
  const id = await savedMeeting(page);
  await expect(
    page.getByText(
      /Uses all 236 available transcript lines from this saved meeting/,
    ),
  ).toBeVisible();
  await page.evaluate(() =>
    window.qaTest.answer({
      answer: 'The first fictional greenhouse observation is the cited line.',
      insufficient: false,
      citations: ['saved-line-0'],
    }),
  );
  await input(page).fill('What was the first observation?');
  await send(page).click();
  const sent = await page.evaluate(
    () =>
      window.qaTest.calls.filter((c) => c.command === 'ask_question').at(-1)
        ?.args,
  );
  expect(sent).toMatchObject({ saved: { id, revision: 1 } });
  await page
    .getByRole('button', { name: 'Transcript 0:00', exact: true })
    .click();
  await expect(
    page.locator(`#saved-transcript-${id}-1-saved-line-0`),
  ).toBeFocused();
  expect(
    await page.evaluate(
      () =>
        window.qaTest.calls.filter((c) => c.command === 'ask_question').length,
    ),
  ).toBe(1);
});
test('editing a saved meeting retires held answer and old revision citations instead of remapping them', async ({
  page,
}) => {
  const id = await savedMeeting(page);
  await page.evaluate(() => window.qaTest.hold());
  await input(page).fill('Summarize the greenhouse review.');
  await send(page).click();
  await expect(
    page.getByRole('button', { name: 'Cancel answer' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Rename', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Meeting title' })
    .fill('Fictional renamed greenhouse review');
  await page.getByRole('button', { name: 'Save title' }).click();
  await expect(
    page.getByRole('heading', {
      name: 'Fictional renamed greenhouse review',
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.locator('.ask-entry')).toHaveCount(0);
  await expect(
    page.locator(`#saved-transcript-${id}-1-saved-line-1`),
  ).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Cancel answer' })).toHaveCount(
    0,
  );
});
test('over-limit scope disables Send and explains refusal without a tail fallback', async ({
  page,
}) => {
  await open(page);
  await page.evaluate(() =>
    window.qaTest.scopeError(
      'This whole transcript exceeds the 128 KiB Ask request limit. No excerpt or request was sent.',
    ),
  );
  await page.getByRole('button', { name: 'Use latest transcript' }).click();
  await input(page).fill('Assess the whole meeting.');
  await expect(send(page)).toBeDisabled();
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: 'No excerpt or request was sent.' }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        window.qaTest.calls.filter((c) => c.command === 'ask_question').length,
    ),
  ).toBe(0);
});

test('ending the current meeting retains accepted conversation for an explicit follow-up', async ({
  page,
}) => {
  await open(page, 236);
  await input(page).fill('What did we choose?');
  await send(page).click();
  await expect(page.locator('.ask-entry')).toHaveCount(1);
  await expect(page.getByText(/plus 1 prior exchange/)).toBeVisible();
  await page.evaluate(() => window.liveTest.publish({ status: 'ended' }));
  await expect(page.locator('.ask-entry')).toHaveCount(1);
  await expect(
    page.getByText(/Uses all 236 available transcript lines/),
  ).toBeVisible();
  await expect(page.getByText(/plus 1 prior exchange/)).toBeVisible();
  await input(page).fill('Why that choice?');
  await send(page).click();
  await expect(page.locator('.ask-entry')).toHaveCount(2);
});
