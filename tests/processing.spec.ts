import { expect, test, type Page } from '@playwright/test';
import type { ProcessingSnapshot } from '../src/lib/processing';
import type {} from './fixtures/native-processing';

function controlTab(browserName: string) {
  // macOS WebKit follows Safari's keyboard navigation mode. Option-Tab
  // includes buttons without changing the developer's system preferences.
  return browserName === 'webkit' && process.platform === 'darwin'
    ? 'Alt+Tab'
    : 'Tab';
}

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
        expected: { session: 'fictional-garden', scopeRevision: 1 },
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
  browserName,
}) => {
  await open(page);
  await page.keyboard.press(controlTab(browserName));
  await expect(
    page.getByRole('button', { name: 'Review processing' }),
  ).toBeFocused();
  await page.keyboard.press('Enter');
  await page.keyboard.press(controlTab(browserName));
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

test('processing controls send only the originating session and scope', async ({
  page,
}) => {
  await open(page);
  await enable(page);
  await page.getByRole('button', { name: 'Pause cues' }).click();
  await page.getByRole('button', { name: 'Resume cues' }).click();
  await page.getByRole('button', { name: 'Disable processing' }).click();
  expect(await calls(page, 'set_processing_paused')).toEqual([
    {
      command: 'set_processing_paused',
      args: {
        expected: { session: 'fictional-garden', scopeRevision: 2 },
        paused: true,
      },
    },
    {
      command: 'set_processing_paused',
      args: {
        expected: { session: 'fictional-garden', scopeRevision: 3 },
        paused: false,
      },
    },
  ]);
  expect(await calls(page, 'revoke_processing')).toEqual([
    {
      command: 'revoke_processing',
      args: {
        expected: { session: 'fictional-garden', scopeRevision: 4 },
      },
    },
  ]);
  expect(await calls(page, 'set_live_cues_paused')).toEqual([]);
  await expect(page.getByText(/Microphone is on/)).toBeVisible();
});

for (const replacement of ['sources', 'session']) {
  test(`delayed Disable cannot revoke fresh approval after changed ${replacement}`, async ({
    page,
  }) => {
    await open(page);
    await enable(page);
    await page.evaluate(() => window.processingTest.hold('revoke_processing'));
    await page.getByRole('button', { name: 'Disable processing' }).click();
    await page.evaluate(
      (replacement) =>
        replacement === 'sources'
          ? window.processingTest.replaceSources()
          : window.processingTest.newSession(),
      replacement,
    );
    await enable(page);
    const snapshots = (await calls(page, 'processing_snapshot')).length;
    await page.evaluate(() =>
      window.processingTest.release('revoke_processing'),
    );
    await expect
      .poll(async () => (await calls(page, 'processing_snapshot')).length)
      .toBe(snapshots + 1);
    await expect(
      page.getByText('Processing on', { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Pause cues' }),
    ).toBeEnabled();
    await expect(page.getByRole('alert')).toHaveCount(0);
    expect(await calls(page, 'revoke_processing')).toHaveLength(1);
    expect(await calls(page, 'approve_processing_scope')).toHaveLength(2);
  });
}

test('shows when lines are being sent and stops showing it after the reply', async ({
  page,
}) => {
  await open(page);
  await enable(page);
  await send(page, { sending: true });
  await expect(page.getByText(/Sending recent lines to /)).toBeVisible();
  await send(page, { sending: false, lastDecision: 'quiet' });
  await expect(page.getByText(/Sending recent lines to /)).toHaveCount(0);
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
    page.getByText('Microphone is on.', { exact: false }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Resume cues' }).click();
  await expect(page.getByRole('button', { name: 'Pause cues' })).toBeVisible();
  await page.getByRole('button', { name: 'Disable processing' }).click();
  await expect(page.getByText('Processing off', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Stop capture' }).click();
  await expect(
    page.getByText('Waiting for the microphone to stop…'),
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
    await page.getByRole('button', { name: 'Stop capture' }).click();
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
  'credentials',
  'allowance',
  'rateLimit',
  'unreachable',
  'timedOut',
  'invalidReply',
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
      page.getByRole('button', { name: 'Stop capture' }),
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
  await page.evaluate(() => window.processingTest.fail('stop_capture'));
  await page.getByRole('button', { name: 'Stop capture' }).click();
  await expect(page.getByRole('alert')).toHaveText(
    'Stop was not confirmed. Check the current status, then try again.',
  );
  await expect(page.getByText(/Microphone is on/)).toBeVisible();
  await expect(page.getByText('PRIVATE_PROVIDER_ERROR')).toHaveCount(0);
  expect(await calls(page, 'stop_capture')).toHaveLength(1);
  await page.getByRole('button', { name: 'Stop capture' }).click();
  await expect(page.getByText('Session ended', { exact: true })).toBeVisible();
});

test('late initial snapshots and old events cannot restore processing after Stop', async ({
  page,
}) => {
  await open(page, '?delay-snapshot');
  await expect(page.getByText('Microphone status is unknown.')).toBeVisible();
  await page.getByRole('button', { name: 'Stop capture' }).click();
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
  browserName,
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
  await page.keyboard.press(controlTab(browserName));
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
    page.getByRole('button', { name: 'Stop capture' }),
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
    'Approval was not confirmed. Check the status and review sources again before enabling.',
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
    page.getByRole('button', { name: 'Stop capture' }),
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
      window.processingTest.hold('set_processing_paused'),
    );
    await page.getByRole('button', { name: action }).click();
    await page.getByRole('button', { name: 'Stop capture' }).click();
    await expect(
      page.getByText('Session ended', { exact: true }),
    ).toBeVisible();
    await page.evaluate(() => window.processingTest.newSession());
    const snapshots = (await calls(page, 'processing_snapshot')).length;
    await page.evaluate(() =>
      window.processingTest.release('set_processing_paused'),
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

test('startup and unknown capture keep Stop available without offering processing', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 560 });
  await open(page);
  for (const capture of ['starting', 'unknown'] as const) {
    await send(page, { capture });
    await expect(
      page.getByRole('button', { name: 'Review processing', exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'Stop capture', exact: true }),
    ).toBeEnabled();
    await expect(
      page.getByText(
        capture === 'starting'
          ? 'Starting microphone… you can stop while it starts.'
          : 'Microphone status is unknown. Use Stop capture to request that it stops.',
      ),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
  await page.getByRole('button', { name: 'Stop capture', exact: true }).click();
  expect(await calls(page, 'stop_capture')).toHaveLength(1);
});

test('confirmed capture off during transcript drain does not enable a new review', async ({
  page,
}) => {
  await open(page);
  await send(page, { phase: 'stopping', capture: 'off', approved: null });
  await expect(
    page.getByText('Finishing session', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('Microphone is off.', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Review processing', exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Resume cues' })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole('button', { name: 'Stop capture', exact: true }),
  ).toHaveCount(0);
});

test('keyboard cancellation during model loading keeps microphone state honest and restores focus', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 560 });
  await open(page);
  await send(page, { startup: 'loading', capture: 'off', processor: null });
  await expect(
    page.getByText('Microphone is off.', { exact: true }),
  ).toBeVisible();
  const cancel = page.getByRole('button', {
    name: 'Cancel start',
    exact: true,
  });
  await cancel.focus();
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('button', { name: 'Cancelling…' }),
  ).toBeDisabled();
  await expect(
    page.getByText('Start cancelled.', { exact: false }),
  ).toBeVisible();
  expect(await calls(page, 'stop_capture')).toEqual([
    {
      command: 'stop_capture',
      args: { target: { operation: 'fictional-live-1', microphone: '1' } },
    },
  ]);
  await send(page, { startup: 'idle', capture: 'off' });
  await expect(
    page.getByRole('heading', { name: 'Cue processing' }),
  ).toBeFocused();
  await expect(page.getByRole('button', { name: 'Cancel start' })).toHaveCount(
    0,
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test('source changes do not invalidate a delayed Stop request', async ({
  page,
}) => {
  await open(page);
  await enable(page);
  await page.evaluate(() => window.processingTest.hold('stop_capture'));
  await page.getByRole('button', { name: 'Stop capture', exact: true }).click();
  await page.evaluate(() => window.processingTest.replaceSources());
  await page.evaluate(() => window.processingTest.release('stop_capture'));
  await expect(
    page.getByText('Waiting for the microphone to stop…', { exact: true }),
  ).toBeVisible();
  expect(await calls(page, 'stop_capture')).toHaveLength(1);
});

for (const replacement of ['session', 'microphone']) {
  test(`delayed Stop preserves replacement ${replacement} without automatic retry`, async ({
    page,
  }) => {
    await open(page);
    await page.evaluate(() => window.processingTest.hold('stop_capture'));
    await page
      .getByRole('button', { name: 'Stop capture', exact: true })
      .click();
    if (replacement === 'session')
      await page.evaluate(() => window.processingTest.newSession());
    else
      await send(page, {
        stopTarget: { operation: 'fictional-live-1', microphone: '3' },
        capture: 'running',
      });
    const snapshots = (await calls(page, 'processing_snapshot')).length;
    await page.evaluate(() => window.processingTest.release('stop_capture'));
    await expect
      .poll(async () => (await calls(page, 'processing_snapshot')).length)
      .toBeGreaterThan(snapshots);
    await expect(
      page.getByText('Microphone is on.', { exact: false }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Stop capture', exact: true }),
    ).toBeEnabled();
    expect(await calls(page, 'stop_capture')).toHaveLength(1);
    expect(await calls(page, 'stop_live_session')).toHaveLength(0);
  });
}

test('missing initial status reads a target before Stop and never falls back to an unscoped command', async ({
  page,
}) => {
  await open(page, '?delay-snapshot');
  await page.getByRole('button', { name: 'Stop capture', exact: true }).click();
  await expect
    .poll(async () => (await calls(page, 'stop_capture')).length)
    .toBe(1);
  expect(await calls(page, 'stop_capture')).toEqual([
    {
      command: 'stop_capture',
      args: { target: { operation: 'fictional-live-1', microphone: '1' } },
    },
  ]);
  expect(await calls(page, 'stop_live_session')).toHaveLength(0);
});

test('Cancel start still stops its own capture if startup finishes before delivery', async ({
  page,
}) => {
  await open(page);
  await send(page, { startup: 'loading', capture: 'off' });
  await page.evaluate(() => window.processingTest.hold('stop_capture'));
  await page.getByRole('button', { name: 'Cancel start', exact: true }).click();
  await page.evaluate(() => window.processingTest.installCapture());
  await page.evaluate(() => window.processingTest.release('stop_capture'));
  await expect(
    page.getByText('Waiting for the microphone to stop…', { exact: true }),
  ).toBeVisible();
  expect(await calls(page, 'stop_capture')).toHaveLength(1);
});
