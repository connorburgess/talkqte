// Executes only the compile-time non-audio stdin fixture, never the player/app.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
let directory, binary;
const mac = process.platform === 'darwin';
const root = fileURLToPath(new URL('../', import.meta.url));
const env = Object.fromEntries(
  ['HOME', 'PATH', 'TMPDIR']
    .filter((k) => typeof process.env[k] === 'string')
    .map((k) => [k, process.env[k]]),
);
before(() => {
  if (!mac) return;
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'tq-input-fixture-')));
  const object = join(directory, 'state.o');
  binary = join(directory, 'stdin-fixture-not-player');
  execFileSync(
    '/usr/bin/clang',
    [
      '-target',
      'arm64-apple-macos14.0',
      '-std=c11',
      '-Wall',
      '-Wextra',
      '-Werror',
      '-c',
      join(root, 'scripts/lab-player-state.c'),
      '-o',
      object,
    ],
    { env, timeout: 30000, maxBuffer: 16384 },
  );
  execFileSync(
    '/usr/bin/swiftc',
    [
      '-target',
      'arm64-apple-macos14.0',
      '-warnings-as-errors',
      '-D',
      'LAB_PLAYER_INPUT_TESTS',
      '-import-objc-header',
      join(root, 'scripts/lab-player-state.h'),
      join(root, 'scripts/lab-owned-player.swift'),
      object,
      '-framework',
      'AppKit',
      '-framework',
      'AVFoundation',
      '-framework',
      'CryptoKit',
      '-lproc',
      '-o',
      binary,
    ],
    { env, timeout: 30000, maxBuffer: 16384 },
  );
});
after(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
});
const command = (type = 'clock_probe') =>
  JSON.stringify({
    schema: 'talkqte.lab.player.v1',
    type,
    runId: 'fictional-transport',
    generation: '1',
    mediaSha256:
      '1faf1c404249bed069065f51262abfce6956fa8a31f237e68bb6e9d06cb893e2',
    ...(type === 'clock_probe' ? { probeId: 'fixture-probe' } : {}),
  }) + '\n';
async function fixture(t, mode = 'normal') {
  const child = spawn(binary, [mode], {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
  });
  const frames = [];
  let partial = '',
    stderrBytes = 0;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    partial += chunk;
    assert.ok(partial.length < 16384);
    for (let i; (i = partial.indexOf('\n')) >= 0;) {
      frames.push(JSON.parse(partial.slice(0, i)));
      partial = partial.slice(i + 1);
    }
  });
  child.stderr.on('data', (b) => {
    stderrBytes += b.length;
  });
  const ended = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  t.after(async () => {
    child.stdin.destroy();
    if (child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {}
    }
    await ended;
  });
  async function wait(predicate) {
    const deadline = performance.now() + 2000;
    while (!predicate(frames)) {
      assert.ok(performance.now() < deadline, 'bounded fixture reply deadline');
      await new Promise((r) => setTimeout(r, 2));
    }
    return frames;
  }
  await wait((fs) => fs.some((f) => f.type === 'fixture_ready'));
  return {
    child,
    frames,
    wait,
    ended,
    async finish() {
      child.stdin.end();
      const result = await ended;
      assert.deepEqual(result, { code: 0, signal: null });
      assert.equal(stderrBytes, 0);
      return frames;
    },
  };
}
const nativeTest = (name, fn) => test(name, { skip: !mac }, fn);
nativeTest(
  'native short newline command replies while stdin remains open',
  async (t) => {
    const f = await fixture(t);
    f.child.stdin.write(command());
    await f.wait((fs) => fs.some((x) => x.type === 'fixture_reply'));
    assert.equal(f.child.stdin.destroyed, false);
    assert.equal(f.child.exitCode, null);
    assert.equal(
      f.frames.find((x) => x.type === 'fixture_reply').command,
      'clock_probe',
    );
    await f.finish();
  },
);
nativeTest(
  'native fragmented command waits for newline then replies without EOF',
  async (t) => {
    const f = await fixture(t);
    const raw = command();
    f.child.stdin.write(raw.slice(0, 60));
    await f.wait((fs) => fs.some((x) => x.step === 'read'));
    assert.equal(
      f.frames.some((x) => x.type === 'fixture_reply'),
      false,
    );
    f.child.stdin.write(raw.slice(60));
    await f.wait((fs) => fs.some((x) => x.type === 'fixture_reply'));
    await f.finish();
  },
);
nativeTest(
  'native coalesced commands are parsed individually in bounded order',
  async (t) => {
    const f = await fixture(t);
    f.child.stdin.write(
      ['clock_probe', 'start', 'stop', 'retire'].map(command).join(''),
    );
    await f.wait(
      (fs) => fs.filter((x) => x.type === 'fixture_reply').length === 4,
    );
    assert.deepEqual(
      f.frames.filter((x) => x.type === 'fixture_reply').map((x) => x.command),
      ['clock_probe', 'start', 'stop', 'retire'],
    );
    await f.finish();
  },
);
nativeTest(
  'native EINTR retries only the interrupted read then accepts a short command',
  async (t) => {
    const f = await fixture(t, 'eintr');
    f.child.stdin.write(command());
    await f.wait((fs) => fs.some((x) => x.type === 'fixture_reply'));
    await f.finish();
  },
);
nativeTest(
  'native empty EOF is explicit and never fabricates a parsed command',
  async (t) => {
    const f = await fixture(t);
    await f.finish();
    assert.ok(f.frames.some((x) => x.step === 'eof'));
    assert.equal(
      f.frames.some((x) => x.type === 'fixture_reply'),
      false,
    );
  },
);
nativeTest(
  'native partial EOF fails protocol without applying a command',
  async (t) => {
    const f = await fixture(t);
    f.child.stdin.write(command().slice(0, 60));
    await f.finish();
    assert.ok(f.frames.some((x) => x.step === 'protocol-error'));
    assert.equal(
      f.frames.some((x) => x.type === 'fixture_reply'),
      false,
    );
  },
);
nativeTest(
  'native read error is explicit and does not retry a broken descriptor',
  async (t) => {
    const f = await fixture(t, 'read-error');
    const result = await f.ended;
    assert.deepEqual(result, { code: 0, signal: null });
    assert.ok(f.frames.some((x) => x.step === 'read-error'));
    assert.equal(
      f.frames.some((x) => x.type === 'fixture_reply'),
      false,
    );
  },
);
nativeTest(
  'native oversized unterminated command fails at the existing frame bound',
  async (t) => {
    const f = await fixture(t);
    f.child.stdin.write('x'.repeat(16384));
    await f.wait((fs) => fs.some((x) => x.step === 'protocol-error'));
    await f.finish();
    assert.equal(
      f.frames.some((x) => x.type === 'fixture_reply'),
      false,
    );
  },
);
