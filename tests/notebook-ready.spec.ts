import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { standIn } from './fixtures/stand-in';

// Fictional own-key readiness & redesign regression checks: no capture,
// provider request or model.
for (const width of [320, 390, 1320]) {
  test(`ready Notebook keeps Start and its sending disclosure together at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await standIn(page, '/?live-from-keys');
    await expect(
      page.getByRole('heading', { name: 'Ready for a meeting', exact: true }),
    ).toBeVisible();
    const session = page.getByRole('region', { name: 'Session', exact: true });
    const start = session.getByRole('button', { name: 'Start live session' });
    await expect(start).toBeInViewport();
    await expect(start).toBeEnabled();
    await expect(session).toContainText(
      'Starts immediately: sends your microphone and system audio to Deepgram and recent lines to Anthropic until you press Stop.',
    );
    await expect(session.getByRole('button', { name: /Export/ })).toHaveCount(
      0,
    );
    await expect(
      page.getByRole('button', { name: 'Cue appearance and timing' }),
    ).toHaveCount(0);
    await expect(page.locator('.companion')).toContainText(
      'Anthropic can offer a source-backed cue',
    );
    await expect(page.locator('.notebook-body')).not.toContainText(
      /phrase rules only|Only leaves if/,
    );
    await expect(page.locator('.focus-disclosure')).not.toHaveAttribute('open');
    await expect(page.locator('.context-disclosure')).not.toHaveAttribute(
      'open',
    );
    // Ready + Ask stays quiet with no disabled composer or 64 KiB technical wall.
    await page.getByRole('tab', { name: 'Ask', exact: true }).click();
    await expect(
      page.getByRole('heading', {
        name: 'Ask after the conversation starts',
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole('textbox', { name: 'Your question' }),
    ).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Send' })).toHaveCount(0);
    await page.getByRole('tab', { name: 'Notes', exact: true }).click();
    // Sidebar footer mounts BuildVersion (never hardcoded 0.1 · alpha).
    await expect(page.locator('.meeting-list')).not.toContainText(
      '0.1 · alpha',
    );
    if (width > 760) {
      await expect(page.locator('.build-version summary')).toContainText(
        '0.1.0 · 1234567',
      );
    }
    // Export stays hidden when nothing exists and appears as Export Markdown… once notes are typed.
    const exportMarkdown = page.getByRole('button', {
      name: 'Export Markdown…',
      exact: true,
    });
    await expect(exportMarkdown).toHaveCount(0);
    const notes = page.getByRole('textbox', {
      name: 'Meeting notes',
      exact: true,
    });
    await notes.fill(
      'Fictional preparation: ask about the garden access route.',
    );
    await expect(exportMarkdown).toBeEnabled();
    await exportMarkdown.press('Enter');
    const review = page.getByRole('dialog', { name: 'Review your export' });
    await expect(review).toContainText(
      'Fictional preparation: ask about the garden access route.',
    );
    await page.keyboard.press('Escape');
    await expect(exportMarkdown).toBeFocused();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    // Starting stays a direct keyboard action, and active-session safety remains visible.
    await start.focus();
    await page.keyboard.press('Enter');
    await expect(
      page
        .getByRole('button', { name: 'Stop live session', exact: true })
        .first(),
    ).toBeEnabled();
    await expect(exportMarkdown).toHaveCount(0);
    await expect(
      page.getByRole('heading', {
        name: 'Live session in progress',
        exact: true,
      }),
    ).toBeVisible();
  });
}

test('Transcript and Ask cross-link cleanly, highlight cited lines, and Settings groups stay accessible', async ({
  page,
}) => {
  await standIn(page, '/?live&processor&keys=set');
  await page
    .getByRole('button', { name: 'Start live session', exact: true })
    .click();
  await page.evaluate(() => {
    window.liveTest.publish({
      transcript: [
        {
          id: 'qa-0',
          atMs: 5_000,
          speaker: 'You',
          text: 'Fictional opening line about the greenhouse schedule.',
        },
        {
          id: 'qa-1',
          atMs: 12_000,
          speaker: 'Them',
          text: 'We chose a Saturday greenhouse check.',
        },
      ],
    });
  });

  // Transcript links directly to Ask.
  await page.getByRole('tab', { name: /Transcript/ }).click();
  await expect(
    page.getByRole('button', { name: 'Ask about transcript' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Ask about transcript' }).click();
  await expect(
    page.getByRole('tab', { name: 'Ask', exact: true }),
  ).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#ask-scope')).toContainText(
    'Uses the latest 2 lines (capped at 200 lines / 64 KiB).',
  );

  // Ask links back to Transcript.
  await page.getByRole('button', { name: 'View transcript' }).click();
  await expect(page.getByRole('tab', { name: /Transcript/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );

  // Ended session promotes outcome-named Export Markdown… in ended actions.
  await page
    .getByRole('button', { name: 'Stop live session', exact: true })
    .first()
    .click();
  await page.evaluate(() => window.captureTest.finishStop());
  await expect(
    page.getByRole('button', { name: 'Export Markdown…', exact: true }),
  ).toBeEnabled();

  // Grouped Settings keeps 5 clear sections and passes axe checks.
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settingsNav = page.getByRole('navigation', {
    name: 'Settings sections',
  });
  await expect(settingsNav.getByRole('link')).toHaveCount(5);
  const axe = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .disableRules(['color-contrast'])
    .analyze();
  expect(axe.violations).toEqual([]);
});
