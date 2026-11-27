import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import type {} from './fixtures/native-microphone';
import type {} from './fixtures/native-meeting-history';

async function open(page: Page) {
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
}
const line = {
  id: 'retention-fictional',
  atMs: 1000,
  speaker: 'Speaker',
  text: 'The fictional greenhouse review is on Saturday.',
};
async function live(page: Page) {
  await page.evaluate(
    (line) =>
      window.liveTest.publish({
        live: true,
        status: 'running',
        transcript: [line],
        notes: '',
        cue: null,
      }),
    line,
  );
  await expect(
    page.getByText('No model cues: this build has no model connection.'),
  ).toBeVisible();
}
const panel = (page: Page) =>
  page.getByRole('region', { name: 'Microphone', exact: true });
async function disclosure(page: Page) {
  await expect(panel(page)).not.toContainText(
    'TalkQTE does not save the transcript.',
  );
  await expect(panel(page)).toContainText(
    'Transcript saving follows Settings → Meetings, independently of cue processing.',
  );
  await expect(panel(page)).toContainText(
    'Save automatically requests a local save of non-empty sessions on stop.',
  );
  await expect(panel(page)).toContainText(
    'Ask each time waits for your choice; Don’t save leaves the session in memory.',
  );
}
for (const mode of ['auto', 'ask', 'off'] as const) {
  test(`unconfigured cue processing describes ${mode} transcript retention accurately`, async ({
    page,
  }) => {
    await open(page);
    await page.evaluate(
      (mode) => window.historyTest.setAfterSessionKeep(mode),
      mode,
    );
    await live(page);
    await disclosure(page);
    await page.evaluate(() => window.liveTest.publish({ status: 'ended' }));
    const saved = await page.evaluate(() => window.historyTest.meetings());
    if (mode === 'auto') {
      expect(saved).toHaveLength(1);
      expect(saved[0].transcript[0].text).toBe(line.text);
      await expect(page.getByText(/Saved to Meetings as/)).toBeVisible();
    } else {
      expect(saved).toEqual([]);
      await expect(
        page.getByRole('region', { name: 'Keep this meeting?' }),
      ).toHaveCount(mode === 'ask' ? 1 : 0);
    }
  });
}
test('lab availability never promises a save and keeps the transcript out of history', async ({
  page,
}) => {
  await open(page);
  await page.evaluate(() => window.historyTest.setAvailability('labRun'));
  await live(page);
  await disclosure(page);
  await expect(panel(page)).toContainText('Lab runs do not save meetings.');
  await page.evaluate(() => window.liveTest.publish({ status: 'ended' }));
  expect(await page.evaluate(() => window.historyTest.meetings())).toEqual([]);
});
test('narrow capture disclosure remains readable with Stop and no accessibility violations', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  await live(page);
  await disclosure(page);
  await expect(
    panel(page).getByRole('button', { name: 'Stop live session', exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  const results = await new AxeBuilder({ page })
    .include('.microphone-panel')
    .analyze();
  expect(results.violations).toEqual([]);
});
