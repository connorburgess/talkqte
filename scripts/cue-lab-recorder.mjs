// Strict owned helper adapter. No helper build, UI action or fallback.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  realpathSync,
  lstatSync,
  openSync,
  closeSync,
  readSync,
  fstatSync,
  constants,
  mkdtempSync,
  chmodSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative, isAbsolute, sep } from 'node:path';
import { TextDecoder } from 'node:util';
import { parseUniqueLabJson } from './cue-lab-strict-json.mjs';
import { gateFailure } from './cue-lab-operation-gate.mjs';
import { checkLabPlayerSource } from './cue-lab-player.mjs';

const root = realpathSync(fileURLToPath(new URL('../', import.meta.url)));
const requireThat = (x) => {
  if (!x) throw gateFailure('protocol');
};
const outside = (path) => {
  const r = relative(root, realpathSync(path));
  return r === '..' || r.startsWith('..' + sep) || isAbsolute(r);
};
const integer = (n) => Number.isSafeInteger(n) && n > 0 && n <= 2147483647;
const hash = (path) => {
  const s = lstatSync(path);
  requireThat(
    s.isFile() &&
      !s.isSymbolicLink() &&
      s.size > 0 &&
      s.size <= 512 * 1024 * 1024,
  );
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stamp = (x) =>
      [x.dev, x.ino, x.size, x.mode, x.mtimeMs, x.ctimeMs].join(':');
    requireThat(stamp(s) === stamp(fstatSync(fd)));
    const digest = createHash('sha256'),
      chunk = Buffer.alloc(65536);
    let got;
    while ((got = readSync(fd, chunk, 0, chunk.length, null)) > 0)
      digest.update(chunk.subarray(0, got));
    requireThat(stamp(s) === stamp(fstatSync(fd)));
    return digest.digest('hex');
  } finally {
    closeSync(fd);
  }
};
function recorder({
  binary,
  sha256,
  directory,
  selectWindows,
  native,
  seconds = 120,
  startupMs = 5000,
  stopMs = 6000,
  fixtureCase,
  playerSource,
}) {
  requireThat(
    isAbsolute(binary ?? '') &&
      realpathSync(binary) === binary &&
      outside(binary) &&
      /^[a-f0-9]{64}$/.test(sha256 ?? '') &&
      hash(binary) === sha256 &&
      typeof selectWindows === 'function' &&
      native &&
      Number.isSafeInteger(seconds) &&
      seconds > 0 &&
      seconds <= 180 &&
      [startupMs, stopMs].every(
        (n) => Number.isSafeInteger(n) && n > 0 && n <= 10000,
      ),
  );
  if (playerSource) checkLabPlayerSource(playerSource);
  const parent = realpathSync(directory);
  requireThat(
    outside(parent) &&
      lstatSync(parent).isDirectory() &&
      (lstatSync(parent).mode & 0o777) === 0o700 &&
      lstatSync(parent).uid === process.getuid?.(),
  );
  const work = realpathSync(mkdtempSync(join(parent, 'record-')));
  chmodSync(work, 0o700);
  const output = join(work, 'capture.mov');
  const listeners = new Set();
  let child,
    pid,
    used = false,
    matched = false,
    geometry = null,
    // Which filter each window got (independent of the active Space, or a
    // single-window display filter), as the helper reported it.
    filters = null,
    // Why the helper stopped, if it failed: its exit code or signal and its
    // last error line (fixed helper text, bounded), for OUTCOME.
    exitStatus = null,
    errorReason = null,
    // macOS's numeric code when a stream stopped (stream-stopped), else null.
    errorCode = null,
    // Milliseconds from spawning the helper to its matched, filters and
    // frame_accepted lines, to check the start deadline against.
    spawnedAt = null,
    timings = { matchedMs: null, filtersMs: null, frameAcceptedMs: null },
    accepted = false,
    final = null,
    invalid = false,
    stopping = null,
    startTimer,
    stopTimer,
    hardTimer,
    groupTimer,
    endSettled = false,
    resolveStart,
    rejectStart,
    resolveEnd,
    rejectEnd,
    signal,
    abort,
    bytes = 0,
    partial = Buffer.alloc(0),
    windows,
    closed = false,
    completed = false;
  const started = new Promise((yes, no) => {
    resolveStart = yes;
    rejectStart = no;
  });
  started.catch(() => {});
  const ended = new Promise((yes, no) => {
    resolveEnd = yes;
    rejectEnd = no;
  });
  ended.catch(() => {});
  const notify = () => {
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        invalid = true;
      }
    }
  };
  const fail = () => {
    if (invalid) return;
    invalid = true;
    rejectStart(gateFailure('protocol'));
    void stop().catch(() => {});
    notify();
  };
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const group = (name) => {
    if (!integer(pid) || child?.pid !== pid || child?.spawnfile !== binary) {
      invalid = true;
      return true;
    }
    try {
      process.kill(-pid, name);
      return true;
    } catch (error) {
      if (error.code === 'ESRCH') return false;
      invalid = true;
      return true;
    }
  };
  const finishEnd = (success) => {
    if (endSettled) return;
    endSettled = true;
    for (const timer of [startTimer, stopTimer, hardTimer, groupTimer])
      clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    if (success && !invalid) resolveEnd();
    else {
      invalid = true;
      rejectStart(gateFailure('protocol'));
      rejectEnd(gateFailure('cleanup'));
      notify();
    }
  };
  const retireAfterClose = () => {
    if (endSettled) return;
    if (!group(0)) return finishEnd(completed);
    // A surviving group after parent/pipe close is unexpected. Retire it but
    // never report its forced cleanup as a successful recording.
    invalid = true;
    group('SIGKILL');
    const until = performance.now() + 100;
    const verify = () => {
      if (!group(0) || performance.now() >= until) return finishEnd(false);
      groupTimer = setTimeout(verify, 10);
    };
    verify();
  };
  function frame(value) {
    requireThat(value && typeof value === 'object' && !Array.isArray(value));
    const since = () =>
      spawnedAt === null ? null : Math.round(performance.now() - spawnedAt);
    if (value.event === 'matched') {
      requireThat(!matched && !accepted);
      for (const key of ['emulator', 'companion'])
        requireThat(
          ['app', 'pid', 'windowId'].every(
            (k) => value[key]?.[k] === windows[key][k],
          ),
        );
      requireThat(value.companion.rule === 'exact pid/window');
      // Where each window sits and the picture's size and scale, as numbers
      // only, so a run can locate a region (the player's captions) in the
      // recording.
      const rect = (r) =>
        ['x', 'y', 'width', 'height'].every((k) => Number.isFinite(r?.[k])) &&
        r.width > 0 &&
        r.height > 0;
      if (value.emulator.frame !== undefined || value.picture !== undefined) {
        requireThat(
          rect(value.emulator.frame) &&
            rect(value.companion.frame) &&
            integer(value.picture?.width) &&
            integer(value.picture?.height) &&
            Number.isFinite(value.picture.scale) &&
            value.picture.scale > 0,
        );
        const pick = (r) =>
          Object.freeze({ x: r.x, y: r.y, width: r.width, height: r.height });
        geometry = Object.freeze({
          emulator: pick(value.emulator.frame),
          companion: pick(value.companion.frame),
          picture: Object.freeze({
            width: value.picture.width,
            height: value.picture.height,
            scale: value.picture.scale,
          }),
        });
      }
      matched = true;
      timings.matchedMs = since();
    } else if (value.event === 'filters') {
      const kind = (k) => ['independent', 'display'].includes(value[k]?.kind);
      requireThat(
        matched &&
          !accepted &&
          !filters &&
          kind('emulator') &&
          kind('companion'),
      );
      filters = Object.freeze({
        emulator: value.emulator.kind,
        companion: value.companion.kind,
      });
      timings.filtersMs = since();
    } else if (value.event === 'error') {
      // Only the helper's fixed reason code is kept: its message may name
      // the recording's path or carry macOS's own text. The start then
      // fails as before.
      if (
        typeof value.reason === 'string' &&
        /^[a-z][a-z-]{0,39}$/.test(value.reason)
      )
        errorReason ??= value.reason;
      if (
        errorCode === null &&
        Number.isSafeInteger(value.code) &&
        Math.abs(value.code) < 2 ** 31
      )
        errorCode = value.code;
      throw gateFailure('protocol');
    } else if (value.event === 'frame_accepted') {
      requireThat(
        matched &&
          !accepted &&
          !final &&
          integer(value.frames) &&
          Number.isSafeInteger(value.wallMs),
      );
      accepted = true;
      timings.frameAcceptedMs = since();
      clearTimeout(startTimer);
      resolveStart({ started: true });
    } else if (value.event === 'stopped') {
      requireThat(
        accepted &&
          !final &&
          value.status === 'completed' &&
          value.problem === '' &&
          integer(value.frames) &&
          integer(value.audioBuffers) &&
          // Whether either window moved or resized after the start, when
          // the picture's placement was fixed.
          ['windowsMoved', 'windowsResized', 'windowsMissing'].every(
            (k) => value[k] === undefined || typeof value[k] === 'boolean',
          ),
      );
      final = value;
    } else throw gateFailure('protocol');
  }
  function chunk(data, stdout) {
    if (endSettled) return;
    try {
      bytes += data.length;
      requireThat(bytes <= 256 * 1024);
      if (!stdout) return;
      partial = Buffer.concat([partial, data]);
      for (let i; (i = partial.indexOf(10)) !== -1;) {
        requireThat(i <= 16384);
        const line = partial.subarray(0, i);
        partial = partial.subarray(i + 1);
        frame(parseUniqueLabJson(decoder.decode(line)));
      }
      requireThat(partial.length <= 16384);
    } catch {
      fail();
    }
  }
  function stop() {
    if (stopping) return stopping;
    stopping = Promise.resolve().then(async () => {
      if (!child) {
        closed = true;
        return { stopped: true };
      }
      if (!closed) {
        if (!integer(pid) || child.pid !== pid || child.spawnfile !== binary) {
          finishEnd(false);
          return await ended;
        }
        if (child.exitCode !== null || child.signalCode !== null)
          invalid = true;
        // The owned group can outlive its parent; parent state never gates this.
        group('SIGTERM');
        stopTimer = setTimeout(() => {
          invalid = true;
          group('SIGKILL');
          // Bound missing close/pipe settlement independently of parent exit.
          hardTimer = setTimeout(() => {
            group('SIGKILL');
            for (const pipe of [child.stdout, child.stderr]) {
              try {
                pipe.destroy?.();
              } catch {}
            }
            finishEnd(false);
          }, 100);
        }, stopMs);
      }
      await ended;
      if (invalid || !completed) throw gateFailure('cleanup');
      return { stopped: true };
    });
    stopping.catch(() => {});
    return stopping;
  }
  return Object.freeze({
    // Why the helper stopped, available whether or not it succeeded: exit
    // code or signal, its fixed error reason, and whether it ever accepted
    // a frame.
    get failureDetail() {
      return exitStatus || errorReason
        ? Object.freeze({
            exit: exitStatus,
            errorReason,
            errorCode,
            frameAccepted: accepted,
            matched,
            filters,
            timings: Object.freeze({ ...timings }),
          })
        : null;
    },
    // The helper's final, content-free report once it stopped: frames and
    // sound buffers written, and whether a window moved or resized.
    get report() {
      return final
        ? Object.freeze({
            frames: final.frames,
            audioBuffers: final.audioBuffers,
            windowsMoved: final.windowsMoved ?? null,
            windowsResized: final.windowsResized ?? null,
            // A window closed or gone by the end of the run.
            windowsMissing: final.windowsMissing ?? null,
            geometry,
            filters,
            timings: Object.freeze({ ...timings }),
          })
        : null;
    },
    playerSource,
    output,
    subscribe(listener) {
      requireThat(typeof listener === 'function');
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async start({ runId, signal: inputSignal } = {}) {
      requireThat(!used && !stopping && !inputSignal?.aborted);
      used = true;
      signal = inputSignal;
      try {
        const identity = native.identity;
        requireThat(identity?.runId === runId && integer(identity.pid));
        windows = structuredClone(await selectWindows({ runId, signal }));
        for (const key of ['emulator', 'companion'])
          requireThat(
            integer(windows[key]?.pid) &&
              integer(windows[key]?.windowId) &&
              typeof windows[key]?.app === 'string' &&
              windows[key].app.length > 0 &&
              windows[key].app.length <= 100,
          );
        requireThat(
          (playerSource
            ? (checkLabPlayerSource(playerSource),
              playerSource.runId === runId &&
                windows.emulator.app === 'TalkQTE Lab Player' &&
                windows.emulator.pid === playerSource.pid &&
                windows.emulator.windowId === playerSource.windowId)
            : windows.emulator.app === 'QuickTime Player') &&
            windows.companion.pid === identity.pid &&
            windows.emulator.pid !== windows.companion.pid &&
            windows.emulator.windowId !== windows.companion.windowId,
        );
        requireThat(!stopping && !signal?.aborted && hash(binary) === sha256);
        const args = [
          '--capture',
          '--strict-windows',
          '--emulator-app',
          windows.emulator.app,
          '--emulator-pid',
          String(windows.emulator.pid),
          '--emulator-window-id',
          String(windows.emulator.windowId),
          '--companion-app',
          windows.companion.app,
          '--companion-pid',
          String(windows.companion.pid),
          '--companion-window-id',
          String(windows.companion.windowId),
          '--seconds',
          String(seconds),
          '--out',
          output,
        ];
        spawnedAt = performance.now();
        child = spawn(
          binary,
          fixtureCase
            ? [
                fileURLToPath(
                  new URL('./fixtures/lab-recorder-child.mjs', import.meta.url),
                ),
                ...args,
              ]
            : args,
          {
            shell: false,
            detached: true,
            cwd: work,
            env: fixtureCase ? { TALKQTE_RECORDER_FIXTURE: fixtureCase } : {},
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        pid = child.pid;
        child.stdout.on('data', (data) => chunk(data, true));
        child.stderr.on('data', (data) => chunk(data, false));
        child.once('error', fail);
        child.once('close', (code, termination) => {
          exitStatus = Object.freeze({
            code: Number.isSafeInteger(code) ? code : null,
            signal: typeof termination === 'string' ? termination : null,
          });
          if (endSettled) return;
          closed = true;
          clearTimeout(startTimer);
          clearTimeout(stopTimer);
          let artifact = false;
          try {
            const s = lstatSync(output);
            artifact =
              s.isFile() &&
              !s.isSymbolicLink() &&
              s.size > 0 &&
              s.uid === process.getuid?.();
            if (artifact) chmodSync(output, 0o600);
          } catch {}
          completed =
            !invalid &&
            accepted &&
            !!final &&
            !partial.length &&
            code === 0 &&
            !termination &&
            artifact;
          if (!completed) invalid = true;
          retireAfterClose();
          if (completed && !invalid && !stopping) notify();
        });
        abort = () => {
          void stop().catch(() => {});
        };
        signal?.addEventListener('abort', abort, { once: true });
        startTimer = setTimeout(fail, startupMs);
        if (signal?.aborted) abort();
        return await started;
      } catch {
        fail();
        throw gateFailure('protocol');
      }
    },
    stop,
  });
}
export function createLabRecorder(options = {}) {
  requireThat(options.fixtureCase === undefined);
  return recorder(options);
}
// Fixed harmless fixture only, no arbitrary test command/provider or real helper.
export function createLabRecorderFixture(options = {}) {
  requireThat(
    [
      'normal',
      'error',
      'partial',
      'moved',
      'missing',
      'wrong',
      'spawn-only',
      'oversize',
      'bad-final',
      'early',
      'truncated',
      'exit1',
      'stderr',
      'ignore-stop',
      'duplicate',
      'bad-utf8',
      'no-audio',
      'no-artifact',
      'stream-stopped',
    ].includes(options.fixtureCase),
  );
  return recorder({
    ...options,
    binary: process.execPath,
    sha256: hash(process.execPath),
  });
}
