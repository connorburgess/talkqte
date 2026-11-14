import assert from 'node:assert/strict';
import { createConnection } from 'node:net';
import { readFile, stat, access } from 'node:fs/promises';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { openLabBroker, evaluatorRequest } from './cue-lab-broker.mjs';
import { systemPromptFor } from './cue-lab.mjs';

const input = {
  events: [
    {
      id: 's1',
      speaker: 'Speaker',
      text: 'The fictional delivery date is Friday.',
    },
  ],
  existingCue: null,
};
const value = { action: 'quiet', cue: null, sourceIds: ['s1'] };
async function setup({
  request = async () => ({ value, elapsedMs: 1, usage: { input_tokens: 3 } }),
  maxCalls = 5,
  hello = true,
  armed = true,
} = {}) {
  const calls = [];
  const broker = await openLabBroker({
    provider: {
      metadata: { provider: 'codex', model: 'gpt-6.1-sol', effort: 'medium' },
      request: async (req) => {
        calls.push(req);
        return request(req);
      },
      close: async () => {},
    },
    maxCalls,
  });
  const descriptor = JSON.parse(await readFile(broker.descriptorPath, 'utf8'));
  const socket = createConnection({ path: descriptor.socketPath });
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  const frames = [],
    waiters = [];
  let partial = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    partial += chunk;
    for (let end; (end = partial.indexOf('\n')) !== -1;) {
      const frame = JSON.parse(partial.slice(0, end));
      partial = partial.slice(end + 1);
      const index = waiters.findIndex((waiter) => waiter.type === frame.type);
      if (index < 0) frames.push(frame);
      else waiters.splice(index, 1)[0].resolve(frame);
    }
  });
  const next = (type) => {
    const index = frames.findIndex((frame) => frame.type === type);
    if (index >= 0) return Promise.resolve(frames.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Missing fictional test frame ${type}`)),
        1500,
      );
      waiters.push({
        type,
        resolve: (frame) => {
          clearTimeout(timer);
          resolve(frame);
        },
      });
    });
  };
  const frame = (type, fields = {}) => ({
    schema: 'talkqte.lab.v1',
    type,
    runId: descriptor.runId,
    sessionId: '7',
    ...fields,
  });
  const send = (type, fields) =>
    socket.write(JSON.stringify(frame(type, fields)) + '\n');
  const greet = (extra = {}) =>
    send('hello', {
      nonce: descriptor.nonce,
      expectedProvider: 'codex',
      expectedModel: 'gpt-6.1-sol',
      expectedEffort: 'medium',
      ...extra,
    });
  const evaluate = (id = '1', extra = {}) =>
    send('evaluate', {
      requestId: id,
      contextRevision: id,
      budgetMs: 1000,
      input,
      ...extra,
    });
  const settle = (id = '1', verdict = 'current') =>
    send('settled', { requestId: id, contextRevision: id, verdict });
  if (hello) {
    greet();
    await next('ready');
    await broker.ready;
    if (armed) {
      const calibration = broker.calibrateClock();
      const probe = await next('clock_probe');
      send('clock_sample', {
        probeId: probe.probeId,
        nativeSessionElapsedMs: 1000,
      });
      await calibration;
      // Synthetic playback acknowledgement for this entirely offline fixture.
      broker.acknowledgePlaybackStart({
        monotonicMs: performance.now(),
        uncertaintyMs: 0,
      });
    }
  }
  return {
    broker,
    descriptor,
    socket,
    calls,
    next,
    frame,
    send,
    greet,
    evaluate,
    settle,
    async close() {
      socket.destroy();
      await broker.close();
    },
  };
}
async function terminal(broker) {
  for (let n = 0; n < 100 && !broker.gate.terminal; n++) await delay(5);
  assert.ok(broker.gate.terminal);
}

test('descriptor/socket permissions and exact hello pin provider without starting inference', async () => {
  const ctx = await setup();
  try {
    assert.equal((await stat(ctx.broker.descriptorPath)).mode & 0o777, 0o600);
    assert.equal((await stat(ctx.descriptor.socketPath)).mode & 0o777, 0o600);
    assert.equal(
      (await stat(new URL('.', `file://${ctx.broker.descriptorPath}`))).mode &
        0o777,
      0o700,
    );
    assert.equal(ctx.calls.length, 0);
  } finally {
    await ctx.close();
  }
  await assert.rejects(access(ctx.broker.descriptorPath), { code: 'ENOENT' });
});

test('trusted evaluator request matches shared prompt, schema and source IDs; arbitrary inputs refused', () => {
  const request = evaluatorRequest(input);
  assert.equal(request.role, 'cue-evaluator');
  assert.equal(
    request.instructions,
    systemPromptFor(input, { compact: true, glance: true }),
  );
  assert.deepEqual(request.schema.properties.sourceIds.items.enum, ['s1']);
  for (const bad of [
    { ...input, instructions: 'untrusted' },
    { ...input, events: [] },
    { ...input, existingCue: { text: 'Unsupported?', sourceIds: ['unknown'] } },
    {
      ...input,
      events: [{ id: 's1', speaker: 'Speaker', text: 'x'.repeat(4097) }],
    },
  ])
    assert.throws(() => evaluatorRequest(bad), /protocol/);
});

test('result holds lease through validation ack, including next evaluate in the same chunk', async () => {
  const ctx = await setup();
  try {
    ctx.evaluate();
    const result = await ctx.next('result');
    assert.deepEqual(result.value, value);
    assert.equal(ctx.broker.gate.dispatchesUsed, 1);
    let idle = false;
    const waiting = ctx.broker.gate.waitIdle().then(() => {
      idle = true;
    });
    await delay(10);
    assert.equal(idle, false);
    ctx.socket.write(
      JSON.stringify(
        ctx.frame('settled', {
          requestId: '1',
          contextRevision: '1',
          verdict: 'staleSuccess',
        }),
      ) +
        '\n' +
        JSON.stringify(
          ctx.frame('evaluate', {
            requestId: '2',
            contextRevision: '2',
            budgetMs: 1000,
            input,
          }),
        ) +
        '\n',
    );
    await ctx.next('result');
    assert.equal(ctx.calls.length, 2);
    ctx.settle('2');
    await waiting;
    await ctx.broker.gate.waitIdle();
    assert.equal(ctx.broker.gate.terminal, null);
  } finally {
    await ctx.close();
  }
});

test('ack grace does not extend provider deadline and permits bounded validation after on-time result', async () => {
  const ctx = await setup({
    request: async () => {
      await delay(20);
      return { value, elapsedMs: 20 };
    },
  });
  try {
    ctx.evaluate('1', { budgetMs: 50 });
    await ctx.next('result');
    await delay(50);
    ctx.settle();
    await ctx.broker.gate.waitIdle();
    assert.equal(ctx.broker.gate.terminal, null);
    assert.equal(ctx.broker.gate.dispatchesUsed, 1);
  } finally {
    await ctx.close();
  }
});

test('failed or mismatched settlement stops all roles and never retries', async () => {
  for (const variant of ['failed', 'mismatch']) {
    const ctx = await setup();
    try {
      ctx.evaluate();
      await ctx.next('result');
      if (variant === 'failed') ctx.settle('1', 'failed');
      else ctx.settle('2');
      await terminal(ctx.broker);
      await assert.rejects(
        ctx.broker.gate.run(() => ctx.broker.gate.request({ role: 'cast' }), {
          role: 'cast',
        }),
      );
      assert.equal(ctx.calls.length, 1);
    } finally {
      await ctx.close();
    }
  }
});

test('missing settlement acknowledgement is terminal under the fixed grace', async () => {
  const ctx = await setup();
  try {
    ctx.evaluate();
    await ctx.next('result');
    await delay(1050);
    await terminal(ctx.broker);
    assert.equal(ctx.calls.length, 1);
  } finally {
    await ctx.close();
  }
});

test('one evaluator waits behind participant and cannot overlap its provider', async () => {
  let release;
  const ctx = await setup({
    request: async (req) => {
      if (req.role === 'cast')
        await new Promise((resolve) => {
          release = resolve;
        });
      return { value, elapsedMs: 1 };
    },
  });
  try {
    const participant = ctx.broker.gate.run(
      () =>
        ctx.broker.gate.request({
          role: 'cast',
          instructions: 'Fictional.',
          input: {},
          schema: {},
        }),
      { role: 'cast' },
    );
    await delay(0);
    ctx.evaluate();
    await delay(10);
    assert.equal(ctx.calls.length, 1);
    release();
    await participant;
    await ctx.next('result');
    assert.equal(ctx.calls.length, 2);
    ctx.settle();
    await ctx.broker.gate.waitIdle();
  } finally {
    await ctx.close();
  }
});

test('participant failure notifies idle app, strips errors and stops future evaluator dispatch', async () => {
  const ctx = await setup({
    request: async () => {
      throw new Error('private provider output');
    },
  });
  try {
    await assert.rejects(
      ctx.broker.gate.run(() => ctx.broker.gate.request({ role: 'cast' }), {
        role: 'cast',
      }),
    );
    const frame = await ctx.next('terminal');
    assert.equal(frame.reason, 'unavailable');
    assert.ok(!JSON.stringify(frame).includes('private'));
    assert.equal(ctx.calls.length, 1);
  } finally {
    await ctx.close();
  }
});

test('unknown fields, bad identities, oversize/invalid UTF8/partial frames and wrong nonce fail without inference', async () => {
  for (const variant of [
    'nonce',
    'provider',
    'extra',
    'identity',
    'oversize',
    'utf8',
    'partial',
  ]) {
    const ctx = await setup({
      hello: !['nonce', 'provider'].includes(variant),
    });
    try {
      if (variant === 'nonce') ctx.greet({ nonce: '0'.repeat(64) });
      else if (variant === 'provider')
        ctx.greet({ expectedProvider: 'claude-code' });
      else if (variant === 'extra')
        ctx.evaluate('1', { instructions: 'not allowed' });
      else if (variant === 'identity') ctx.evaluate('01');
      else if (variant === 'oversize') ctx.socket.write('x'.repeat(65537));
      else if (variant === 'utf8') ctx.socket.write(Buffer.from([255, 10]));
      else {
        ctx.socket.write('{');
        await delay(1050);
      }
      await terminal(ctx.broker);
      assert.equal(ctx.calls.length, 0);
    } finally {
      await ctx.close();
    }
  }
});

test('no reconnect, and a duplicate evaluate cannot reset budget or repair failure', async () => {
  const ctx = await setup();
  try {
    ctx.evaluate();
    await ctx.next('result');
    ctx.settle();
    await ctx.broker.gate.waitIdle();
    ctx.evaluate();
    await terminal(ctx.broker);
    assert.equal(ctx.calls.length, 1);
  } finally {
    await ctx.close();
  }
  const reconnect = await setup();
  try {
    const second = createConnection({ path: reconnect.descriptor.socketPath });
    second.on('error', () => {});
    await terminal(reconnect.broker);
    second.destroy();
    assert.equal(reconnect.calls.length, 0);
  } finally {
    await reconnect.close();
  }
});

test('calibrated publication observation is memory-only, maps current cue and omits resolved/cleared cards', async () => {
  const ctx = await setup({ armed: false });
  try {
    assert.throws(() => ctx.broker.cuesAt(1000));
    const calibration = ctx.broker.calibrateClock();
    const probe = await ctx.next('clock_probe');
    ctx.send('clock_sample', {
      probeId: probe.probeId,
      nativeSessionElapsedMs: 1000,
    });
    const clock = await calibration;
    assert.ok(clock.uncertaintyMs <= 50);
    ctx.broker.acknowledgePlaybackStart({
      monotonicMs: performance.now(),
      uncertaintyMs: 0,
    });
    ctx.evaluate();
    await ctx.next('result');
    ctx.settle();
    await ctx.broker.gate.waitIdle();
    const cue = {
      cueId: 'c1',
      text: 'Who owns the final review?',
      kind: 'question',
      held: false,
      resolved: false,
      decider: 'model',
      requestId: '1',
      decisionAtNativeMs: 1050,
      publishedAtNativeMs: 1100,
    };
    ctx.send('cue_state', {
      observation: {
        snapshotRevision: '1',
        nativeSessionElapsedMs: 1200,
        publicationSucceeded: true,
        currentCue: cue,
        cleared: [],
      },
    });
    await delay(10);
    assert.equal(ctx.broker.cuesAt(1000)[0].text, cue.text);
    const returned = ctx.broker.observation;
    returned.currentCue.text = 'Mutated';
    assert.equal(ctx.broker.observation.currentCue.text, cue.text);
    ctx.send('cue_state', {
      observation: {
        snapshotRevision: '2',
        nativeSessionElapsedMs: 1300,
        publicationSucceeded: true,
        currentCue: { ...cue, resolved: true },
        cleared: [],
      },
    });
    await delay(10);
    assert.deepEqual(ctx.broker.cuesAt(1000), []);
    ctx.send('cue_state', {
      observation: {
        snapshotRevision: '3',
        nativeSessionElapsedMs: 1400,
        publicationSucceeded: true,
        currentCue: null,
        cleared: [{ cueId: 'c1', clearedAtNativeMs: 1400 }],
      },
    });
    await delay(10);
    assert.deepEqual(ctx.broker.cuesAt(1000), []);
  } finally {
    await ctx.close();
  }
});

test('late clock sample fails timed readiness with no model dispatch and no retry', async () => {
  const ctx = await setup({ armed: false });
  try {
    const calibration = ctx.broker.calibrateClock();
    await ctx.next('clock_probe');
    await assert.rejects(calibration);
    assert.ok(ctx.broker.gate.terminal);
    await assert.rejects(ctx.broker.calibrateClock());
    assert.equal(ctx.calls.length, 0);
  } finally {
    await ctx.close();
  }
});

test('actual playback ack may precede calibration; same-chunk sample/evaluate cannot race readiness', async () => {
  const ctx = await setup({ armed: false });
  try {
    ctx.broker.acknowledgePlaybackStart({
      monotonicMs: performance.now(),
      uncertaintyMs: 1,
    });
    const calibration = ctx.broker.calibrateClock();
    const probe = await ctx.next('clock_probe');
    ctx.socket.write(
      JSON.stringify(
        ctx.frame('clock_sample', {
          probeId: probe.probeId,
          nativeSessionElapsedMs: 1000,
        }),
      ) +
        '\n' +
        JSON.stringify(
          ctx.frame('evaluate', {
            requestId: '1',
            contextRevision: '1',
            budgetMs: 1000,
            input,
          }),
        ) +
        '\n',
    );
    await calibration;
    await ctx.next('result');
    ctx.settle();
    await ctx.broker.gate.waitIdle();
    assert.equal(ctx.calls.length, 1);
    assert.equal(ctx.broker.gate.terminal, null);
  } finally {
    await ctx.close();
  }
});

test('missing actual playback ack refuses inference even with a calibrated clock', async () => {
  const ctx = await setup({ armed: false });
  try {
    const calibration = ctx.broker.calibrateClock();
    const probe = await ctx.next('clock_probe');
    ctx.send('clock_sample', {
      probeId: probe.probeId,
      nativeSessionElapsedMs: 1000,
    });
    await calibration;
    ctx.evaluate();
    await terminal(ctx.broker);
    assert.equal(ctx.calls.length, 0);
  } finally {
    await ctx.close();
  }
});

test('Stop is idempotent and aborts an active provider through confirmed cleanup', async () => {
  let cleaned = false;
  const ctx = await setup({
    request: ({ signal }) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener(
          'abort',
          () => {
            setTimeout(() => {
              cleaned = true;
              reject(new Error('private'));
            }, 15);
          },
          { once: true },
        ),
      ),
  });
  try {
    ctx.evaluate();
    for (let n = 0; n < 100 && !ctx.calls.length; n++) await delay(2);
    ctx.send('cancel', {
      reason: 'stop',
      requestId: '1',
      contextRevision: '1',
    });
    ctx.send('cancel', {
      reason: 'stop',
      requestId: '1',
      contextRevision: '1',
    });
    await terminal(ctx.broker);
    await ctx.broker.gate.close();
    assert.equal(cleaned, true);
    assert.equal(ctx.calls.length, 1);
  } finally {
    await ctx.close();
  }
});

test('the same cap counts participant and evaluator attempts without counting settlement twice', async () => {
  const ctx = await setup({ maxCalls: 2 });
  try {
    await ctx.broker.gate.run(() => ctx.broker.gate.request({ role: 'cast' }), {
      role: 'cast',
    });
    ctx.evaluate();
    await ctx.next('result');
    ctx.settle();
    await ctx.broker.gate.waitIdle();
    ctx.evaluate('2');
    await terminal(ctx.broker);
    assert.equal(ctx.broker.gate.dispatchesUsed, 2);
    assert.equal(ctx.calls.length, 2);
  } finally {
    await ctx.close();
  }
});

test('invalid source reply, failed emission and receive overflow are terminal without repair', async () => {
  for (const variant of ['source', 'emission', 'queue']) {
    const ctx = await setup({
      request: async () => ({
        value: { ...value, sourceIds: ['unknown'] },
        elapsedMs: 1,
      }),
    });
    try {
      if (variant === 'source') ctx.evaluate();
      else if (variant === 'emission')
        ctx.send('cue_state', {
          observation: {
            snapshotRevision: '1',
            nativeSessionElapsedMs: 1000,
            publicationSucceeded: false,
            currentCue: null,
            cleared: [],
          },
        });
      else
        ctx.socket.write(
          Array.from(
            { length: 40 },
            () => JSON.stringify(ctx.frame('unknown')) + '\n',
          ).join(''),
        );
      await terminal(ctx.broker);
      assert.equal(ctx.calls.length, variant === 'source' ? 1 : 0);
    } finally {
      await ctx.close();
    }
  }
});

for (const variant of ['stop', 'revoke', 'disconnect', 'close', 'failure'])
  test(`a published cue cannot remain actionable after ${variant}`, async () => {
    const ctx = await setup();
    try {
      ctx.evaluate();
      await ctx.next('result');
      ctx.settle();
      await ctx.broker.gate.waitIdle();
      ctx.send('cue_state', {
        observation: {
          snapshotRevision: '1',
          nativeSessionElapsedMs: 1200,
          publicationSucceeded: true,
          cleared: [],
          currentCue: {
            cueId: 'c1',
            text: 'Who owns the review?',
            kind: 'question',
            held: false,
            resolved: false,
            decider: 'model',
            requestId: '1',
            decisionAtNativeMs: 1050,
            publishedAtNativeMs: 1100,
          },
        },
      });
      for (let n = 0; n < 100 && !ctx.broker.observation; n++) await delay(2);
      assert.equal(ctx.broker.cuesAt(1000).length, 1);
      if (variant === 'disconnect') ctx.socket.destroy();
      else if (variant === 'close') await ctx.broker.close();
      else if (variant === 'failure') ctx.send('unknown');
      else ctx.send('cancel', { reason: variant });
      await terminal(ctx.broker);
      assert.equal(ctx.broker.observation, null);
      assert.throws(() => ctx.broker.cuesAt(1000));
    } finally {
      await ctx.close();
    }
  });

for (const connect of [false, true])
  test(`independent pre-auth Stop awaits participant cleanup with ${connect ? 'an unauthenticated client' : 'no client'}`, async () => {
    const root = new AbortController();
    let began,
      release,
      cleaned = false;
    const entered = new Promise((resolve) => {
      began = resolve;
    });
    const cleanup = new Promise((resolve) => {
      release = resolve;
    });
    const broker = await openLabBroker({
      provider: {
        metadata: { provider: 'codex', model: 'gpt-6.1-sol', effort: 'medium' },
        request: ({ signal }) =>
          new Promise((_, reject) => {
            signal.addEventListener(
              'abort',
              async () => {
                await cleanup;
                cleaned = true;
                reject(new Error('fictional cancelled work'));
              },
              { once: true },
            );
            began();
          }),
        close: async () => {},
      },
      maxCalls: 2,
      signal: root.signal,
    });
    let socket;
    if (connect) {
      const descriptor = JSON.parse(
        await readFile(broker.descriptorPath, 'utf8'),
      );
      socket = createConnection({ path: descriptor.socketPath });
      await new Promise((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('error', reject);
      });
    }
    let completed = false;
    const operation = broker.gate.run(
      () => broker.gate.request({ role: 'cast' }),
      { role: 'cast' },
    );
    const checked = assert.rejects(operation);
    operation
      .finally(() => {
        completed = true;
      })
      .catch(() => {});
    await entered;
    root.abort();
    const closing = broker.close();
    assert.equal(completed, false);
    assert.equal(cleaned, false);
    assert.equal(broker.gate.dispatchesUsed, 1);
    release();
    await Promise.all([checked, closing]);
    assert.equal(completed, true);
    assert.equal(cleaned, true);
    socket?.destroy();
    await assert.rejects(
      broker.gate.run(() => broker.gate.request({ role: 'judge' }), {
        role: 'judge',
      }),
    );
  });
