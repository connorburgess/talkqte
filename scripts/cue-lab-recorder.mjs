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
    if (value.event === 'matched') {
      requireThat(!matched && !accepted);
      for (const key of ['emulator', 'companion'])
        requireThat(
          ['app', 'pid', 'windowId'].every(
            (k) => value[key]?.[k] === windows[key][k],
          ),
        );
      requireThat(value.companion.rule === 'exact pid/window');
      matched = true;
    } else if (value.event === 'frame_accepted') {
      requireThat(
        matched &&
          !accepted &&
          !final &&
          integer(value.frames) &&
          Number.isSafeInteger(value.wallMs),
      );
      accepted = true;
      clearTimeout(startTimer);
      resolveStart({ started: true });
    } else if (value.event === 'stopped') {
      requireThat(
        accepted &&
          !final &&
          value.status === 'completed' &&
          value.problem === '' &&
          integer(value.frames) &&
          integer(value.audioBuffers),
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
          windows.emulator.app === 'QuickTime Player' &&
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
      'partial',
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
    ].includes(options.fixtureCase),
  );
  return recorder({
    ...options,
    binary: process.execPath,
    sha256: hash(process.execPath),
  });
}
