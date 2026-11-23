import assert from 'node:assert/strict';
import { test as nodeTest, mock } from 'node:test';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import {
  mkdtempSync,
  chmodSync,
  rmSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLabRecorderFixture } from './cue-lab-recorder.mjs';
const test = (name, fn) =>
  nodeTest(name, { skip: process.platform === 'win32' }, fn);
function fixture(mode, extra = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'tq-recorder-'));
  chmodSync(directory, 0o700);
  const identity = { runId: 'owned-run', pid: 44001 };
  const recorder = createLabRecorderFixture({
    directory,
    fixtureCase: mode,
    native: { identity },
    selectWindows: async () => ({
      emulator: { app: 'QuickTime Player', pid: 44002, windowId: 1 },
      companion: { app: 'TalkQTE', pid: 44001, windowId: 2 },
    }),
    startupMs: 1000,
    stopMs: 200,
    seconds: 1,
    ...extra,
  });
  return {
    recorder,
    close: () => rmSync(directory, { recursive: true, force: true }),
  };
}
for (const mode of ['normal', 'partial', 'moved', 'missing'])
  test(
    'real harmless child ' +
      mode +
      ' needs accepted frame and completed finalization',
    async () => {
      const f = fixture(mode);
      try {
        assert.deepEqual(await f.recorder.start({ runId: 'owned-run' }), {
          started: true,
        });
        const stop = f.recorder.stop();
        assert.equal(stop, f.recorder.stop());
        assert.deepEqual(await stop, { stopped: true });
        // The helper's final report: frames written and whether a window
        // moved or resized after its place in the picture was fixed.
        const { timings, ...report } = f.recorder.report;
        // Milliseconds from spawn to each start line, in order.
        assert.ok(
          Number.isSafeInteger(timings.matchedMs) &&
            timings.matchedMs >= 0 &&
            timings.filtersMs >= timings.matchedMs &&
            timings.frameAcceptedMs >= timings.filtersMs,
        );
        assert.deepEqual(report, {
          frames: 1,
          audioBuffers: 1,
          windowsMoved: mode === 'moved',
          windowsResized: false,
          windowsMissing: mode === 'missing',
          geometry: {
            emulator: { x: 100, y: 80, width: 960, height: 568 },
            companion: { x: 700, y: 620, width: 320, height: 76 },
            picture: { width: 1840, height: 1272, scale: 2 },
          },
          filters: { emulator: 'independent', companion: 'display' },
        });
      } finally {
        f.close();
      }
    },
  );
for (const mode of [
  'wrong',
  'spawn-only',
  'oversize',
  'early',
  'truncated',
  'stderr',
  'duplicate',
  'bad-utf8',
])
  test('no recording readiness from ' + mode, async () => {
    const f = fixture(mode);
    try {
      await assert.rejects(f.recorder.start({ runId: 'owned-run' }));
      await assert.rejects(f.recorder.stop());
    } finally {
      f.close();
    }
  });
test("a helper failure keeps its exit and fixed reason, never the helper's message", async () => {
  const f = fixture('error');
  try {
    await assert.rejects(f.recorder.start({ runId: 'owned-run' }));
    await f.recorder.stop().catch(() => {});
    const detail = f.recorder.failureDetail;
    assert.deepEqual(
      [detail.exit, detail.errorReason, detail.frameAccepted],
      [{ code: 2, signal: null }, 'output-write', false],
    );
    // No macOS stream code and no start line before this failure.
    assert.equal(detail.errorCode, null);
    assert.deepEqual(
      { ...detail.timings },
      { matchedMs: null, filtersMs: null, frameAcceptedMs: null },
    );
    assert.doesNotMatch(JSON.stringify(detail), /fictional|denied/);
  } finally {
    f.close();
  }
});
for (const [mode, reason, matched] of [
  ['list-timeout', 'list-timeout', false],
  ['start-timeout', 'start-timeout', true],
])
  test(`a helper that timed out (${reason}) fails the start with its fixed reason`, async () => {
    const f = fixture(mode);
    try {
      await assert.rejects(f.recorder.start({ runId: 'owned-run' }));
      await f.recorder.stop().catch(() => {});
      const detail = f.recorder.failureDetail;
      assert.deepEqual(
        [detail.exit, detail.errorReason, detail.errorCode, detail.matched],
        [{ code: 2, signal: null }, reason, null, matched],
      );
      assert.equal(detail.frameAccepted, false);
      assert.equal(detail.timings.frameAcceptedMs, null);
      assert.equal(detail.timings.matchedMs === null, !matched);
    } finally {
      f.close();
    }
  });
test('a stream macOS stopped keeps its fixed reason, code and start timings, never its text', async () => {
  const f = fixture('stream-stopped');
  try {
    await assert.rejects(f.recorder.start({ runId: 'owned-run' }));
    await f.recorder.stop().catch(() => {});
    const detail = f.recorder.failureDetail;
    assert.deepEqual(
      [
        detail.exit,
        detail.errorReason,
        detail.errorCode,
        detail.frameAccepted,
        detail.matched,
        { ...detail.filters },
      ],
      [
        { code: 1, signal: null },
        'stream-stopped',
        -3805,
        false,
        true,
        { emulator: 'independent', companion: 'display' },
      ],
    );
    assert.ok(Number.isSafeInteger(detail.timings.matchedMs));
    assert.ok(detail.timings.filtersMs >= detail.timings.matchedMs);
    assert.equal(detail.timings.frameAcceptedMs, null);
    assert.equal(f.recorder.report, null);
    assert.doesNotMatch(JSON.stringify(detail), /fictional|interruption/);
  } finally {
    f.close();
  }
});
for (const mode of [
  'bad-final',
  'exit1',
  'ignore-stop',
  'no-audio',
  'no-artifact',
])
  test(
    'failed or forced finalization never becomes success ' + mode,
    async () => {
      const f = fixture(mode);
      try {
        await f.recorder.start({ runId: 'owned-run' });
        await assert.rejects(f.recorder.stop());
      } finally {
        f.close();
      }
    },
  );
test('wrong native process identity and Stop during window selection cannot launch later', async () => {
  let resolve;
  const pending = new Promise((yes) => (resolve = yes));
  const f = fixture('normal', { selectWindows: () => pending });
  try {
    const start = f.recorder.start({ runId: 'owned-run' });
    await f.recorder.stop();
    resolve({
      emulator: { app: 'QuickTime Player', pid: 44002, windowId: 1 },
      companion: { app: 'TalkQTE', pid: 44001, windowId: 2 },
    });
    await assert.rejects(start);
  } finally {
    f.close();
  }
  const g = fixture('normal');
  try {
    await assert.rejects(g.recorder.start({ runId: 'foreign' }));
    await g.recorder.stop();
  } finally {
    g.close();
  }
});
test('strict Swift source gates exact identities before streams and readiness after successful append', () => {
  const source = readFileSync(
    fileURLToPath(new URL('./lab-window-capture.swift', import.meta.url)),
    'utf8',
  );
  assert.match(
    source,
    /windowID == emulatorId && \$0\.owningApplication\?\.processID == emulatorPid/,
  );
  assert.match(
    source,
    /windowID == companionId && \$0\.owningApplication\?\.processID == companionPid/,
  );
  assert.ok(
    source.indexOf('if strictWindows {') <
      source.indexOf('let emulatorStream ='),
  );
  assert.match(
    source,
    /guard strictWindows && streamsStarted && frames > 0 && !frameReported && problem == nil/,
  );
  assert.match(source, /&& writer.status == \.writing else/);
  assert.match(
    source,
    /adaptor\.append\(output, withPresentationTime: time\) \{\s*lastTime = time\s*frames \+= 1\s*reportReady\(\)/,
  );
  // Each window is captured on its own, never through a display filter
  // that shows only the active Space (RunB07's black recording).
  // Both windows get the desktop-independent filter, and the filters event
  // says so; no child process probes it first.
  assert.match(
    source,
    /let emulatorFilter = SCContentFilter\(desktopIndependentWindow: emulatorNow\)/,
  );
  assert.match(
    source,
    /let companionFilter = SCContentFilter\(desktopIndependentWindow: companionNow\)/,
  );
  assert.match(source, /let emulatorKind = "independent"/);
  assert.match(source, /let companionKind = "independent"/);
  assert.doesNotMatch(
    source,
    /Process\(\)|probe-window|SCContentFilter\(display: onDisplay/,
  );
  // Sizes, crops, placement and the canvas use the windows as re-read.
  assert.match(
    source,
    /let union = emulatorNow\.frame\.union\(companionNow\.frame\)/,
  );
  assert.match(source, /windowConfiguration\(companionNow\)/);
  assert.match(source, /placeOf\(companionNow\)/);
  assert.doesNotMatch(source, /placeOf\(companion\)|placeOf\(emulator\)/);
  // Every failure carries a fixed reason code: each direct fail() call
  // (less the definition and bounded()'s own) names one, and so does each
  // bounded() call.
  assert.equal(
    source.match(/\bfail\(/g).length - 2 + source.match(/\bbounded\(1/g).length,
    source.match(/, reason: "[a-z][a-z-]*"\)/g).length,
  );
  assert.match(source, /code: 2, reason: reason\)/);
  // The window server is connected before any ScreenCaptureKit call (an
  // unconnected process aborts on the independent filter).
  assert.ok(
    source.indexOf('_ = CGMainDisplayID()') <
      source.indexOf('let options = parseArguments()'),
  );
  // Nothing before the first frame can hang silently: the listing and each
  // stream start are bounded and end with a fixed reason. The only
  // ScreenCaptureKit listing is the bounded one.
  assert.match(
    source,
    /let listed = await listWindows\(onScreenOnly: true, within: 1\.5\)/,
  );
  assert.match(source, /reason: "list-timeout"\)/);
  assert.doesNotMatch(source, /SCShareableContent\.excludingDesktopWindows/);
  for (const stream of ['emulatorStream', 'companionStream', 'soundStream'])
    assert.match(
      source,
      new RegExp(
        `try await bounded\\(1\\.5, reason: "start-timeout"\\) \\{ try await ${stream}\\.startCapture\\(\\) \\}`,
      ),
    );
  // A stream macOS stops is reported with a fixed reason and its code.
  assert.match(
    source,
    /didStopWithError error: Error\) \{\s*let code = \(error as NSError\)\.code\s*emit\(\["event": "error", "reason": "stream-stopped", "code": code,/,
  );
  assert.match(source, /"event": "filters"/);
  assert.doesNotMatch(
    source,
    /SCContentFilter\(display: display, including: \[emulator, companion\]\)/,
  );
  // A window gone by the end is reported, never read as unmoved; a canvas
  // too large for the encoder is refused with the reason.
  assert.match(source, /windowsMissing = true/);
  assert.match(source, /"windowsMissing": windowsMissing/);
  assert.match(source, /guard width <= 8192 && height <= 8192 else \{/);
  assert.match(source, /Put both on one display\./);
  // A fixed drawing order: the player first, the companion (cue card) last.
  assert.match(source, /for key in order \{/);
  assert.ok(
    source.indexOf('writer.place(emulatorStream') <
      source.indexOf('writer.place(companionStream'),
  );
  // The canvas is the windows' union alone (as re-read, asserted above),
  // not clipped to one display.
  assert.ok(
    source.indexOf('try await soundStream.startCapture() }') <
      source.indexOf('let signals ='),
  );
  assert.ok(
    source.indexOf('source.resume()') <
      source.indexOf('writer.streamsStarted = true'),
  );
  assert.match(source, /if !strictWindows \{ emit\(\["event": "started"/);
});

function mockedRecorder() {
  const groupSignals = [];
  let present = true;
  const child = Object.assign(new EventEmitter(), {
    pid: 56789,
    exitCode: null,
    signalCode: null,
    stdout: Object.assign(new EventEmitter(), { destroy() {} }),
    stderr: Object.assign(new EventEmitter(), { destroy() {} }),
  });
  mock.method(childProcess, 'spawn', (binary) => {
    child.spawnfile = binary;
    queueMicrotask(() => {
      emit({
        event: 'matched',
        emulator: { app: 'QuickTime Player', pid: 44002, windowId: 1 },
        companion: {
          app: 'TalkQTE',
          pid: 44001,
          windowId: 2,
          rule: 'exact pid/window',
        },
      });
      emit({ event: 'frame_accepted', frames: 1, wallMs: 1 });
    });
    return child;
  });
  mock.method(process, 'kill', (pid, signal) => {
    assert.equal(pid, -56789);
    groupSignals.push(signal);
    if (signal === 0 && !present)
      throw Object.assign(Error('absent'), { code: 'ESRCH' });
    if (signal === 'SIGKILL') present = false;
    return true;
  });
  syncBuiltinESMExports();
  const f = fixture('normal', { stopMs: 20 });
  function emit(value) {
    child.stdout.emit('data', Buffer.from(JSON.stringify(value) + '\n'));
  }
  return {
    ...f,
    child,
    groupSignals,
    finish(groupPresent = true) {
      present = groupPresent;
      writeFileSync(f.recorder.output, 'fictional mock artifact', {
        mode: 0o600,
      });
      emit({
        event: 'stopped',
        frames: 1,
        audioBuffers: 1,
        status: 'completed',
        problem: '',
      });
      child.exitCode = 0;
      child.emit('close', 0, null);
    },
    close() {
      mock.restoreAll();
      syncBuiltinESMExports();
      f.close();
    },
  };
}
const bounded = (promise) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(Error('recorder settlement timed out')),
      500,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
for (const mode of ['parent-exited-pipes-held', 'termination-without-close'])
  test(`owned group is retired and missing close is bounded: ${mode}`, async () => {
    const f = mockedRecorder();
    try {
      await f.recorder.start({ runId: 'owned-run' });
      if (mode === 'parent-exited-pipes-held') f.child.exitCode = 0;
      await assert.rejects(
        bounded(f.recorder.stop()),
        (error) => error.category === 'cleanup',
      );
      assert.ok(f.groupSignals.includes('SIGTERM'));
      assert.ok(f.groupSignals.includes('SIGKILL'));
    } finally {
      f.close();
    }
  });
test('valid parent close with surviving group retires descendants and remains failed cleanup', async () => {
  const f = mockedRecorder();
  try {
    await f.recorder.start({ runId: 'owned-run' });
    f.finish(true);
    await assert.rejects(
      bounded(f.recorder.stop()),
      (error) => error.category === 'cleanup',
    );
    assert.ok(f.groupSignals.includes(0));
    assert.ok(f.groupSignals.includes('SIGKILL'));
  } finally {
    f.close();
  }
});
test('successful completed parent close also confirms owned group absence', async () => {
  const f = mockedRecorder();
  try {
    await f.recorder.start({ runId: 'owned-run' });
    f.finish(false);
    assert.deepEqual(await bounded(f.recorder.stop()), { stopped: true });
    assert.ok(f.groupSignals.includes(0));
    assert.equal(f.groupSignals.includes('SIGKILL'), false);
  } finally {
    f.close();
  }
});
