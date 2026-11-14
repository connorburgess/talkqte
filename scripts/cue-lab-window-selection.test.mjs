import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import {
  createLabOwnedWindowSelectorFixture,
  selectLabOwnedWindowRows,
} from './cue-lab-window-selection.mjs';
const options = {
  playerSource: { pid: 41, windowId: 51, runId: 'fictional-run' },
  nativeIdentity: { pid: 42, runId: 'fictional-run' },
  nativeApplication: 'TalkQTE Development',
};
const rows = [
  {
    event: 'window',
    app: 'TalkQTE Lab Player',
    pid: 41,
    windowId: 51,
    title: 'Fictional generated meeting',
    onScreen: true,
    frame: { width: 960, height: 540 },
  },
  {
    event: 'window',
    app: 'TalkQTE Development',
    pid: 42,
    windowId: 52,
    title: 'TalkQTE companion',
    onScreen: true,
    frame: { width: 400, height: 80 },
  },
];
test('exact known player window and same owned native companion are selected', () => {
  const selected = selectLabOwnedWindowRows(rows, options);
  assert.equal(selected.emulator.pid, 41);
  assert.equal(selected.companion.windowId, 52);
});
for (const mode of [
  'foreignpid',
  'wrongwindow',
  'hidden',
  'titlefuzzy',
  'duplicate',
  'wrongrun',
  'wrongapp',
]) {
  test(`strict owned selection refuses ${mode}`, () => {
    const r = structuredClone(rows),
      o = structuredClone(options);
    if (mode === 'foreignpid') r[1].pid = 43;
    if (mode === 'wrongwindow') r[0].windowId = 99;
    if (mode === 'hidden') r[1].onScreen = false;
    if (mode === 'titlefuzzy') r[1].title = 'Other TalkQTE companion';
    if (mode === 'duplicate') r.push({ ...r[1] });
    if (mode === 'wrongrun') o.nativeIdentity.runId = 'other';
    if (mode === 'wrongapp') r[1].app = 'Other app';
    assert.throws(() => selectLabOwnedWindowRows(r, o));
  });
}
test('strict helper listing filters owned PIDs before emitting any title', () => {
  const source = readFileSync(
    new URL('./lab-window-capture.swift', import.meta.url),
    'utf8',
  );
  const list = source.slice(
    source.indexOf('if options["list"]'),
    source.indexOf('guard options["capture"]'),
  );
  assert.ok(
    list.indexOf('ownedPids.contains') < list.indexOf('"title": window.title'),
  );
  assert.match(list, /playerPid != nativePid/);
});

for (const fixtureCase of [
  'normal',
  'partial',
  'foreign',
  'duplicate',
  'oversize',
  'malformed',
  'held-pipes',
]) {
  test(
    `actual harmless list helper ${fixtureCase} obeys owned parser/termination bounds`,
    { skip: process.platform === 'win32' },
    async () => {
      const select = createLabOwnedWindowSelectorFixture({
        ...options,
        native: { identity: options.nativeIdentity },
        fixtureCase,
        deadlineMs: 100,
      });
      if (['normal', 'partial'].includes(fixtureCase))
        assert.equal(
          (await select({ runId: 'fictional-run' })).companion.windowId,
          52,
        );
      else await assert.rejects(select({ runId: 'fictional-run' }));
      await assert.rejects(select({ runId: 'fictional-run' }));
    },
  );
}

// Failure may close the parent synchronously while descendants remain alive.
// Do not let close cancel the owned group's only bounded KILL path.
test('failed parent close retains cleanup ownership until descendant retirement', async () => {
  const { default: childProcess } = await import('node:child_process');
  const { syncBuiltinESMExports } = await import('node:module');
  const { EventEmitter } = await import('node:events');
  const { PassThrough } = await import('node:stream');
  const { mock } = await import('node:test');
  const child = new EventEmitter();
  Object.assign(child, {
    pid: 77771,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  const signals = [];
  let alive = true;
  mock.method(childProcess, 'spawn', () => {
    queueMicrotask(() => child.stdout.write('malformed\n'));
    return child;
  });
  mock.method(process, 'kill', (pid, signal) => {
    assert.equal(pid, -77771);
    signals.push(signal);
    if (!alive) throw Object.assign(new Error('absent'), { code: 'ESRCH' });
    if (signal === 'SIGTERM') child.emit('close', 0, null);
    if (signal === 'SIGKILL') alive = false;
    return true;
  });
  syncBuiltinESMExports();
  try {
    const select = createLabOwnedWindowSelectorFixture({
      ...options,
      native: { identity: options.nativeIdentity },
      deadlineMs: 1000,
    });
    await assert.rejects(
      select({ runId: 'fictional-run' }),
      (e) => e.category === 'cleanup',
    );
    assert.equal(alive, false);
    assert.ok(signals.includes(0));
    assert.equal(signals.filter((s) => s === 'SIGTERM').length, 1);
    assert.equal(signals.filter((s) => s === 'SIGKILL').length, 1);
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
  }
});
