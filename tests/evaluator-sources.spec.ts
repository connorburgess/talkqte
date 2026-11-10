import { expect, test, type Page } from '@playwright/test';
import { mixedCue, mixedSources } from './fixtures/evaluator-cue';
import type { Cue } from '../src/lib/types';

async function nativePage(page: Page, companion = false) {
  await page.clock.install();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.route(/\/\?(?:window=cue).*|:\d+\/$/, async (route) => {
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
  await page.goto(companion ? '/?window=cue' : '/');
  await page.waitForFunction(() => !!window.liveTest);
  await page.evaluate(() => window.liveTest.start());
}

async function show(page: Page, cue: Cue = mixedCue) {
  await page.evaluate((value) => window.liveTest.setCue(value), cue);
  await expect(page.getByRole('heading', { name: cue.question })).toBeVisible();
}

test('mixed sources stay distinct and keyboard disclosure holds the suggestion', async ({
  page,
}) => {
  await nativePage(page);
  await show(page, { ...mixedCue, aboutFocus: true });
  const question = page.getByRole('region', { name: 'Suggested question' });
  await expect(question).toContainText('Suggestion with prior context');
  const sources = page.getByRole('list', { name: 'Cue sources', exact: true });
  await expect(sources).toBeHidden();
  await question.getByRole('button', { name: 'Why?', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(sources.getByRole('listitem')).toHaveCount(3);
  await expect(sources.getByRole('listitem').nth(0)).toContainText(
    'This conversation · 1:02 · Maya',
  );
  await expect(sources.getByRole('listitem').nth(1)).toContainText(
    'Granola · 2026-11-01 · prior note',
  );
  await expect(sources.getByRole('listitem').nth(2)).toContainText(
    'Imported file · 2026-11-02 · prior note',
  );
  await expect(question).toContainText(
    'Prior notes are not from this conversation.',
  );
  await expect(question).toContainText('Kept here until you dismiss it.');
  await expect(question).not.toContainText('From the live transcript');
  await expect(question).toContainText(
    'This suggestion cites speech with words from your focus list.',
  );
  await expect(question).not.toContainText(
    'came through sooner and stays longer',
  );
  await question.getByRole('button', { name: 'Hide context' }).click();
  await expect(sources).toBeHidden();
  await expect(question).toContainText('Kept here until you dismiss it.');
  await question.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await expect(question).toHaveCount(0);
});

test('mixed resolution keeps its own sources and removal releases every excerpt', async ({
  page,
}) => {
  await nativePage(page);
  const resolved: Cue = {
    ...mixedCue,
    held: true,
    expanded: true,
    resolvedBy: {
      sourceId: mixedSources[0].id,
      evidence: 'Legacy resolution text.',
      sources: [mixedSources[0], mixedSources[2]],
    },
  };
  await show(page, resolved);
  const resolution = page.getByRole('list', {
    name: 'Resolution sources',
    exact: true,
  });
  await expect(resolution.getByRole('listitem')).toHaveCount(2);
  await expect(resolution).toContainText('Printing plan');
  await expect(
    page.getByText('Marked resolved from these sources.', { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByText('This was answered in the conversation.', { exact: false }),
  ).toHaveCount(0);
  // Native source invalidation publishes a newer snapshot with no cue.
  await page.evaluate(() => window.liveTest.setCue(null));
  await expect(
    page.getByText('Legal review takes two days.', { exact: false }),
  ).toHaveCount(0);
  await expect(resolution).toHaveCount(0);
});

test('four long sources fit a narrow companion with larger text and usable dismissal', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 560 });
  await nativePage(page, true);
  const long: Cue = structuredClone(mixedCue);
  long.held = true;
  long.expanded = true;
  long.sources!.push({
    ...mixedSources[2],
    id: 'prior:file:long',
    text: '界'.repeat(1_365),
    provenance: {
      kind: 'priorNote',
      provider: 'file',
      date: '2026-11-03',
      title: 'Garden'.repeat(33),
    },
  });
  await show(page, long);
  await page.evaluate(() => window.liveTest.setQuestionSize('large'));
  await expect(
    page
      .getByRole('list', { name: 'Cue sources', exact: true })
      .getByRole('listitem'),
  ).toHaveCount(4);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  const last = page
    .getByRole('list', { name: 'Cue sources', exact: true })
    .getByRole('listitem')
    .last();
  await last.scrollIntoViewIfNeeded();
  expect(
    await last.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  const dismiss = page.getByRole('button', { name: 'Dismiss', exact: true });
  await dismiss.scrollIntoViewIfNeeded();
  await dismiss.click();
  await expect(
    page.getByRole('region', { name: 'Suggested question' }),
  ).toHaveCount(0);
});
