import { expect, test } from '@playwright/test';
import { standIn } from './fixtures/stand-in';

// Fictional own-key readiness only: no capture, provider request or model.
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
    await expect(session.getByRole('button', { name: 'Export' })).toHaveCount(
      0,
    );
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
    // Notes remain immediately editable; Export still reviews exactly this copy.
    const notes = page.getByRole('textbox', {
      name: 'Meeting notes',
      exact: true,
    });
    await notes.fill(
      'Fictional preparation: ask about the garden access route.',
    );
    await page
      .getByRole('button', { name: 'Export', exact: true })
      .press('Enter');
    const review = page.getByRole('dialog', { name: 'Review your export' });
    await expect(review).toContainText(
      'Fictional preparation: ask about the garden access route.',
    );
    await page.keyboard.press('Escape');
    await expect(
      page.getByRole('button', { name: 'Export', exact: true }),
    ).toBeFocused();
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
    await expect(
      page.getByRole('button', { name: 'Export', exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole('heading', {
        name: 'Live session in progress',
        exact: true,
      }),
    ).toBeVisible();
  });
}
