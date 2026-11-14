import { expect, test, type Page } from '@playwright/test';
import type {} from './fixtures/native-microphone';

async function open(page: Page, query = '?live&processor') {
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
  await page.goto(`/${query}`);
  await page
    .getByRole('button', { name: 'Start live session', exact: true })
    .click();
  await expect(stop(page)).toBeEnabled();
}
const stop = (page: Page) =>
  page.getByRole('button', { name: 'Stop live session', exact: true });
const panel = (page: Page) =>
  page.getByRole('region', { name: 'Cue processing', exact: true });
const review = (page: Page) =>
  panel(page).getByRole('button', { name: 'Review processing', exact: true });
const mic = (page: Page) =>
  page.getByRole('region', { name: 'Microphone', exact: true });
async function prepare(page: Page) {
  await review(page).click();
  await panel(page)
    .getByRole('button', { name: 'Review selected sources' })
    .click();
  await expect(
    panel(page).getByRole('heading', { name: 'Review before enabling' }),
  ).toBeFocused();
}
async function enable(page: Page) {
  await prepare(page);
  await panel(page)
    .getByRole('button', { name: 'Enable for this session' })
    .click();
  await expect(panel(page).getByRole('status')).toHaveText(
    'Model connection on',
  );
}
async function calls(page: Page, command: string) {
  return page.evaluate(
    (command) =>
      window.permissionTest.calls.filter((call) => call.command === command),
    command,
  );
}

test('unconfigured notebook stays useful with phrase cues, optional setup and a single capture control', async ({
  page,
}) => {
  await open(page, '?live');
  await expect(panel(page)).toContainText('No model connection');
  await expect(panel(page)).toContainText(
    'No model cues: this build has no model connection.',
  );
  await expect(review(page)).toHaveCount(0);
  await expect(stop(page)).toHaveCount(1);
  await expect(
    page.getByRole('button', { name: 'Stop capture', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Pause cues', exact: true }),
  ).toHaveCount(1);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(panel(page)).toBeVisible();
  await expect(stop(page)).toBeEnabled();
  expect(await calls(page, 'approve_processing_scope')).toEqual([]);
  await stop(page).click();
  await expect(mic(page).getByRole('status')).toHaveText('Off');
});

test('hosted review names exact selected sources, stays optional, and preserves review across Settings', async ({
  page,
}) => {
  await open(page, '?live&processor&hosted');
  await expect(
    page.getByRole('button', { name: 'Pause cues', exact: true }),
  ).toHaveCount(0);
  await review(page).focus();
  await page.keyboard.press('Enter');
  await expect(
    panel(page).getByRole('heading', { name: 'Choose what to process' }),
  ).toBeFocused();
  for (const checkbox of await panel(page).getByRole('checkbox').all())
    await expect(checkbox).not.toBeChecked();
  await panel(page)
    .getByRole('checkbox', { name: /supplier review/ })
    .check();
  await panel(page)
    .getByRole('checkbox', { name: 'Also include recent conversation' })
    .check();
  await panel(page)
    .getByRole('button', { name: 'Review selected sources' })
    .click();
  await expect(panel(page)).toContainText('Sent to Example service');
  await expect(panel(page)).toContainText(
    'Imported file · 2026-11-02 · prior note',
  );
  await expect(
    panel(page).getByText('Garden launch · watering plan'),
  ).toHaveCount(0);
  expect((await calls(page, 'review_processing_scope'))[0].args).toMatchObject({
    scope: {
      conversation: 'recentAndNewSpeech',
      notes: [{ provider: 'file', sourceId: 'garden', revision: 1 }],
    },
  });
  expect(await calls(page, 'approve_processing_scope')).toEqual([]);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(
    panel(page).getByRole('heading', { name: 'Review before enabling' }),
  ).toBeVisible();
  await panel(page)
    .getByRole('button', { name: 'Enable for this session' })
    .click();
  await expect(panel(page).getByRole('status')).toHaveText(
    'Model connection on',
  );
  expect(await calls(page, 'approve_processing_scope')).toEqual([
    { command: 'approve_processing_scope', args: { id: 'review-1' } },
  ]);
  await expect(mic(page)).not.toContainText('transcript is not saved or sent');
  await expect(stop(page)).toHaveCount(1);
});

test('pause and disable keep capture on; Stop stays independent of a pending permission command', async ({
  page,
}) => {
  await open(page);
  await enable(page);
  await expect(
    page.getByRole('button', { name: 'Pause cues', exact: true }),
  ).toHaveCount(1);
  await panel(page)
    .getByRole('button', { name: 'Pause cues', exact: true })
    .click();
  await expect(panel(page).getByRole('status')).toHaveText('Cues paused');
  await expect(mic(page).getByRole('status')).toHaveText('On');
  await panel(page).getByRole('button', { name: 'Resume cues' }).click();
  await panel(page).getByRole('button', { name: 'Disable processing' }).click();
  await expect(review(page)).toBeEnabled();
  await expect(mic(page).getByRole('status')).toHaveText('On');
  await enable(page);
  await page.evaluate(() =>
    window.permissionTest.hold('set_processing_paused'),
  );
  await panel(page)
    .getByRole('button', { name: 'Pause cues', exact: true })
    .click();
  await expect(stop(page)).toBeEnabled();
  await stop(page).click();
  await expect(mic(page).getByRole('status')).toHaveText('Off');
  await page.evaluate(() =>
    window.permissionTest.release('set_processing_paused'),
  );
  await expect(panel(page).getByRole('status')).toHaveText('Session ended');
  await expect(
    panel(page).getByRole('button', { name: 'Resume cues' }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(() =>
      window.microphoneTest.calls.includes('set_live_cues_paused'),
    ),
  ).toBe(false);
});

test('cancelling a pending review discards its reply and restores keyboard focus', async ({
  page,
}) => {
  await open(page);
  await review(page).click();
  await page.evaluate(() =>
    window.permissionTest.hold('review_processing_scope'),
  );
  await panel(page)
    .getByRole('button', { name: 'Review selected sources' })
    .click();
  await panel(page)
    .getByRole('button', { name: 'Cancel', exact: true })
    .focus();
  await page.keyboard.press('Enter');
  await expect(review(page)).toBeFocused();
  await page.evaluate(() =>
    window.permissionTest.release('review_processing_scope'),
  );
  await expect
    .poll(() => calls(page, 'cancel_processing_review'))
    .toHaveLength(1);
  await expect(
    panel(page).getByRole('button', { name: 'Enable for this session' }),
  ).toHaveCount(0);
  expect(await calls(page, 'approve_processing_scope')).toEqual([]);
});

test('changed notes retire review without stealing focus from Settings', async ({
  page,
}) => {
  await open(page);
  await prepare(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const name = page.getByRole('textbox', { name: 'Name', exact: true });
  await name.focus();
  await page.evaluate(() => window.permissionTest.replaceSources());
  await expect(
    panel(page).getByRole('button', { name: 'Enable for this session' }),
  ).toHaveCount(0);
  await expect(panel(page)).toContainText('an approved note changed');
  await expect(name).toBeFocused();
  await prepare(page);
  expect((await calls(page, 'review_processing_scope'))[1].args).toMatchObject({
    expected: { scopeRevision: 2 },
  });
  expect(await calls(page, 'approve_processing_scope')).toEqual([]);
});

test('approval failure is explicit, private errors stay out of UI, and recovery needs another click', async ({
  page,
}) => {
  await open(page);
  await prepare(page);
  await page.evaluate(() =>
    window.permissionTest.fail('approve_processing_scope'),
  );
  await panel(page)
    .getByRole('button', { name: 'Enable for this session' })
    .click();
  await expect(panel(page).getByRole('alert')).toContainText(
    'Approval was not confirmed',
  );
  await expect(panel(page)).not.toContainText('PRIVATE_PROVIDER_ERROR');
  await expect(panel(page).getByRole('status')).toHaveText(
    'Model connection off',
  );
  expect(await calls(page, 'approve_processing_scope')).toHaveLength(1);
  await expect(
    panel(page).getByRole('button', { name: 'Enable for this session' }),
  ).toHaveCount(0);
  await panel(page)
    .getByRole('button', { name: 'Review selected sources' })
    .click();
  await panel(page)
    .getByRole('button', { name: 'Enable for this session' })
    .click();
  expect(
    (await calls(page, 'approve_processing_scope')).map((call) => call.args),
  ).toEqual([{ id: 'review-1' }, { id: 'review-2' }]);
  await expect(panel(page).getByRole('status')).toHaveText(
    'Model connection on',
  );
});

test('Stop during pending approval cannot enable processing after capture ends', async ({
  page,
}) => {
  await open(page);
  await prepare(page);
  await page.evaluate(() =>
    window.permissionTest.hold('approve_processing_scope'),
  );
  await panel(page)
    .getByRole('button', { name: 'Enable for this session' })
    .click();
  await stop(page).click();
  await expect(mic(page).getByRole('status')).toHaveText('Off');
  await page.evaluate(() =>
    window.permissionTest.release('approve_processing_scope'),
  );
  await expect(panel(page).getByRole('status')).toHaveText('Session ended');
  await expect(
    panel(page).getByText('Approved sources for this session'),
  ).toHaveCount(0);
});

test('narrow permission review wraps long sources and leaves capture controls reachable', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  await page.evaluate(() => {
    const state = window.captureTest.state();
    return window.captureTest.send({
      notes: state.notes.map((note) => ({
        ...note,
        title: 'Fictional garden planning '.repeat(8),
      })),
    });
  });
  await prepare(page);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  const approve = panel(page).getByRole('button', {
    name: 'Enable for this session',
  });
  await approve.scrollIntoViewIfNeeded();
  expect((await approve.boundingBox())!.height).toBeGreaterThanOrEqual(48);
  await panel(page)
    .getByRole('button', { name: 'Cancel', exact: true })
    .click();
  await expect(review(page)).toBeFocused();
  await stop(page).scrollIntoViewIfNeeded();
  await expect(stop(page)).toBeEnabled();
});

test('status failure blocks permission changes until refresh without blocking Stop', async ({
  page,
}) => {
  await open(page);
  await prepare(page);
  await page.evaluate(() => {
    window.permissionTest.fail('approve_processing_scope');
    window.captureTest.failSnapshot();
  });
  await panel(page)
    .getByRole('button', { name: 'Enable for this session' })
    .click();
  await expect(panel(page).getByRole('status')).toHaveText(
    'Connection status unknown',
  );
  await expect(
    panel(page).getByRole('button', { name: 'Review selected sources' }),
  ).toBeDisabled();
  await expect(stop(page)).toBeEnabled();
  await page.getByRole('button', { name: 'Refresh capture status' }).click();
  await expect(panel(page).getByRole('status')).toHaveText(
    'Model connection off',
  );
  await expect(
    panel(page).getByRole('button', { name: 'Review selected sources' }),
  ).toBeEnabled();
  expect(await calls(page, 'approve_processing_scope')).toHaveLength(1);
  await panel(page)
    .getByRole('button', { name: 'Review selected sources' })
    .click();
  await panel(page)
    .getByRole('button', { name: 'Enable for this session' })
    .click();
  await expect(panel(page).getByRole('status')).toHaveText(
    'Model connection on',
  );
});
