import assert from 'node:assert/strict';
import { createConnection } from 'node:net';
import { readFile, stat, access } from 'node:fs/promises';
import fsPromises from 'node:fs/promises';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
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
  sourceSessionMode = 'legacy-fixture',
  metadata = {
    provider: 'codex',
    model: 'gpt-6.1-sol',
    effort: 'medium',
    deadlineMs: 30000,
  },
  spentMicroUsd,
} = {}) {
  const calls = [];
  const broker = await openLabBroker({
    sourceSessionMode,
    provider: {
      metadata,
      ...(spentMicroUsd === undefined ? {} : { spentMicroUsd }),
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
      expectedProvider: metadata.provider,
      expectedModel: metadata.model,
      expectedEffort: metadata.effort,
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
    // Frames received and not yet taken by next().
    frames,
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

test('missing settlement acknowledgement is terminal one second after the request deadline', async () => {
  const ctx = await setup();
  try {
    ctx.evaluate('1', { budgetMs: 300 });
    await ctx.next('result');
    await delay(900);
    // Still inside deadline + 1 s: native may yet settle or retire it.
    assert.equal(ctx.broker.gate.terminal, null);
    await delay(700);
    await terminal(ctx.broker);
    assert.equal(ctx.broker.gate.terminal, 'deadline');
    assert.equal(ctx.calls.length, 1);
  } finally {
    await ctx.close();
  }
});

test('an expired settlement up to one second after the request deadline continues the run', async () => {
  // Reviewer's probe: budget 300 ms, result at about 250 ms, `expired` 1050 ms later.
  const ctx = await setup({
    request: async () => {
      await delay(250);
      return { value, elapsedMs: 250 };
    },
  });
  try {
    ctx.evaluate('1', { budgetMs: 300 });
    await ctx.next('result');
    await delay(1050);
    ctx.settle('1', 'expired');
    await ctx.broker.gate.waitIdle();
    assert.equal(ctx.broker.gate.terminal, null);
    assert.equal(ctx.broker.evaluationSummary.verdicts.expired, 1);
  } finally {
    await ctx.close();
  }
});

test('evaluation summary distinguishes evaluates seen, dispatches spent and retirement before dispatch', async () => {
  let release;
  let n = 0;
  const ctx = await setup({
    request: (req) => {
      n++;
      if (n > 1) return Promise.resolve({ value, elapsedMs: 1, usage: {} });
      // The first call settles only after an explicit release, after abort.
      return new Promise((_, reject) =>
        req.signal.addEventListener('abort', () => {
          release = () =>
            reject(Object.assign(new Error('f'), { category: 'cancelled' }));
        }),
      );
    },
  });
  try {
    ctx.evaluate('1', { budgetMs: 30 });
    assert.equal((await ctx.next('failed')).requestId, '1');
    // Queued behind the settling first request; retired before dispatch.
    ctx.evaluate('2', { budgetMs: 30 });
    assert.equal((await ctx.next('failed')).requestId, '2');
    release();
    ctx.evaluate('3');
    assert.equal((await ctx.next('result')).requestId, '3');
    ctx.settle('3');
    await ctx.broker.gate.waitIdle();
    const s = ctx.broker.evaluationSummary;
    assert.equal(s.requested, 3);
    assert.equal(s.dispatched, 2);
    assert.equal(s.retiredBeforeDispatch, 1);
    assert.equal(ctx.broker.gate.dispatchesUsed, 2);
  } finally {
    await ctx.close();
  }
});

test('an adapter deadline that cannot outlast a request budget and its settlement is refused', async () => {
  for (const deadlineMs of [undefined, 100, 11000]) {
    await assert.rejects(
      openLabBroker({
        sourceSessionMode: 'legacy-fixture',
        provider: {
          metadata: {
            provider: 'codex',
            model: 'gpt-6.1-sol',
            effort: 'medium',
            deadlineMs,
          },
          request: async () => ({ value }),
          close: async () => {},
        },
        maxCalls: 1,
      }),
      { category: 'protocol' },
    );
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
      sourceSessionMode: 'legacy-fixture',
      provider: {
        metadata: {
          provider: 'codex',
          model: 'gpt-6.1-sol',
          effort: 'medium',
          deadlineMs: 30000,
        },
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

for (const mode of [
  'missing',
  'mismatch',
  'duplicate',
  'noncanonical',
  'zero',
]) {
  test(`strict source join refuses ${mode} expectation before dispatch`, async () => {
    const ctx = await setup({ hello: false, sourceSessionMode: 'required' });
    try {
      if (mode === 'duplicate') {
        ctx.broker.expectSourceSession('7');
        assert.throws(() => ctx.broker.expectSourceSession('7'));
      } else if (mode === 'noncanonical' || mode === 'zero') {
        assert.throws(() =>
          ctx.broker.expectSourceSession(mode === 'zero' ? '0' : '07'),
        );
      } else {
        if (mode === 'mismatch') ctx.broker.expectSourceSession('8');
        ctx.greet();
      }
      await terminal(ctx.broker);
      assert.equal(ctx.calls.length, 0);
    } finally {
      await ctx.close();
    }
  });
}
test('strict expectation joins authenticated hello and returned calibration session', async () => {
  const ctx = await setup({ hello: false, sourceSessionMode: 'required' });
  try {
    ctx.broker.expectSourceSession('7');
    ctx.greet();
    await ctx.next('ready');
    await ctx.broker.ready;
    const calibrated = ctx.broker.calibrateClock();
    const probe = await ctx.next('clock_probe');
    ctx.send('clock_sample', {
      probeId: probe.probeId,
      nativeSessionElapsedMs: 100,
    });
    assert.equal((await calibrated).sessionId, '7');
    assert.equal(ctx.calls.length, 0);
    assert.throws(() => ctx.broker.expectSourceSession('7'));
    await terminal(ctx.broker);
  } finally {
    await ctx.close();
  }
});
test('clock sample from a replacement session is terminal before inference', async () => {
  const ctx = await setup({ hello: false, sourceSessionMode: 'required' });
  try {
    ctx.broker.expectSourceSession('7');
    ctx.greet();
    await ctx.next('ready');
    await ctx.broker.ready;
    const calibrated = ctx.broker.calibrateClock();
    const failed = assert.rejects(calibrated);
    const probe = await ctx.next('clock_probe');
    ctx.send('clock_sample', {
      sessionId: '8',
      probeId: probe.probeId,
      nativeSessionElapsedMs: 100,
    });
    await failed;
    await terminal(ctx.broker);
    assert.equal(ctx.calls.length, 0);
  } finally {
    await ctx.close();
  }
});

const DIAGNOSTIC_KEYS = [
  'connectionAccepted',
  'helloAuthenticated',
  'clockProbeSent',
  'clockSampleReceived',
  'calibrated',
  'cause',
  'terminal',
];
function assertContentFree(ctx, diagnostics) {
  assert.deepEqual(Object.keys(diagnostics), DIAGNOSTIC_KEYS);
  const serialized = JSON.stringify(diagnostics);
  for (const secret of [
    ctx.descriptor.nonce,
    ctx.descriptor.socketPath,
    ctx.broker.descriptorPath,
    dirname(ctx.broker.descriptorPath),
  ])
    assert.equal(serialized.includes(secret), false);
}

test('a symlinked temporary root yields a canonical descriptor whose socket is its lexical sibling', async () => {
  const real = realpathSync(mkdtempSync(join(tmpdir(), 'tq-root-')));
  const holder = realpathSync(mkdtempSync(join(tmpdir(), 'tq-alias-')));
  const alias = join(holder, 'root');
  symlinkSync(real, alias);
  const original = process.env.TMPDIR;
  let ctx;
  try {
    process.env.TMPDIR = alias;
    assert.equal(tmpdir(), alias);
    assert.notEqual(alias, real);
    ctx = await setup();
    const { descriptorPath } = ctx.broker;
    // The launcher hands native this canonical path; native then requires the
    // socket's parent to equal the descriptor's parent without resolving links.
    assert.equal(realpathSync(descriptorPath), descriptorPath);
    assert.equal(dirname(descriptorPath).startsWith(real + '/'), true);
    assert.equal(
      dirname(ctx.descriptor.socketPath),
      dirname(realpathSync(descriptorPath)),
    );
    assert.equal(ctx.broker.startupDiagnostics.calibrated, true);
  } finally {
    if (original === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = original;
    await ctx?.close();
    rmSync(holder, { recursive: true, force: true });
    rmSync(real, { recursive: true, force: true });
  }
});

test('startup diagnostics stay empty until a peer connects and report a normal close as closed', async () => {
  const broker = await openLabBroker({
    sourceSessionMode: 'legacy-fixture',
    provider: {
      metadata: {
        provider: 'codex',
        model: 'gpt-6.1-sol',
        effort: 'medium',
        deadlineMs: 30000,
      },
      request: async () => ({ value }),
      close: async () => {},
    },
    maxCalls: 1,
  });
  assert.deepEqual(
    { ...broker.startupDiagnostics },
    {
      connectionAccepted: false,
      helloAuthenticated: false,
      clockProbeSent: false,
      clockSampleReceived: false,
      calibrated: false,
      cause: null,
      terminal: null,
    },
  );
  await broker.close();
  assert.equal(broker.startupDiagnostics.cause, null);
  assert.equal(broker.startupDiagnostics.terminal, 'closed');
  assert.equal(broker.startupDiagnostics.connectionAccepted, false);
});

test('a rejected hello keeps its first cause through later close with zero dispatches', async () => {
  const ctx = await setup({ hello: false });
  try {
    ctx.greet({ nonce: 'f'.repeat(64) });
    await terminal(ctx.broker);
    await assert.rejects(ctx.broker.ready);
  } finally {
    await ctx.close();
  }
  const diagnostics = ctx.broker.startupDiagnostics;
  assert.equal(diagnostics.connectionAccepted, true);
  assert.equal(diagnostics.helloAuthenticated, false);
  assert.equal(diagnostics.cause, 'hello-rejected');
  assert.equal(diagnostics.terminal, 'protocol');
  assert.equal(ctx.calls.length, 0);
  assertContentFree(ctx, diagnostics);
});

test('a peer that disconnects before hello is distinguished from a rejected hello', async () => {
  const ctx = await setup({ hello: false });
  try {
    ctx.socket.end();
    await terminal(ctx.broker);
  } finally {
    await ctx.close();
  }
  assert.equal(ctx.broker.startupDiagnostics.cause, 'closed-before-hello');
  assert.equal(ctx.broker.startupDiagnostics.helloAuthenticated, false);
  assertContentFree(ctx, ctx.broker.startupDiagnostics);
});

test('an unanswered clock probe reports a calibration deadline after authentication', async () => {
  const ctx = await setup({ armed: false });
  try {
    const calibration = ctx.broker.calibrateClock();
    await ctx.next('clock_probe');
    await assert.rejects(calibration, { category: 'deadline' });
    await terminal(ctx.broker);
  } finally {
    await ctx.close();
  }
  const diagnostics = ctx.broker.startupDiagnostics;
  assert.equal(diagnostics.helloAuthenticated, true);
  assert.equal(diagnostics.clockProbeSent, true);
  assert.equal(diagnostics.clockSampleReceived, false);
  assert.equal(diagnostics.calibrated, false);
  assert.equal(diagnostics.cause, 'clock-deadline');
  assert.equal(diagnostics.terminal, 'deadline');
  assert.equal(ctx.calls.length, 0);
  assertContentFree(ctx, diagnostics);
});

test('an invalid clock sample is a rejected frame, not a timeout', async () => {
  const ctx = await setup({ armed: false });
  try {
    const calibration = ctx.broker.calibrateClock();
    const probe = await ctx.next('clock_probe');
    ctx.send('clock_sample', {
      probeId: probe.probeId,
      nativeSessionElapsedMs: -1,
    });
    await assert.rejects(calibration);
    await terminal(ctx.broker);
  } finally {
    await ctx.close();
  }
  assert.equal(ctx.broker.startupDiagnostics.cause, 'frame-rejected');
  assert.equal(ctx.broker.startupDiagnostics.terminal, 'protocol');
  assert.equal(ctx.broker.startupDiagnostics.calibrated, false);
});

test('failures after calibration do not appear as startup causes', async () => {
  const ctx = await setup();
  try {
    ctx.socket.end();
    await terminal(ctx.broker);
  } finally {
    await ctx.close();
  }
  assert.equal(ctx.broker.startupDiagnostics.calibrated, true);
  assert.equal(ctx.broker.startupDiagnostics.cause, null);
  assert.equal(ctx.broker.startupDiagnostics.terminal, 'protocol');
});

test('a calibration rejected for combined uncertainty is not reported as calibrated', async () => {
  const ctx = await setup({ armed: false });
  try {
    ctx.broker.acknowledgePlaybackStart({
      monotonicMs: performance.now(),
      uncertaintyMs: 100,
    });
    const calibration = ctx.broker.calibrateClock();
    const probe = await ctx.next('clock_probe');
    await delay(2);
    ctx.send('clock_sample', {
      probeId: probe.probeId,
      nativeSessionElapsedMs: 1000,
    });
    await assert.rejects(calibration);
    await terminal(ctx.broker);
  } finally {
    await ctx.close();
  }
  const diagnostics = ctx.broker.startupDiagnostics;
  assert.equal(diagnostics.clockSampleReceived, true);
  assert.equal(diagnostics.calibrated, false);
  assert.equal(diagnostics.cause, 'clock-rejected');
  assert.equal(ctx.calls.length, 0);
});

const fictionalProvider = () => ({
  metadata: {
    provider: 'codex',
    model: 'gpt-6.1-sol',
    effort: 'medium',
    deadlineMs: 30000,
  },
  request: async () => ({ value }),
  close: async () => {},
});
// Runs one broker opening with a substitute temporary root and working
// directory, restoring both before the caller inspects leftovers.
async function openWithRoot(root, cwd) {
  const original = process.env.TMPDIR;
  const previous = process.cwd();
  try {
    process.chdir(cwd);
    process.env.TMPDIR = root;
    return await openLabBroker({ provider: fictionalProvider(), maxCalls: 1 });
  } finally {
    process.chdir(previous);
    if (original === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = original;
  }
}

test('a relative temporary root is refused and leaves no run directory', async () => {
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'tq-rel-')));
  try {
    // Short names keep the socket path within the platform limit, so only the
    // relative-root rule can refuse this opening.
    mkdirSync(join(outside, 'r'));
    mkdirSync(join(outside, 'w'));
    // Relative to the working directory, this root is outside it.
    await assert.rejects(openWithRoot('../r', join(outside, 'w')), {
      category: 'protocol',
    });
    assert.deepEqual(readdirSync(join(outside, 'r')), []);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test('a temporary root inside the checkout named like ..cache is refused', async () => {
  const checkout = realpathSync(fileURLToPath(new URL('../', import.meta.url)));
  const inside = mkdtempSync(join(checkout, '..tq-cache-'));
  try {
    await assert.rejects(openWithRoot(inside, checkout), {
      category: 'protocol',
    });
    assert.deepEqual(readdirSync(inside), []);
  } finally {
    rmSync(inside, { recursive: true, force: true });
  }
});

test('a failed run-directory permission change removes the canonical directory', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tq-chmod-')));
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'tq-chmod-cwd-')));
  const original = fsPromises.chmod;
  fsPromises.chmod = async (path, mode) => {
    if (basename(String(path)).startsWith('tq-lab-'))
      throw Object.assign(new Error('fictional chmod failure'), {
        code: 'EPERM',
      });
    return original(path, mode);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(openWithRoot(root, cwd), { category: 'protocol' });
    assert.deepEqual(readdirSync(root), []);
  } finally {
    fsPromises.chmod = original;
    syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

// Per-request deadline continuation (wire change in the native lab PR).
const abortable = (req, category = 'cancelled') =>
  new Promise((_, reject) => {
    const settle = () =>
      reject(Object.assign(new Error('fictional'), { category }));
    if (req.signal?.aborted) settle();
    else req.signal?.addEventListener('abort', settle, { once: true });
  });
function slowThenQuick(category) {
  let n = 0;
  return async (req) => {
    n++;
    if (n === 1) return abortable(req, category);
    return { value, elapsedMs: 1, usage: {} };
  };
}

test('a broker lease deadline fails only that request and the next request is evaluated', async () => {
  const ctx = await setup({ request: slowThenQuick() });
  try {
    ctx.evaluate('1', { budgetMs: 50 });
    const failed = await ctx.next('failed');
    assert.deepEqual(
      [failed.requestId, failed.contextRevision, failed.code],
      ['1', '1', 'deadline'],
    );
    assert.equal(ctx.broker.gate.terminal, null);
    ctx.evaluate('2');
    const result = await ctx.next('result');
    assert.equal(result.requestId, '2');
    ctx.settle('2');
    await ctx.broker.gate.waitIdle();
    assert.equal(ctx.broker.gate.terminal, null);
    assert.equal(ctx.broker.gate.dispatchesUsed, 2);
    const summary = ctx.broker.evaluationSummary;
    assert.equal(summary.deadlineByBroker, 1);
    assert.equal(summary.deadlineByNative, 0);
    assert.equal(summary.resultsSent, 1);
    assert.equal(summary.resultActions.quiet, 1);
    assert.equal(summary.verdicts.current, 1);
  } finally {
    await ctx.close();
  }
});

test('a native deadline cancel retires the running request without a reply and keeps the run', async () => {
  const ctx = await setup({ request: slowThenQuick() });
  try {
    ctx.evaluate('1');
    for (let n = 0; n < 100 && ctx.calls.length < 1; n++) await delay(5);
    ctx.send('cancel', {
      requestId: '1',
      contextRevision: '1',
      reason: 'deadline',
    });
    ctx.evaluate('2');
    const result = await ctx.next('result');
    assert.equal(result.requestId, '2');
    ctx.settle('2');
    await ctx.broker.gate.waitIdle();
    await assert.rejects(ctx.next('failed'));
    assert.equal(ctx.broker.gate.terminal, null);
    assert.equal(ctx.broker.evaluationSummary.deadlineByNative, 1);
  } finally {
    await ctx.close();
  }
});

test('a native deadline cancel while awaiting settlement retires that request', async () => {
  const ctx = await setup();
  try {
    ctx.evaluate('1');
    await ctx.next('result');
    ctx.send('cancel', {
      requestId: '1',
      contextRevision: '1',
      reason: 'deadline',
    });
    ctx.evaluate('2');
    assert.equal((await ctx.next('result')).requestId, '2');
    ctx.settle('2');
    await ctx.broker.gate.waitIdle();
    assert.equal(ctx.broker.gate.terminal, null);
    assert.equal(ctx.broker.evaluationSummary.resultsSent, 2);
  } finally {
    await ctx.close();
  }
});

test('an expired settlement verdict is recorded and does not end the run', async () => {
  const ctx = await setup();
  try {
    ctx.evaluate('1');
    await ctx.next('result');
    ctx.settle('1', 'expired');
    await ctx.broker.gate.waitIdle();
    assert.equal(ctx.broker.gate.terminal, null);
    assert.equal(ctx.broker.evaluationSummary.verdicts.expired, 1);
  } finally {
    await ctx.close();
  }
});

test('a late native deadline cancel for a request the broker already failed is ignored', async () => {
  const ctx = await setup({ request: slowThenQuick() });
  try {
    ctx.evaluate('1', { budgetMs: 50 });
    await ctx.next('failed');
    ctx.send('cancel', {
      requestId: '1',
      contextRevision: '1',
      reason: 'deadline',
    });
    ctx.evaluate('2');
    assert.equal((await ctx.next('result')).requestId, '2');
    ctx.settle('2');
    await ctx.broker.gate.waitIdle();
    assert.equal(ctx.broker.gate.terminal, null);
  } finally {
    await ctx.close();
  }
});

test('a deadline cancel for an unknown request or without identity is terminal', async () => {
  for (const fields of [
    { requestId: '9', contextRevision: '9', reason: 'deadline' },
    { reason: 'deadline' },
  ]) {
    const ctx = await setup({ request: slowThenQuick() });
    try {
      ctx.evaluate('1');
      ctx.send('cancel', fields);
      await terminal(ctx.broker);
      assert.equal(ctx.broker.gate.terminal, 'protocol');
    } finally {
      await ctx.close();
    }
  }
});

test('unconfirmed provider cleanup after a request deadline stays terminal', async () => {
  const ctx = await setup({ request: slowThenQuick('cleanup') });
  try {
    ctx.evaluate('1', { budgetMs: 50 });
    await terminal(ctx.broker);
    assert.notEqual(ctx.broker.gate.terminal, null);
  } finally {
    await ctx.close().catch(() => {});
  }
});

test('repeated request deadlines still end the run at the dispatch cap', async () => {
  const ctx = await setup({
    maxCalls: 2,
    request: (req) => abortable(req),
  });
  try {
    for (const id of ['1', '2']) {
      ctx.evaluate(id, { budgetMs: 30 });
      assert.equal((await ctx.next('failed')).code, 'deadline');
      await ctx.broker.gate.waitIdle();
    }
    assert.equal(ctx.broker.gate.terminal, null);
    ctx.evaluate('3');
    assert.equal((await ctx.next('failed')).code, 'dispatch_limit');
    await terminal(ctx.broker);
    assert.equal(ctx.broker.gate.dispatchesUsed, 2);
  } finally {
    await ctx.close();
  }
});

test('a temporary root inside the checkout is refused even when started from another directory', async () => {
  const checkout = realpathSync(fileURLToPath(new URL('../', import.meta.url)));
  const inside = mkdtempSync(join(checkout, 'tq-inside-'));
  const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'tq-cwd-')));
  try {
    await assert.rejects(openWithRoot(inside, elsewhere), {
      category: 'protocol',
    });
    assert.deepEqual(readdirSync(inside), []);
  } finally {
    rmSync(inside, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

const apiMetadata = {
  provider: 'anthropic-api',
  model: 'claude-opus-5-5',
  effort: 'low',
  deadlineMs: 30000,
  spendCapMicroUsd: 1_000_000,
};

test('the API route declares request budgeting and its spend cap at ready; the CLI route does not', async () => {
  const api = await setup({
    hello: false,
    metadata: apiMetadata,
    spentMicroUsd: 0,
  });
  try {
    api.greet();
    const ready = await api.next('ready');
    assert.equal(ready.dispatchBudgetKind, 'apiRequests');
    assert.equal(ready.spendCapMicroUsd, 1_000_000);
    assert.equal(ready.spendUsedMicroUsd, 0);
  } finally {
    await api.close();
  }
  const cli = await setup({ hello: false });
  try {
    cli.greet();
    const ready = await cli.next('ready');
    assert.equal(ready.dispatchBudgetKind, 'cliDispatchAttempts');
    assert.equal(Object.hasOwn(ready, 'spendCapMicroUsd'), false);
    assert.equal(Object.hasOwn(ready, 'spendUsedMicroUsd'), false);
  } finally {
    await cli.close();
  }
});

test('an API provider without a spend cap, or a CLI provider with one, is refused', async () => {
  for (const metadata of [
    { ...apiMetadata, spendCapMicroUsd: undefined },
    {
      provider: 'codex',
      model: 'gpt-6.1-sol',
      effort: 'medium',
      deadlineMs: 30000,
      spendCapMicroUsd: 1,
    },
  ])
    await assert.rejects(
      openLabBroker({
        sourceSessionMode: 'legacy-fixture',
        provider: {
          metadata,
          request: async () => ({}),
          close: async () => {},
        },
        maxCalls: 1,
      }),
      { category: 'protocol' },
    );
});

test('a provider refusal is a request-scoped failed refusal and the next request is evaluated', async () => {
  let n = 0;
  const ctx = await setup({
    metadata: apiMetadata,
    spentMicroUsd: 0,
    request: async () => {
      n++;
      if (n === 1)
        throw Object.assign(new Error('fictional'), { category: 'refusal' });
      return { value, elapsedMs: 1, usage: {} };
    },
  });
  try {
    ctx.evaluate('1');
    const failed = await ctx.next('failed');
    assert.deepEqual([failed.requestId, failed.code], ['1', 'refusal']);
    assert.equal(ctx.broker.gate.terminal, null);
    ctx.evaluate('2');
    assert.equal((await ctx.next('result')).requestId, '2');
    ctx.settle('2');
    await ctx.broker.gate.waitIdle();
    assert.equal(ctx.broker.gate.terminal, null);
    assert.equal(ctx.broker.evaluationSummary.refusals, 1);
    assert.equal(ctx.broker.gate.dispatchesUsed, 2);
  } finally {
    await ctx.close();
  }
});

test('an API reply at its output bound is a request-scoped failed output_limit and the next request is evaluated', async () => {
  let n = 0;
  const ctx = await setup({
    metadata: apiMetadata,
    spentMicroUsd: 0,
    request: async () => {
      n++;
      if (n === 1)
        throw Object.assign(new Error('fictional'), {
          category: 'output-limit',
        });
      return { value, elapsedMs: 1, usage: {} };
    },
  });
  try {
    ctx.evaluate('1');
    const failed = await ctx.next('failed');
    assert.deepEqual([failed.requestId, failed.code], ['1', 'output_limit']);
    assert.equal(ctx.broker.gate.terminal, null);
    ctx.evaluate('2');
    assert.equal((await ctx.next('result')).requestId, '2');
    ctx.settle('2');
    await ctx.broker.gate.waitIdle();
    assert.equal(ctx.broker.evaluationSummary.outputLimits, 1);
    assert.equal(ctx.broker.gate.dispatchesUsed, 2);
  } finally {
    await ctx.close();
  }
});

test('on a subscription route an output limit still ends the run', async () => {
  const ctx = await setup({
    request: async () => {
      throw Object.assign(new Error('fictional'), {
        category: 'output-limit',
      });
    },
  });
  try {
    ctx.evaluate('1');
    const failed = await ctx.next('failed');
    assert.notEqual(failed.code, 'output_limit');
    await terminal(ctx.broker);
    assert.equal(ctx.broker.evaluationSummary.outputLimits, 0);
  } finally {
    await ctx.close();
  }
});

// Native (#341) treats `failed` code refusal as request-scoped only when it
// names the active request, and as terminal otherwise. The broker therefore
// sends it exactly once, with the active request's ids, and never for a
// request it has already retired.
test('a refusal frame names the active request exactly; a late refusal after retirement sends nothing', async () => {
  let n = 0;
  const ctx = await setup({
    metadata: apiMetadata,
    spentMicroUsd: 0,
    request: async ({ signal }) => {
      n++;
      if (n === 1)
        throw Object.assign(new Error('fictional'), { category: 'refusal' });
      if (n === 2)
        // Outlives its budget, then reports a refusal after retirement.
        return new Promise((_, reject) =>
          signal.addEventListener(
            'abort',
            () =>
              setTimeout(
                () =>
                  reject(
                    Object.assign(new Error('fictional'), {
                      category: 'refusal',
                    }),
                  ),
                20,
              ),
            { once: true },
          ),
        );
      return { value, elapsedMs: 1, usage: {} };
    },
  });
  try {
    ctx.evaluate('1');
    const refusal = await ctx.next('failed');
    assert.deepEqual(Object.keys(refusal).sort(), [
      'code',
      'contextRevision',
      'requestId',
      'runId',
      'schema',
      'sessionId',
      'type',
    ]);
    assert.deepEqual(
      [refusal.requestId, refusal.contextRevision, refusal.code],
      ['1', '1', 'refusal'],
    );
    ctx.evaluate('2', { budgetMs: 50 });
    const deadline = await ctx.next('failed');
    assert.deepEqual([deadline.requestId, deadline.code], ['2', 'deadline']);
    await delay(100);
    ctx.evaluate('3');
    assert.equal((await ctx.next('result')).requestId, '3');
    ctx.settle('3');
    await ctx.broker.gate.waitIdle();
    // No second failed frame for request 2, so native never sees an
    // unmatched refusal.
    assert.equal(ctx.frames.filter((f) => f.type === 'failed').length, 0);
    assert.equal(ctx.broker.gate.terminal, null);
    assert.equal(ctx.broker.evaluationSummary.refusals, 1);
  } finally {
    await ctx.close();
  }
});

test('a spend-cap usage limit ends the run with failed usage_limit', async () => {
  const ctx = await setup({
    metadata: apiMetadata,
    spentMicroUsd: 0,
    request: async () => {
      throw Object.assign(new Error('fictional'), { category: 'usage-limit' });
    },
  });
  try {
    ctx.evaluate('1');
    assert.equal((await ctx.next('failed')).code, 'usage_limit');
    await terminal(ctx.broker);
    assert.equal(ctx.broker.gate.terminal, 'usage-limit');
  } finally {
    await ctx.close();
  }
});
