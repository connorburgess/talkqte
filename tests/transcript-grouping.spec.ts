import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import type {} from './fixtures/native-microphone';
import type {} from './fixtures/native-meeting-qa';
import type {} from './fixtures/native-meeting-history';

const both = {
  microphone: true,
  application: 'Fictional Call',
  applicationAttached: true,
};

async function openLive(page: Page) {
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
  await page.goto('/?keys=set');
  await page.evaluate(() => window.liveTest.start());
}

test('live transcript groups consecutive same-speaker segments into readable paragraphs while preserving line IDs, boundaries, and citation highlight', async ({
  page,
}) => {
  await openLive(page);
  await page.evaluate((sources) => {
    window.liveTest.publish({
      sources,
      transcript: [
        // Four consecutive segments from You in one uninterrupted answer.
        {
          id: 't-1',
          atMs: 10_000,
          speaker: 'You',
          text: 'On the fictional greenhouse rollout we hit a retry storm during the weekend import.',
        },
        {
          id: 't-2',
          atMs: 13_000,
          speaker: 'You',
          text: 'Each worker retried the same batch without checking whether a prior write had already committed.',
        },
        {
          id: 't-3',
          atMs: 16_000,
          speaker: 'You',
          text: 'I added an idempotency key per batch and bounded the queue so duplicates dropped cleanly.',
        },
        {
          id: 't-4',
          atMs: 26_000, // 10s mid-turn pause -> new paragraph inside the SAME You turn.
          speaker: 'You',
          text: 'After that change, duplicate alerts fell from forty a week to zero.',
        },
        // Long 35s silence gap -> new You turn with fresh header and timestamp.
        {
          id: 't-5',
          atMs: 61_000,
          speaker: 'You',
          text: 'To follow up on timing, we kept the dry-run mode on for one week first.',
        },
        // Source/speaker switch -> diarized Speaker 1 (2 consecutive lines -> 1 turn).
        {
          id: 't-6',
          atMs: 65_000,
          speaker: 'Speaker 1',
          speakerId: 0,
          text: 'How did you validate the dry-run output?',
        },
        {
          id: 't-7',
          atMs: 68_000,
          speaker: 'Speaker 1',
          speakerId: 0,
          text: 'Did it slow down the normal nightly sync?',
        },
        // Speaker switch to Speaker 2.
        {
          id: 't-8',
          atMs: 71_000,
          speaker: 'Speaker 2',
          speakerId: 1,
          text: 'And who owned the rollback checklist?',
        },
        // Two explicitly unknown-speaker lines must NEVER merge together.
        {
          id: 't-9',
          atMs: 74_000,
          speaker: 'Unknown speaker',
          text: 'Could we check the lighting schedule too?',
        },
        {
          id: 't-10',
          atMs: 76_000,
          speaker: 'Unknown speaker',
          text: 'Yes, the north wing still needs timers.',
        },
      ],
    });
  }, both);

  // Ask cites the 3rd line inside the first 4-segment You turn.
  await page.getByRole('tab', { name: 'Ask', exact: true }).click();
  await page.evaluate(() =>
    window.qaTest.answer({
      answer: 'An idempotency key per batch stopped the duplicate alerts.',
      insufficient: false,
      citations: ['t-3'],
    }),
  );
  await page
    .getByRole('textbox', { name: 'Your question' })
    .fill('How were duplicates stopped?');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page
    .getByRole('button', { name: 'Transcript 0:16', exact: true })
    .click();

  const transcript = page.locator('#transcript-panel');
  // 10 underlying segments collapse into 6 turns:
  // [You 0:10-0:26 (4 lines), You 1:01, Speaker 1 1:05-1:08 (2 lines), Speaker 2 1:11, Unknown 1:14, Unknown 1:16].
  const turns = transcript.locator('.transcript-segment');
  await expect(turns).toHaveCount(6);
  await expect(
    turns.nth(0).locator('.transcript-segment-head time'),
  ).toHaveText('0:10–0:26');
  // First turn has 2 paragraphs because of the 10s mid-turn pause before t-4.
  await expect(turns.nth(0).locator('.transcript-paragraph')).toHaveCount(2);

  // All 10 immutable line IDs and timestamps remain intact in the DOM.
  await expect(transcript.locator('.transcript-line')).toHaveCount(10);
  const cited = page.locator('#transcript-line-t-3');
  await expect(cited).toBeFocused();
  await expect(cited).toHaveClass(/is-cited/);
  await expect(cited).toHaveAttribute('data-at-ms', '16000');
  await expect(cited.locator('.transcript-line-cited-time')).toHaveText('0:16');
  // Sibling segments inside the same turn are NOT marked cited.
  await expect(page.locator('#transcript-line-t-1')).not.toHaveClass(
    /is-cited/,
  );
  await expect(page.locator('#transcript-line-t-2')).not.toHaveClass(
    /is-cited/,
  );
  await expect(page.locator('#transcript-line-t-4')).not.toHaveClass(
    /is-cited/,
  );

  // Jump to latest line focuses the last underlying segment even inside a turn.
  await transcript
    .getByRole('button', { name: 'Jump to latest line', exact: true })
    .click();
  await expect(page.locator('#transcript-line-t-10')).toBeFocused();

  const audit = await new AxeBuilder({ page })
    .include('#transcript-panel')
    .analyze();
  expect(audit.violations).toEqual([]);
});

test('live partial segments append smoothly to the active turn and finalize without duplicating headers', async ({
  page,
}) => {
  await openLive(page);
  await page.evaluate((sources) => {
    window.liveTest.publish({
      sources,
      transcript: [
        {
          id: 'p-1',
          atMs: 5_000,
          speaker: 'Speaker 1',
          speakerId: 0,
          text: 'We tested the fictional compost sensor overnight.',
        },
        {
          id: 'p-2',
          atMs: 8_000,
          speaker: 'Speaker 1',
          speakerId: 0,
          text: 'Battery draw stayed under...',
          partial: true,
        },
      ],
    });
  }, both);

  await page.getByRole('tab', { name: /Transcript/ }).click();
  const transcript = page.locator('#transcript-panel');
  await expect(transcript.locator('.transcript-segment')).toHaveCount(1);
  await expect(page.locator('#transcript-line-p-2')).toHaveClass(/is-partial/);

  // Open inline rename on the active Speaker 1 turn while the partial finalizes.
  await transcript.getByRole('button', { name: 'Rename Speaker 1' }).click();
  const renameInput = transcript.getByRole('textbox', {
    name: 'Speaker 1 name',
  });
  await expect(renameInput).toBeFocused();

  // Finalize p-2 and append p-3 from the same speaker: turn stays 1, rename input stays open/focused.
  await page.evaluate((sources) => {
    window.liveTest.publish({
      sources,
      transcript: [
        {
          id: 'p-1',
          atMs: 5_000,
          speaker: 'Speaker 1',
          speakerId: 0,
          text: 'We tested the fictional compost sensor overnight.',
        },
        {
          id: 'p-2',
          atMs: 8_000,
          speaker: 'Speaker 1',
          speakerId: 0,
          text: 'Battery draw stayed under two percent.',
        },
        {
          id: 'p-3',
          atMs: 11_000,
          speaker: 'Speaker 1',
          speakerId: 0,
          text: 'That leaves plenty of margin for winter.',
        },
      ],
    });
  }, both);

  await expect(transcript.locator('.transcript-segment')).toHaveCount(1);
  await expect(page.locator('#transcript-line-p-2')).not.toHaveClass(
    /is-partial/,
  );
  await expect(transcript.locator('.transcript-line')).toHaveCount(3);
  await expect(renameInput).toBeFocused();
});

test('saved meeting transcript groups consecutive turns, keeps echo isolation, and stays readable at 390px', async ({
  page,
}) => {
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
  await page.evaluate(() => {
    window.historyTest.add({
      title: 'Fictional greenhouse review',
      startedAtMs: Date.UTC(2026, 10, 20, 10, 0),
      durationMs: 120_000,
      sources: 'both',
      application: 'Fictional Call',
      transcript: [
        {
          atMs: 1_000,
          label: 'you',
          text: 'Let us walk through the winter watering setup.',
        },
        {
          atMs: 4_000,
          label: 'you',
          text: 'We moved the valve shutoff closer to the door.',
        },
        {
          atMs: 7_000,
          label: 'you',
          text: 'That cuts the evening check to two minutes.',
        },
        {
          atMs: 9_000,
          label: 'you',
          echo: true,
          text: 'Echoed remote line through speakers.',
        },
        {
          atMs: 11_000,
          label: 'them',
          speakerId: 0,
          text: 'Great, did the spare hose fittings arrive?',
        },
        {
          atMs: 14_000,
          label: 'them',
          speakerId: 0,
          text: 'We will need two brass adapters before frost.',
        },
        {
          atMs: 55_000, // > 30s silence gap starts a new Speaker 1 turn.
          label: 'them',
          speakerId: 0,
          text: 'One more thing: please label the north timer.',
        },
      ],
      notes: 'Confirm frost dates.',
      cues: [],
    });
  });

  await page.getByRole('button', { name: 'Meetings', exact: true }).click();
  await page
    .getByRole('button', { name: /^Fictional greenhouse review/ })
    .click();
  await page.setViewportSize({ width: 390, height: 844 });

  const region = page.getByRole('region', { name: /Transcript \(6\)/ });
  const turns = region.locator('.transcript-segment');
  // 6 spoken segments (1 echo collapsed) -> 3 grouped turns:
  // [You 0:01-0:07 (3 lines), Speaker 1 0:11-0:14 (2 lines), Speaker 1 0:55 (1 line)].
  await expect(turns).toHaveCount(3);
  await expect(turns.nth(0).locator('.transcript-line')).toHaveCount(3);
  await expect(turns.nth(1).locator('.transcript-line')).toHaveCount(2);
  await expect(turns.nth(2).locator('.transcript-line')).toHaveCount(1);

  // Expanding likely echoes adds the standalone echo card without merging into You.
  await region.getByRole('button', { name: 'Show 1 likely echo line' }).click();
  await expect(turns).toHaveCount(4);
  await expect(turns.nth(1)).toHaveClass(/is-echo/);

  // Renaming Speaker 1 updates both Speaker 1 turns immediately.
  await region
    .getByRole('button', { name: 'Rename Speaker 1' })
    .first()
    .click();
  const input = region.getByRole('textbox', { name: 'Speaker 1 name' });
  await input.fill('Priya');
  await input.press('Enter');
  await expect(region.locator('.transcript-speaker-chip')).toHaveText([
    'Priya',
    'Priya',
  ]);

  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test('a 236-segment fictional session collapses repeated speaker headings while keeping all 236 line anchors', async ({
  page,
}) => {
  await openLive(page);
  await page.evaluate((sources) => {
    // 236 segments over ~20 minutes: 12 turns alternating between interviewer (4 lines)
    // and candidate (~16 lines each), 5s apart within each turn.
    const transcript = [];
    let atMs = 5_000;
    let index = 0;
    for (let round = 0; round < 12 && index < 236; round++) {
      for (let q = 0; q < 4 && index < 236; q++) {
        index++;
        transcript.push({
          id: `fict-${index}`,
          atMs,
          speaker: 'Speaker 1',
          speakerId: 0,
          text: `Fictional interviewer question part ${index}.`,
        });
        atMs += 4_000;
      }
      for (let a = 0; a < 16 && index < 236; a++) {
        index++;
        transcript.push({
          id: `fict-${index}`,
          atMs,
          speaker: 'You',
          text: `Fictional candidate answer segment ${index} describing the orchard water valve rollout.`,
        });
        atMs += 5_000;
      }
    }
    window.liveTest.publish({ sources, transcript });
  }, both);

  await page.getByRole('tab', { name: /Transcript/ }).click();
  const transcript = page.locator('#transcript-panel');
  // 236 segments collapse to 24 turn headers instead of 236 repeated headers.
  await expect(transcript.locator('.transcript-segment')).toHaveCount(24);
  // Every underlying immutable line ID remains individually addressable.
  await expect(transcript.locator('.transcript-line')).toHaveCount(236);
  await expect(page.locator('#transcript-line-fict-1')).toBeVisible();
  await expect(page.locator('#transcript-line-fict-236')).toContainText(
    'Fictional candidate answer segment 236',
  );
});
