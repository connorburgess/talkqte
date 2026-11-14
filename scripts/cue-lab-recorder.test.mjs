import assert from 'node:assert/strict';
import { test as nodeTest } from 'node:test';
import { mkdtempSync, chmodSync, rmSync, readFileSync } from 'node:fs';
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
for (const mode of ['normal', 'partial'])
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
      source.indexOf('let pictureStream ='),
  );
  assert.match(
    source,
    /guard strictWindows && streamsStarted && frames > 0 && !frameReported/,
  );
  assert.match(
    source,
    /video\.append\(buffer\) \{\s*frames \+= 1\s*reportReady\(\)/,
  );
  assert.ok(
    source.indexOf('try await soundStream.startCapture()') <
      source.indexOf('let signals ='),
  );
  assert.ok(
    source.indexOf('source.resume()') <
      source.indexOf('writer.streamsStarted = true'),
  );
  assert.match(source, /if !strictWindows \{ emit\(\["event": "started"/);
});
