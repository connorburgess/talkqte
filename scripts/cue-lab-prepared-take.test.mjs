import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { createConnection } from 'node:net';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import {
  createPreparedTake,
  createLabPlaybackSession,
} from './cue-lab-prepared-take.mjs';

const deferred = () => {
  let resolve;
  const promise = new Promise((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
};
const media = {
  fictional: true,
  path: '/fictional/prepared.mp4',
  sha256: 'a'.repeat(64),
  durationMs: 102480,
};
function fixture({
  badIdentity = false,
  listening = true,
  recorderFails = false,
  missingAck = false,
  duplicateAck = false,
  ackUncertainty = 0,
  release = true,
  providerCleanup,
  releaseWait,
  playbackWait,
  body,
  bodyFails = false,
  bodyCleanupFails = false,
  missingDisplayLabel = false,
  sourceCloseFails = false,
  initialSignal,
  strictSource = false,
  preallocatedRunId,
  playerRetirement = false,
  playerRetirementFails = false,
  playerRetirementUnconfirmed = false,
} = {}) {
  const selectedMedia = body
    ? {
        ...media,
        purpose: 'neutral-calibration',
        displayLabel: 'Fictional neutral calibration',
      }
    : media;
  const trace = [],
    events = new EventEmitter(),
    child = new EventEmitter();
  const activePlay = deferred(),
    providerClosing = deferred();
  let launchOptions,
    socket,
    stopped = false,
    playerHandler,
    recorderHandler,
    sourceHandler;
  const counts = {
    nativeStop: 0,
    playerStop: 0,
    recorderStop: 0,
    providerClose: 0,
    launcherClose: 0,
    unsubscribe: 0,
    bodyClose: 0,
    requests: 0,
  };
  Object.assign(child, {
    pid: 44001,
    spawnfile: '/fictional/Fixture.app/Contents/MacOS/talkqte',
    exitCode: null,
    signalCode: null,
    kill(name) {
      assert.equal(name, 'SIGUSR2');
      counts.nativeStop++;
      trace.push('native-stop');
      Promise.resolve(releaseWait).then(() => {
        if (!release) return;
        trace.push('native-released');
        for (const step of ['latched', 'stopping', 'released'])
          launchOptions.onTiming({
            event: 'dev_stop',
            run_id: launchOptions.environment.TALKQTE_DEV_LAB_RUN_ID,
            step,
          });
        socket?.destroy();
      });
      return true;
    },
  });
  const launcher = {
    executable: child.spawnfile,
    launch(options) {
      launchOptions = options;
      trace.push('launch');
      queueMicrotask(() =>
        options.onTiming({
          event: 'dev_stop',
          run_id: options.environment.TALKQTE_DEV_LAB_RUN_ID,
          step: 'armed',
        }),
      );
      return child;
    },
    close() {
      counts.launcherClose++;
    },
  };
  async function authenticate() {
    const d = JSON.parse(
      await readFile(
        launchOptions.environment.TALKQTE_DEV_LAB_DESCRIPTOR,
        'utf8',
      ),
    );
    socket = createConnection({ path: d.socketPath });
    socket.on('error', () => {});
    await new Promise((yes, no) => {
      socket.once('connect', yes);
      socket.once('error', no);
    });
    const frame = (type, extra = {}) => ({
      schema: 'talkqte.lab.v1',
      type,
      runId: d.runId,
      sessionId: '1',
      ...extra,
    });
    let partial = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      partial += chunk;
      for (let end; (end = partial.indexOf('\n')) !== -1;) {
        const value = JSON.parse(partial.slice(0, end));
        partial = partial.slice(end + 1);
        if (value.type === 'clock_probe') {
          trace.push('clock-sample');
          socket.write(
            JSON.stringify(
              frame('clock_sample', {
                probeId: value.probeId,
                nativeSessionElapsedMs: 10,
              }),
            ) + '\n',
          );
        }
      }
    });
    trace.push('authenticate');
    socket.write(
      JSON.stringify(
        frame('hello', {
          nonce: d.nonce,
          expectedProvider: 'codex',
          expectedModel: 'gpt-6.1-sol',
          expectedEffort: 'medium',
        }),
      ) + '\n',
    );
  }
  const player = {
    subscribe(handler) {
      playerHandler = handler;
      return () => {
        counts.unsubscribe++;
        handler();
      };
    },
    async prepare() {
      trace.push('prepare');
      return { ...media, ...(badIdentity ? { sha256: 'b'.repeat(64) } : {}) };
    },
    async play({ onStarted, signal }) {
      trace.push('play');
      signal.addEventListener('abort', () => activePlay.resolve(), {
        once: true,
      });
      const ack = {
        sha256: media.sha256,
        monotonicMs: performance.now(),
        uncertaintyMs: ackUncertainty,
        ...(body && !missingDisplayLabel
          ? { displayLabel: selectedMedia.displayLabel }
          : {}),
      };
      if (!missingAck) onStarted(ack);
      if (duplicateAck) onStarted(ack);
      await authenticate();
      if (playbackWait) await Promise.race([playbackWait, activePlay.promise]);
      else await delay(10);
      trace.push('play-ended');
      return { completed: !signal.aborted, sha256: media.sha256 };
    },
    async stop() {
      counts.playerStop++;
      stopped = true;
      trace.push('player-stop');
      activePlay.resolve();
      playerHandler();
      return { stopped: true };
    },
  };
  if (playerRetirement)
    player.close = async ({ nativeReleased }) => {
      assert.equal(nativeReleased, true);
      trace.push('player-retired');
      assert.ok(trace.includes('native-released'));
      assert.ok(trace.includes('recorder-stop'));
      if (playerRetirementFails) throw Error('fictional retirement failure');
      return { closed: !playerRetirementUnconfirmed };
    };
  let recorderRunId, sourceRunId;
  const recorder = {
    subscribe(handler) {
      recorderHandler = handler;
      return () => {
        counts.unsubscribe++;
        handler();
      };
    },
    async start({ runId }) {
      recorderRunId = runId;
      trace.push('record-ready');
      if (recorderFails) throw Error('private recorder failure');
      return { started: true };
    },
    async stop() {
      counts.recorderStop++;
      trace.push('recorder-stop');
      recorderHandler();
      return { stopped: true };
    },
  };
  const adaptedBody = body
    ? Object.assign(
        async (options) => {
          trace.push('body');
          assert.equal(options.run.phase, 'ready');
          assert.equal(
            options.runId,
            launchOptions.environment.TALKQTE_DEV_LAB_RUN_ID,
          );
          assert.equal(options.runId, sourceRunId);
          assert.equal(options.runId, recorderRunId);
          if (preallocatedRunId) assert.equal(options.runId, preallocatedRunId);
          else assert.match(options.runId, /^[a-f0-9-]{36}$/);
          if (bodyFails) throw Error('private body failure');
          return body(options);
        },
        {
          async close() {
            counts.bodyClose++;
            if (bodyCleanupFails) throw Error('private body cleanup');
          },
        },
      )
    : undefined;
  const options = {
    ...(preallocatedRunId ? { runId: preallocatedRunId } : {}),
    launcher,
    stopAfterS: 110,
    media: selectedMedia,
    player,
    recorder,
    source: {
      ...(strictSource
        ? {
            mode: 'v1',
            subscribe(fn) {
              sourceHandler = fn;
              return () => (sourceHandler = () => {});
            },
          }
        : {}),
      close() {
        trace.push('source-close');
        if (sourceCloseFails) throw Error('private observer cleanup');
      },
      async waitListening({ runId }) {
        sourceRunId = runId;
        trace.push('listening');
        return {
          runId,
          listening,
          ...(strictSource ? { version: 1, sessionId: '1' } : {}),
        };
      },
    },
    settings: {
      provider: 'codex',
      model: 'gpt-6.1-sol',
      effort: 'medium',
      maxCalls: 3,
      deadlineMs: 100,
      execution: 'offline-stand-in',
      environment: {},
      openers: {
        codex: async () => ({
          async request() {
            counts.requests++;
            return { value: { quiet: true }, elapsedMs: 1 };
          },
          async close() {
            counts.providerClose++;
            trace.push('provider-close');
            providerClosing.resolve();
            if (providerCleanup) await providerCleanup;
          },
        }),
      },
    },
    processEvents: events,
    startupMs: 100,
    releaseMs: 100,
    armingMs: 50,
    nativeReleaseMs: 50,
    takeMs: 300,
    signal: initialSignal,
    ...(adaptedBody ? { body: adaptedBody } : {}),
  };
  const take = adaptedBody
    ? createLabPlaybackSession(options)
    : createPreparedTake(options);
  return {
    take,
    trace,
    counts,
    events,
    providerClosing: providerClosing.promise,
    failSource: () => sourceHandler?.({ type: 'failed' }),
    failPlayer: () => playerHandler(),
    failRecorder: () => recorderHandler(),
    disconnect: () => socket?.destroy(),
    nativeExit: () => {
      child.exitCode = 1;
      child.emit('exit', 1, null);
      socket?.destroy();
    },
    get stopped() {
      return stopped;
    },
  };
}

test('prepared speech starts after Listening and recorder readiness but before lazy authentication/calibration', async () => {
  const f = fixture();
  const result = await f.take.done;
  assert.equal(result.completed, true);
  assert.equal(result.nativeReleased, true);
  const index = (x) => f.trace.indexOf(x);
  assert.ok(index('listening') < index('record-ready'));
  assert.ok(index('record-ready') < index('play'));
  assert.ok(index('play') < index('authenticate'));
  assert.ok(index('authenticate') < index('clock-sample'));
  assert.equal(f.take.phase, 'completed');
  assert.deepEqual(f.counts, {
    nativeStop: 1,
    playerStop: 1,
    recorderStop: 1,
    providerClose: 1,
    launcherClose: 1,
    unsubscribe: 2,
    bodyClose: 0,
    requests: 0,
  });
});

for (const [name, options] of Object.entries({
  'changed media identity': { badIdentity: true },
  'not actually Listening': { listening: false },
  'recorder startup failure': { recorderFails: true },
  'missing actual playback acknowledgement': { missingAck: true },
  'duplicate playback acknowledgement': { duplicateAck: true },
  'unbounded playback clock uncertainty': { ackUncertainty: 101 },
}))
  test(name + ' stops without claiming completion', async () => {
    const f = fixture(options);
    await assert.rejects(f.take.done);
    assert.notEqual(f.take.phase, 'completed');
    assert.equal(f.counts.requests, 0);
    for (const k of [
      'playerStop',
      'recorderStop',
      'providerClose',
      'launcherClose',
    ])
      assert.equal(f.counts[k], 1, k);
    if (
      options.badIdentity ||
      options.listening === false ||
      options.recorderFails
    )
      assert.equal(f.trace.includes('play'), false);
  });

test('Stop is idempotent during speech and holds completion until provider and actual release settle', async () => {
  const cleanup = deferred(),
    released = deferred(),
    playback = deferred();
  const f = fixture({
    providerCleanup: cleanup.promise,
    releaseWait: released.promise,
    playbackWait: playback.promise,
  });
  while (!f.trace.includes('clock-sample')) await delay(1);
  const stop = f.take.stop();
  assert.equal(f.take.stop(), stop);
  let settled = false;
  stop.catch(() => {
    settled = true;
  });
  await f.providerClosing;
  await delay(5);
  assert.equal(settled, false);
  released.resolve();
  await delay(5);
  assert.equal(settled, false);
  cleanup.resolve();
  await assert.rejects(stop);
  await assert.rejects(f.take.done);
  assert.equal(f.counts.nativeStop, 1);
  assert.equal(f.counts.providerClose, 1);
  assert.equal(f.counts.recorderStop, 1);
  assert.equal(f.stopped, true);
});

test('missing actual native release remains failed cleanup', async () => {
  const f = fixture({ release: false });
  await assert.rejects(f.take.done, (e) => e.category === 'cleanup');
  assert.equal(f.take.phase, 'failed-cleanup');
  assert.equal(f.counts.nativeStop, 1);
});

test('host Stop before authentication closes owned adapters without playback', async () => {
  const f = fixture();
  f.events.emit('SIGINT');
  await assert.rejects(f.take.done);
  assert.equal(f.trace.includes('play'), false);
  assert.equal(f.counts.requests, 0);
  assert.equal(f.counts.playerStop, 1);
  assert.equal(f.counts.recorderStop, 1);
});

test('shared body starts only after prefix completion and actual calibrated readiness; cleanup once', async () => {
  const f = fixture({
    body: async ({ run }) => {
      await run.gate.waitIdle();
    },
  });
  await f.take.done;
  assert.ok(f.trace.indexOf('body') > f.trace.indexOf('play-ended'));
  assert.ok(f.trace.indexOf('body') > f.trace.indexOf('clock-sample'));
  assert.equal(f.counts.bodyClose, 1);
});

for (const options of [{ bodyFails: true }, { bodyCleanupFails: true }])
  test(
    'body failure propagates through shared cleanup ' + JSON.stringify(options),
    async () => {
      const f = fixture({ body: async () => {}, ...options });
      await assert.rejects(f.take.done);
      assert.equal(f.counts.bodyClose, 1);
      assert.equal(f.counts.nativeStop, 1);
      assert.equal(f.counts.providerClose, 1);
      assert.equal(f.counts.playerStop, 1);
    },
  );

test('prepared take refuses an adaptive body and a nonfictional media identity', () => {
  assert.throws(() => createPreparedTake({ body: () => {} }));
  assert.throws(() =>
    createPreparedTake({ media: { ...media, fictional: false } }),
  );
});

test('source observer cleanup failure cannot skip launcher observation cleanup', async () => {
  const f = fixture({ sourceCloseFails: true });
  await assert.rejects(f.take.done, (error) => error.category === 'cleanup');
  assert.equal(f.take.phase, 'failed-cleanup');
  assert.equal(f.counts.launcherClose, 1);
  assert.equal(f.counts.providerClose, 1);
  assert.equal(f.trace.filter((e) => e === 'source-close').length, 1);
});

test('body bootstrap rejects narrative or unlabelled media before subscribing or constructing a run', () => {
  let subscriptions = 0;
  const subscribe = () => {
    subscriptions++;
    return () => {};
  };
  const body = Object.assign(async () => {}, { close: async () => {} });
  const options = {
    launcher: { executable: '/fictional/app', launch() {}, close() {} },
    source: { waitListening() {} },
    player: { prepare() {}, play() {}, stop() {}, subscribe },
    recorder: { start() {}, stop() {}, subscribe },
    stopAfterS: 110,
    body,
  };
  for (const edit of [
    { purpose: 'narrative', displayLabel: 'Narrative' },
    { purpose: 'neutral-calibration' },
    { purpose: 'neutral-calibration', displayLabel: '   ' },
    { purpose: 'neutral-calibration', displayLabel: 'x'.repeat(121) },
    { purpose: 'neutral-calibration', displayLabel: 'hidden\nlabel' },
  ])
    assert.throws(() =>
      createLabPlaybackSession({ ...options, media: { ...media, ...edit } }),
    );
  assert.equal(subscriptions, 0);
});

test('body never starts without actual player acknowledgement of the displayed bootstrap label', async () => {
  let bodies = 0;
  const f = fixture({
    body: async () => {
      bodies++;
    },
    missingDisplayLabel: true,
  });
  await assert.rejects(f.take.done);
  assert.equal(bodies, 0);
  assert.equal(f.counts.playerStop, 1);
});

for (const event of [
  'host-stop',
  'native-process-exit',
  'broker-disconnect',
  'player-failure',
  'recorder-failure',
])
  test(`post-ready ${event} aborts body and cleans every owner once`, async () => {
    const entered = deferred();
    const f = fixture({
      body: async ({ signal }) => {
        entered.resolve();
        await new Promise((resolve) =>
          signal.addEventListener('abort', resolve, { once: true }),
        );
      },
    });
    await entered.promise;
    if (event === 'host-stop') f.events.emit('SIGINT');
    else if (event === 'native-process-exit') f.nativeExit();
    else if (event === 'broker-disconnect') f.disconnect();
    else if (event === 'player-failure') f.failPlayer();
    else f.failRecorder();
    await assert.rejects(f.take.done);
    assert.equal(f.counts.nativeStop, event === 'native-process-exit' ? 0 : 1);
    if (event === 'native-process-exit')
      assert.equal(f.take.phase, 'failed-cleanup');
    assert.equal(f.counts.bodyClose, 1);
    assert.equal(f.counts.providerClose, 1);
    assert.equal(f.counts.playerStop, 1);
    assert.equal(f.counts.recorderStop, 1);
  });

test('strict source session binds before lazy hello and retirement after readiness aborts all owners', async () => {
  const holding = deferred();
  const entered = deferred();
  const f = fixture({
    strictSource: true,
    body: async () => {
      entered.resolve();
      await holding.promise;
    },
  });
  await entered.promise;
  f.failSource();
  holding.resolve();
  await assert.rejects(f.take.done);
  assert.equal(f.counts.nativeStop, 1);
  assert.equal(f.counts.providerClose, 1);
  assert.equal(f.counts.playerStop, 1);
  assert.equal(f.counts.recorderStop, 1);
  assert.equal(f.counts.requests, 0);
});
test('strict prepared source allows saved playback before hello/calibration without deadlock', async () => {
  const f = fixture({ strictSource: true });
  await f.take.done;
  assert.ok(f.trace.indexOf('listening') < f.trace.indexOf('play'));
  assert.ok(f.trace.indexOf('record-ready') < f.trace.indexOf('play'));
  assert.equal(f.counts.nativeStop, 1);
  assert.equal(f.counts.providerClose, 1);
});

test('prepared model path preserves preallocated player run identity and retires only after native release/recorder', async () => {
  const f = fixture({
    preallocatedRunId: 'owned-shared-run',
    strictSource: true,
    playerRetirement: true,
    body: async () => {},
  });
  await f.take.done;
  assert.ok(
    f.trace.indexOf('native-released') < f.trace.indexOf('player-retired'),
  );
  assert.ok(
    f.trace.indexOf('recorder-stop') < f.trace.indexOf('player-retired'),
  );
});
test('prepared model path cannot retire player without confirmed native release', async () => {
  const f = fixture({
    strictSource: true,
    playerRetirement: true,
    release: false,
  });
  await assert.rejects(f.take.done, { category: 'cleanup' });
  assert.equal(f.trace.includes('player-retired'), false);
});
test('prepared model path preserves player retirement failure as failed cleanup', async () => {
  const f = fixture({
    strictSource: true,
    playerRetirement: true,
    playerRetirementFails: true,
  });
  await assert.rejects(f.take.done, { category: 'cleanup' });
  assert.equal(f.take.phase, 'failed-cleanup');
});

test('prepared player retirement without explicit closed proof remains failed cleanup', async () => {
  const f = fixture({
    strictSource: true,
    playerRetirement: true,
    playerRetirementUnconfirmed: true,
  });
  await assert.rejects(f.take.done, { category: 'cleanup' });
});
