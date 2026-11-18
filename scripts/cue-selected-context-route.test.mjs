import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { readFile, access } from 'node:fs/promises';
import { openLabBroker } from './cue-lab-broker.mjs';
import { openLabProvider } from './cue-lab-provider.mjs';
import { openAnthropicLab } from './cue-lab-anthropic.mjs';
import {
  SELECTED_CONTEXT,
  SELECTED_FRAME,
  selectedIdentity,
  selectedSystemPrompt,
} from './cue-selected-context.mjs';
const model = 'claude-opus-5-5';
const fixture = JSON.parse(
  await readFile(
    new URL('./fixtures/selected-context-input.json', import.meta.url),
    'utf8',
  ),
);

// All HTTP is loopback, all credentials fictional. The broker and API worker are real.
// The socket peer uses the shared native wire fixture; native UI consent, capture,
// model usefulness and native freshness/application are not established by this test.
async function fakeApi(respond) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const params = JSON.parse(body);
    requests.push(params);
    const value = await respond(JSON.parse(params.messages[0].content));
    const events = [
      {
        type: 'message_start',
        message: {
          id: 'msg_fictional',
          type: 'message',
          role: 'assistant',
          model,
          content: [],
          usage: { input_tokens: 30, output_tokens: 1 },
        },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: JSON.stringify(value) },
      },
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 10 },
      },
      { type: 'message_stop' },
    ];
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(
      events
        .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
        .join(''),
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    requests,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}

async function route(fake) {
  let opens = 0;
  const provider = await openLabProvider({
    provider: 'anthropic-api',
    model,
    effort: 'low',
    maxCalls: 4,
    deadlineMs: 30000,
    contextPolicy: SELECTED_CONTEXT,
    execution: 'offline-stand-in',
    environment: { PATH: process.env.PATH },
    deferOpen: true,
    openers: {
      'anthropic-api': async (options) => {
        opens++;
        return openAnthropicLab({
          ...options,
          offline: { baseUrl: fake.baseUrl, key: 'sk-ant-api-offline-route' },
        });
      },
    },
  });
  assert.equal(provider.opened, false);
  assert.equal(opens, 0);
  assert.equal(fake.requests.length, 0);
  // Synthetic approval boundary: this exercises routing, not native UI consent.
  await provider.open();
  assert.equal(opens, 1);
  assert.equal(fake.requests.length, 0);
  const broker = await openLabBroker({
    provider,
    maxCalls: 4,
    contextPolicy: SELECTED_CONTEXT,
  });
  broker.expectSourceSession('7');
  const descriptor = JSON.parse(await readFile(broker.descriptorPath, 'utf8'));
  const socket = createConnection({ path: descriptor.socketPath });
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  const queued = [],
    waiters = [];
  let partial = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    partial += chunk;
    for (let end; (end = partial.indexOf('\n')) !== -1;) {
      const frame = JSON.parse(partial.slice(0, end));
      partial = partial.slice(end + 1);
      const waiter = waiters.findIndex((w) => w.type === frame.type);
      if (waiter < 0) queued.push(frame);
      else waiters.splice(waiter, 1)[0].resolve(frame);
    }
  });
  const next = (type) => {
    const found = queued.findIndex((f) => f.type === type);
    if (found >= 0) return Promise.resolve(queued.splice(found, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`missing fictional ${type}`)),
        2500,
      );
      waiters.push({
        type,
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
      });
    });
  };
  const send = (type, fields = {}) =>
    socket.write(
      JSON.stringify({
        schema: SELECTED_FRAME,
        type,
        runId: descriptor.runId,
        sessionId: '7',
        ...fields,
      }) + '\n',
    );
  send('hello', {
    nonce: descriptor.nonce,
    expectedProvider: 'anthropic-api',
    expectedModel: model,
    expectedEffort: 'low',
    ...selectedIdentity(),
  });
  await next('ready');
  await broker.ready;
  const calibration = broker.calibrateClock();
  const probe = await next('clock_probe');
  send('clock_sample', {
    probeId: probe.probeId,
    nativeSessionElapsedMs: 1000,
  });
  await calibration;
  broker.acknowledgePlaybackStart({
    monotonicMs: performance.now(),
    uncertaintyMs: 0,
  });
  return {
    broker,
    provider,
    socket,
    next,
    send,
    close: async () => {
      socket.destroy();
      await broker.close();
    },
  };
}

const evaluate = (peer, current, id = '1') =>
  peer.send('evaluate', {
    requestId: id,
    contextRevision: id,
    budgetMs: 5000,
    input: current,
  });
const settle = (peer, id = '1') =>
  peer.send('settled', {
    requestId: id,
    contextRevision: id,
    verdict: 'current',
  });

test('selected native-wire fixture traverses real broker/provider/worker/SDK for both frozen-input arms', async () => {
  const fake = await fakeApi((current) => ({
    action: 'quiet',
    cue: null,
    sourceIds: [current.events[0].id],
  }));
  const peer = await route(fake).catch(async (error) => {
    await fake.close();
    throw error;
  });
  try {
    for (const [index, notes] of [[], fixture.priorNotes].entries()) {
      const current = { ...structuredClone(fixture), priorNotes: notes };
      const id = String(index + 1);
      evaluate(peer, current, id);
      const frame = await peer.next('result');
      assert.deepEqual(frame.value, {
        action: 'quiet',
        cue: null,
        sourceIds: [current.events[0].id],
      });
      settle(peer, id);
      await peer.broker.gate.waitIdle();
      const params = fake.requests[index];
      assert.deepEqual(JSON.parse(params.messages[0].content), current);
      assert.equal(params.system[0].text, selectedSystemPrompt());
    }
    assert.deepEqual(fake.requests[0].system, fake.requests[1].system);
    assert.deepEqual(
      fake.requests[0].output_config,
      fake.requests[1].output_config,
    );
    assert.equal(peer.provider.calls, 2);
    assert.equal(peer.broker.evaluationSummary.resultsSent, 2);
    peer.send('cancel', { reason: 'stop' });
    assert.equal((await peer.next('terminal')).reason, 'protocol');
  } finally {
    await peer.close();
    await fake.close();
  }
  assert.equal(fake.requests.length, 2);
});

for (const [kind, action, counter] of [
  ['ordinary', 'show', 'showWithCue'],
  ['asked', 'withdraw', 'askedKept'],
]) {
  test(`real selected worker preserves broker ${kind}/${action} settlement and union citations`, async () => {
    const ids = [fixture.events[0].id, fixture.priorNotes[0].id];
    const fake = await fakeApi(() => ({
      action,
      cue: action === 'show' ? 'Will review finish in time?' : null,
      sourceIds: ids,
    }));
    const peer = await route(fake).catch(async (error) => {
      await fake.close();
      throw error;
    });
    try {
      const current = structuredClone(fixture);
      current.existingCue = {
        text: 'Will review finish in time?',
        sourceIds: [ids[0]],
        ...(kind === 'asked' ? { kind } : {}),
      };
      evaluate(peer, current);
      assert.deepEqual((await peer.next('result')).value, {
        action: 'quiet',
        cue: null,
        sourceIds: ids,
      });
      assert.equal(peer.broker.evaluationSummary[counter], 1);
      assert.equal(peer.broker.evaluationSummary.invalidReplies, 0);
      assert.equal(fake.requests.length, 1);
      settle(peer);
      await peer.broker.gate.waitIdle();
    } finally {
      await peer.close();
      await fake.close();
    }
  });
}

test('real selected worker cannot hide an unselected citation through occupied-cue settlement', async () => {
  const fake = await fakeApi(() => ({
    action: 'show',
    cue: 'Will review finish in time?',
    sourceIds: ['prior:file:unselected'],
  }));
  const peer = await route(fake).catch(async (error) => {
    await fake.close();
    throw error;
  });
  try {
    const current = structuredClone(fixture);
    current.existingCue = {
      text: 'Will review finish in time?',
      sourceIds: [current.events[0].id],
    };
    evaluate(peer, current);
    assert.equal((await peer.next('terminal')).reason, 'unavailable');
    assert.equal(peer.broker.evaluationSummary.resultsSent, 0);
    assert.equal(peer.broker.evaluationSummary.showWithCue, 0);
    assert.equal(fake.requests.length, 1);
  } finally {
    await peer.close();
    await fake.close();
  }
  assert.equal(fake.requests.length, 1);
});

test('Stop during real worker HTTP request suppresses late result and retires descriptor without retry', async () => {
  let release, entered;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  const requested = new Promise((resolve) => {
    entered = resolve;
  });
  const fake = await fakeApi(async (current) => {
    entered();
    await blocked;
    return {
      action: 'show',
      cue: 'Will review finish in time?',
      sourceIds: [current.events[0].id, current.priorNotes[0].id],
    };
  });
  let peer;
  try {
    peer = await route(fake);
    evaluate(peer, structuredClone(fixture));
    await requested;
    peer.send('cancel', { reason: 'stop' });
    // The public terminal code intentionally redacts cancellation as protocol.
    assert.equal((await peer.next('terminal')).reason, 'protocol');
    release();
    await peer.close();
    assert.equal(peer.broker.gate.terminal, 'cancelled');
    assert.equal(peer.broker.evaluationSummary.resultsSent, 0);
    assert.equal(peer.provider.calls, 1);
    assert.equal(fake.requests.length, 1);
    await assert.rejects(access(peer.broker.descriptorPath), {
      code: 'ENOENT',
    });
  } finally {
    release();
    await peer?.close();
    await fake.close();
  }
});
