import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { createConnection } from 'node:net';
import { readFile, access } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { createLabRun } from './cue-lab-run.mjs';
import { createLabNativeOwner } from './cue-lab-native-owner.mjs';

const deferred = () => {
  let resolve;
  const promise = new Promise((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
};
const request = {
  role: 'cast',
  instructions: 'Only fictional speech.',
  input: {},
  schema: {
    type: 'object',
    properties: { quiet: { type: 'boolean' } },
    required: ['quiet'],
    additionalProperties: false,
  },
};
const bounded = (promise) =>
  Promise.race([
    promise,
    delay(1000).then(() => {
      throw Error('fixture timed out');
    }),
  ]);
function fixture({
  authenticate = true,
  providerRequest,
  cleanup,
  release,
  startWait,
  openerWait,
  nativeOverride,
  startupMs = 500,
  closeFailure = false,
  releaseValue = { released: true },
} = {}) {
  const processEvents = new EventEmitter();
  const nativeEvents = new EventEmitter();
  const entered = deferred();
  const calls = [];
  let opened = 0,
    closed = 0,
    stops = 0,
    starts = 0,
    socket,
    descriptorPath;
  const settings = {
    provider: 'codex',
    model: 'gpt-6.1-sol',
    effort: 'medium',
    maxCalls: 3,
    deadlineMs: 100,
    execution: 'offline-stand-in',
    environment: {},
    openers: {
      codex: async () => {
        opened++;
        if (openerWait) await openerWait;
        return {
          request: async (r) => {
            calls.push(r);
            entered.resolve();
            return providerRequest
              ? providerRequest(r)
              : { value: { quiet: true }, elapsedMs: 1 };
          },
          close: async () => {
            closed++;
            if (closeFailure) throw Error('private cleanup detail');
            if (cleanup) await cleanup;
          },
        };
      },
    },
  };
  const native = {
    subscribe(handler) {
      nativeEvents.on('event', handler);
      return () => nativeEvents.off('event', handler);
    },
    async start({ descriptorPath: path, runId, metadata }) {
      starts++;
      descriptorPath = path;
      assert.equal(nativeEvents.listenerCount('event'), 1);
      assert.equal(processEvents.listenerCount('SIGINT'), 1);
      assert.deepEqual(
        [metadata.provider, metadata.model, metadata.effort],
        ['codex', 'gpt-6.1-sol', 'medium'],
      );
      if (startWait) await startWait;
      if (!authenticate) return;
      const d = JSON.parse(await readFile(path, 'utf8'));
      assert.equal(d.runId, runId);
      socket = createConnection({ path: d.socketPath });
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
          if (value.type === 'clock_probe')
            socket.write(
              JSON.stringify(
                frame('clock_sample', {
                  probeId: value.probeId,
                  nativeSessionElapsedMs: 1000,
                }),
              ) + '\n',
            );
        }
      });
      socket.write(
        JSON.stringify(
          frame('hello', {
            nonce: d.nonce,
            expectedProvider: metadata.provider,
            expectedModel: metadata.model,
            expectedEffort: metadata.effort,
          }),
        ) + '\n',
      );
    },
    async stop() {
      stops++;
      if (release) await release;
      socket?.destroy();
      return releaseValue;
    },
  };
  const run = createLabRun({
    settings,
    native: nativeOverride ?? native,
    processEvents,
    startupMs,
    releaseMs: 30,
  });
  const started = async () => {
    for (let n = 0; n < 100 && !starts; n++) await delay(1);
    assert.equal(starts, 1);
  };
  return {
    run,
    calls,
    entered,
    processEvents,
    nativeEvents,
    started,
    get opened() {
      return opened;
    },
    get closed() {
      return closed;
    },
    get stops() {
      return stops;
    },
    get descriptorPath() {
      return descriptorPath;
    },
  };
}

test('one pinned provider and broker admit no dispatch until native calibration and actual playback acknowledgement', async () => {
  const f = fixture();
  await f.started();
  await delay(10);
  assert.equal(f.calls.length, 0);
  assert.notEqual(f.run.phase, 'ready');
  f.run.acknowledgePlaybackStart({
    monotonicMs: performance.now(),
    uncertaintyMs: 0,
  });
  await bounded(f.run.ready);
  const value = await f.run.gate.run(() => f.run.request(request), {
    role: 'cast',
  });
  assert.deepEqual(value.value, { quiet: true });
  assert.equal(f.run.dispatchesUsed, 1);
  await f.run.close();
  assert.equal(f.opened, 1);
  assert.equal(f.closed, 1);
  assert.equal(f.stops, 1);
  await assert.rejects(access(f.descriptorPath));
  assert.equal(f.nativeEvents.listenerCount('event'), 0);
  assert.equal(f.processEvents.listenerCount('SIGINT'), 0);
});

test('Stop before provider startup constructs no resources or native process', async () => {
  const f = fixture();
  await f.run.stop();
  await assert.rejects(f.run.ready);
  assert.equal(f.opened, 0);
  assert.equal(f.closed, 0);
  assert.equal(f.stops, 0);
  assert.equal(f.run.phase, 'closed');
});

test('Stop during delayed provider construction still closes the single late-created adapter', async () => {
  const open = deferred();
  const f = fixture({ openerWait: open.promise });
  await delay(0);
  const stopping = f.run.stop();
  assert.equal(f.opened, 1);
  assert.equal(f.closed, 0);
  open.resolve();
  await bounded(stopping);
  await assert.rejects(f.run.ready);
  assert.equal(f.closed, 1);
  assert.equal(f.stops, 0);
});

for (const event of [
  'stop-requested',
  'session-ended',
  'process-ended',
  'failed',
])
  test(`native ${event} before authentication aborts startup independently and waits release`, async () => {
    const release = deferred();
    const f = fixture({ authenticate: false, release: release.promise });
    await f.started();
    f.nativeEvents.emit('event', { type: event });
    await assert.rejects(bounded(f.run.ready));
    assert.equal(f.run.dispatchesUsed, 0);
    assert.equal(f.run.phase, 'stopping');
    release.resolve();
    await bounded(f.run.close());
    assert.equal(f.closed, 1);
    assert.equal(f.stops, 1);
    assert.equal(f.run.phase, 'closed');
  });

for (const event of ['SIGINT', 'SIGTERM'])
  test(`host ${event} stops before auth and cannot resume that run`, async () => {
    const f = fixture({ authenticate: false });
    await f.started();
    f.processEvents.emit(event);
    await assert.rejects(bounded(f.run.ready));
    await bounded(f.run.close());
    assert.equal(f.run.dispatchesUsed, 0);
    assert.throws(() => f.run.gate.run(() => {}, { role: 'judge' }));
  });

test('missing native release is failed cleanup even if provider cleanup succeeds', async () => {
  const f = fixture({ authenticate: false, release: new Promise(() => {}) });
  await f.started();
  await assert.rejects(bounded(f.run.stop()), { category: 'cleanup' });
  assert.equal(f.run.phase, 'failed-cleanup');
  assert.equal(f.closed, 1);
});

test('Stop aborts active provider immediately but waits both native release and provider cleanup', async () => {
  const cleanup = deferred(),
    release = deferred();
  let aborted = false;
  const f = fixture({
    cleanup: cleanup.promise,
    release: release.promise,
    providerRequest: ({ signal }) =>
      new Promise((_, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            aborted = true;
            reject(Error('fictional cancellation'));
          },
          { once: true },
        );
      }),
  });
  f.run.acknowledgePlaybackStart({
    monotonicMs: performance.now(),
    uncertaintyMs: 0,
  });
  await bounded(f.run.ready);
  const operation = f.run.gate.run(() => f.run.request(request), {
    role: 'cast',
  });
  const checked = assert.rejects(operation);
  await f.entered.promise;
  const stopping = f.run.stop();
  assert.equal(aborted, true);
  assert.equal(f.run.phase, 'stopping');
  release.resolve();
  cleanup.resolve();
  await bounded(Promise.all([stopping, checked]));
  assert.equal(f.run.phase, 'closed');
  assert.equal(f.closed, 1);
  assert.equal(f.run.dispatchesUsed, 1);
});

test('provider failure stops native owner without waiting for a native notification', async () => {
  const f = fixture({
    providerRequest: async () => {
      throw Error('private fixture provider');
    },
  });
  f.run.acknowledgePlaybackStart({
    monotonicMs: performance.now(),
    uncertaintyMs: 0,
  });
  await bounded(f.run.ready);
  await assert.rejects(
    f.run.gate.run(() => f.run.request(request), { role: 'cast' }),
  );
  await bounded(f.run.close());
  assert.equal(f.stops, 1);
  assert.equal(f.closed, 1);
});

test('an early role dispatch fails closed instead of running without clock/playback evidence', async () => {
  const f = fixture({ authenticate: false });
  await f.started();
  assert.throws(() =>
    f.run.gate.run(() => f.run.request(request), { role: 'cast' }),
  );
  await assert.rejects(f.run.ready);
  await bounded(f.run.close());
  assert.equal(f.calls.length, 0);
});

test('owned-process early Stop aborts root before arming and waits actual release after its single signal', async () => {
  const launched = deferred();
  const executable = '/fictional/TalkQTE.app/Contents/MacOS/talkqte';
  const child = new EventEmitter();
  Object.assign(child, {
    pid: 4242,
    spawnfile: executable,
    exitCode: null,
    signalCode: null,
  });
  const signals = [];
  child.kill = (value) => {
    signals.push(value);
    return true;
  };
  let timing, runId;
  const native = createLabNativeOwner({
    executable,
    stopAfterS: 120,
    armingMs: 200,
    releaseMs: 200,
    launch({ environment, onTiming }) {
      runId = environment.TALKQTE_DEV_LAB_RUN_ID;
      timing = onTiming;
      launched.resolve();
      return child;
    },
  });
  const f = fixture({ nativeOverride: native });
  await launched.promise;
  const closing = f.run.stop();
  assert.equal(f.run.phase, 'stopping');
  assert.equal(f.calls.length, 0);
  assert.deepEqual(signals, []);
  timing({ event: 'dev_stop', run_id: runId, step: 'armed' });
  assert.deepEqual(signals, ['SIGUSR2']);
  await assert.rejects(f.run.ready);
  assert.equal(f.run.phase, 'stopping');
  timing({ event: 'dev_stop', run_id: runId, step: 'latched' });
  timing({ event: 'dev_stop', run_id: runId, step: 'released' });
  await bounded(closing);
  assert.equal(f.run.phase, 'closed');
  assert.equal(f.closed, 1);
  assert.equal(f.run.dispatchesUsed, 0);
});

test('startup deadline without native authentication stops with zero dispatches', async () => {
  const f = fixture({ authenticate: false, startupMs: 15 });
  await assert.rejects(bounded(f.run.ready));
  await bounded(f.run.close());
  assert.equal(f.run.dispatchesUsed, 0);
  assert.equal(f.stops, 1);
  assert.equal(f.closed, 1);
});

test('a native Stop acknowledgement without explicit release is failed cleanup', async () => {
  const f = fixture({ authenticate: false, releaseValue: { signalled: true } });
  await f.started();
  await assert.rejects(bounded(f.run.stop()), { category: 'cleanup' });
  assert.equal(f.run.phase, 'failed-cleanup');
  assert.equal(f.closed, 1);
});

test('provider cleanup failure remains terminal even after native release', async () => {
  const f = fixture({ authenticate: false, closeFailure: true });
  await f.started();
  await assert.rejects(bounded(f.run.stop()), { category: 'cleanup' });
  assert.equal(f.run.phase, 'failed-cleanup');
  assert.equal(f.closed, 1);
  assert.equal(f.stops, 1);
});
