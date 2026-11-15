import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
  rmSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import {
  createLabPlayerFixture,
  verifyLabPlayerBuild,
  mapLabPlayerStart,
  LAB_PLAYER_MEDIA_SHA256,
  validateLabPlayerDurations,
} from './cue-lab-player.mjs';
const bridge = {
  sentMs: 1000,
  receivedMs: 1002,
  hostTicks: '10000000000',
  absoluteBeforeTicks: '10000000000',
  absoluteAfterTicks: '10000000000',
  timebaseNumer: 1,
  timebaseDenom: 1,
};
const frame = {
  schema: 'talkqte.lab.player.v1',
  type: 'started',
  runId: 'fictional-run',
  generation: '1',
  mediaSha256: LAB_PLAYER_MEDIA_SHA256,
  sampleRate: 48000,
  totalFrames: 4919040,
  timebaseNumer: 1,
  timebaseDenom: 1,
  outputLatencyEstimateMs: 12,
  outputSampleRate: 48000,
  outputChannels: 2,
  outputDeviceId: 42,
  hostTimeValid: true,
  sampleTimeValid: true,
  clockPair: {
    absoluteBeforeTicks: '10020000000',
    continuousTicks: '10020000000',
    absoluteAfterTicks: '10020000000',
  },
  observations: [
    {
      hostTicks: '10010000000',
      sampleTime: '480',
      hostTimeValid: true,
      sampleTimeValid: true,
    },
    {
      hostTicks: '10020000000',
      sampleTime: '960',
      hostTimeValid: true,
      sampleTimeValid: true,
    },
  ],
};
test('real advancing coeval render observations map media zero through measured bridge, independent of receipt', () => {
  const start = mapLabPlayerStart(frame, bridge, { nowMs: 1200 });
  assert.equal(start.monotonicMs, 1001);
  assert.equal(start.uncertaintyMs, 1.001);
  assert.equal(start.basis, 'audio-render');
  assert.equal(start.outputLatencyEstimateMs, 12);
  assert.equal(
    mapLabPlayerStart(frame, bridge, { nowMs: 1300 }).monotonicMs,
    1001,
  );
});
for (const variant of [
  'scheduled-only',
  'one-sample',
  'stalled',
  'backwards',
  'invalidhost',
  'invalidsample',
  'sampleoverflow',
  'tickoverflow',
  'wrongrate',
  'wrongtimebase',
  'spread',
  'routeinvalid',
  'latebridge',
  'expiredmapping',
  'negativeanchor',
]) {
  test(`render clock refuses ${variant} rather than manufacturing start`, () => {
    const f = structuredClone(frame),
      b = { ...bridge };
    let nowMs = 1200;
    if (variant === 'scheduled-only') f.type = 'scheduled';
    if (variant === 'one-sample') f.observations.pop();
    if (variant === 'stalled') f.observations[1].sampleTime = '480';
    if (variant === 'backwards') f.observations.reverse();
    if (variant === 'invalidhost') f.observations[0].hostTimeValid = false;
    if (variant === 'invalidsample') f.observations[0].sampleTimeValid = false;
    if (variant === 'sampleoverflow')
      f.observations[1].sampleTime = '18446744073709551615';
    if (variant === 'tickoverflow')
      f.observations[1].hostTicks = '18446744073709551616';
    if (variant === 'wrongrate') f.sampleRate = 44100;
    if (variant === 'wrongtimebase') f.timebaseNumer = 2;
    if (variant === 'spread') f.observations[1].hostTicks = '10030000000';
    if (variant === 'routeinvalid') f.outputSampleRate = 0;
    if (variant === 'latebridge') b.receivedMs = 1101;
    if (variant === 'expiredmapping') nowMs = 112000;
    if (variant === 'negativeanchor') f.observations[0].hostTicks = '1';
    assert.throws(() => mapLabPlayerStart(f, b, { nowMs }));
  });
}
test('large host ticks use checked rational delta instead of lossy whole-uptime Number arithmetic', () => {
  const offset = 18000000000000000000n;
  const f = structuredClone(frame),
    b = { ...bridge, hostTicks: String(BigInt(bridge.hostTicks) + offset) };
  b.absoluteBeforeTicks = String(BigInt(bridge.absoluteBeforeTicks) + offset);
  b.absoluteAfterTicks = String(BigInt(bridge.absoluteAfterTicks) + offset);
  for (const key of Object.keys(f.clockPair))
    f.clockPair[key] = String(BigInt(f.clockPair[key]) + offset);
  for (const o of f.observations)
    o.hostTicks = String(BigInt(o.hostTicks) + offset);
  const start = mapLabPlayerStart(f, b, { nowMs: 1200 });
  assert.equal(start.monotonicMs, 1001);
});
test('non-unit timebase keeps exact sample-clock conversion', () => {
  const f = structuredClone(frame),
    b = { ...bridge, timebaseNumer: 125, timebaseDenom: 3 };
  f.timebaseNumer = 125;
  f.timebaseDenom = 3;
  // Ten milliseconds = 240000 ticks at the declared timebase.
  f.observations[0].hostTicks = String(BigInt(b.hostTicks) + 240000n);
  f.observations[1].hostTicks = String(BigInt(b.hostTicks) + 480000n);
  assert.equal(mapLabPlayerStart(f, b, { nowMs: 1200 }).monotonicMs, 1001);
});
test('Swift callback has only C atomic store and completion requires claim, frames, generation state and engine Stop', () => {
  const swift = readFileSync(
    new URL('./lab-owned-player.swift', import.meta.url),
    'utf8',
  );
  const callback = swift
    .split(
      'node.scheduleBuffer(pcm, completionCallbackType: .dataPlayedBack) { type in',
    )[1]
    .split('}')[0]
    .trim();
  assert.equal(callback, 'lab_player_completed(flag, Int32(type.rawValue))');
  assert.match(swift, /lab_player_claim_completion\(state\) == 1/);
  assert.match(swift, /maximumSample >= frames/);
  assert.match(swift, /node\.stop\(\); engine\.stop\(\)/);
  assert.match(swift, /guard !engine\.isRunning/);
  const c = readFileSync(
    new URL('./lab-player-state.c', import.meta.url),
    'utf8',
  );
  assert.match(c, /atomic_is_lock_free/);
  assert.match(c, /atomic_compare_exchange_strong_explicit/);
});

const media = {
  fictional: true,
  path: '/fictional/prepared.mp4',
  sha256: LAB_PLAYER_MEDIA_SHA256,
  durationMs: 102480,
};
const fixtureOptions = {
  runId: 'fictional-run',
  prepareMs: 2000,
  startMs: 100,
  stopMs: 100,
};
test('owned harmless fixture prepares once, starts only on real protocol observation and retains identity through Stop', async () => {
  const player = createLabPlayerFixture(fixtureOptions);
  try {
    const prepared = await player.prepare({ media });
    assert.equal(prepared.sha256, media.sha256);
    assert.equal((await player.prepare({ media })).sha256, media.sha256);
    const pid = player.identity.pid;
    let starts = 0;
    const result = await player.play({
      media,
      onStarted: (a) => {
        starts++;
        assert.equal(a.basis, 'audio-render');
      },
    });
    assert.equal(result.completed, true);
    assert.equal(starts, 1);
    assert.throws(() => player.play({ media, onStarted() {} }));
    assert.deepEqual(await player.stop(), { stopped: true });
    assert.equal(player.identity.pid, pid);
    assert.doesNotThrow(() => process.kill(pid, 0));
    assert.throws(() => player.close());
    assert.deepEqual(await player.close({ nativeReleased: true }), {
      closed: true,
    });
  } finally {
    await player.close({ nativeReleased: true }).catch(() => {});
  }
});
for (const fixtureCase of [
  'wrong-pid',
  'wrong-run',
  'no-start',
  'early-complete',
  'duplicate',
  'oversize',
  'held-pipes',
]) {
  test(`owned harmless ${fixtureCase} fails closed and cannot become successful cleanup`, async () => {
    const player = createLabPlayerFixture({ ...fixtureOptions, fixtureCase });
    let failures = 0;
    player.subscribe(() => failures++);
    try {
      const ready = player.prepare({ media });
      if (['wrong-pid', 'wrong-run', 'duplicate'].includes(fixtureCase))
        await assert.rejects(ready);
      else {
        await ready;
        if (fixtureCase === 'held-pipes')
          await player.play({ media, onStarted() {} });
        else await assert.rejects(player.play({ media, onStarted() {} }));
      }
      await assert.rejects(player.close({ nativeReleased: true }));
      if (fixtureCase !== 'held-pipes') assert.equal(failures, 1);
    } finally {
      await player.close({ nativeReleased: true }).catch(() => {});
    }
  });
}
test('Stop before preparation is latched and cannot later spawn', async () => {
  const p = createLabPlayerFixture(fixtureOptions);
  assert.deepEqual(await p.stop(), { stopped: true });
  assert.throws(() => p.prepare({ media }));
  assert.deepEqual(await p.close({ nativeReleased: true }), { closed: true });
});

test(
  'approved receipt repeats exact bundle seal and pinned signature before owned spawn',
  { skip: process.platform !== 'darwin' },
  () => {
    const directory = realpathSync(
      mkdtempSync(join(tmpdir(), 'tq-player-build-test-')),
    );
    const bundlePath = join(directory, 'TalkQTE Lab Player.app');
    mkdirSync(join(bundlePath, 'Contents/MacOS'), { recursive: true });
    const executable = join(bundlePath, 'Contents/MacOS/lab-owned-player');
    writeFileSync(executable, 'fictional executable bytes');
    chmodSync(executable, 0o700);
    const sha256 = createHash('sha256')
      .update(readFileSync(executable))
      .digest('hex');
    const requirement =
      'identifier "com.talkqte.lab-player" and certificate leaf = H"0000000000000000000000000000000000000000"';
    const record = {
      schema: 'talkqte.lab.player.build.v1',
      executable,
      bundlePath,
      sha256,
      commit: 'a'.repeat(40),
      signature: {
        identifier: 'com.talkqte.lab-player',
        authority: 'TalkQTE Development',
        designatedRequirement: requirement,
      },
    };
    const manifestFile = join(directory, 'manifest.json');
    writeFileSync(manifestFile, JSON.stringify(record), { mode: 0o600 });
    const approved = {
      manifestSha256: createHash('sha256')
        .update(readFileSync(manifestFile))
        .digest('hex'),
      executableSha256: sha256,
      commit: record.commit,
    };
    let invalidSeal = false,
      verifyCalls = 0;
    mock.method(childProcess, 'spawnSync', (command, args) => {
      if (command === '/usr/libexec/PlistBuddy')
        return {
          status: 0,
          stdout: args[1].includes('CFBundleIdentifier')
            ? 'com.talkqte.lab-player'
            : args[1].includes('CFBundleExecutable')
              ? 'lab-owned-player'
              : 'TalkQTE Lab Player',
        };
      assert.equal(command, '/usr/bin/codesign');
      if (args[0] === '--verify') {
        verifyCalls++;
        return { status: invalidSeal ? 1 : 0 };
      }
      return {
        status: 0,
        stdout: '',
        stderr:
          'Identifier=com.talkqte.lab-player\nAuthority=TalkQTE Development\ndesignated => ' +
          requirement +
          '\n',
      };
    });
    syncBuiltinESMExports();
    try {
      const build = verifyLabPlayerBuild({ manifestFile, approved });
      assert.equal(verifyCalls, 1);
      build.check();
      assert.equal(verifyCalls, 2);
      // An altered sealed resource does not change executable digest/stamp.
      invalidSeal = true;
      assert.throws(() => build.check());
      assert.equal(verifyCalls, 3);
      assert.throws(() =>
        verifyLabPlayerBuild({
          manifestFile,
          approved: { ...approved, executableSha256: 'b'.repeat(64) },
        }),
      );
    } finally {
      mock.restoreAll();
      syncBuiltinESMExports();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test('sleep between probe and render cannot silently rebase the absolute/continuous offset', () => {
  const f = structuredClone(frame);
  // Audio absolute time excludes sleep; libuv continuous time advances 300ms.
  f.clockPair.continuousTicks = String(
    BigInt(f.clockPair.continuousTicks) + 300000000n,
  );
  assert.throws(() => mapLabPlayerStart(f, bridge, { nowMs: 1500 }));
});
test('existing nonzero sleep offset maps render ticks into continuous time explicitly', () => {
  const offset = 300000000n,
    f = structuredClone(frame),
    b = { ...bridge };
  b.hostTicks = String(BigInt(b.hostTicks) + offset);
  f.clockPair.continuousTicks = String(
    BigInt(f.clockPair.continuousTicks) + offset,
  );
  assert.equal(mapLabPlayerStart(f, b, { nowMs: 1200 }).monotonicMs, 1001);
});
test('clock read brackets may straddle a zero offset without unsigned underflow', () => {
  const f = structuredClone(frame),
    b = { ...bridge };
  b.absoluteBeforeTicks = '9999999999';
  b.absoluteAfterTicks = '10000000001';
  f.clockPair.absoluteBeforeTicks = '10019999999';
  f.clockPair.absoluteAfterTicks = '10020000001';
  assert.equal(mapLabPlayerStart(f, b, { nowMs: 1200 }).monotonicMs, 1001);
});
test('Swift checks clock discontinuity throughout render and disables AVPlayer stalling wait before host-time rate', () => {
  const swift = readFileSync(
    new URL('./lab-owned-player.swift', import.meta.url),
    'utf8',
  );
  assert.match(
    swift,
    /try require\(low <= offset.high && high >= offset.low\)/,
  );
  assert.match(
    swift,
    /do \{ pair = try clockPair\(\) \} catch \{ return stop\(failure: true\) \}/,
  );
  assert.ok(
    swift.indexOf('video.automaticallyWaitsToMinimizeStalling = false') <
      swift.indexOf('video?.setRate'),
  );
});

test('saved media audio edit duration accepts its natural end without padding to the longer video', () => {
  const durations = validateLabPlayerDurations({
    totalFrames: 4848912,
    audioTrackDurationMs: 101019,
    assetDurationMs: 102480,
  });
  assert.equal(durations.audioDurationMs, 101019);
  assert.equal(durations.videoOnlyTailMs, 1461);
  assert.throws(() =>
    validateLabPlayerDurations({
      totalFrames: 4848912,
      audioTrackDurationMs: 102480,
      assetDurationMs: 102480,
    }),
  );
  assert.throws(() =>
    validateLabPlayerDurations({
      totalFrames: 4919040,
      audioTrackDurationMs: 101019,
      assetDurationMs: 102480,
    }),
  );
});
async function waitForAudio(player) {
  const deadline = performance.now() + 2000;
  while (!player.diagnostics.audioCompleted) {
    assert.ok(performance.now() < deadline, 'fixture audio evidence deadline');
    await new Promise((r) => setTimeout(r, 1));
  }
}

test('natural audio completion alone does not resolve play until separate final video evidence', async () => {
  const player = createLabPlayerFixture({
    ...fixtureOptions,
    fixtureCase: 'video-tail',
  });
  try {
    await player.prepare({ media });
    let resolved = false;
    const resultPromise = player.play({ media, onStarted() {} }).then((r) => {
      resolved = true;
      return r;
    });
    // Wait for the actual protocol event, not a manufactured playback timestamp.
    await waitForAudio(player);
    assert.equal(resolved, false);
    assert.equal(player.diagnostics.videoCompleted, false);
    const result = await resultPromise;
    assert.equal(result.durations.videoOnlyTailMs, 1461);
    assert.equal(result.audioCompletion.framesPlayed, 4848912);
    assert.equal(result.audioCompletion.basis, 'receipt');
    assert.equal(result.videoCompletion.videoTimeMs, 102480);
    assert.equal(result.videoCompletion.basis, 'receipt');
    assert.ok(
      result.videoCompletion.receivedMonotonicMs >=
        result.audioCompletion.receivedMonotonicMs,
    );
    await player.close({ nativeReleased: true });
  } finally {
    await player.close({ nativeReleased: true }).catch(() => {});
  }
});
test('missing video completion stays pending and Stop cannot invent final completion', async () => {
  const player = createLabPlayerFixture({
    ...fixtureOptions,
    fixtureCase: 'missing-video',
  });
  try {
    await player.prepare({ media });
    const result = player.play({ media, onStarted() {} });
    const rejected = assert.rejects(result);
    await waitForAudio(player);
    await player.stop();
    await rejected;
    assert.equal(player.diagnostics.videoCompleted, false);
    await player.close({ nativeReleased: true });
  } finally {
    await player.close({ nativeReleased: true }).catch(() => {});
  }
});
test('abort after audio end but before final video remains cancellation, not completed playback', async () => {
  const player = createLabPlayerFixture({
    ...fixtureOptions,
    fixtureCase: 'video-tail',
  });
  const controller = new AbortController();
  try {
    await player.prepare({ media });
    const pending = player.play({
      media,
      signal: controller.signal,
      onStarted() {},
    });
    const rejected = assert.rejects(pending);
    await waitForAudio(player);
    controller.abort();
    await rejected;
    assert.equal(player.diagnostics.failure.category, 'cancelled');
    await assert.rejects(player.close({ nativeReleased: true }));
    assert.equal(player.diagnostics.failure.category, 'cancelled');
  } finally {
    await player.close({ nativeReleased: true }).catch(() => {});
  }
});
test('completed playback releases caller abort ownership but does not forgive failed retirement', async () => {
  const player = createLabPlayerFixture({
    ...fixtureOptions,
    fixtureCase: 'held-pipes',
  });
  const controller = new AbortController();
  try {
    await player.prepare({ media, signal: controller.signal });
    const result = await player.play({
      media,
      signal: controller.signal,
      onStarted() {},
    });
    assert.equal(result.completed, true);
    controller.abort();
    assert.equal(player.diagnostics.failure, null);
    assert.deepEqual(await player.stop(), { stopped: true });
    // A descendant holding pipes remains a genuine cleanup failure after audio/video end.
    await assert.rejects(player.close({ nativeReleased: true }));
  } finally {
    await player.close({ nativeReleased: true }).catch(() => {});
  }
});
test('fixed failed preparation stage and numeric diagnostics survive Stop/cleanup failure', async () => {
  const player = createLabPlayerFixture({
    ...fixtureOptions,
    fixtureCase: 'prepare-failed',
  });
  const controller = new AbortController();
  await assert.rejects(player.prepare({ media, signal: controller.signal }));
  controller.abort(); // Later cancellation cannot replace the earlier fixed failed stage.
  await assert.rejects(player.close({ nativeReleased: true }));
  assert.deepEqual(player.diagnostics.failure, {
    category: 'player-failure',
    stage: 'audio-duration',
    decodedFrames: 4848912,
    audioTrackDurationMs: 101019,
    assetDurationMs: 102480,
  });
  assert.equal(player.diagnostics.process.exitCode, 0);
  assert.equal(player.diagnostics.preparationProgress.stage, 'launch');
  assert.equal(player.diagnostics.failure.stage, 'audio-duration');
  assert.equal(player.diagnostics.stderrBytes, 0);
});
test('unexpected prepare exit retains only bounded exit/signal/category, never raw stderr', async () => {
  const player = createLabPlayerFixture({
    ...fixtureOptions,
    fixtureCase: 'exit-prepare',
  });
  await assert.rejects(player.prepare({ media }));
  await assert.rejects(player.close({ nativeReleased: true }));
  assert.equal(player.diagnostics.failure.category, 'process-exit');
  assert.deepEqual(player.diagnostics.process, { exitCode: 7, signal: null });
  assert.equal(Object.hasOwn(player.diagnostics, 'stderr'), false);
});

test('unexpected prepare signal is retained independently of fixed protocol failure', async () => {
  const player = createLabPlayerFixture({
    ...fixtureOptions,
    fixtureCase: 'signal-prepare',
  });
  await assert.rejects(player.prepare({ media }));
  await assert.rejects(player.close({ nativeReleased: true }));
  assert.equal(player.diagnostics.failure.category, 'process-exit');
  assert.deepEqual(player.diagnostics.process, {
    exitCode: null,
    signal: 'SIGTERM',
  });
});

test('caller abort from genuine started observation retains cancelled diagnostics through cleanup', async () => {
  const player = createLabPlayerFixture(fixtureOptions);
  const controller = new AbortController();
  try {
    await player.prepare({ media, signal: controller.signal });
    let starts = 0;
    await assert.rejects(
      player.play({
        media,
        signal: controller.signal,
        onStarted() {
          starts++;
          controller.abort();
        },
      }),
    );
    assert.equal(starts, 1);
    await assert.rejects(player.close({ nativeReleased: true }));
    assert.deepEqual(player.diagnostics.failure, { category: 'cancelled' });
    assert.equal(player.diagnostics.audioCompleted, false);
    assert.equal(player.diagnostics.videoCompleted, false);
  } finally {
    await player.close({ nativeReleased: true }).catch(() => {});
  }
});

test('preparation deadline retains fixed last progress independently of terminal first failure', async () => {
  const player = createLabPlayerFixture({
    ...fixtureOptions,
    fixtureCase: 'progress-deadline',
  });
  const controller = new AbortController();
  try {
    await assert.rejects(player.prepare({ media, signal: controller.signal }));
    controller.abort();
    await assert.rejects(player.close({ nativeReleased: true }));
    assert.deepEqual(player.diagnostics.failure, { category: 'deadline' });
    assert.equal(
      player.diagnostics.preparationProgress.stage,
      'engine-connect',
    );
    assert.equal(player.diagnostics.preparationProgress.basis, 'receipt');
    assert.equal(player.diagnostics.preparationProgressCount, 8);
    assert.equal(player.diagnostics.prepared, false);
  } finally {
    await player.close({ nativeReleased: true }).catch(() => {});
  }
});
for (const fixtureCase of [
  'progress-duplicate',
  'progress-unknown',
  'wrong-pcm-format',
]) {
  test(`preparation rejects ${fixtureCase} without promoting progress to readiness`, async () => {
    const player = createLabPlayerFixture({ ...fixtureOptions, fixtureCase });
    await assert.rejects(player.prepare({ media }));
    await assert.rejects(player.close({ nativeReleased: true }));
    assert.equal(player.diagnostics.failure.category, 'protocol');
    assert.equal(player.diagnostics.prepared, false);
    assert.ok(player.diagnostics.preparationProgressCount <= 12);
  });
}

test('clock transport diagnostics survive deadline and allow independent late Stop acknowledgement', async () => {
  const player = createLabPlayerFixture({
    ...fixtureOptions,
    fixtureCase: 'no-clock',
  });
  await assert.rejects(player.prepare({ media }));
  await assert.rejects(player.close({ nativeReleased: true }));
  const d = player.diagnostics;
  assert.equal(d.failure.category, 'deadline');
  assert.equal(d.transport.clockProbeQueued, true);
  assert.equal(d.transport.clockProbeParsed, true);
  assert.equal(d.transport.clockProbeApplied, true);
  assert.equal(d.transport.clockSampleReceived, false);
  assert.equal(d.transport.stoppedAcknowledged, true);
  assert.equal(d.process.exitCode, 0); // Acknowledged retirement is distinct from failed-run cleanup result.
});
test('unbounded control diagnostics fail protocol without replacing first failure', async () => {
  const player = createLabPlayerFixture({
    ...fixtureOptions,
    fixtureCase: 'bad-transport',
  });
  await assert.rejects(player.prepare({ media }));
  await assert.rejects(player.close({ nativeReleased: true }));
  assert.equal(player.diagnostics.failure.category, 'protocol');
  assert.equal(player.diagnostics.transport.parsedCommands, 0);
});
