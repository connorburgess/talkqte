// Explicit local file synthesis only. No audio output device, provider or player.
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants, lstatSync, realpathSync } from 'node:fs';
import { chmod, mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const fail = (category) =>
  Object.assign(new Error(`Local voice stopped: ${category}.`), { category });
const check = (value) => {
  if (!value) throw fail('protocol');
};
const integer = (n, low, high) =>
  Number.isSafeInteger(n) && n >= low && n <= high;
const id = (s) => typeof s === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(s);
const words = (s, max) =>
  typeof s === 'string' &&
  s.trim().length > 0 &&
  s.length <= max &&
  !/[\u0000-\u001f\u007f]/.test(s);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const checkout = realpathSync(fileURLToPath(new URL('../', import.meta.url)));
const external = (path) => {
  const rel = relative(checkout, realpathSync(path));
  return rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel);
};

/** Fixed say command boundary. A close event is not enough: retire its owned
 * process group and confirm absence, or report failed cleanup. */
export function runLocalSay({
  voice,
  rate,
  output,
  text,
  list = false,
  signal,
  deadlineAt,
  maxOutputBytes = 16384,
  maxFileBytes = 4 * 1024 * 1024,
} = {}) {
  check(Number.isFinite(deadlineAt) && deadlineAt > performance.now());
  check(
    integer(maxOutputBytes, 1, 65536) &&
      integer(maxFileBytes, 44, 8 * 1024 * 1024),
  );
  check(
    list ||
      (words(voice, 80) &&
        integer(rate, 80, 240) &&
        isAbsolute(output ?? '') &&
        words(text, 400) &&
        !/\[\[|\]\]/.test(text)),
  );
  if (signal?.aborted) return Promise.reject(fail('cancelled'));
  const args = list
    ? ['-v', '?']
    : [
        '-v',
        voice,
        '-r',
        String(rate),
        '--file-format=WAVE',
        '--data-format=LEI16@48000',
        '--channels=1',
        '-o',
        output,
        '-f',
        '-',
      ];
  return new Promise((resolve, reject) => {
    let child,
      problem,
      settled = false,
      bytes = 0,
      stdout = '',
      pid,
      closed = false;
    let timer, killTimer, hardTimer, poll, verifyTimer;
    const group = (name) => {
      if (!pid) return false;
      try {
        process.kill(-pid, name);
        return true;
      } catch (error) {
        if (error.code === 'ESRCH') return false;
        problem = 'cleanup';
        return true;
      }
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      for (const t of [timer, killTimer, hardTimer, verifyTimer])
        clearTimeout(t);
      clearInterval(poll);
      signal?.removeEventListener('abort', abort);
      if (problem) reject(fail(problem));
      else resolve({ stdout, cleanupConfirmed: true });
    };
    const stop = (category) => {
      if (settled) return;
      problem ??= category;
      if (hardTimer) return;
      group('SIGTERM');
      killTimer ??= setTimeout(() => group('SIGKILL'), 100);
      hardTimer ??= setTimeout(() => {
        problem = 'cleanup';
        finish();
      }, 500);
    };
    const abort = () => stop('cancelled');
    const data = (chunk, keep) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > maxOutputBytes) return stop('output-limit');
      if (keep) stdout += chunk.toString('utf8');
    };
    try {
      child = spawn('/usr/bin/say', args, {
        shell: false,
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          PATH: '/usr/bin:/bin',
          ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
        },
      });
      pid = child.pid;
      child.stdout.on('data', (chunk) => data(chunk, list));
      child.stderr.on('data', (chunk) => data(chunk, false));
      child.stdin.on('error', () => stop('process'));
      child.once('error', () => {
        problem ??= 'process';
        if (!pid) finish();
        else stop('process');
      });
      child.once('close', (code, exitSignal) => {
        closed = true;
        if (!Number.isSafeInteger(pid) || pid < 1) problem = 'cleanup';
        if (code !== 0 || exitSignal) problem ??= 'process';
        // Even a successful parent may leave descendants. Retire the group.
        group('SIGKILL');
        const until = performance.now() + 100;
        const verify = () => {
          if (!group(0)) return finish();
          if (performance.now() >= until) {
            problem = 'cleanup';
            return finish();
          }
          verifyTimer = setTimeout(verify, 10);
        };
        verify();
      });
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(
        () => stop('deadline'),
        Math.max(0, deadlineAt - performance.now()),
      );
      if (!list)
        poll = setInterval(() => {
          try {
            const s = lstatSync(output);
            if (
              !s.isFile() ||
              s.isSymbolicLink() ||
              s.size > maxFileBytes ||
              (s.mode & 0o777) !== 0o600
            )
              stop('file-limit');
          } catch {
            stop('file-limit');
          }
        }, 10);
      child.stdin.end(list ? undefined : text);
      if (signal?.aborted) abort();
    } catch {
      problem ??= 'process';
      if (pid && !closed) stop('process');
      else finish();
    }
  });
}

/** Strict bounded PCM probe; file duration is metadata, never heard timing. */
export function probeLocalWave(bytes, maxDurationMs) {
  check(
    Buffer.isBuffer(bytes) &&
      bytes.length >= 44 &&
      bytes.toString('ascii', 0, 4) === 'RIFF' &&
      bytes.toString('ascii', 8, 12) === 'WAVE',
  );
  check(bytes.readUInt32LE(4) + 8 === bytes.length);
  let offset = 12,
    format = null,
    frames = null;
  while (offset < bytes.length) {
    check(offset + 8 <= bytes.length);
    const kind = bytes.toString('ascii', offset, offset + 4),
      length = bytes.readUInt32LE(offset + 4);
    offset += 8;
    check(offset + length + (length % 2) <= bytes.length);
    if (kind === 'fmt ') {
      check(!format && (length === 16 || length === 18));
      check(
        bytes.readUInt16LE(offset) === 1 &&
          bytes.readUInt16LE(offset + 2) === 1 &&
          bytes.readUInt32LE(offset + 4) === 48000 &&
          bytes.readUInt32LE(offset + 8) === 96000 &&
          bytes.readUInt16LE(offset + 12) === 2 &&
          bytes.readUInt16LE(offset + 14) === 16,
      );
      if (length === 18) check(bytes.readUInt16LE(offset + 16) === 0);
      format = true;
    } else if (kind === 'data') {
      check(format && frames === null && length > 0 && length % 2 === 0);
      frames = length / 2;
    } else check(['JUNK', 'PAD ', 'LIST', 'fact'].includes(kind));
    offset += length + (length % 2);
  }
  check(format && frames > 0);
  const durationMs = frames / 48;
  check(durationMs <= maxDurationMs);
  return { durationMs, sampleRate: 48000, channels: 1 };
}

/** Explicit execution mode; the injected runner is allowed only for offline
 * stand-ins. Voice discovery occurs once on first synthesis, not on import. */
export function createLocalVoice({
  voices,
  rate,
  execution,
  timeoutMs = 30000,
  maxDurationMs = 30000,
  maxClipBytes = 4 * 1024 * 1024,
  maxTotalBytes = 16 * 1024 * 1024,
  maxLines = 100,
  run,
} = {}) {
  check(
    voices &&
      typeof voices === 'object' &&
      !Array.isArray(voices) &&
      Object.keys(voices).length >= 1 &&
      Object.keys(voices).length <= 20,
  );
  const pinned = Object.fromEntries(Object.entries(voices));
  check(
    Object.entries(pinned).every(
      ([speaker, voice]) =>
        words(speaker, 80) &&
        words(voice, 80) &&
        /^[A-Za-z][A-Za-z0-9 ()-]*$/.test(voice),
    ),
  );
  check(
    integer(rate, 80, 240) &&
      integer(timeoutMs, 1, 60000) &&
      integer(maxDurationMs, 1, 60000),
  );
  check(
    integer(maxClipBytes, 44, 8 * 1024 * 1024) &&
      integer(maxTotalBytes, maxClipBytes, 64 * 1024 * 1024) &&
      integer(maxLines, 1, 100),
  );
  check(
    execution === 'offline-stand-in'
      ? typeof run === 'function'
      : execution === 'local-say' &&
          process.platform === 'darwin' &&
          run === undefined,
  );
  const runner = run ?? runLocalSay;
  const root = new AbortController();
  let directory,
    active,
    closing,
    terminal,
    installed = false,
    boundRun,
    count = 0,
    bytesUsed = 0;
  const used = new Set();
  const stop = (category) => {
    terminal ??= category;
    root.abort();
  };
  const start = async (request) => {
    check(
      request &&
        typeof request === 'object' &&
        !Array.isArray(request) &&
        Object.keys(request).every((k) =>
          [
            'runId',
            'lineId',
            'speaker',
            'text',
            'signal',
            'deadlineAt',
          ].includes(k),
        ),
    );
    const { runId, lineId, speaker, text, signal, deadlineAt } = request;
    check(
      id(runId) &&
        id(lineId) &&
        words(speaker, 80) &&
        Object.hasOwn(pinned, speaker) &&
        words(text, 400) &&
        !/\[\[|\]\]/.test(text),
    );
    check(Number.isFinite(deadlineAt) && deadlineAt > performance.now());
    check(!boundRun || boundRun === runId);
    check(!used.has(lineId) && count < maxLines);
    boundRun = runId;
    used.add(lineId);
    count++;
    if (signal?.aborted) throw fail('cancelled');
    const abort = () => stop('cancelled');
    signal?.addEventListener('abort', abort, { once: true });
    const end = Math.min(deadlineAt, performance.now() + timeoutMs);
    let timedOut = false;
    const timer = setTimeout(
      () => {
        timedOut = true;
        stop('deadline');
      },
      Math.max(0, end - performance.now()),
    );
    const enforceDeadline = () => {
      if (performance.now() >= end) {
        timedOut = true;
        stop('deadline');
      }
      if (root.signal.aborted)
        throw fail(timedOut ? 'deadline' : (terminal ?? 'cancelled'));
    };
    const invoke = async (args) => {
      enforceDeadline();
      if (root.signal.aborted) throw fail(terminal ?? 'cancelled');
      const result = await runner({
        ...args,
        signal: root.signal,
        deadlineAt: end,
        maxOutputBytes: 16384,
        maxFileBytes: Math.min(maxClipBytes, maxTotalBytes - bytesUsed),
      });
      if (result?.cleanupConfirmed !== true) throw fail('cleanup');
      enforceDeadline();
      check(
        typeof result.stdout === 'string' &&
          Buffer.byteLength(result.stdout) <= 16384,
      );
      return result;
    };
    try {
      if (!directory) {
        const parent = realpathSync(tmpdir());
        check(external(parent));
        directory = realpathSync(
          await mkdtemp(join(parent, 'tq-local-voice-')),
        );
        await chmod(directory, 0o700);
        check(external(directory));
      }
      if (!installed) {
        const result = await invoke({ list: true });
        const names = result.stdout
          .split(/\r?\n/)
          .map((line) =>
            /^(.+?)\s+[a-z]{2,3}_[A-Z]{2}\s+#/.exec(line)?.[1].trim(),
          )
          .filter(Boolean);
        check(Object.values(pinned).every((voice) => names.includes(voice)));
        installed = true;
      }
      check(maxTotalBytes - bytesUsed >= 44);
      const path = join(directory, `${randomUUID()}.wav`);
      const handle = await open(
        path,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      );
      let original;
      try {
        original = await handle.stat();
      } finally {
        await handle.close();
      }
      await invoke({ voice: pinned[speaker], rate, output: path, text });
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      let bytes;
      try {
        const before = await file.stat();
        check(
          before.dev === original.dev &&
            before.ino === original.ino &&
            before.isFile() &&
            before.nlink === 1 &&
            before.uid === process.getuid?.() &&
            (before.mode & 0o777) === 0o600 &&
            before.size >= 44 &&
            before.size <= maxClipBytes &&
            bytesUsed + before.size <= maxTotalBytes,
        );
        bytes = Buffer.alloc(before.size);
        let offset = 0;
        while (offset < bytes.length) {
          const read = await file.read(
            bytes,
            offset,
            bytes.length - offset,
            offset,
          );
          check(read.bytesRead > 0);
          offset += read.bytesRead;
        }
        const after = await file.stat();
        const named = lstatSync(path);
        check(
          after.mode === before.mode &&
            after.uid === before.uid &&
            after.nlink === 1 &&
            named.nlink === 1 &&
            after.size === before.size &&
            after.mtimeMs === before.mtimeMs &&
            after.ctimeMs === before.ctimeMs &&
            named.dev === after.dev &&
            named.ino === after.ino &&
            !named.isSymbolicLink(),
        );
      } finally {
        await file.close();
      }
      const metadata = probeLocalWave(bytes, maxDurationMs);
      enforceDeadline();
      bytesUsed += bytes.length;
      return Object.freeze({
        runId,
        lineId,
        speaker,
        textSha256: digest(Buffer.from(text)),
        clipSha256: digest(bytes),
        path,
        ...metadata,
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  };
  return Object.freeze({
    synthesizeLine(request) {
      if (active) return Promise.reject(fail('busy'));
      if (terminal || closing)
        return Promise.reject(fail(terminal ?? 'closed'));
      active = Promise.resolve()
        .then(() => start(request))
        .catch((error) => {
          if (error?.category === 'cleanup') terminal = 'cleanup';
          const category =
            terminal ??
            ([
              'cancelled',
              'deadline',
              'process',
              'output-limit',
              'file-limit',
              'cleanup',
              'protocol',
            ].includes(error?.category)
              ? error.category
              : 'file');
          stop(category);
          throw fail(category);
        })
        .finally(() => {
          active = null;
        });
      return active;
    },
    close() {
      if (closing) return closing;
      let resolve, reject;
      closing = new Promise((a, b) => {
        resolve = a;
        reject = b;
      });
      stop('closed');
      Promise.resolve()
        .then(async () => {
          await active?.catch(() => {});
          if (directory) await rm(directory, { recursive: true, force: true });
          if (terminal === 'cleanup') throw fail('cleanup');
          return { closed: true };
        })
        .then(resolve, () => reject(fail('cleanup')));
      return closing;
    },
  });
}
