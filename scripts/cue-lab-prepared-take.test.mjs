import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { EventEmitter } from 'node:events';
import { createConnection } from 'node:net';
import { readFile } from 'node:fs/promises';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLabEvidenceWriter } from './cue-lab-evidence-writer.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import {
  createPreparedTake,
  createLabPlaybackSession,
  createFixedModelTake,
  assertFixedModelTakeOptions,
} from './cue-lab-prepared-take.mjs';
import { createLabPlayerFixture } from './cue-lab-player.mjs';
import { labelLabBootstrapMedia } from './cue-lab-media.mjs';
import { fictionalTestMedia } from './fixtures/lab-test-media.mjs';

const deferred = () => {
  let resolve;
  const promise = new Promise((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
};
async function waitForTrace(fixture, entry) {
  const until = performance.now() + 1000;
  while (!fixture.trace.includes(entry)) {
    assert.ok(performance.now() < until, `Missing stand-in event ${entry}`);
    await delay(1);
  }
}
// Approved through the real manifest loader (synthetic, fictional).
const media = fictionalTestMedia();
function fixture({
  badIdentity = false,
  listening = true,
  recorderFails = false,
  // The helper exited before accepting a frame (RunB08): stop cannot
  // confirm a recording, and none exists.
  recorderNeverRecorded = false,
  // The recorder's process has not exited and stop cannot confirm it.
  recorderStillRunning = false,
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
  fixedModel = false,
  effort = 'medium',
  mediaOverride,
  ownedPlayer,
  foreignPlayer = false,
  wrongFixedSource = false,
  recorderStalls = false,
  recorderMs,
  recordDelayMs = 0,
  tailMs,
  guardSink,
  observe,
  helloSession = '1',
  lateBeforeStart = false,
  firstRequestTimesOut = false,
  // Direct API route: the owner's in-app approval is read from native
  // connection rows, delivered here once the take reports it is waiting.
  api = false,
  approvalRows = [],
  onApproval,
  // Startup failures: native never reports armed, or never says hello.
  neverArm = false,
  noHello = false,
  beforeListening,
  startupMs: startupOverride,
  // Cloud transcription: the launcher's token release, observed in order.
  cloud = false,
  releaseFails = false,
  // Called while the provider opens (after approval), e.g. to move a clock.
  onProviderOpen,
  // A planned turn-off: native's outcome row for SIGUSR1, and whether the
  // live session then ends (as the lab cue run ending ends the stream).
  turnOffAfterMs,
  launcherTurnOff = turnOffAfterMs !== undefined,
  offStep = 'done',
  offEndsSession = true,
} = {}) {
  if (api) effort = 'low';
  if (fixedModel) {
    strictSource = true;
    preallocatedRunId = 'fictional-run';
    playerRetirement = true;
  }
  const selectedMedia = body
    ? labelLabBootstrapMedia(media, 'Fictional neutral calibration')
    : (mediaOverride ?? media);
  const trace = [],
    events = new EventEmitter(),
    child = new EventEmitter();
  const activePlay = deferred(),
    providerClosing = deferred(),
    evaluated = deferred();
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
    providerOpen: 0,
    turnOff: 0,
  };
  Object.assign(child, {
    pid: 44001,
    spawnfile: '/fictional/Fixture.app/Contents/MacOS/talkqte',
    exitCode: null,
    signalCode: null,
    kill(name) {
      if (name === 'SIGUSR1') {
        counts.turnOff++;
        trace.push('turn-off');
        queueMicrotask(() => {
          const run_id = launchOptions.environment.TALKQTE_DEV_LAB_RUN_ID;
          for (const step of ['latched', offStep])
            launchOptions.onTiming({ event: 'dev_off', run_id, step });
          if (offStep === 'done' && offEndsSession)
            launchOptions.onTiming({
              event: 'session',
              state: 'ended',
              session: 1,
            });
        });
        return true;
      }
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
      if (!neverArm)
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
    ...(launcherTurnOff ? { turnOff: { step: null, repeats: 0 } } : {}),
  };
  if (cloud) {
    launcher.transcription = { backend: 'deepgram' };
    launcher.releaseTranscriptionToken = () => {
      trace.push('token-released');
      if (releaseFails) throw Error('fictional release failure');
    };
  }
  let evaluatorHandler;
  if (api)
    launcher.subscribeEvaluator = (handler) => {
      evaluatorHandler = handler;
      return () => (evaluatorHandler = null);
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
      sessionId: helloSession,
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
          if (fixedModel)
            socket.write(
              JSON.stringify(
                frame('evaluate', {
                  requestId: '1',
                  contextRevision: '1',
                  budgetMs: firstRequestTimesOut ? 40 : 1000,
                  input: {
                    events: [
                      {
                        id: 's1',
                        speaker: 'Speaker',
                        text: 'The fictional delivery date is Friday.',
                      },
                    ],
                    existingCue: null,
                  },
                }),
              ) + '\n',
            );
        } else if (
          value.type === 'failed' &&
          value.code === 'deadline' &&
          firstRequestTimesOut
        ) {
          // Request-scoped: the run continues with the next request.
          trace.push('deadline-' + value.requestId);
          socket.write(
            JSON.stringify(
              frame('evaluate', {
                requestId: '2',
                contextRevision: '2',
                budgetMs: 1000,
                input: {
                  events: [
                    {
                      id: 's1',
                      speaker: 'Speaker',
                      text: 'The fictional delivery date is Friday.',
                    },
                  ],
                  existingCue: null,
                },
              }),
            ) + '\n',
          );
        } else if (value.type === 'result' && fixedModel) {
          trace.push('validated-quiet');
          socket.write(
            JSON.stringify(
              frame('settled', {
                requestId: value.requestId,
                contextRevision: value.contextRevision,
                verdict: 'current',
              }),
            ) + '\n',
          );
          evaluated.resolve();
        }
      }
    });
    trace.push('authenticate');
    socket.write(
      JSON.stringify(
        frame('hello', {
          nonce: d.nonce,
          expectedProvider: api ? 'anthropic-api' : 'codex',
          expectedModel: api ? 'claude-opus-5-5' : 'gpt-6.1-sol',
          expectedEffort: effort,
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
        ...(fixedModel ? { basis: 'audio-render' } : {}),
        monotonicMs: performance.now(),
        uncertaintyMs: ackUncertainty,
        ...(body && !missingDisplayLabel
          ? { displayLabel: selectedMedia.displayLabel }
          : {}),
      };
      if (!missingAck) onStarted(ack);
      if (duplicateAck) onStarted(ack);
      if (!noHello) await authenticate();
      if (fixedModel)
        await Promise.race([evaluated.promise, activePlay.promise]);
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
  let selectedPlayer = player;
  if (ownedPlayer) {
    selectedPlayer = {
      ...ownedPlayer,
      async play(options) {
        const playback = ownedPlayer.play({
          ...options,
          onStarted(anchor) {
            options.onStarted(anchor);
            if (!noHello) void authenticate().catch(() => activePlay.resolve());
          },
        });
        const completed = await playback;
        const aborted = deferred();
        const onAbort = () => aborted.resolve();
        options.signal.addEventListener('abort', onAbort, { once: true });
        try {
          if (!options.signal.aborted)
            await Promise.race([evaluated.promise, aborted.promise]);
        } finally {
          options.signal.removeEventListener('abort', onAbort);
        }
        return completed;
      },
    };
  }
  if (playerRetirement)
    player.close = async ({ nativeReleased }) => {
      assert.equal(nativeReleased, true);
      trace.push('player-retired');
      assert.ok(!trace.includes('launch') || trace.includes('native-released'));
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
      if (recordDelayMs) await delay(recordDelayMs);
      if (recorderStalls) await activePlay.promise;
      if (lateBeforeStart) {
        const now = performance.now.bind(performance);
        mock.method(performance, 'now', () => now() + 6000);
      }
      if (recorderFails || recorderNeverRecorded)
        throw Error('private recorder failure');
      return { started: true };
    },
    async stop() {
      counts.recorderStop++;
      trace.push('recorder-stop');
      recorderHandler();
      if (recorderNeverRecorded) throw Error('private recorder failure');
      return { stopped: !recorderStillRunning };
    },
    get failureDetail() {
      if (recorderStillRunning) return { frameAccepted: false, exit: null };
      return recorderNeverRecorded
        ? { frameAccepted: false, exit: { code: 1, signal: null } }
        : undefined;
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
    stopAfterS: api ? 320 : 110,
    ...(api
      ? {
          approvalBudgetMs: 180000,
          onApproval(event) {
            trace.push('approval-' + event.state);
            if (event.state === 'approved' && cloud)
              assert.ok(trace.includes('token-released'));
            onApproval?.(event);
            if (event.state === 'waiting')
              for (const row of approvalRows)
                queueMicrotask(() => evaluatorHandler?.(Object.freeze(row)));
          },
        }
      : {}),
    media: selectedMedia,
    player: selectedPlayer,
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
        beforeListening?.();
        sourceRunId = runId;
        trace.push('listening');
        return {
          runId,
          listening,
          ...(strictSource
            ? {
                version: 1,
                sessionId: '1',
                source: {
                  application: wrongFixedSource
                    ? 'QuickTime Player'
                    : 'TalkQTE Lab Player',
                },
              }
            : {}),
        };
      },
    },
    settings: {
      provider: api ? 'anthropic-api' : 'codex',
      model: api ? 'claude-opus-5-5' : 'gpt-6.1-sol',
      effort,
      maxCalls: fixedModel ? (api ? 40 : 20) : 3,
      deadlineMs: 30000,
      execution: 'offline-stand-in',
      environment: {},
      openers: {
        [api ? 'anthropic-api' : 'codex']: async () => ({
          ...(counts.providerOpen++, onProviderOpen?.(), {}),
          async request({ signal }) {
            counts.requests++;
            if (firstRequestTimesOut && counts.requests === 1)
              return new Promise((_, reject) =>
                signal.addEventListener(
                  'abort',
                  () =>
                    reject(
                      Object.assign(new Error('fictional'), {
                        category: 'cancelled',
                      }),
                    ),
                  { once: true },
                ),
              );
            return {
              value: fixedModel
                ? { action: 'quiet', cue: null, sourceIds: ['s1'] }
                : { quiet: true },
              elapsedMs: 1,
            };
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
    startupMs: startupOverride ?? (fixedModel ? 1000 : 100),
    releaseMs: 100,
    armingMs: 50,
    nativeReleaseMs: 50,
    takeMs: api ? 135000 : fixedModel ? 1500 : 300,
    signal: initialSignal,
    ...(adaptedBody ? { body: adaptedBody } : {}),
    ...(recorderMs ? { recorderMs } : {}),
    ...(tailMs === undefined ? {} : { tailMs }),
    observe,
    onGuard: guardSink,
    ...(turnOffAfterMs === undefined ? {} : { turnOffAfterMs }),
  };
  if (fixedModel) {
    if (!ownedPlayer)
      Object.assign(selectedPlayer, {
        identity: { runId: preallocatedRunId },
        startDeadlineMs: 100,
      });
    launcher.mode = 'model-enabled';
    launcher.playerSource = selectedPlayer.identity;
    recorder.playerSource = foreignPlayer
      ? { ...selectedPlayer.identity, pid: 999 }
      : selectedPlayer.identity;
  }
  const take = adaptedBody
    ? createLabPlaybackSession(options)
    : fixedModel
      ? createFixedModelTake(options)
      : createPreparedTake(options);
  return {
    take,
    trace,
    counts,
    events,
    get evaluatorSubscribed() {
      return typeof evaluatorHandler === 'function';
    },
    deliverEvaluator: (row) => evaluatorHandler?.(Object.freeze(row)),
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
    providerOpen: 1,
    turnOff: 0,
  });
});

test('fixed saved meeting composes actual player controller, one model gate, same-session calibration and complete cleanup', async () => {
  const player = createLabPlayerFixture({
    runId: 'fictional-run',
    prepareMs: 2000,
    startMs: 100,
    stopMs: 100,
  });
  try {
    await player.prepare({ media });
    const guards = [],
      events = [];
    const f = fixture({
      fixedModel: true,
      ownedPlayer: player,
      recordDelayMs: 25,
      guardSink: (g) => guards.push(g),
      observe: (e) => events.push(e),
    });
    const result = await f.take.done;
    assert.equal(result.completed, true);
    assert.equal(result.nativeReleased, true);
    assert.equal(result.dispatchesUsed, 1);
    assert.equal(f.take.dispatchesUsed, 1);
    assert.equal(result.clockCalibration.sessionId, '1');
    assert.equal(result.clockCalibration, f.take.clockCalibration);
    assert.equal(Object.isFrozen(result.clockCalibration), true);
    assert.equal(f.take.startupDiagnostics.stage, 'ready');
    assert.equal(f.take.startupDiagnostics.failure, null);
    assert.equal(f.take.startupDiagnostics.broker.calibrated, true);
    assert.ok(
      result.clockCalibration.uncertaintyMs + guards[1].actualUncertaintyMs <=
        100,
    );
    assert.equal(f.counts.requests, 1);
    assert.equal(f.counts.providerClose, 1);
    assert.equal(f.counts.nativeStop, 1);
    assert.equal(f.counts.recorderStop, 1);
    assert.ok(
      f.trace.indexOf('record-ready') < f.trace.indexOf('authenticate'),
    );
    assert.ok(f.trace.includes('validated-quiet'));
    assert.equal(guards.length, 2);
    assert.ok(guards[1].remainingAtAnchorMs >= media.durationMs + 1000);
    assert.equal(result.guard, f.take.guard);
    assert.equal(player.diagnostics.failure, null);
    assert.equal(player.diagnostics.process.exitCode, 0);
    assert.equal(player.diagnostics.transport.lastCommand, 'retire');
    assert.equal(events.at(-1).outcome, 'observed');
  } finally {
    await player.close({ nativeReleased: true }).catch(() => {});
  }
});
test('fixed source capability rejects a same-run different player before ownership', () => {
  assert.throws(() => fixture({ fixedModel: true, foreignPlayer: true }));
});
test('wrong fixed Listening source stops before playback or evaluator dispatch', async () => {
  const f = fixture({ fixedModel: true, wrongFixedSource: true });
  await assert.rejects(f.take.done);
  assert.equal(f.counts.requests, 0);
  assert.equal(f.trace.includes('play'), false);
  assert.equal(f.counts.nativeStop, 1);
  assert.equal(f.counts.recorderStop, 1);
});
test('recorder readiness expiry aborts and retains startup ownership before cleanup completes', async () => {
  const f = fixture({ fixedModel: true, recorderStalls: true, recorderMs: 10 });
  await assert.rejects(f.take.done);
  assert.equal(f.trace.includes('play'), false);
  assert.equal(f.counts.requests, 0);
  assert.equal(f.counts.nativeStop, 1);
  assert.equal(f.counts.recorderStop, 1);
});
test('fixed saved meeting refuses exhausted native budget before Start', async () => {
  try {
    const f = fixture({ fixedModel: true, lateBeforeStart: true });
    await assert.rejects(f.take.done);
    assert.equal(f.trace.includes('play'), false);
    assert.equal(f.counts.requests, 0);
    assert.equal(f.counts.nativeStop, 1);
  } finally {
    mock.restoreAll();
  }
});
test('different authenticated session cannot dispatch or complete the strict model take', async () => {
  const f = fixture({ fixedModel: true, helloSession: '2' });
  await assert.rejects(f.take.done);
  assert.equal(f.counts.requests, 0);
  assert.equal(f.counts.nativeStop, 1);
  assert.equal(f.counts.providerClose, 1);
});
for (const name of ['SIGINT', 'SIGTERM']) {
  test(`host ${name} after validated quiet remains cancelled with once-only cleanup`, async () => {
    const records = [];
    const pendingPlayback = deferred();
    const f = fixture({
      fixedModel: true,
      playbackWait: pendingPlayback.promise,
      observe: (e) => records.push(e),
    });
    await waitForTrace(f, 'validated-quiet');
    f.events.emit(name);
    await assert.rejects(f.take.done, { category: 'cancelled' });
    assert.equal(records.at(-1).outcome, 'cancelled');
    assert.equal(f.counts.nativeStop, 1);
    assert.equal(f.counts.playerStop, 1);
    assert.equal(f.counts.recorderStop, 1);
    assert.equal(f.counts.providerClose, 1);
  });
}
test('pre-aborted outer signal remains cancelled without model dispatch', async () => {
  const signal = AbortSignal.abort();
  const records = [];
  const f = fixture({
    fixedModel: true,
    initialSignal: signal,
    observe: (e) => records.push(e),
  });
  await assert.rejects(f.take.done, { category: 'cancelled' });
  assert.equal(records.at(-1).outcome, 'cancelled');
  assert.equal(f.counts.requests, 0);
  assert.equal(f.counts.playerStop, 1);
  assert.equal(f.counts.recorderStop, 1);
});
test('actual source failure stays first cause when host cancellation follows', async () => {
  const records = [],
    pendingPlayback = deferred();
  const f = fixture({
    fixedModel: true,
    playbackWait: pendingPlayback.promise,
    observe: (e) => records.push(e),
  });
  await waitForTrace(f, 'validated-quiet');
  f.failSource();
  await delay(0);
  f.events.emit('SIGINT');
  await assert.rejects(f.take.done, { category: 'protocol' });
  assert.equal(records.at(-1).outcome, 'failure');
  assert.equal(f.counts.nativeStop, 1);
  assert.equal(f.counts.providerClose, 1);
});

test("a native process exit during playback is kept as the run's first stop reason", async () => {
  const pendingPlayback = deferred();
  const f = fixture({
    fixedModel: true,
    playbackWait: pendingPlayback.promise,
  });
  await waitForTrace(f, 'validated-quiet');
  f.nativeExit();
  await assert.rejects(f.take.done);
  // Evidence can say what ended the take, whatever cleanup reports after.
  assert.equal(f.take.runStopReason, 'process-ended');
  assert.equal(f.take.failure, 'protocol');
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
    // The take keeps a fixed, content-free startup stage for the failure.
    assert.notEqual(f.take.startupDiagnostics.failure, null);
    assert.notEqual(f.take.startupDiagnostics.failure.stage, 'ready');
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
test('a recorder that exited before any frame names its step and still lets the player retire', async () => {
  const f = fixture({
    strictSource: true,
    playerRetirement: true,
    recorderNeverRecorded: true,
  });
  await assert.rejects(f.take.done);
  assert.equal(f.take.failedStep, 'recorder-start');
  assert.equal(f.trace.includes('play'), false);
  assert.ok(f.trace.includes('player-retired'));
});
test('a recorder that may still be recording keeps the player', async () => {
  const f = fixture({
    strictSource: true,
    playerRetirement: true,
    recorderFails: true,
    recorderStillRunning: true,
  });
  await assert.rejects(f.take.done);
  assert.equal(f.take.failedStep, 'recorder-start');
  assert.equal(f.trace.includes('player-retired'), false);
});
test('a take that completes has no failed step', async () => {
  const f = fixture({ strictSource: true, playerRetirement: true });
  await f.take.done;
  assert.equal(f.take.failedStep, null);
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

test('host cancellation during actual playback ends stopped, not failed cleanup, with the player retired', async () => {
  const player = createLabPlayerFixture({
    runId: 'fictional-run',
    prepareMs: 2000,
    startMs: 100,
    stopMs: 100,
  });
  try {
    await player.prepare({ media });
    let f;
    f = fixture({
      fixedModel: true,
      ownedPlayer: player,
      recordDelayMs: 25,
      observe: (e) => {
        // Cancel while the owned player is still rendering fictional media.
        if (e.stage === 'speech.render-start')
          setImmediate(() => f.events.emit('SIGINT'));
      },
    });
    await assert.rejects(f.take.done, { category: 'cancelled' });
    assert.equal(f.take.phase, 'stopped');
    assert.deepEqual(player.diagnostics.failure, { category: 'cancelled' });
    assert.equal(player.diagnostics.transport.stoppedAcknowledged, true);
    assert.equal(player.diagnostics.transport.lastCommand, 'retire');
    assert.deepEqual(player.diagnostics.process, { exitCode: 0, signal: null });
    assert.equal(player.diagnostics.audioCompleted, false);
  } finally {
    await player.close({ nativeReleased: true }).catch(() => {});
  }
});

test('a request deadline during the fixed model take is recorded and the take completes on the next decision', async () => {
  const player = createLabPlayerFixture({
    runId: 'fictional-run',
    prepareMs: 2000,
    startMs: 100,
    stopMs: 100,
  });
  try {
    await player.prepare({ media });
    const f = fixture({
      fixedModel: true,
      ownedPlayer: player,
      recordDelayMs: 25,
      firstRequestTimesOut: true,
    });
    const result = await f.take.done;
    assert.equal(result.completed, true);
    assert.equal(result.dispatchesUsed, 2);
    assert.ok(f.trace.includes('deadline-1'));
    assert.ok(f.trace.includes('validated-quiet'));
    const summary = f.take.evaluationSummary;
    assert.equal(summary.deadlineByBroker, 1);
    assert.equal(summary.resultsSent, 1);
    assert.equal(summary.resultActions.quiet, 1);
    assert.equal(f.counts.providerClose, 1);
  } finally {
    await player.close({ nativeReleased: true }).catch(() => {});
  }
});

test('the fixed model take accepts low effort, as the signed native lab build does, and completes', async () => {
  const player = createLabPlayerFixture({
    runId: 'fictional-run',
    prepareMs: 2000,
    startMs: 100,
    stopMs: 100,
  });
  try {
    await player.prepare({ media });
    const f = fixture({
      fixedModel: true,
      ownedPlayer: player,
      recordDelayMs: 25,
      effort: 'low',
    });
    const result = await f.take.done;
    assert.equal(result.completed, true);
    assert.equal(result.dispatchesUsed, 1);
  } finally {
    await player.close({ nativeReleased: true }).catch(() => {});
  }
});

test('the fixed model take refuses any effort the native lab build does not accept, before constructing anything', () => {
  for (const effort of ['high', 'xhigh', 'max', 'ultra', ''])
    assert.throws(() => fixture({ fixedModel: true, effort }), {
      category: 'protocol',
    });
});

test('the fixed model take option check is usable on its own and matches construction', () => {
  const settings = {
    provider: 'codex',
    model: 'gpt-6.1-sol',
    effort: 'low',
    maxCalls: 20,
  };
  const options = { settings, stopAfterS: 110, media };
  assert.doesNotThrow(() => assertFixedModelTakeOptions(options));
  for (const changed of [
    { settings: { ...settings, effort: 'high' } },
    { settings: { ...settings, maxCalls: 19 } },
    { stopAfterS: 120 },
    { media: { ...media, durationMs: 104001 } },
    { media: { ...media, fictional: false } },
  ])
    assert.throws(
      () => assertFixedModelTakeOptions({ ...options, ...changed }),
      {
        category: 'protocol',
      },
    );
});

test('the takes refuse a hand-built media descriptor even with the approved path and hash', () => {
  const settings = {
    provider: 'codex',
    model: 'gpt-6.1-sol',
    effort: 'low',
    maxCalls: 20,
  };
  assert.doesNotThrow(() =>
    assertFixedModelTakeOptions({ settings, stopAfterS: 110, media }),
  );
  assert.throws(
    () =>
      assertFixedModelTakeOptions({
        settings,
        stopAfterS: 110,
        media: { ...media },
      }),
    { category: 'protocol' },
  );
  assert.throws(
    () => fixture({ fixedModel: true, mediaOverride: { ...media } }),
    {
      category: 'protocol',
    },
  );
});

// Direct API route: the owner approves the connection in the app after
// Listening and before playback (native `evaluator` row, approval `review`).
const reviewRow = {
  event: 'evaluator',
  approval: 'review',
  state: 'on',
  backend: 'lab-api',
  model: 'claude-opus-5-5',
  effort: 'low',
  session: '7',
};
async function apiTake(
  t,
  { onApproval, evidence = false, owned = true, ...options } = {},
) {
  // The real player stand-in, with its full 1 s start budget (a loaded test
  // host can miss 100 ms); or the in-process player, whose start anchor
  // follows a shifted test clock.
  let player;
  if (owned) {
    player = createLabPlayerFixture({
      runId: 'fictional-run',
      prepareMs: 2000,
      startMs: 1000,
      stopMs: 100,
    });
    t.after(() => player.close({ nativeReleased: true }).catch(() => {}));
    await player.prepare({ media });
  }
  let writer;
  if (evidence) {
    const parent = realpathSync(mkdtempSync(join(tmpdir(), 'tq-api-take-')));
    t.after(() => rmSync(parent, { recursive: true, force: true }));
    writer = createLabEvidenceWriter({
      parentDirectory: parent,
      runId: 'fictional-run',
      fictional: true,
    });
    writer.addClock({ id: 'node', kind: 'monotonic' });
  }
  const approvals = [];
  const f = fixture({
    fixedModel: true,
    api: true,
    ownedPlayer: player,
    recordDelayMs: 25,
    guardSink: (g) => writer?.recordGuard(g),
    onApproval(event) {
      approvals.push(event);
      onApproval?.(event);
    },
    ...options,
  });
  return { f, approvals, writer };
}

test('the API take plays only after the in-app approval and records the wait apart from the source window', async (t) => {
  const { f, approvals, writer } = await apiTake(t, {
    approvalRows: [reviewRow],
    evidence: true,
  });
  const result = await f.take.done;
  assert.equal(result.completed, true);
  assert.equal(result.dispatchesUsed, 1);
  assert.deepEqual(
    approvals.map((e) => e.state),
    ['waiting', 'approved'],
  );
  assert.equal(approvals[0].budgetMs, 180000);
  assert.equal(approvals[1].session, '7');
  assert.deepEqual(result.approval, {
    budgetMs: 180000,
    waitMs: approvals[1].waitMs,
    session: '7',
  });
  // Approval sits between Listening and the recorder, before any playback.
  const at = (entry) => f.trace.indexOf(entry);
  assert.ok(at('listening') < at('approval-waiting'));
  assert.ok(at('approval-approved') < at('record-ready'));
  assert.ok(at('record-ready') < at('authenticate'));
  // The native Stop guard moves out by exactly the approval budget.
  assert.equal(result.guard.approvalBudgetMs, 180000);
  assert.equal(result.guard.approvalWaitMs, approvals[1].waitMs);
  assert.equal(
    result.guard.sourceDeadline - result.guard.nativeStartedAt,
    320000,
  );
  const { manifestPath } = writer.close();
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.writer.failed, false);
  assert.equal(manifest.guards.length, 2);
  assert.equal(manifest.guards[1].approvalBudgetMs, 180000);
});

test('a tail keeps the app running after the media and is counted in the source window', async (t) => {
  const guards = [];
  const { f } = await apiTake(t, {
    approvalRows: [reviewRow],
    evidence: true,
    tailMs: 400,
    guardSink: (g) => guards.push(g),
  });
  const started = performance.now();
  const result = await f.take.done;
  assert.equal(result.completed, true);
  assert.equal(guards[0].tailMs, 400);
  assert.ok(
    guards[0].remainingAtRequestMs >=
      guards[0].startBudgetMs +
        guards[0].mediaDurationMs +
        400 +
        guards[0].completionReserveMs,
  );
  assert.ok(performance.now() - started >= 400);
});

test('Stop during the tail ends the take as stopped, not completed', async (t) => {
  const { f } = await apiTake(t, {
    approvalRows: [reviewRow],
    tailMs: 15000,
  });
  // Wait until the media has finished and the tail has begun.
  for (let n = 0; n < 300 && f.take.phase !== 'playing'; n++) await delay(10);
  await delay(300);
  const stopping = f.take.stop();
  await assert.rejects(f.take.done);
  await stopping.catch(() => {});
  assert.notEqual(f.take.phase, 'completed');
});

test('no approval within 180 s stops the API take without playback, a request or an approved notice', async (t) => {
  const { f, approvals } = await apiTake(t, {
    onApproval(event) {
      if (event.state !== 'waiting') return;
      // Advance only the approval timer: it is created right after this
      // notice, then real timers return before cleanup starts.
      mock.timers.enable({ apis: ['setTimeout'] });
      queueMicrotask(() => {
        mock.timers.tick(180000);
        mock.timers.reset();
      });
    },
  });
  await assert.rejects(f.take.done, { category: 'approval-not-given' });
  assert.deepEqual(
    approvals.map((e) => e.state),
    ['waiting'],
  );
  assert.equal(f.take.approval, null);
  assert.equal(f.counts.requests, 0);
  assert.equal(f.trace.includes('record-ready'), false);
  assert.equal(f.trace.includes('authenticate'), false);
  assert.equal(f.counts.nativeStop, 1);
  // The provider (key file, worker) is never opened without approval.
  assert.equal(f.counts.providerOpen, 0);
  assert.equal(f.counts.providerClose, 0);
  assert.equal(f.take.phase, 'stopped');
});

for (const [name, row] of [
  ['a launch-setting approval', { ...reviewRow, approval: 'launchSetting' }],
  ['another backend', { ...reviewRow, backend: 'claude-cli' }],
  ['another model', { ...reviewRow, model: 'claude-sonnet-5-5' }],
])
  test(`${name} is an approval fault: no playback and no request`, async (t) => {
    const { f, approvals } = await apiTake(t, { approvalRows: [row] });
    await assert.rejects(f.take.done, { category: 'approval-fault' });
    assert.deepEqual(
      approvals.map((e) => e.state),
      ['waiting'],
    );
    assert.equal(f.counts.requests, 0);
    assert.equal(f.trace.includes('record-ready'), false);
    assert.equal(f.counts.nativeStop, 1);
  });

test('a launch-setting row after approval stops the API take as a fault', async (t) => {
  const { f, approvals } = await apiTake(t, {
    approvalRows: [reviewRow, { ...reviewRow, approval: 'launchSetting' }],
  });
  await assert.rejects(f.take.done, { category: 'approval-fault' });
  assert.equal(approvals[0].state, 'waiting');
});

test('the option check pins each route: Codex 20 calls at 110 s, API 40 calls with the 180 s approval and Stop at 320 s', () => {
  const codex = {
    settings: {
      provider: 'codex',
      model: 'gpt-6.1-sol',
      effort: 'low',
      maxCalls: 20,
    },
    stopAfterS: 110,
    media,
  };
  const api = {
    settings: {
      provider: 'anthropic-api',
      model: 'claude-opus-5-5',
      effort: 'low',
      maxCalls: 40,
    },
    stopAfterS: 320,
    approvalBudgetMs: 180000,
    takeMs: 135000,
    media,
  };
  assert.doesNotThrow(() => assertFixedModelTakeOptions(codex));
  assert.doesNotThrow(() => assertFixedModelTakeOptions(api));
  assert.doesNotThrow(() =>
    assertFixedModelTakeOptions({ ...api, tailMs: 10000 }),
  );
  for (const changed of [
    { ...codex, settings: { ...codex.settings, maxCalls: 40 } },
    { ...codex, approvalBudgetMs: 180000, stopAfterS: 290 },
    { ...api, settings: { ...api.settings, maxCalls: 20 } },
    { ...api, approvalBudgetMs: undefined },
    { ...api, approvalBudgetMs: 120000, stopAfterS: 260 },
    { ...api, stopAfterS: 290 },
    { ...api, takeMs: undefined },
    { ...api, takeMs: 315000 },
    { ...api, tailMs: 15001 },
    { ...api, tailMs: -1 },
    { ...api, tailMs: 2.5 },
    { ...codex, tailMs: 1000 },
  ])
    assert.throws(() => assertFixedModelTakeOptions(changed), {
      category: 'protocol',
    });
});

// The approval wait is not startup or take time. A shifted clock stands in
// for the owner taking 5 s, 60 s or 175 s; the run's own startup clock is
// real and would fire at 1 s if it were still running.
const shiftedClock = (t) => {
  const real = performance.now.bind(performance);
  let offset = 0;
  t.mock.method(performance, 'now', () => real() + offset);
  return (ms) => (offset += ms);
};
for (const seconds of [5, 60, 175])
  test(`an approval after ${seconds} s proceeds to playback and completes`, async (t) => {
    const advance = shiftedClock(t);
    const { f, approvals } = await apiTake(t, {
      owned: false,
      approvalRows: [reviewRow],
      onApproval(event) {
        if (event.state === 'waiting') advance(seconds * 1000);
      },
    });
    const result = await f.take.done;
    assert.equal(result.completed, true);
    assert.deepEqual(
      approvals.map((e) => e.state),
      ['waiting', 'approved'],
    );
    assert.ok(result.approval.waitMs >= seconds * 1000);
    assert.equal(result.guard.approvalWaitMs, result.approval.waitMs);
    assert.ok(result.guard.remainingAtAnchorMs >= media.durationMs + 1000);
    assert.equal(f.counts.providerOpen, 1);
    assert.equal(f.counts.requests, 1);
  });

test('an approval after 181 s is not given: no marker, no provider opened, nothing played', async (t) => {
  const advance = shiftedClock(t);
  const { f, approvals } = await apiTake(t, {
    owned: false,
    approvalRows: [reviewRow],
    onApproval(event) {
      if (event.state === 'waiting') advance(181000);
    },
  });
  await assert.rejects(f.take.done, { category: 'approval-not-given' });
  assert.deepEqual(
    approvals.map((e) => e.state),
    ['waiting'],
  );
  assert.equal(f.counts.providerOpen, 0);
  assert.equal(f.counts.requests, 0);
  assert.equal(f.trace.includes('record-ready'), false);
  assert.equal(f.trace.includes('play'), false);
  assert.equal(f.counts.nativeStop, 1);
});

test('a real wait longer than the startup budget does not fail the run', async (t) => {
  // A 2 s startup budget, and the owner approves after 2.5 s. The rest of
  // startup after approval keeps a full 2 s on a busy test host.
  const { f, approvals } = await apiTake(t, {
    owned: false,
    startupMs: 2000,
    onApproval(event) {
      if (event.state === 'waiting')
        setTimeout(() => f.deliverEvaluator(reviewRow), 2500);
    },
  });
  const result = await f.take.done;
  assert.equal(result.completed, true);
  assert.deepEqual(
    approvals.map((e) => e.state),
    ['waiting', 'approved'],
  );
  assert.ok(result.approval.waitMs >= 2500);
});

test('a startup failure before approval still stops the take, with no provider opened', async (t) => {
  const { f, approvals } = await apiTake(t, {
    owned: false,
    neverArm: true,
    approvalRows: [reviewRow],
  });
  await assert.rejects(f.take.done);
  assert.deepEqual(approvals, []);
  assert.equal(f.counts.providerOpen, 0);
  assert.equal(f.trace.includes('play'), false);
});

test('after approval the startup deadline still catches a native that never says hello', async (t) => {
  const { f, approvals } = await apiTake(t, {
    owned: false,
    noHello: true,
    approvalRows: [reviewRow],
  });
  await assert.rejects(f.take.done);
  assert.deepEqual(
    approvals.map((e) => e.state),
    ['waiting', 'approved'],
  );
  assert.deepEqual(f.take.startupDiagnostics.failure, {
    stage: 'awaiting-hello',
    reason: 'deadline',
  });
  assert.equal(f.counts.requests, 0);
});

test('an approval that could no longer fit the media before native Stop is not given', async (t) => {
  // Listening 60 s after native start, then approval 165 s later: inside the
  // 180 s budget, but 102 s of media would pass the 320 s native Stop.
  const advance = shiftedClock(t);
  const { f, approvals } = await apiTake(t, {
    owned: false,
    approvalRows: [reviewRow],
    beforeListening: () => advance(60000),
    onApproval(event) {
      if (event.state === 'waiting') advance(165000);
    },
  });
  await assert.rejects(f.take.done, { category: 'approval-not-given' });
  assert.deepEqual(
    approvals.map((e) => e.state),
    ['waiting'],
  );
  assert.equal(f.counts.providerOpen, 0);
  assert.equal(f.trace.includes('play'), false);
});

test('with cloud transcription the token is released after approval and before the approved notice', async (t) => {
  const { f, approvals } = await apiTake(t, {
    owned: false,
    cloud: true,
    approvalRows: [reviewRow],
  });
  const result = await f.take.done;
  assert.equal(result.completed, true);
  const at = (entry) => f.trace.indexOf(entry);
  assert.ok(at('approval-waiting') < at('token-released'));
  assert.ok(at('token-released') < at('approval-approved'));
  assert.ok(at('approval-approved') < at('record-ready'));
  assert.deepEqual(
    approvals.map((e) => e.state),
    ['waiting', 'approved'],
  );
});

test('a failed token release stops the take before the approved notice', async (t) => {
  const { f, approvals } = await apiTake(t, {
    owned: false,
    cloud: true,
    releaseFails: true,
    approvalRows: [reviewRow],
  });
  await assert.rejects(f.take.done);
  assert.deepEqual(
    approvals.map((e) => e.state),
    ['waiting'],
  );
  assert.equal(f.trace.includes('play'), false);
});

test('a take that runs out of time while the provider opens stops without releasing the token', async (t) => {
  const advance = shiftedClock(t);
  const { f, approvals } = await apiTake(t, {
    owned: false,
    cloud: true,
    approvalRows: [reviewRow],
    onApproval(event) {
      if (event.state === 'waiting') advance(170000);
    },
    // Opening the provider takes the take past its 180 s approval budget.
    onProviderOpen: () => advance(15000),
  });
  await assert.rejects(f.take.done, { category: 'approval-not-given' });
  assert.equal(f.counts.providerOpen, 1);
  assert.equal(f.trace.includes('token-released'), false);
  assert.deepEqual(
    approvals.map((e) => e.state),
    ['waiting'],
  );
});

test('a planned turn-off is asked once after the render start, and the run ending after done is the expected stop', async () => {
  const events = [];
  const f = fixture({
    turnOffAfterMs: 20,
    playbackWait: new Promise(() => {}),
    observe: (e) => events.push(e),
  });
  await assert.rejects(f.take.done, { category: 'turned-off' });
  assert.equal(f.take.phase, 'stopped');
  assert.equal(f.take.failure, 'turned-off');
  assert.equal(f.take.turnOff.afterMs, 20);
  assert.ok(f.take.turnOff.askedAfterRenderMs >= 19);
  assert.equal(f.take.turnOff.outcome, 'done');
  assert.equal(f.counts.turnOff, 1);
  assert.ok(f.trace.indexOf('turn-off') < f.trace.indexOf('native-stop'));
  // Ordinary Stop and cleanup are unchanged, once each.
  assert.equal(f.counts.nativeStop, 1);
  assert.equal(f.counts.providerClose, 1);
  assert.equal(f.counts.recorderStop, 1);
  assert.equal(events.at(-1).stage, 'run.ended');
  assert.equal(events.at(-1).outcome, 'observed');
});

test('a turn-off native refuses stops the take as a failed check', async () => {
  const f = fixture({
    turnOffAfterMs: 20,
    offStep: 'failed',
    playbackWait: new Promise(() => {}),
  });
  await assert.rejects(f.take.done, { category: 'turn-off-failed' });
  assert.equal(f.take.turnOff.outcome, 'failed');
  assert.equal(f.counts.turnOff, 1);
  assert.equal(f.counts.nativeStop, 1);
});

test('a done turn-off with no native end lets the take complete and reports it', async () => {
  const played = deferred();
  const f = fixture({
    turnOffAfterMs: 20,
    offEndsSession: false,
    playbackWait: played.promise,
  });
  await waitForTrace(f, 'turn-off');
  while (f.take.turnOff?.outcome !== 'done') await delay(1);
  played.resolve();
  const result = await f.take.done;
  assert.equal(result.completed, true);
  assert.equal(result.turnOff.outcome, 'done');
  assert.equal(f.counts.turnOff, 1);
});

test('no turn-off is sent after the take stops, and plan and launch must agree', async () => {
  const f = fixture({
    turnOffAfterMs: 50,
    playbackWait: new Promise(() => {}),
  });
  await waitForTrace(f, 'play');
  await assert.rejects(f.take.stop(), { category: 'cancelled' });
  await delay(80);
  assert.equal(f.counts.turnOff, 0);
  assert.equal(f.take.turnOff, null);
  for (const options of [
    { launcherTurnOff: true },
    { turnOffAfterMs: 20, launcherTurnOff: false },
    { turnOffAfterMs: 0 },
    { turnOffAfterMs: media.durationMs },
    { turnOffAfterMs: 1.5 },
  ])
    assert.throws(() => fixture(options), { category: 'protocol' });
});
