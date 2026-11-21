import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createConnection } from 'node:net';
import { readFile } from 'node:fs/promises';
import { createLabPlaybackSession } from './cue-lab-prepared-take.mjs';
import { labelLabBootstrapMedia } from './cue-lab-media.mjs';
import { fictionalTestMedia } from './fixtures/lab-test-media.mjs';
import { test, after } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createAdaptiveBody } from './cue-lab-adaptive-take.mjs';
import { createLabOperationGate } from './cue-lab-operation-gate.mjs';
import { briefsFile, loadFixtureBriefs } from './cue-dialogue-briefs.mjs';

const briefs = await loadFixtureBriefs();
const brief = briefs[0];
const folder = await mkdtemp(join(tmpdir(), 'talkqte-adaptive-'));
after(() => rm(folder, { recursive: true, force: true }));
const frozen = briefsFile(briefs, { source: 'fixture' });
const file = join(folder, 'briefs.json');
await writeFile(file, frozen.text);
const scenario = { file, sha256: frozen.sha256, id: brief.id, branch: 'A' };
const hash = (s) => createHash('sha256').update(s).digest('hex');
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const tick = () => new Promise((r) => setImmediate(r));

function fixture(options = {}) {
  let time = 2000,
    castCount = 0,
    voiceClosed = 0,
    providerClosed = 0;
  let cues = [];
  const trace = [],
    calls = [],
    controller = new AbortController();
  const provider = {
    async request(request) {
      const view = JSON.parse(request.input);
      calls.push({ role: request.role, view });
      trace.push(request.role);
      if (options.request) return options.request(request, view, ++castCount);
      if (request.role === 'cue-evaluator') return { value: null };
      if (request.role === 'listener')
        return {
          value: {
            speak: false,
            text: null,
            card: view.card ? 'ignored' : 'none',
          },
        };
      if (request.role === 'judge')
        return {
          value: {
            verdicts: view.criteria.map((c) => ({
              criterion: c.id,
              met: 'unclear',
              lineIds: ['l1'],
              reason: 'The fictional transcript does not settle it.',
            })),
          },
        };
      return {
        value: {
          speaker: brief.people[0].name,
          text: 'The fictional rollout is ready.',
          next:
            ++castCount < (options.turns ?? 1) ? brief.people[0].name : 'end',
        },
      };
    },
    async close() {
      providerClosed++;
    },
  };
  const gate = createLabOperationGate({
    provider,
    maxCalls: options.globalCap ?? 20,
    signal: controller.signal,
  });
  const voice = {
    async synthesizeLine(input) {
      trace.push('synthesize');
      if (options.voice) return options.voice(input);
      return {
        runId: input.runId,
        lineId: input.lineId,
        speaker: input.speaker,
        path: '/fictional/line.wav',
        textSha256: hash(input.text),
        clipSha256: hash('clip'),
        durationMs: 1000,
        sampleRate: 48000,
        channels: 1,
      };
    },
    async close() {
      voiceClosed++;
    },
  };
  const player = {
    async playLine(input) {
      trace.push('play');
      if (options.play) return options.play(input, setTime);
      time = Math.max(time, input.notBeforeMonotonicMs);
      const start = {
        runId: input.clip.runId,
        lineId: input.clip.lineId,
        clipSha256: input.clip.clipSha256,
        monotonicMs: time,
        uncertaintyMs: 0,
      };
      input.onStarted(start);
      time += 1000;
      trace.push('played');
      return {
        ...start,
        completed: true,
        startedMonotonicMs: start.monotonicMs,
        endedMonotonicMs: time,
        sampleRate: 48000,
        framesPlayed: 48000,
      };
    },
  };
  function setTime(value) {
    time = value;
  }
  const run = {
    gate,
    request: (r) => gate.request(r),
    cuesAt(nowMs) {
      trace.push('cues');
      return structuredClone(cues);
    },
  };
  const body = createAdaptiveBody({
    scenario: { ...scenario, branch: options.branch ?? 'A' },
    clock: {
      now: () => time,
      playbackStart: () => ({ monotonicMs: 1000, uncertaintyMs: 0 }),
    },
    voice,
    player,
    maxCalls: 20,
    briefSource: 'fixture',
    settings: { pauseBeforeMs: 0, interjectEvery: 1 },
    ...options.body,
  });
  return {
    body,
    run,
    gate,
    provider,
    player,
    trace,
    calls,
    controller,
    setTime,
    setCues(value) {
      cues = value;
    },
    get voiceClosed() {
      return voiceClosed;
    },
    get providerClosed() {
      return providerClosed;
    },
    async close() {
      await body.close();
      await gate.close();
    },
  };
}

test('same gate dispatches cast and blind judge once after exact heard playback', async () => {
  const f = fixture();
  try {
    const result = await f.body({
      runId: 'fictional-run',
      run: f.run,
      signal: f.controller.signal,
    });
    assert.equal(result.status, 'completed');
    assert.equal(f.gate.dispatchesUsed, 2);
    assert.deepEqual(
      f.calls.map((c) => c.role),
      ['cast', 'judge'],
    );
    assert.deepEqual(Object.keys(f.calls[1].view).sort(), [
      'criteria',
      'transcript',
    ]);
    assert.equal(
      result.transcript[0].startMs,
      1000,
      'uses actual prefix origin, not body entry',
    );
    assert.equal(result.transcript[0].durationMs, 1000);
    assert.ok(f.trace.indexOf('played') < f.trace.indexOf('judge'));
    assert.equal(f.providerClosed, 0, 'body does not own provider cleanup');
  } finally {
    await f.close();
  }
});

test('listener sees fresh post-settlement cue, silence advances once, queued speech absent', async () => {
  const f = fixture({ turns: 2 });
  const entered = deferred(),
    settle = deferred();
  let evaluator;
  const original = f.run.gate.waitIdle;
  let waits = 0;
  f.run.gate = {
    ...f.gate,
    async waitIdle(options) {
      if (++waits === 2) {
        evaluator = f.gate.run(
          async () => {
            await f.gate.request({ role: 'cue-evaluator', input: '{}' });
            entered.resolve();
            await f.gate.settle(() => settle.promise);
          },
          { role: 'cue-evaluator' },
        );
      }
      return original(options);
    },
  };
  try {
    const work = f.body({
      runId: 'fictional-run',
      run: f.run,
      signal: f.controller.signal,
    });
    await entered.promise;
    assert.equal(f.calls.filter((c) => c.role === 'listener').length, 0);
    f.setCues([
      {
        cueId: 'current',
        text: 'Which fictional rollout?',
        atMs: 1000,
        source: 'runtime',
        decider: 'model',
      },
    ]);
    settle.resolve();
    const result = await work;
    await evaluator;
    assert.deepEqual(
      f.calls.map((c) => c.role),
      ['cast', 'cue-evaluator', 'listener', 'cast', 'judge'],
    );
    const listener = f.calls.find((c) => c.role === 'listener').view;
    assert.equal(listener.card, 'Which fictional rollout?');
    assert.equal(listener.transcript.length, 1);
    assert.equal(result.transcript.length, 2);
  } finally {
    settle.resolve();
    await f.close();
  }
});

test('branch B never reads or sends actual cue observations', async () => {
  const f = fixture({ turns: 2, branch: 'B' });
  f.run.cuesAt = () => {
    throw Error('branch B must not observe cues');
  };
  try {
    await f.body({ runId: 'fictional-run', run: f.run });
    assert.equal(f.calls.find((c) => c.role === 'listener').view.card, null);
  } finally {
    await f.close();
  }
});

for (const kind of [
  'no-start',
  'wrong-id',
  'partial',
  'future-end',
  'short-frames',
  'duplicate-start',
]) {
  test(`rejects ${kind} playback without another generation or judge`, async () => {
    const f = fixture({
      play: async ({ clip, onStarted }, setTime) => {
        const start = {
          runId: clip.runId,
          lineId: clip.lineId,
          clipSha256: clip.clipSha256,
          monotonicMs: 2000,
          uncertaintyMs: 0,
        };
        if (kind !== 'no-start') onStarted(start);
        if (kind === 'duplicate-start') onStarted(start);
        setTime(3000);
        return {
          ...start,
          completed: kind !== 'partial',
          lineId: kind === 'wrong-id' ? 'other' : clip.lineId,
          startedMonotonicMs: 2000,
          endedMonotonicMs: kind === 'future-end' ? 4000 : 3000,
          sampleRate: 48000,
          framesPlayed: kind === 'short-frames' ? 24 : 48000,
        };
      },
    });
    try {
      await assert.rejects(f.body({ runId: 'fictional-run', run: f.run }), {
        category: 'protocol',
      });
      assert.deepEqual(
        f.calls.map((c) => c.role),
        ['cast'],
      );
    } finally {
      await f.close();
    }
  });
}

test('abort discards late synthesis and close retains ownership until it settles', async () => {
  const started = deferred(),
    late = deferred();
  const f = fixture({
    voice: async (input) => {
      started.resolve();
      await late.promise;
      return { runId: input.runId };
    },
  });
  const work = f.body({
    runId: 'fictional-run',
    run: f.run,
    signal: f.controller.signal,
  });
  await started.promise;
  f.controller.abort();
  await assert.rejects(work, { category: 'cancelled' });
  const close = f.body.close();
  assert.equal(close, f.body.close());
  let closed = false;
  close.then(() => {
    closed = true;
  });
  await tick();
  assert.equal(closed, false);
  assert.equal(f.trace.includes('play'), false);
  late.resolve();
  await close;
  assert.equal(f.voiceClosed, 1);
  assert.equal(f.calls.length, 1);
  await f.gate.close();
});

test('initial abort dispatches no role and body cannot be reused after close', async () => {
  const f = fixture();
  f.controller.abort();
  try {
    await assert.rejects(
      f.body({
        runId: 'fictional-run',
        run: f.run,
        signal: f.controller.signal,
      }),
      { category: 'cancelled' },
    );
    assert.equal(f.calls.length, 0);
    await f.body.close();
    await assert.rejects(f.body({ runId: 'fictional-run', run: f.run }), {
      category: 'protocol',
    });
  } finally {
    await f.close();
  }
});

test('global evaluator dispatches consume same cap and are never double counted', async () => {
  const f = fixture({ globalCap: 2 });
  await f.gate.run(
    () => f.gate.request({ role: 'cue-evaluator', input: '{}' }),
    { role: 'cue-evaluator' },
  );
  try {
    await assert.rejects(f.body({ runId: 'fictional-run', run: f.run }), {
      category: 'operation',
    });
    assert.equal(f.gate.dispatchesUsed, 2);
    assert.deepEqual(
      f.calls.map((c) => c.role),
      ['cue-evaluator', 'cast'],
    );
  } finally {
    await f.close();
  }
});

test('step ceiling bounds silence/state transitions', async () => {
  const f = fixture({ turns: 2, body: { maxSteps: 2 } });
  try {
    await assert.rejects(f.body({ runId: 'fictional-run', run: f.run }), {
      category: 'protocol',
    });
    assert.deepEqual(
      f.calls.map((c) => c.role),
      ['cast', 'listener'],
    );
  } finally {
    await f.close();
  }
});

test('Stop during an active line rejects completion and never judges it', async () => {
  const started = deferred(),
    drain = deferred();
  const f = fixture({
    play: async ({ clip, onStarted }) => {
      onStarted({ ...clip, monotonicMs: 2000, uncertaintyMs: 0 });
      started.resolve();
      await drain.promise;
      return {
        completed: true,
        ...clip,
        startedMonotonicMs: 2000,
        endedMonotonicMs: 3000,
        framesPlayed: 48000,
      };
    },
  });
  const work = f.body({
    runId: 'fictional-run',
    run: f.run,
    signal: f.controller.signal,
  });
  await started.promise;
  f.controller.abort();
  await assert.rejects(work, { category: 'cancelled' });
  const closed = f.body.close();
  drain.resolve();
  await closed;
  assert.deepEqual(
    f.calls.map((c) => c.role),
    ['cast'],
  );
  await f.gate.close();
});

test('synthesis deadline aborts its work without fallback or playback', async () => {
  const f = fixture({
    body: { operationMs: 10 },
    voice: ({ signal }) =>
      new Promise((_, reject) =>
        signal.addEventListener(
          'abort',
          () => reject(Error('fixture stopped')),
          { once: true },
        ),
      ),
  });
  try {
    await assert.rejects(f.body({ runId: 'fictional-run', run: f.run }), {
      category: 'deadline',
    });
    assert.equal(f.trace.includes('play'), false);
    assert.deepEqual(
      f.calls.map((c) => c.role),
      ['cast'],
    );
  } finally {
    await f.close();
  }
});

test('foreign clip text is rejected before playback', async () => {
  const f = fixture({
    voice: async (input) => ({
      ...input,
      path: '/fictional/line.wav',
      textSha256: hash('different words'),
      clipSha256: hash('clip'),
      durationMs: 1000,
      sampleRate: 48000,
      channels: 1,
    }),
  });
  try {
    await assert.rejects(f.body({ runId: 'fictional-run', run: f.run }), {
      category: 'protocol',
    });
    assert.equal(f.trace.includes('play'), false);
  } finally {
    await f.close();
  }
});

test('missing actual playback origin cannot be replaced by body entry time', async () => {
  const f = fixture({
    body: { clock: { now: () => 2000, playbackStart: () => null } },
  });
  try {
    await assert.rejects(f.body({ runId: 'fictional-run', run: f.run }), {
      category: 'protocol',
    });
    assert.equal(f.calls.length, 0);
  } finally {
    await f.close();
  }
});

test('voice cleanup failure is retained as failed cleanup', async () => {
  const f = fixture();
  // Adapter closure is validated independently of provider/native cleanup.
  const g = createAdaptiveBody({
    scenario,
    clock: {
      now: () => 0,
      playbackStart: () => ({ monotonicMs: 0, uncertaintyMs: 0 }),
    },
    voice: {
      synthesizeLine() {},
      close() {
        throw Error('private fixture diagnostic');
      },
    },
    player: f.player,
    maxCalls: 1,
  });
  await assert.rejects(g.close(), { category: 'cleanup' });
  await f.close();
});

// In-memory native child and loopback broker client only. No process is spawned
// and no audio, player, app, recorder device or provider is opened.
async function playbackFixture({ abortPrefix = false } = {}) {
  let launch, socket, anchor;
  const prefixStarted = deferred(),
    prefixFinished = deferred();
  const trace = [],
    counts = { nativeStop: 0, playerStop: 0, recorderStop: 0 };
  const child = Object.assign(new EventEmitter(), {
    pid: 45001,
    spawnfile: '/fictional/Player.app/Contents/MacOS/talkqte',
    exitCode: null,
    signalCode: null,
    kill() {
      counts.nativeStop++;
      for (const step of ['latched', 'stopping', 'released'])
        launch.onTiming({
          event: 'dev_stop',
          run_id: launch.environment.TALKQTE_DEV_LAB_RUN_ID,
          step,
        });
      socket?.destroy();
      return true;
    },
  });
  const f = fixture({
    body: {
      scenario: { ...scenario, branch: 'B' },
      clock: { now: () => current, playbackStart: () => anchor },
    },
  });
  let current = 0;
  const basePlay = f.player.playLine;
  f.player.playLine = async (options) => {
    // Existing fake player uses its own simulated clock; keep the injected
    // playback clock on that same domain for actual start/end validation.
    const original = options.onStarted;
    return basePlay({
      ...options,
      onStarted: (value) => {
        current = value.monotonicMs;
        original(value);
      },
    }).then((value) => {
      current = value.endedMonotonicMs;
      return value;
    });
  };
  async function hello() {
    const descriptor = JSON.parse(
      await readFile(launch.environment.TALKQTE_DEV_LAB_DESCRIPTOR, 'utf8'),
    );
    socket = createConnection({ path: descriptor.socketPath });
    socket.on('error', () => {});
    await new Promise((yes, no) => {
      socket.once('connect', yes);
      socket.once('error', no);
    });
    const frame = (type, extra) => ({
      schema: 'talkqte.lab.v1',
      type,
      runId: descriptor.runId,
      sessionId: '1',
      ...extra,
    });
    let partial = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      partial += chunk;
      let end;
      while ((end = partial.indexOf('\n')) !== -1) {
        const value = JSON.parse(partial.slice(0, end));
        partial = partial.slice(end + 1);
        if (value.type === 'clock_probe')
          socket.write(
            JSON.stringify(
              frame('clock_sample', {
                probeId: value.probeId,
                nativeSessionElapsedMs: 10,
              }),
            ) + '\n',
          );
      }
    });
    trace.push('hello');
    socket.write(
      JSON.stringify(
        frame('hello', {
          nonce: descriptor.nonce,
          expectedProvider: 'codex',
          expectedModel: 'gpt-6.1-sol',
          expectedEffort: 'medium',
        }),
      ) + '\n',
    );
  }
  const player = Object.assign(f.player, {
    subscribe: () => () => {},
    async prepare({ media }) {
      return media;
    },
    async play({ media, signal, onStarted }) {
      trace.push('prefix');
      anchor = { monotonicMs: performance.now(), uncertaintyMs: 0 };
      onStarted({
        sha256: media.sha256,
        displayLabel: media.displayLabel,
        ...anchor,
      });
      current = anchor.monotonicMs + 1000;
      f.setTime(current);
      prefixStarted.resolve();
      signal.addEventListener('abort', () => prefixFinished.resolve(), {
        once: true,
      });
      if (!abortPrefix) await hello();
      await prefixFinished.promise;
      return { sha256: media.sha256, completed: !signal.aborted };
    },
    async stop() {
      counts.playerStop++;
      prefixFinished.resolve();
      return { stopped: true };
    },
  });
  const take = createLabPlaybackSession({
    launcher: {
      executable: child.spawnfile,
      launch(options) {
        launch = options;
        queueMicrotask(() =>
          options.onTiming({
            event: 'dev_stop',
            run_id: options.environment.TALKQTE_DEV_LAB_RUN_ID,
            step: 'armed',
          }),
        );
        return child;
      },
      close() {},
    },
    settings: {
      provider: 'codex',
      model: 'gpt-6.1-sol',
      effort: 'medium',
      maxCalls: 10,
      // Current broker requests plus settlement must fit the adapter ceiling.
      // Startup/take test deadlines remain 1000/2000 ms below.
      deadlineMs: 30000,
      execution: 'offline-stand-in',
      environment: {},
      openers: {
        codex: async () => ({
          request: async (request) => ({
            ...(await f.provider.request(request)),
            elapsedMs: 1,
          }),
          close: () => f.provider.close(),
        }),
      },
    },
    stopAfterS: 10,
    media: labelLabBootstrapMedia(
      fictionalTestMedia({ durationMs: 1000 }),
      'Neutral calibration — outside the scenario',
    ),
    source: {
      async waitListening({ runId }) {
        trace.push('Listening');
        return { runId, listening: true };
      },
    },
    recorder: {
      subscribe: () => () => {},
      async start() {
        trace.push('recorder');
        return { started: true };
      },
      async stop() {
        counts.recorderStop++;
        return { stopped: true };
      },
    },
    player,
    body: f.body,
    processEvents: new EventEmitter(),
    startupMs: 1000,
    releaseMs: 500,
    nativeReleaseMs: 200,
    takeMs: 2000,
  });
  return { f, take, trace, counts, prefixStarted, prefixFinished };
}

test('composition starts neutral speech before lazy auth, waits prefix completion before generation', async () => {
  const p = await playbackFixture();
  try {
    await Promise.race([
      p.prefixStarted.promise,
      p.take.done.then(() => {
        throw new Error('take completed before the calibration prefix');
      }),
    ]);
    await tick();
    assert.equal(p.f.calls.length, 0);
    assert.deepEqual(p.trace.slice(0, 3), ['Listening', 'recorder', 'prefix']);
    p.prefixFinished.resolve();
    const result = await p.take.done;
    assert.equal(result.completed, true);
    assert.ok(p.trace.indexOf('prefix') < p.trace.indexOf('hello'));
    assert.deepEqual(
      p.f.calls.map((c) => c.role),
      ['cast', 'judge'],
    );
    assert.equal(p.f.voiceClosed, 1);
    assert.equal(p.f.providerClosed, 1);
    assert.deepEqual(p.counts, {
      nativeStop: 1,
      playerStop: 1,
      recorderStop: 1,
    });
  } finally {
    await p.take.stop().catch(() => {});
    await p.f.gate.close();
  }
});

test('Stop during prefix before authentication closes uninvoked body with zero generation', async () => {
  const p = await playbackFixture({ abortPrefix: true });
  await Promise.race([
    p.prefixStarted.promise,
    p.take.done.then(() => {
      throw new Error('take completed before the calibration prefix');
    }),
  ]);
  const stopping = p.take.stop();
  await assert.rejects(stopping);
  await assert.rejects(p.take.done);
  assert.equal(p.f.calls.length, 0);
  assert.equal(p.f.voiceClosed, 1);
  assert.equal(p.f.providerClosed, 1);
  assert.deepEqual(p.counts, { nativeStop: 1, playerStop: 1, recorderStop: 1 });
  await p.f.gate.close();
});
