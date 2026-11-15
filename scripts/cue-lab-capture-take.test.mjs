import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createLabCaptureTake } from './cue-lab-capture-take.mjs';
import {
  createLabPlayerFixture,
  LAB_PLAYER_MEDIA_SHA256,
} from './cue-lab-player.mjs';
const media = {
  fictional: true,
  path: '/fictional/prepared.mp4',
  sha256: LAB_PLAYER_MEDIA_SHA256,
  durationMs: 102480,
};
function fixture({
  lateBeforeStart = false,
  lateAtStart = false,
  missingRelease = false,
  recorderFails = false,
  retirementFails = false,
  retirementUnconfirmed = false,
  sourceFails = false,
  holdPlayback = false,
  playerDeadline = 1000,
  syncPlayerStop = false,
  syncRecorderStop = false,
  foreignPlayer = false,
  wrongSource = false,
  observe,
  guardSink,
  playerFails = false,
  signal,
  takeMs,
  ownedPlayer,
  recorderDelayMs = 0,
} = {}) {
  const trace = [],
    counts = {
      play: 0,
      provider: 0,
      dispatch: 0,
      nativeStop: 0,
      playerStop: 0,
      playerClose: 0,
      recordStop: 0,
    };
  let sourceHandler,
    playerHandler,
    recorderHandler,
    timing,
    delta = 0;
  let entered;
  const playEntered = new Promise((resolve) => (entered = resolve));
  const processEvents = new EventEmitter();
  const originalNow = performance.now.bind(performance);
  if (lateBeforeStart || lateAtStart)
    mock.method(performance, 'now', () => originalNow() + delta);
  const child = Object.assign(new EventEmitter(), {
    pid: 44001,
    spawnfile: '/fictional/talkqte',
    exitCode: null,
    signalCode: null,
    kill(signal) {
      assert.equal(signal, 'SIGUSR2');
      counts.nativeStop++;
      trace.push('native-stop');
      queueMicrotask(() => {
        if (!missingRelease) {
          trace.push('native-release');
          timing({
            event: 'dev_stop',
            step: 'released',
            run_id: 'fictional-run',
          });
        }
      });
      return true;
    },
  });
  const launcher = {
    mode: 'capture-only',
    executable: child.spawnfile,
    launch(options) {
      timing = options.onTiming;
      trace.push('native-launch');
      assert.equal(options.metadata, undefined);
      assert.deepEqual(Object.keys(options.environment).sort(), [
        'TALKQTE_DEV_LAB_RUN_ID',
        'TALKQTE_DEV_STOP_AFTER_S',
        'TALKQTE_DEV_STOP_SIGNAL',
      ]);
      queueMicrotask(() =>
        timing({ event: 'dev_stop', step: 'armed', run_id: 'fictional-run' }),
      );
      return child;
    },
    close() {
      trace.push('launcher-close');
    },
  };
  const source = {
    mode: 'v1',
    subscribe(fn) {
      sourceHandler = fn;
      return () => (sourceHandler = () => {});
    },
    async waitListening() {
      trace.push('listening');
      if (sourceFails) throw Error('fictional source failure');
      return {
        runId: 'fictional-run',
        version: 1,
        listening: true,
        sessionId: '1',
        source: {
          application: wrongSource ? 'QuickTime Player' : 'TalkQTE Lab Player',
        },
      };
    },
    close() {
      trace.push('source-close');
    },
  };
  const player = ownedPlayer ?? {
    startDeadlineMs: playerDeadline,
    identity: { runId: 'fictional-run' },
    subscribe(fn) {
      playerHandler = fn;
      return () => (playerHandler = () => {});
    },
    async prepare() {
      trace.push('player-prepared');
      return media;
    },
    async play({ onStarted, signal }) {
      counts.play++;
      trace.push('play');
      entered();
      if (playerFails) throw Error('fictional player failure');
      if (lateAtStart) delta = 7000;
      onStarted({
        sha256: media.sha256,
        basis: 'audio-render',
        monotonicMs: performance.now(),
        uncertaintyMs: 1,
      });
      if (holdPlayback)
        await new Promise((resolve) =>
          signal.addEventListener('abort', resolve, { once: true }),
        );
      await Promise.resolve();
      return { completed: !signal.aborted, sha256: media.sha256 };
    },
    stop() {
      counts.playerStop++;
      if (syncPlayerStop)
        throw Error('fictional synchronous player Stop failure');
      trace.push('player-stop');
      playerHandler?.();
      return { stopped: true };
    },
    async close({ nativeReleased }) {
      counts.playerClose++;
      trace.push('player-retire');
      assert.equal(nativeReleased, true);
      if (retirementFails) throw Error('fictional failure');
      return { closed: !retirementUnconfirmed };
    },
  };
  const recorder = {
    subscribe(fn) {
      recorderHandler = fn;
      return () => (recorderHandler = () => {});
    },
    async start() {
      if (recorderDelayMs)
        await new Promise((resolve) => setTimeout(resolve, recorderDelayMs));
      trace.push('recorder-frame');
      if (recorderFails) throw Error('fictional failure');
      if (lateBeforeStart) delta = 6000;
      return { started: true };
    },
    stop() {
      counts.recordStop++;
      if (syncRecorderStop)
        throw Error('fictional synchronous recorder Stop failure');
      trace.push('recorder-final');
      recorderHandler?.();
      return { stopped: true };
    },
  };
  const guardReceipts = [];
  launcher.playerSource = player.identity;
  recorder.playerSource = foreignPlayer
    ? {
        ...player.identity,
        pid: 123,
        processStart: { seconds: '4', microseconds: 5 },
        executable: '/fictional/other-player',
      }
    : player.identity;
  const take = createLabCaptureTake({
    runId: 'fictional-run',
    launcher,
    source,
    player,
    recorder,
    media,
    nativeReleaseMs: 20,
    signal,
    ...(takeMs === undefined ? {} : { takeMs }),
    processEvents,
    onGuard: (receipt) => {
      guardReceipts.push(receipt);
      guardSink?.(receipt);
    },
    observe,
    // An attempted provider hook is deliberately never part of this API.
    settings: {
      openers: {
        codex() {
          counts.provider++;
          throw Error('must not construct');
        },
      },
    },
  });
  return {
    take,
    trace,
    counts,
    processEvents,
    guardReceipts,
    playEntered,
    failSource: () => sourceHandler({ type: 'failed' }),
  };
}
test('natural protocol playback composes with capture root abort and independently completes cleanup', async () => {
  // Real controller and harmless subprocess; no app, audio, capture or provider.
  const player = createLabPlayerFixture({
    runId: 'fictional-run',
    prepareMs: 2000,
    startMs: 100,
    stopMs: 100,
  });
  try {
    await player.prepare({ media });
    const events = [];
    const f = fixture({
      ownedPlayer: player,
      // The protocol stand-in extrapolates its first sample 10ms before receipt.
      // Give the simulated recorder a setup interval after native admission.
      recorderDelayMs: 25,
      observe: (e) => events.push(e),
    });
    const result = await f.take.done;
    assert.equal(result.completed, true);
    assert.equal(result.nativeReleased, true);
    assert.equal(f.take.phase, 'completed');
    assert.equal(f.counts.nativeStop, 1);
    assert.equal(f.counts.recordStop, 1);
    assert.equal(player.diagnostics.failure, null);
    assert.equal(player.diagnostics.audioCompleted, true);
    assert.equal(player.diagnostics.videoCompleted, true);
    assert.equal(player.diagnostics.transport.stoppedAcknowledged, true);
    assert.equal(player.diagnostics.transport.lastCommand, 'retire');
    assert.deepEqual(player.diagnostics.process, { exitCode: 0, signal: null });
    assert.equal(events.at(-1).outcome, 'observed');
    assert.ok(f.trace.includes('source-close'));
    assert.ok(f.trace.includes('launcher-close'));
  } finally {
    await player.close({ nativeReleased: true }).catch(() => {});
  }
});
test('capture-only proves no provider/backend/descriptor and final retirement after native release plus recorder finish', async () => {
  const f = fixture();
  const result = await f.take.done;
  assert.equal(result.captureOnly, true);
  assert.equal(result.dispatchesUsed, 0);
  assert.equal(f.counts.provider, 0);
  assert.equal(f.counts.dispatch, 0);
  assert.equal(f.counts.play, 1);
  assert.equal(f.counts.nativeStop, 1);
  assert.equal(f.counts.playerStop, 1);
  assert.equal(f.counts.playerClose, 1);
  assert.ok(f.trace.indexOf('recorder-frame') < f.trace.indexOf('play'));
  assert.ok(
    f.trace.indexOf('native-release') < f.trace.indexOf('player-retire'),
  );
  assert.ok(
    f.trace.indexOf('recorder-final') < f.trace.indexOf('player-retire'),
  );
  await f.take.stop();
  assert.equal(f.counts.nativeStop, 1);
  assert.equal(f.counts.playerClose, 1);
  const source = readFileSync(
    new URL('./cue-lab-capture-take.mjs', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(
    source,
    /import.*cue-lab-(provider|broker)|openLabProvider|openLabBroker/,
  );
});
for (const mode of [
  'lateBeforeStart',
  'lateAtStart',
  'recorderFails',
  'sourceFails',
  'retirementFails',
  'retirementUnconfirmed',
  'missingRelease',
]) {
  test(`capture-only ${mode} preserves failed outcome and exactly-once ownership`, async () => {
    const f = fixture({ [mode]: true });
    try {
      await assert.rejects(f.take.done);
      assert.equal(f.counts.provider, 0);
      assert.equal(f.counts.dispatch, 0);
      assert.equal(f.counts.nativeStop, 1);
      assert.equal(f.counts.playerStop, 1);
      if (['lateBeforeStart', 'recorderFails', 'sourceFails'].includes(mode))
        assert.equal(f.counts.play, 0);
      if (mode === 'missingRelease') {
        assert.equal(f.counts.playerClose, 0);
        assert.equal(f.take.phase, 'failed-cleanup');
      }
    } finally {
      mock.restoreAll();
    }
  });
}

test('capture-only process Stop aborts active playback and removes signal handlers after exact cleanup', async () => {
  const f = fixture({ holdPlayback: true });
  await f.playEntered;
  f.processEvents.emit('SIGINT');
  await assert.rejects(f.take.done);
  assert.equal(f.counts.nativeStop, 1);
  assert.equal(f.counts.playerStop, 1);
  assert.equal(f.counts.playerClose, 1);
  assert.equal(f.processEvents.listenerCount('SIGINT'), 0);
  assert.equal(f.processEvents.listenerCount('SIGTERM'), 0);
});

test('capture-only refuses a player start deadline longer than the reserved guard budget', () => {
  assert.throws(() => fixture({ playerDeadline: 2000 }));
});

for (const mode of ['syncPlayerStop', 'syncRecorderStop'])
  test(`capture cleanup isolates ${mode} and still closes independent resources once`, async () => {
    const f = fixture({ [mode]: true });
    await assert.rejects(f.take.done, (e) => e.category === 'cleanup');
    await assert.rejects(f.take.stop(), (e) => e.category === 'cleanup');
    assert.equal(f.counts.nativeStop, 1);
    assert.equal(f.counts.playerStop, 1);
    assert.equal(f.counts.recordStop, 1);
    assert.equal(f.trace.filter((x) => x === 'source-close').length, 1);
    assert.equal(f.trace.filter((x) => x === 'launcher-close').length, 1);
    assert.equal(f.processEvents.listenerCount('SIGINT'), 0);
    assert.equal(f.processEvents.listenerCount('SIGTERM'), 0);
    assert.equal(f.take.phase, 'failed-cleanup');
    if (mode === 'syncRecorderStop') assert.equal(f.counts.playerClose, 0);
  });

test('same-run foreign player capture identity is rejected before native construction', () => {
  assert.throws(() => fixture({ foreignPlayer: true }));
});
test('historical Listening for another fixed source does not permit playback', async () => {
  const f = fixture({ wrongSource: true });
  await assert.rejects(f.take.done);
  assert.equal(f.counts.play, 0);
});
test('numeric source guard receipts preserve actual Start timing and full-media reserve', async () => {
  const f = fixture();
  const result = await f.take.done;
  assert.equal(f.guardReceipts.length, 2);
  const [request, actual] = f.guardReceipts;
  assert.equal(request.sourceDeadline - request.nativeStartedAt, 110000);
  assert.equal(
    request.remainingAtRequestMs,
    request.sourceDeadline - request.startRequestAt,
  );
  assert.ok(
    request.remainingAtRequestMs >=
      102480 + request.startBudgetMs + request.completionReserveMs,
  );
  assert.equal(actual.actualAnchorMs, result.anchor.monotonicMs);
  assert.equal(
    actual.remainingAtAnchorMs,
    actual.sourceDeadline - actual.actualAnchorMs - actual.actualUncertaintyMs,
  );
  assert.ok(actual.remainingAtAnchorMs >= 102480 + actual.completionReserveMs);
  assert.equal(result.guard, actual);
  assert.equal(f.take.guard, actual);
  assert.ok(Object.isFrozen(actual));
});

test('core capture evidence preserves measured start versus receipt-only stages', async () => {
  const events = [];
  const f = fixture({ observe: (event) => events.push(event) });
  await f.take.done;
  assert.deepEqual(
    events.map((e) => e.stage),
    [
      'run.started',
      'source.listening',
      'recorder.frame-accepted',
      'speech.render-start',
      'speech.render-end',
      'run.ended',
    ],
  );
  assert.equal(events[1].ids.sessionId, '1');
  assert.equal(events[3].timing.basis, 'event');
  assert.equal(events[4].timing.basis, 'receipt');
  assert.ok(
    events
      .filter((e) => e.stage !== 'speech.render-start')
      .every((e) => e.timing.basis === 'receipt'),
  );
  assert.ok(events.every((e) => !e.stage.startsWith('video.') && !e.payload));
});
test('evidence observer failure stops the take but cannot skip cleanup', async () => {
  const f = fixture({
    observe(event) {
      if (event.stage === 'source.listening')
        throw Error('fictional evidence failure');
    },
  });
  await assert.rejects(f.take.done);
  assert.equal(f.counts.play, 0);
  assert.equal(f.counts.nativeStop, 1);
  assert.equal(f.counts.recordStop, 1);
  assert.equal(f.counts.playerStop, 1);
  assert.ok(f.trace.includes('launcher-close'));
});
test('capture stand-in writes bounded core events and numeric guard receipts through real writer files', async (t) => {
  const fs = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createLabEvidenceWriter } =
    await import('./cue-lab-evidence-writer.mjs');
  const parent = fs.realpathSync(
    fs.mkdtempSync(join(tmpdir(), 'tq-take-evidence-')),
  );
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const writer = createLabEvidenceWriter({
    parentDirectory: parent,
    runId: 'fictional-run',
    fictional: true,
  });
  t.after(() => writer.close());
  writer.addClock({ id: 'node', kind: 'monotonic' });
  const f = fixture({
    observe(e) {
      assert.equal(writer.emit(e), true);
    },
    guardSink: (g) => writer.recordGuard(g),
  });
  await f.take.done;
  const { manifestPath } = writer.close();
  const manifest = JSON.parse(fs.readFileSync(manifestPath));
  assert.equal(manifest.writer.failed, false);
  assert.equal(manifest.writer.events, 6);
  assert.equal(manifest.guards.length, 2);
  assert.equal(manifest.guards[1].actualAnchorMs, f.take.guard.actualAnchorMs);
  assert.equal(manifest.runtime.node, process.version);
  assert.equal(manifest.clocks[0].anchor, undefined);
});

for (const mode of [
  'sourceFails',
  'playerFails',
  'lateBeforeStart',
  'wrongSource',
  'observer',
  'guard',
])
  test(`runtime ${mode} remains failure evidence after successful cleanup`, async () => {
    const events = [];
    const f = fixture({
      ...(['observer', 'guard'].includes(mode) ? {} : { [mode]: true }),
      observe(event) {
        if (mode === 'observer' && event.stage === 'source.listening')
          throw Error('fictional observer failure');
        events.push(event);
      },
      guardSink() {
        if (mode === 'guard') throw Error('fictional guard failure');
      },
    });
    try {
      await assert.rejects(f.take.done, (e) => e.category === 'protocol');
      await assert.rejects(f.take.stop(), (e) => e.category === 'protocol');
      assert.equal(events.at(-1).stage, 'run.ended');
      assert.equal(events.at(-1).outcome, 'failure');
      assert.equal(f.take.phase, 'failed');
      assert.equal(f.counts.nativeStop, 1);
      assert.equal(f.counts.recordStop, 1);
      assert.equal(f.counts.playerStop, 1);
      assert.ok(events.every((e) => !e.payload));
    } finally {
      mock.restoreAll();
    }
  });
for (const mode of ['stop', 'SIGINT', 'SIGTERM', 'external'])
  test(`explicit ${mode} remains cancelled evidence despite subsequent aborted work`, async () => {
    const events = [],
      external = new AbortController();
    const f = fixture({
      holdPlayback: true,
      signal: external.signal,
      observe: (e) => events.push(e),
    });
    await f.playEntered;
    if (mode === 'stop') void f.take.stop().catch(() => {});
    else if (mode === 'external') external.abort();
    else f.processEvents.emit(mode);
    await assert.rejects(f.take.done, (e) => e.category === 'cancelled');
    assert.equal(events.at(-1).outcome, 'cancelled');
    assert.equal(f.take.phase, 'stopped');
    assert.equal(f.counts.nativeStop, 1);
    assert.equal(f.counts.recordStop, 1);
  });
test('deadline is failure evidence rather than cancellation', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const events = [];
  const f = fixture({
    holdPlayback: true,
    takeMs: 10,
    observe: (e) => events.push(e),
  });
  await f.playEntered;
  t.mock.timers.tick(10);
  await assert.rejects(f.take.done, (e) => e.category === 'deadline');
  assert.equal(events.at(-1).outcome, 'failure');
  assert.equal(f.take.phase, 'failed');
});
test('adapter terminal notification remains failure after later user Stop', async () => {
  const events = [];
  const f = fixture({ holdPlayback: true, observe: (e) => events.push(e) });
  await f.playEntered;
  f.failSource();
  await Promise.resolve();
  void f.take.stop().catch(() => {});
  await assert.rejects(f.take.done, (e) => e.category === 'protocol');
  assert.equal(events.at(-1).outcome, 'failure');
  assert.equal(f.counts.nativeStop, 1);
});
test('cleanup failure remains independent and dominates cancelled outcome', async () => {
  const events = [];
  const f = fixture({
    holdPlayback: true,
    syncRecorderStop: true,
    observe: (e) => events.push(e),
  });
  await f.playEntered;
  void f.take.stop().catch(() => {});
  await assert.rejects(f.take.done, (e) => e.category === 'cleanup');
  assert.equal(events.at(-1).outcome, 'failure');
  assert.equal(f.take.phase, 'failed-cleanup');
  assert.equal(f.counts.nativeStop, 1);
  assert.equal(f.counts.playerStop, 1);
  assert.equal(f.counts.recordStop, 1);
});
