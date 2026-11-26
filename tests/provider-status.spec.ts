import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  // Load a blank document so only the status bridge under test runs.
  await page.route('**/', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><title>Fictional status checks</title>',
    }),
  );
  await page.goto('/');
});

test('concurrent status consumers share a read, while subsequent reads see external changes', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const path = '/tests/fixtures/provider-status-harness.ts';
    const h: typeof import('./fixtures/provider-status-harness') = await import(
      path
    );
    const first = h.keys.keysStatus();
    const second = h.keys.keysStatus();
    const concurrentCalls = h.calls;
    h.resolveRead(h.absent);
    const initial = await Promise.all([first, second]);
    const next = h.keys.keysStatus();
    h.resolveRead(h.present);
    return { concurrentCalls, total: h.calls, initial, next: await next };
  });
  expect(result.concurrentCalls).toBe(1);
  expect(result.total).toBe(2);
  expect(result.initial.map((s) => s.deepgram.state)).toEqual([
    'notSet',
    'notSet',
  ]);
  expect(result.next.deepgram.state).toBe('set');
});

test('a rejected status read is shared and a later refresh can recover', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const path = '/tests/fixtures/provider-status-harness.ts';
    const h: typeof import('./fixtures/provider-status-harness') = await import(
      path
    );
    const pending = Promise.allSettled([
      h.keys.keysStatus(),
      h.keys.keysStatus(),
    ]);
    h.rejectRead();
    const failures = await pending;
    const retry = h.keys.keysStatus();
    h.resolveRead(h.present);
    return {
      failures: failures.map((r) => r.status),
      calls: h.calls,
      retry: await retry,
    };
  });
  expect(result.failures).toEqual(['rejected', 'rejected']);
  expect(result.calls).toBe(2);
  expect(result.retry.deepgram.state).toBe('set');
});

for (const change of ['save', 'remove', 'test', 'event'] as const) {
  test(`${change} invalidates an older pending status reply`, async ({
    page,
  }) => {
    const result = await page.evaluate(async (change) => {
      const path = '/tests/fixtures/provider-status-harness.ts';
      const h: typeof import('./fixtures/provider-status-harness') =
        await import(path);
      const stop = await h.keys.watchKeys(() => {});
      const old = h.keys.keysStatus();
      if (change === 'save')
        await h.keys.setKey('deepgram', 'fictional-placeholder');
      else if (change === 'remove') await h.keys.removeKey('deepgram');
      else if (change === 'test') await h.keys.testKey('deepgram');
      else await h.changed();
      const fresh = h.keys.keysStatus();
      h.resolveRead(change === 'remove' ? h.present : h.absent);
      h.resolveRead(change === 'remove' ? h.absent : h.present);
      const statuses = await Promise.all([old, fresh]);
      stop();
      return { states: statuses.map((s) => s.deepgram.state), calls: h.calls };
    }, change);
    expect(result.states).toEqual(
      change === 'remove' ? ['notSet', 'notSet'] : ['set', 'set'],
    );
    expect(result.calls).toBe(2);
  });
}

test('a read started during a mutation cannot satisfy the refresh after it finishes', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const path = '/tests/fixtures/provider-status-harness.ts';
    const h: typeof import('./fixtures/provider-status-harness') = await import(
      path
    );
    h.holdMutation();
    const save = h.keys.setKey('deepgram', 'fictional-placeholder');
    const during = h.keys.keysStatus();
    h.releaseMutation();
    await save;
    const after = h.keys.keysStatus();
    h.resolveRead(h.absent);
    h.resolveRead(h.present);
    const statuses = await Promise.all([during, after]);
    return { states: statuses.map((s) => s.deepgram.state), calls: h.calls };
  });
  expect(result.states).toEqual(['set', 'set']);
  expect(result.calls).toBe(2);
});
