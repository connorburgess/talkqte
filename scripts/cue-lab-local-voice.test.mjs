import assert from 'node:assert/strict';
import { test as nodeTest, mock } from 'node:test';
const test = (name, fn) =>
  nodeTest(name, { skip: process.platform === 'win32' }, fn);
import { EventEmitter } from 'node:events';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import {
  chmod,
  rename,
  lstat,
  readFile,
  writeFile,
  symlink,
  rm,
  mkdtemp,
} from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import {
  createLocalVoice,
  probeLocalWave,
  runLocalSay,
} from './cue-lab-local-voice.mjs';

const sha = (s) => createHash('sha256').update(s).digest('hex');
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
function wav(frames = 480) {
  const b = Buffer.alloc(44 + frames * 2);
  b.write('RIFF');
  b.writeUInt32LE(b.length - 8, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(48000, 24);
  b.writeUInt32LE(96000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(frames * 2, 40);
  b.fill(1, 44);
  return b;
}
const request = (extra = {}) => ({
  runId: 'fictional-run',
  lineId: 'l1',
  speaker: 'Maya',
  text: 'The fictional rollout starts Monday.',
  deadlineAt: performance.now() + 2000,
  ...extra,
});
function fixture(options = {}) {
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    if (args.list)
      return {
        stdout:
          options.list ?? 'Samantha en_US # Hello\nDaniel en_GB # Hello\n',
        cleanupConfirmed: true,
      };
    if (options.run) return options.run(args);
    await writeFile(args.output, options.bytes ?? wav());
    return { stdout: '', cleanupConfirmed: true };
  };
  return {
    voice: createLocalVoice({
      voices: { Maya: 'Samantha', Eli: 'Daniel' },
      rate: 185,
      execution: 'offline-stand-in',
      run,
      ...options.config,
    }),
    calls,
  };
}

test('one installed-voice query, exact pinned synthesis and private immutable PCM metadata', async () => {
  const f = fixture();
  const first = await f.voice.synthesizeLine(request());
  try {
    assert.equal(first.durationMs, 10);
    assert.equal(first.textSha256, sha(request().text));
    assert.equal(first.clipSha256, sha(await readFile(first.path)));
    assert.equal((await lstat(first.path)).mode & 0o777, 0o600);
    assert.equal((await lstat(dirname(first.path))).mode & 0o777, 0o700);
    assert.ok(Object.isFrozen(first));
    const second = await f.voice.synthesizeLine(
      request({ lineId: 'l2', speaker: 'Eli' }),
    );
    assert.notEqual(first.path, second.path);
    assert.deepEqual(
      f.calls
        .filter((c) => !c.list)
        .map(({ voice, rate, text }) => ({ voice, rate, text })),
      [
        { voice: 'Samantha', rate: 185, text: request().text },
        { voice: 'Daniel', rate: 185, text: request().text },
      ],
    );
    assert.equal(f.calls.filter((c) => c.list).length, 1);
  } finally {
    await f.voice.close();
  }
  await assert.rejects(lstat(first.path), { code: 'ENOENT' });
});

for (const mutation of [
  'missing-voice',
  'markup',
  'unknown-speaker',
  'expired',
  'wrong-run',
  'duplicate',
]) {
  test(`rejects ${mutation} without fallback/retry and stays terminal`, async () => {
    const f = fixture(
      mutation === 'missing-voice' ? { list: 'Other en_US # Hello\n' } : {},
    );
    try {
      if (['wrong-run', 'duplicate'].includes(mutation))
        await f.voice.synthesizeLine(request());
      const bad =
        {
          markup: { text: 'Hello [[rate 999]] there' },
          'unknown-speaker': { speaker: 'Other' },
          expired: { deadlineAt: performance.now() - 1 },
          'wrong-run': { runId: 'other', lineId: 'l2' },
          duplicate: {},
        }[mutation] ?? {};
      await assert.rejects(f.voice.synthesizeLine(request(bad)), {
        category: 'protocol',
      });
      const count = f.calls.length;
      await assert.rejects(f.voice.synthesizeLine(request({ lineId: 'l3' })));
      assert.equal(f.calls.length, count);
      assert.equal(
        f.calls.filter((c) => !c.list).length,
        ['wrong-run', 'duplicate'].includes(mutation) ? 1 : 0,
      );
    } finally {
      await f.voice.close();
    }
  });
}

for (const mutation of [
  'truncated',
  'stereo',
  'compressed',
  'rate',
  'empty',
  'duration',
  'bytes',
]) {
  test(`rejects ${mutation} output before any clip is returned`, async () => {
    let bytes = wav();
    if (mutation === 'truncated') bytes = bytes.subarray(0, 60);
    if (mutation === 'stereo') bytes.writeUInt16LE(2, 22);
    if (mutation === 'compressed') bytes.writeUInt16LE(3, 20);
    if (mutation === 'rate') bytes.writeUInt32LE(44100, 24);
    if (mutation === 'empty') bytes = wav(0);
    const f = fixture({
      bytes,
      config:
        mutation === 'duration'
          ? { maxDurationMs: 1 }
          : mutation === 'bytes'
            ? { maxClipBytes: 100 }
            : {},
    });
    try {
      await assert.rejects(f.voice.synthesizeLine(request()));
      assert.equal(f.calls.length, 2);
    } finally {
      await f.voice.close();
    }
  });
}

test('PCM probe rejects duplicate or trailing undeclared data', () => {
  const a = Buffer.concat([wav(), Buffer.from('trailing')]);
  assert.throws(() => probeLocalWave(a, 30000));
  const b = Buffer.concat([
    wav(),
    Buffer.from('data\x02\x00\x00\x00\x01\x00', 'binary'),
  ]);
  b.writeUInt32LE(b.length - 8, 4);
  assert.throws(() => probeLocalWave(b, 30000));
});

test('concurrent second line is busy; abort holds close until runner cleanup settles', async () => {
  const entered = deferred(),
    settle = deferred(),
    abort = new AbortController();
  const f = fixture({
    run: async ({ signal }) => {
      entered.resolve(signal);
      await settle.promise;
      throw Error('private raw process output');
    },
  });
  const work = f.voice.synthesizeLine(request({ signal: abort.signal }));
  const childSignal = await entered.promise;
  await assert.rejects(f.voice.synthesizeLine(request({ lineId: 'l2' })), {
    category: 'busy',
  });
  abort.abort();
  assert.equal(childSignal.aborted, true);
  const close = f.voice.close();
  assert.equal(close, f.voice.close());
  let finished = false;
  close.then(() => {
    finished = true;
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(finished, false);
  settle.resolve();
  await assert.rejects(work, (e) => !e.message.includes('private raw'));
  await close;
});

test('file replacement and symlink are rejected with owned files removed', async () => {
  const f = fixture({
    run: async ({ output }) => {
      const alternate = join(dirname(output), 'alternate.wav');
      await writeFile(alternate, wav(), { mode: 0o600 });
      await rm(output);
      await symlink(alternate, output);
      return { stdout: '', cleanupConfirmed: true };
    },
  });
  try {
    await assert.rejects(f.voice.synthesizeLine(request()));
  } finally {
    await f.voice.close();
  }
});

test('replaced regular inode or widened permissions cannot become a returned clip', async () => {
  for (const mutation of ['inode', 'mode']) {
    const f = fixture({
      run: async ({ output }) => {
        if (mutation === 'inode') {
          const replacement = join(dirname(output), 'replacement.wav');
          await writeFile(replacement, wav(), { mode: 0o600 });
          await rename(replacement, output);
        } else await writeFile(output, wav(), { mode: 0o600 });
        if (mutation === 'mode') await chmod(output, 0o644);
        return { stdout: '', cleanupConfirmed: true };
      },
    });
    try {
      await assert.rejects(f.voice.synthesizeLine(request()), {
        category: 'protocol',
      });
    } finally {
      await f.voice.close();
    }
  }
});

test('canonical module boundary rejects checkout-local temp parents and aliases after cwd changes', async () => {
  const checkout = fileURLToPath(new URL('../', import.meta.url));
  const inside = await mkdtemp(join(checkout, '..voice-runtime-'));
  const outside = await mkdtemp(join(tmpdir(), 'voice-alias-'));
  await symlink(inside, join(outside, 'alias'));
  const originalCwd = process.cwd(),
    originalTmp = process.env.TMPDIR;
  try {
    process.chdir(outside);
    for (const parent of [checkout, inside, join(outside, 'alias')]) {
      process.env.TMPDIR = parent;
      const f = fixture();
      try {
        await assert.rejects(f.voice.synthesizeLine(request()), {
          category: 'protocol',
        });
        assert.equal(f.calls.length, 0);
      } finally {
        await f.voice.close();
      }
    }
  } finally {
    process.chdir(originalCwd);
    if (originalTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = originalTmp;
    await rm(inside, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('pre-aborted line performs no voice query or synthesis', async () => {
  const controller = new AbortController();
  controller.abort();
  const f = fixture();
  try {
    await assert.rejects(
      f.voice.synthesizeLine(request({ signal: controller.signal })),
      { category: 'cancelled' },
    );
    assert.equal(f.calls.length, 0);
  } finally {
    await f.voice.close();
  }
});

test('line count and cumulative file bytes cannot reset between lines', async () => {
  for (const config of [
    { maxLines: 1 },
    { maxClipBytes: 1004, maxTotalBytes: 1004 },
  ]) {
    const f = fixture({ config });
    try {
      await f.voice.synthesizeLine(request());
      await assert.rejects(f.voice.synthesizeLine(request({ lineId: 'l2' })));
      assert.equal(
        f.calls.filter((c) => !c.list).length,
        1,
        'budget refusal occurs before a second synthesis',
      );
    } finally {
      await f.voice.close();
    }
  }
});

test('missing cleanup confirmation is terminal, never reported as a usable clip', async () => {
  const f = fixture({
    run: async () => ({ stdout: '', cleanupConfirmed: false }),
  });
  try {
    await assert.rejects(f.voice.synthesizeLine(request()), {
      category: 'cleanup',
    });
  } finally {
    await assert.rejects(f.voice.close(), { category: 'cleanup' });
  }
});

test('cleanup failure wins over an already requested close or cancellation', async () => {
  for (const result of ['reject', 'missing-confirmation']) {
    const started = deferred(),
      release = deferred();
    const f = fixture({
      run: async () => {
        started.resolve();
        await release.promise;
        if (result === 'reject')
          throw Object.assign(Error('fixture cleanup'), {
            category: 'cleanup',
          });
        return { stdout: '', cleanupConfirmed: false };
      },
    });
    const work = f.voice.synthesizeLine(request());
    await started.promise;
    const close = f.voice.close();
    release.resolve();
    await assert.rejects(work, { category: 'cleanup' });
    await assert.rejects(close, { category: 'cleanup' });
  }
});

test('adapter timeout aborts stand-in work and never accepts a late file', async () => {
  const f = fixture({
    config: { timeoutMs: 50 },
    run: ({ signal }) =>
      new Promise((_, reject) =>
        signal.addEventListener(
          'abort',
          () =>
            reject(
              Object.assign(Error('cancelled'), { category: 'cancelled' }),
            ),
          { once: true },
        ),
      ),
  });
  try {
    await assert.rejects(f.voice.synthesizeLine(request()), {
      category: 'deadline',
    });
  } finally {
    await f.voice.close();
  }
});

// Mock OS process primitives; these tests never launch say or any child.
async function processFixture({ mode = 'normal' } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'voice-process-test-'));
  const output = join(directory, 'line.wav');
  await writeFile(output, '', { mode: 0o600 });
  const child = Object.assign(new EventEmitter(), {
    pid: 45678,
    stdin: new EventEmitter(),
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
  });
  const spawned = [],
    signals = [];
  let present = true;
  mock.method(childProcess, 'spawn', (command, args, options) => {
    spawned.push({ command, args, options });
    return child;
  });
  mock.method(process, 'kill', (pid, signal) => {
    assert.equal(pid, -45678);
    if (signal === 0) {
      if (present) return true;
      throw Object.assign(Error('absent'), { code: 'ESRCH' });
    }
    signals.push(signal);
    if (mode !== 'lost-cleanup' && signal === 'SIGKILL') present = false;
    if (['abort', 'overflow', 'deadline', 'file-overflow'].includes(mode))
      queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
    return true;
  });
  child.stdin.end = (input) => {
    spawned[0].input = input;
    queueMicrotask(() => {
      if (mode === 'overflow') child.stdout.emit('data', Buffer.alloc(17000));
      else if (mode === 'file-overflow')
        void writeFile(output, Buffer.alloc(128));
      else if (!['abort', 'deadline', 'deadline-no-close'].includes(mode)) {
        child.stdout.emit('data', Buffer.from('Samantha en_US # Hello\n'));
        child.emit('close', 0, null);
      }
    });
  };
  syncBuiltinESMExports();
  return {
    output,
    spawned,
    signals,
    child,
    async close() {
      mock.restoreAll();
      syncBuiltinESMExports();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test('fixed say process uses stdin, no shell/network/device, explicit PCM and retires group', async () => {
  const f = await processFixture();
  try {
    const result = await runLocalSay({
      voice: 'Samantha',
      rate: 185,
      output: f.output,
      text: 'Fictional words.',
      deadlineAt: performance.now() + 1000,
    });
    assert.equal(result.cleanupConfirmed, true);
    assert.equal(f.spawned[0].command, '/usr/bin/say');
    assert.equal(f.spawned[0].options.shell, false);
    assert.equal(f.spawned[0].options.detached, true);
    assert.equal(f.spawned[0].input, 'Fictional words.');
    assert.deepEqual(f.spawned[0].args, [
      '-v',
      'Samantha',
      '-r',
      '185',
      '--file-format=WAVE',
      '--data-format=LEI16@48000',
      '--channels=1',
      '-o',
      f.output,
      '-f',
      '-',
    ]);
    assert.deepEqual(f.signals, ['SIGKILL']);
  } finally {
    await f.close();
  }
});

for (const mode of [
  'abort',
  'overflow',
  'deadline',
  'file-overflow',
  'lost-cleanup',
  'deadline-no-close',
])
  test(`owned process ${mode} fails safely without a retry`, async () => {
    const f = await processFixture({ mode });
    try {
      const controller = new AbortController();
      const work = runLocalSay({
        list: mode !== 'file-overflow',
        ...(mode === 'file-overflow'
          ? {
              voice: 'Samantha',
              rate: 185,
              output: f.output,
              text: 'Fictional words.',
              maxFileBytes: 64,
            }
          : {}),
        signal: controller.signal,
        deadlineAt:
          performance.now() + (mode.startsWith('deadline') ? 20 : 1000),
      });
      if (mode === 'abort') controller.abort();
      await assert.rejects(work, {
        category: {
          abort: 'cancelled',
          overflow: 'output-limit',
          deadline: 'deadline',
          'lost-cleanup': 'cleanup',
          'file-overflow': 'file-limit',
          'deadline-no-close': 'cleanup',
        }[mode],
      });
      assert.equal(f.spawned.length, 1);
    } finally {
      await f.close();
    }
  });
