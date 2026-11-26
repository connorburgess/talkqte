import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import type {} from './fixtures/native-prior-context';

const panel = (page: Page) =>
  page.getByRole('region', { name: 'Prior context' });
async function open(page: Page, scenario: string, extra = '') {
  await page.route('**/*', async (route) => {
    if (route.request().resourceType() !== 'document') return route.continue();
    const response = await route.fetch();
    await route.fulfill({
      response,
      body: (await response.text()).replace(
        '/src/main.tsx',
        '/tests/fixtures/native-prior-context.tsx',
      ),
    });
  });
  await page.goto(`/?case=${scenario}${extra}`);
  await panel(page).locator('summary').press('Enter');
}

test('opening the empty disclosure checks metadata without importing or reading meeting contents', async ({
  page,
}) => {
  await open(page, 'none');
  await expect(panel(page)).toContainText('No saved meetings yet.');
  expect(
    await page.evaluate(() =>
      window.priorContextTest.calls().map((call) => call.name),
    ),
  ).toEqual(
    expect.arrayContaining([
      'granola_status',
      'kept_meetings',
      'meeting_history_status',
    ]),
  );
  expect(
    await page.evaluate(() =>
      window.priorContextTest
        .calls()
        .some((call) =>
          /open_kept|import_context|review_processing|approve_processing|generate/.test(
            call.name,
          ),
        ),
    ),
  ).toBe(false);
});

test('saved meetings without notes explain transcript exclusion and offer a review path', async ({
  page,
}) => {
  await open(page, 'transcript-only');
  await expect(panel(page)).toContainText(
    'Saved meetings have no reusable notes yet.',
  );
  await expect(panel(page)).toContainText(
    'Transcripts are not used as prior context.',
  );
  await panel(page)
    .getByRole('button', { name: 'Review saved meetings' })
    .click();
  await expect(page.getByText('Opened Meetings for review.')).toBeVisible();
  await panel(page)
    .getByRole('button', { name: 'Choose kept meetings' })
    .click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText(
    'Saved meetings have no reusable notes yet.',
  );
  await expect(
    dialog.getByRole('button', { name: 'Import selected', exact: true }),
  ).toBeDisabled();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(
    panel(page).getByRole('button', { name: 'Choose kept meetings' }),
  ).toBeFocused();
});

test('archived written notes can still be reviewed and explicitly imported without processing approval', async ({
  page,
}) => {
  await open(page, 'archived');
  await expect(panel(page)).toContainText('Saved notes are archived.');
  await expect(panel(page)).toContainText('select their notes manually');
  await panel(page)
    .getByRole('button', { name: 'Choose kept meetings' })
    .click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('separate processing review and approval');
  await expect(dialog.getByRole('checkbox')).not.toBeChecked();
  await dialog.getByRole('checkbox').check();
  await dialog.getByRole('button', { name: 'Import 1 selected' }).click();
  await expect(panel(page).locator('summary')).toContainText('1 note selected');
  await expect(panel(page)).toContainText(
    'Written note: check the garden gate.',
  );
  const calls = await page.evaluate(() => window.priorContextTest.calls());
  expect(
    calls
      .filter((call) => call.name === 'import_context_notes')
      .map((call) => call.args),
  ).toEqual([{ ids: ['garden-notes'], dates: undefined }]);
  expect(
    calls.some((call) => /approve|generate|open_kept/.test(call.name)),
  ).toBe(false);
});

for (const [scenario, heading] of [
  ['auto-off', 'Automatic prior context is off.'],
  ['saving-off', 'No notes selected for this session.'],
  ['available', 'No notes selected for this session.'],
  ['unreadable', 'Saved meetings could not be read.'],
  ['partial-unreadable', 'Saved meetings have no reusable notes yet.'],
  ['metadata-unknown', 'No prior notes selected.'],
  ['labRun', 'Saved meeting context is off in this lab run.'],
  ['newer', 'Saved meetings need a newer version of TalkQTE.'],
  ['unavailable', 'Saved meeting context is unavailable.'],
]) {
  test(`${scenario}: distinguish empty availability without claiming lost history`, async ({
    page,
  }) => {
    await open(page, scenario);
    await expect(panel(page)).toContainText(heading);
    if (scenario === 'partial-unreadable')
      await expect(panel(page)).toContainText(
        'The availability above covers readable meetings only.',
      );
    if (scenario === 'metadata-unknown')
      await expect(panel(page)).not.toContainText('no reusable notes');
    if (scenario === 'auto-off') {
      await panel(page)
        .getByRole('button', { name: 'Review meeting settings' })
        .click();
      await expect(
        page.getByText('Opened meeting settings for review.'),
      ).toBeVisible();
    }
    if (['labRun', 'newer', 'unavailable'].includes(scenario))
      await expect(
        panel(page).getByRole('button', { name: 'Choose kept meetings' }),
      ).toBeDisabled();
    else
      await expect(
        panel(page).getByRole('button', { name: 'Choose kept meetings' }),
      ).toBeEnabled();
  });
}

test('metadata failures are retryable without importing notes', async ({
  page,
}) => {
  await open(page, 'error');
  await expect(panel(page)).toContainText('Saved notes could not be checked.');
  await page.evaluate(() =>
    window.priorContextTest.setScenario('transcript-only', false),
  );
  await panel(page)
    .getByRole('button', { name: 'Retry saved notes check' })
    .click();
  await expect(panel(page)).toContainText(
    'Saved meetings have no reusable notes yet.',
  );
});

test('closing and reopening while metadata waits retires the old response', async ({
  page,
}) => {
  await open(page, 'none', '&hold');
  await expect(panel(page)).toContainText('Checking saved notes…');
  await expect
    .poll(() => page.evaluate(() => window.priorContextTest.pending()))
    .toBe(1);
  await panel(page).locator('summary').press('Enter');
  await page.evaluate(() =>
    window.priorContextTest.setScenario('transcript-only'),
  );
  await panel(page).locator('summary').press('Enter');
  await expect(panel(page)).toContainText(
    'Saved meetings have no reusable notes yet.',
  );
  await page.evaluate(() => window.priorContextTest.release());
  await expect(panel(page)).not.toContainText('No saved meetings yet.');
});

test('a history change refreshes availability and retires an older pending check', async ({
  page,
}) => {
  await open(page, 'none', '&hold');
  await expect
    .poll(() => page.evaluate(() => window.priorContextTest.pending()))
    .toBe(1);
  await page.evaluate(() =>
    window.priorContextTest.setScenario('transcript-only'),
  );
  await expect(panel(page)).toContainText(
    'Saved meetings have no reusable notes yet.',
  );
  await page.evaluate(() => window.priorContextTest.release());
  await expect(panel(page)).not.toContainText('No saved meetings yet.');
});

test('narrow guidance and chooser remain readable and keyboard accessible', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, 'archived');
  await expect(panel(page)).toContainText('Saved notes are archived.');
  await panel(page)
    .getByRole('button', { name: 'Choose kept meetings' })
    .focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  expect(
    await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth),
  ).toBe(true);
  await expect(dialog.getByRole('checkbox')).not.toBeChecked();
  const axe = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(axe.violations).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(
    panel(page).getByRole('button', { name: 'Choose kept meetings' }),
  ).toBeFocused();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
