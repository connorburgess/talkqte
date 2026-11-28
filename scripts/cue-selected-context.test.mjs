import { createConnection } from 'node:net';
import { readFile } from 'node:fs/promises';
import { openLabBroker } from './cue-lab-broker.mjs';
import { openLabProvider } from './cue-lab-provider.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { openAnthropicLab } from './cue-lab-anthropic.mjs';
import { worstCaseMicroUsd } from './cue-lab-anthropic-core.mjs';
import { selectedSnapshotInput } from './cue-selected-snapshot.mjs';
import {
  SELECTED_CONTEXT,
  SELECTED_FRAME,
  SELECTED_INPUT,
  SELECTED_PROMPT,
  selectedIdentity,
  selectedSystemPrompt,
  buildSelectedContextParams,
  selectedPriorContextInput,
  selectedPriorContextReply,
} from './cue-selected-context.mjs';
import { createHash } from 'node:crypto';
const model = 'claude-opus-5-5';
const fixture = JSON.parse(
  readFileSync(
    new URL('./fixtures/selected-snapshot-input.json', import.meta.url),
  ),
);
const input = (notes = true) => ({
  ...structuredClone(fixture),
  inputContract: SELECTED_INPUT,
  ...(!notes ? { priorNotes: [] } : {}),
});

test('v2 zero-note control uses exactly the same selected prompt/schema; v1 remains nonempty', () => {
  const withNotes = buildSelectedContextParams(model, input());
  const without = buildSelectedContextParams(model, input(false));
  assert.deepEqual(withNotes.system, without.system);
  assert.deepEqual(withNotes.output_config, without.output_config);
  assert.equal(
    createHash('sha256').update(selectedSystemPrompt()).digest('hex'),
    SELECTED_PROMPT,
  );
  assert.equal(JSON.parse(without.messages[0].content).priorNotes.length, 0);
  assert.throws(() => selectedSnapshotInput({ ...fixture, priorNotes: [] }));
  assert.throws(() => selectedPriorContextInput({ ...input(), events: [] }));
  const legacy = { events: input().events, existingCue: null };
  assert.ok(
    worstCaseMicroUsd(model, input(), SELECTED_CONTEXT) >
      worstCaseMicroUsd(model, legacy),
  );
});

test('v2 control/u64/namespace/citation policy rejects exact malformed selection', () => {
  const corpus = JSON.parse(
    readFileSync(
      new URL('./fixtures/selected-snapshot-strings.json', import.meta.url),
    ),
  );
  for (const value of corpus.negative)
    for (const field of ['text', 'title']) {
      const bad = input();
      bad.priorNotes[0][field] = value;
      assert.throws(() => selectedPriorContextInput(bad));
    }
  for (const revision of [
    '0',
    '1',
    '9007199254740993',
    '18446744073709551615',
  ]) {
    const valid = input();
    valid.priorNotes[0].snapshotRevision = revision;
    assert.equal(
      JSON.parse(selectedPriorContextInput(valid)).priorNotes[0]
        .snapshotRevision,
      revision,
    );
  }
  for (const revision of ['01', '-1', '1e3', '18446744073709551616']) {
    const bad = input();
    bad.priorNotes[0].snapshotRevision = revision;
    assert.throws(() => selectedPriorContextInput(bad));
  }
  const ids = [input().events[0].id, input().priorNotes[0].id];
  assert.deepEqual(
    selectedPriorContextReply(
      { action: 'show', cue: 'Will review finish in time?', sourceIds: ids },
      input(),
    ).sourceIds,
    ids,
  );
  assert.throws(() =>
    selectedPriorContextReply(
      {
        action: 'show',
        cue: 'Will review finish in time?',
        sourceIds: [ids[1]],
      },
      input(),
    ),
  );
  assert.throws(() =>
    selectedPriorContextReply(
      { action: 'quiet', cue: null, sourceIds: ['prior:file:unselected'] },
      input(),
    ),
  );
});

// Real production parent -> worker -> SDK -> loopback fake stream. No real key/network.
async function api() {
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const params = JSON.parse(body);
    requests.push(params);
    const parsed = JSON.parse(params.messages[0].content);
    const value = {
      action: 'quiet',
      cue: null,
      sourceIds: [parsed.events[0].id],
    };
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
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    requests,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(r);
      }),
  };
}
const open = (fake, contextPolicy) =>
  openAnthropicLab({
    model,
    effort: 'low',
    maxCalls: 4,
    deadlineMs: 5000,
    contextPolicy,
    environment: { PATH: process.env.PATH },
    offline: { baseUrl: fake.baseUrl, key: 'sk-ant-api-offline-selected' },
  });

test('actual fixed-mode worker sends exact selected snapshots or empty control to fake streamed API', async () => {
  const fake = await api();
  const session = await open(fake, SELECTED_CONTEXT);
  try {
    assert.deepEqual(
      Object.fromEntries(
        Object.keys(selectedIdentity()).map((k) => [k, session.metadata[k]]),
      ),
      selectedIdentity(),
    );
    for (const notes of [false, true]) {
      const current = input(notes);
      const result = await session.request({
        role: 'cue-evaluator',
        input: current,
      });
      assert.equal(result.value.action, 'quiet');
      const params = fake.requests.at(-1);
      assert.equal(params.system[0].text, selectedSystemPrompt());
      assert.deepEqual(JSON.parse(params.messages[0].content), current);
    }
    assert.equal(session.calls, 2);
    const malformed = input();
    malformed.priorNotes[0].text = 'Bad\rtext';
    await assert.rejects(
      session.request({ role: 'cue-evaluator', input: malformed }),
      { category: 'invalid-request' },
    );
    assert.equal(fake.requests.length, 2);
    assert.equal(session.calls, 2);
  } finally {
    await session.close();
    await fake.close();
  }
});

test('legacy production provider refuses selected payload before fake API dispatch', async () => {
  const fake = await api();
  const session = await open(fake, 'fresh-only');
  try {
    await assert.rejects(
      session.request({ role: 'cue-evaluator', input: input() }),
      { category: 'invalid-request' },
    );
    assert.equal(fake.requests.length, 0);
    assert.equal(session.calls, 0);
  } finally {
    await session.close();
    await fake.close();
  }
});

test('selected broker/provider require trusted matching API identity before any dispatch', async () => {
  let calls = 0;
  const metadata = {
    provider: 'anthropic-api',
    model,
    effort: 'low',
    deadlineMs: 30000,
    spendCapMicroUsd: 1000000,
    ...selectedIdentity(),
  };
  const provider = {
    metadata,
    request: async () => {
      calls++;
      throw new Error('must not dispatch');
    },
    close: async () => {},
  };
  await assert.rejects(openLabBroker({ provider, maxCalls: 1 }));
  for (const field of Object.keys(selectedIdentity())) {
    await assert.rejects(
      openLabBroker({
        provider: { ...provider, metadata: { ...metadata, [field]: 'wrong' } },
        maxCalls: 1,
        contextPolicy: SELECTED_CONTEXT,
      }),
    );
  }
  await assert.rejects(
    openLabProvider({ provider: 'codex', contextPolicy: SELECTED_CONTEXT }),
  );
  assert.equal(calls, 0);
});

async function selectedPeer(rawValue) {
  const captured = [];
  const providerErrors = [];
  const provider = await openLabProvider({
    provider: 'anthropic-api',
    model,
    effort: 'low',
    maxCalls: 3,
    deadlineMs: 30000,
    contextPolicy: SELECTED_CONTEXT,
    execution: 'offline-stand-in',
    environment: { PATH: process.env.PATH },
    openers: {
      'anthropic-api': async () => ({
        request: async (request) => {
          captured.push(request);
          return { value: rawValue, elapsedMs: 1 };
        },
        close: async () => {},
      }),
    },
  });
  const broker = await openLabBroker({
    provider: {
      metadata: provider.metadata,
      close: () => provider.close(),
      request: async (request) => {
        try {
          return await provider.request(request);
        } catch (error) {
          providerErrors.push(error.category);
          throw error;
        }
      },
    },
    maxCalls: 3,
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
    captured,
    providerErrors,
    next,
    send,
    close: async () => {
      socket.destroy();
      await broker.close();
    },
  };
}

test('actual provider raw validation preserves broker occupied-show and asked-withdraw settlement', async () => {
  const ids = [input().events[0].id, input().priorNotes[0].id];
  for (const [kind, action, counter] of [
    ['ordinary', 'show', 'showWithCue'],
    ['asked', 'withdraw', 'askedKept'],
  ]) {
    const raw = {
      action,
      cue: action === 'show' ? 'Will review finish in time?' : null,
      sourceIds: ids,
    };
    const peer = await selectedPeer(raw);
    try {
      const current = input();
      current.existingCue = {
        text: 'Will review finish in time?',
        sourceIds: [ids[0]],
        ...(kind === 'asked' ? { kind: 'asked' } : {}),
      };
      peer.send('evaluate', {
        requestId: '1',
        contextRevision: '1',
        budgetMs: 5000,
        input: current,
      });
      const settled = await peer.next('result');
      assert.deepEqual(settled.value, {
        action: 'quiet',
        cue: null,
        sourceIds: ids,
      });
      assert.equal(peer.captured.length, 1);
      assert.equal(peer.broker.evaluationSummary[counter], 1);
      assert.equal(peer.broker.evaluationSummary.invalidReplies, 0);
      peer.send('settled', {
        requestId: '1',
        contextRevision: '1',
        verdict: 'current',
      });
    } finally {
      await peer.close();
    }
  }
});

test('actual provider rejects malformed union IDs before broker settlement can hide them', async () => {
  for (const [kind, action] of [
    ['ordinary', 'show'],
    ['asked', 'withdraw'],
  ]) {
    const peer = await selectedPeer({
      action,
      cue: action === 'show' ? 'Will review finish in time?' : null,
      sourceIds: ['prior:file:unselected'],
    });
    try {
      const current = input();
      current.existingCue = {
        text: 'Will review finish in time?',
        sourceIds: [current.events[0].id],
        ...(kind === 'asked' ? { kind: 'asked' } : {}),
      };
      peer.send('evaluate', {
        requestId: '1',
        contextRevision: '1',
        budgetMs: 5000,
        input: current,
      });
      // Existing gate maps the provider's raw-schema failure to unavailable.
      assert.equal((await peer.next('terminal')).reason, 'unavailable');
      assert.deepEqual(peer.providerErrors, ['schema']);
      assert.equal(peer.broker.evaluationSummary.resultsSent, 0);
      assert.equal(peer.broker.evaluationSummary.showWithCue, 0);
      assert.equal(peer.broker.evaluationSummary.askedKept, 0);
      assert.equal(peer.captured.length, 1);
    } finally {
      await peer.close();
    }
  }
});

test('selected-prior-v2 preserves sessionMode:"interview" end-to-end across shared fixture, params, spend, receipts, and fake API worker', async () => {
  const sharedInterviewFixture = JSON.parse(
    readFileSync(
      new URL(
        './fixtures/selected-context-interview-input.json',
        import.meta.url,
      ),
    ),
  );
  assert.deepEqual(
    JSON.parse(selectedPriorContextInput(sharedInterviewFixture)),
    sharedInterviewFixture,
  );
  for (const notes of [false, true]) {
    const meeting = input(notes);
    const interview = { ...meeting, sessionMode: 'interview' };
    const params = buildSelectedContextParams(model, interview);
    assert.equal(params.system[0].text, selectedSystemPrompt());
    const wire = JSON.parse(params.messages[0].content);
    assert.equal(wire.sessionMode, 'interview');
    assert.equal(wire.priorNotes.length, notes ? 1 : 0);
    assert.ok(
      worstCaseMicroUsd(model, interview, SELECTED_CONTEXT) >=
        worstCaseMicroUsd(model, meeting, SELECTED_CONTEXT),
    );
  }

  const fake = await api();
  const session = await open(fake, SELECTED_CONTEXT);
  try {
    assert.equal(session.metadata.promptSha256, SELECTED_PROMPT);
    for (const current of [
      sharedInterviewFixture,
      { ...input(false), sessionMode: 'interview' },
    ]) {
      const result = await session.request({
        role: 'cue-evaluator',
        input: current,
      });
      assert.equal(result.value.action, 'quiet');
      const sent = fake.requests.at(-1);
      assert.equal(sent.system[0].text, selectedSystemPrompt());
      const wire = JSON.parse(sent.messages[0].content);
      assert.equal(wire.sessionMode, 'interview');
      assert.deepEqual(wire, current);
    }
    // Invalid sessionMode fails before any API dispatch (never silently stripped).
    await assert.rejects(
      session.request({
        role: 'cue-evaluator',
        input: { ...input(), sessionMode: 'meeting' },
      }),
      { category: 'invalid-request' },
    );
    assert.equal(fake.requests.length, 2);
  } finally {
    await session.close();
    await fake.close();
  }
});
