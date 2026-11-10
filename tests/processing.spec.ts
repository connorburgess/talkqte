import { expect, test, type Page } from '@playwright/test';
import type { ProcessingSnapshot } from '../src/lib/processing';
import type {} from './fixtures/native-processing';

async function open(page: Page, query = '') {
  await page.route('**/*', async (route) => {
    if (route.request().resourceType() !== 'document') return route.continue();
    const response = await route.fetch();
    await route.fulfill({
      response,
      body: (await response.text()).replace(
        '/src/main.tsx',
        '/tests/fixtures/native-processing.tsx',
      ),
    });
  });
  await page.goto(`/${query}`);
  await expect(
    page.getByRole('heading', { name: 'Cue processing' }),
  ).toBeVisible();
}
async function send(page: Page, value: Partial<ProcessingSnapshot>) {
  await page.evaluate((value) => window.processingTest.send(value), value);
}
async function calls(page: Page, command: string) {
  return page.evaluate(
    (command) =>
      window.processingTest.calls.filter((call) => call.command === command),
    command,
  );
}
async function review(page: Page) {
  await page
    .getByRole('button', { name: 'Review processing', exact: true })
    .click();
  await page.getByRole('button', { name: 'Review selected sources' }).click();
  await expect(
    page.getByRole('heading', { name: 'Review before enabling' }),
  ).toBeFocused();
}
async function enable(page: Page) {
  await review(page);
  await page.getByRole('button', { name: 'Enable for this session' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Processing on' }),
  ).toBeVisible();
}

test('default off, exact source identities, and explicit hosted confirmation', async ({
  page,
}) => {
  await open(page, '?hosted');
  await expect(page.getByText('Processing off', { exact: true })).toBeVisible();
  expect(await calls(page, 'approve_processing_scope')).toEqual([]);
  await page.getByRole('button', { name: 'Review processing' }).click();
  await expect(
    page.getByRole('heading', { name: 'Choose what to process' }),
  ).toBeFocused();
  for (const checkbox of await page.getByRole('checkbox').all())
    await expect(checkbox).not.toBeChecked();
  await page.getByRole('checkbox', { name: /supplier review/ }).check();
  await page
    .getByRole('checkbox', { name: 'Also include recent conversation' })
    .check();
  await page.getByRole('button', { name: 'Review selected sources' }).click();
  await expect(page.getByText('Sent to Example service')).toBeVisible();
  await expect(
    page.getByText('Recent conversation and new speech', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Garden launch · watering plan')).toHaveCount(0);
  expect(await calls(page, 'review_processing_scope')).toEqual([
    {
      command: 'review_processing_scope',
      args: {
        scope: {
          conversation: 'recentAndNewSpeech',
          notes: [{ provider: 'file', sourceId: 'garden', revision: 1 }],
        },
      },
    },
  ]);
  expect(await calls(page, 'approve_processing_scope')).toEqual([]);
  await page.getByRole('button', { name: 'Enable for this session' }).click();
  await expect(page.getByText('Processing on', { exact: true })).toBeVisible();
  expect(await calls(page, 'approve_processing_scope')).toEqual([
    { command: 'approve_processing_scope', args: { id: 'review-1' } },
  ]);
  await page.getByText('Approved sources for this session').click();
  await expect(page.getByText('Garden launch · supplier review')).toBeVisible();
});

test('keyboard cancellation restores focus and forgets a draft', async ({
  page,
}) => {
  await open(page);
  await page.keyboard.press('Tab');
  await expect(
    page.getByRole('button', { name: 'Review processing' }),
  ).toBeFocused();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  await expect(
    page.getByRole('checkbox', { name: 'Also include recent conversation' }),
  ).toBeFocused();
  await page.keyboard.press('Space');
  await page.keyboard.press('Escape');
  await expect(
    page.getByRole('button', { name: 'Review processing' }),
  ).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('checkbox', { name: 'Also include recent conversation' }),
  ).not.toBeChecked();
  await page.getByRole('button', { name: 'Review selected sources' }).click();
  await page.keyboard.press('Escape');
  await expect(
    page.getByRole('button', { name: 'Review processing' }),
  ).toBeFocused();
  expect(await calls(page, 'cancel_processing_review')).toHaveLength(1);
  expect(await calls(page, 'approve_processing_scope')).toEqual([]);
});

test('Pause and Disable preserve capture; Stop waits for capture confirmation', async ({
  page,
}) => {
  await open(page);
  await enable(page);
  await send(page, { lastDecision: 'quiet' });
  await expect(
    page.getByText('No cue needed from the last evaluated speech.'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Pause cues' }).click();
  await expect(page.getByText('Cues paused', { exact: true })).toBeVisible();
  await expect(
    page.getByText('Microphone and transcript continue.', { exact: false }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Resume cues' }).click();
  await expect(page.getByRole('button', { name: 'Pause cues' })).toBeVisible();
  await page.getByRole('button', { name: 'Disable processing' }).click();
  await expect(page.getByText('Processing off', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Stop live session' }).click();
  await expect(
    page.getByText(
      'Stopping the live session… waiting for the microphone to stop.',
    ),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Stopping…' })).toBeDisabled();
  await send(page, { capture: 'off' });
  await expect(page.getByText('Microphone is off.')).toBeVisible();
  expect(await calls(page, 'approve_processing_scope')).toHaveLength(1);
});

for (const command of ['review_processing_scope', 'approve_processing_scope']) {
  test(`Stop bypasses a held ${command} reply and late replies cannot enable a new session`, async ({
    page,
  }) => {
    await open(page);
    await page.evaluate(
      (command) => window.processingTest.hold(command),
      command,
    );
    await page.getByRole('button', { name: 'Review processing' }).click();
    await page.getByRole('button', { name: 'Review selected sources' }).click();
    if (command === 'approve_processing_scope')
      await page
        .getByRole('button', { name: 'Enable for this session' })
        .click();
    await expect.poll(() => calls(page, command)).toHaveLength(1);
    await page.getByRole('button', { name: 'Stop live session' }).click();
    await expect(
      page.getByText('Session ended', { exact: true }),
    ).toBeVisible();
    await page.evaluate(() => window.processingTest.newSession());
    await page.evaluate(
      (command) => window.processingTest.release(command),
      command,
    );
    await expect(
      page.getByText('Processing off', { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Review processing' }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Enable for this session' }),
    ).toHaveCount(0);
    await expect(page.getByRole('alert')).toHaveCount(0);
  });
}

test('changed note revisions close a review; mismatched returned scope is rejected', async ({
  page,
}) => {
  await open(page);
  await review(page);
  await page.evaluate(() => window.processingTest.replaceSources());
  await expect(
    page.getByRole('button', { name: 'Enable for this session' }),
  ).toHaveCount(0);
  await expect(page.getByText(/An approved source changed/)).toBeVisible();
  await page.evaluate(() => window.processingTest.mismatch());
  await page.getByRole('button', { name: 'Review processing' }).click();
  await page.getByRole('button', { name: 'Review selected sources' }).click();
  await expect(page.getByRole('alert')).toHaveText(
    'Sources changed before review. Choose the current notes and try again.',
  );
  expect(await calls(page, 'approve_processing_scope')).toHaveLength(0);
});

for (const issue of [
  'authentication',
  'allowance',
  'rateLimit',
  'worker',
  'inputLimit',
] as const) {
  test(`${issue} stays distinct from quiet and does not retry or switch processors`, async ({
    page,
  }) => {
    await open(page);
    await enable(page);
    await send(page, { phase: 'unavailable', issue, lastDecision: null });
    await expect(
      page.getByText('Processing unavailable', { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText('No cue needed from the last evaluated speech.'),
    ).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'Stop live session' }),
    ).toBeEnabled();
    expect(await calls(page, 'approve_processing_scope')).toHaveLength(1);
    expect(await calls(page, 'review_processing_scope')).toHaveLength(1);
    await page.getByRole('button', { name: 'Disable processing' }).click();
    await expect(
      page.getByRole('button', { name: 'Review processing' }),
    ).toBeVisible();
  });
}

test('failed Stop retains capture warning, redacts errors and permits an explicit retry', async ({
  page,
}) => {
  await open(page);
  await page.evaluate(() => window.processingTest.fail('stop_live_session'));
  await page.getByRole('button', { name: 'Stop live session' }).click();
  await expect(page.getByRole('alert')).toHaveText(
    'Stop was not confirmed. Try Stop live session again.',
  );
  await expect(
    page.getByText(/Microphone and transcript continue/),
  ).toBeVisible();
  await expect(page.getByText('PRIVATE_PROVIDER_ERROR')).toHaveCount(0);
  expect(await calls(page, 'stop_live_session')).toHaveLength(1);
  await page.getByRole('button', { name: 'Stop live session' }).click();
  await expect(page.getByText('Session ended', { exact: true })).toBeVisible();
});

test('late initial snapshots and old events cannot restore processing after Stop', async ({
  page,
}) => {
  await open(page, '?delay-snapshot');
  await expect(page.getByText('Microphone status is unknown.')).toBeVisible();
  await page.getByRole('button', { name: 'Stop live session' }).click();
  await expect(page.getByText('Session ended', { exact: true })).toBeVisible();
  await page.evaluate(() => {
    window.processingTest.releaseSnapshot();
    return window.processingTest.stale();
  });
  await expect(page.getByText('Session ended', { exact: true })).toBeVisible();
});

test('empty notes and oversized selection are actionable without implicit approval', async ({
  page,
}) => {
  await open(page);
  await send(page, { notes: [] });
  await page.getByRole('button', { name: 'Review processing' }).click();
  await expect(
    page.getByText(
      'No prior notes imported. You can continue with new speech only.',
    ),
  ).toBeVisible();
  await page.evaluate(() =>
    window.processingTest.fail('review_processing_scope', 'input_limit'),
  );
  await page.getByRole('button', { name: 'Review selected sources' }).click();
  await expect(page.getByRole('alert')).toHaveText(
    'These notes exceed the processing limit. Choose fewer and review again.',
  );
  await page.getByRole('button', { name: 'Review selected sources' }).click();
  await expect(page.getByText('New speech only, from approval')).toBeVisible();
  expect(await calls(page, 'approve_processing_scope')).toHaveLength(0);
});

test('320px layout wraps long sources and keeps keyboard access to approval and Stop', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 560 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await open(page, '?hosted');
  await send(page, {
    notes: [
      {
        provider: 'file',
        sourceId: 'long',
        revision: 1,
        title: 'Garden launch · ' + 'SupplierAndWateringPlan'.repeat(8),
        sourceDate: '2026-11-03',
      },
    ],
  });
  await page.getByRole('button', { name: 'Review processing' }).click();
  await page.getByRole('checkbox', { name: /SupplierAndWateringPlan/ }).check();
  await page.getByRole('button', { name: 'Review selected sources' }).click();
  await expect(
    page.getByRole('heading', { name: 'Review before enabling' }),
  ).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(
    page.getByRole('button', { name: 'Enable for this session' }),
  ).toBeFocused();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(320);
  for (const button of await page.getByRole('button').all())
    expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(48);
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('button', { name: 'Stop live session' }),
  ).toBeVisible();
});

test('cancel while preparing discards the late review and restores the launcher', async ({
  page,
}) => {
  await open(page);
  await page.evaluate(() =>
    window.processingTest.hold('review_processing_scope'),
  );
  await page.getByRole('button', { name: 'Review processing' }).click();
  await page.getByRole('button', { name: 'Review selected sources' }).click();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(
    page.getByRole('button', { name: 'Review processing' }),
  ).toBeFocused();
  await page.evaluate(() =>
    window.processingTest.release('review_processing_scope'),
  );
  await expect
    .poll(() => calls(page, 'cancel_processing_review'))
    .toHaveLength(1);
  await expect(
    page.getByRole('button', { name: 'Enable for this session' }),
  ).toHaveCount(0);
});

test('a failed approval and missing processor do not invent processing or hide Stop', async ({
  page,
}) => {
  await open(page);
  await review(page);
  await page.evaluate(() =>
    window.processingTest.fail('approve_processing_scope'),
  );
  await page.getByRole('button', { name: 'Enable for this session' }).click();
  await expect(page.getByRole('alert')).toHaveText(
    'Approval was not confirmed. Check the current status before trying again.',
  );
  await expect(page.getByText('Processing off', { exact: true })).toBeVisible();
  await expect(page.getByText('PRIVATE_PROVIDER_ERROR')).toHaveCount(0);
  await page.getByRole('button', { name: 'Cancel' }).click();
  await send(page, { processor: null, scopeRevision: 2 });
  await expect(
    page.getByText('No evaluated-cue processor is available for this session.'),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Review processing' }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Stop live session' }),
  ).toBeEnabled();
});

for (const action of ['Pause cues', 'Resume cues']) {
  test(`delayed ${action} cannot alter a new unapproved session`, async ({
    page,
  }) => {
    await open(page);
    await enable(page);
    if (action === 'Resume cues')
      await page.getByRole('button', { name: 'Pause cues' }).click();
    await page.evaluate(() =>
      window.processingTest.hold('set_live_cues_paused'),
    );
    await page.getByRole('button', { name: action }).click();
    await page.getByRole('button', { name: 'Stop live session' }).click();
    await expect(
      page.getByText('Session ended', { exact: true }),
    ).toBeVisible();
    await page.evaluate(() => window.processingTest.newSession());
    const snapshots = (await calls(page, 'processing_snapshot')).length;
    await page.evaluate(() =>
      window.processingTest.release('set_live_cues_paused'),
    );
    await expect
      .poll(async () => (await calls(page, 'processing_snapshot')).length)
      .toBe(snapshots + 1);
    await expect(
      page.getByText('Processing off', { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Review processing' }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Resume cues' })).toHaveCount(
      0,
    );
    await expect(page.getByRole('button', { name: 'Pause cues' })).toHaveCount(
      0,
    );
    await expect(page.getByRole('alert')).toHaveCount(0);
  });
}
