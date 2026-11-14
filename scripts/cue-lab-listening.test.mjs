import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLabListening } from './cue-lab-listening.mjs';
import { prepareLabFixtureLauncher } from './cue-lab-launcher.mjs';
import { createLabNativeOwner } from './cue-lab-native-owner.mjs';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { once, EventEmitter } from 'node:events';

test('observed source stopping/end aborts ownership without claiming native release', async () => {
  let timing;
  const notifications = [];
  const child = Object.assign(new EventEmitter(), {
    pid: 44001,
    spawnfile: '/fictional/app',
    exitCode: null,
    signalCode: null,
    kill: () => true,
  });
  const owner = createLabNativeOwner({
    executable: '/fictional/app',
    stopAfterS: 110,
    launch(options) {
      timing = options.onTiming;
      queueMicrotask(() =>
        timing({ event: 'dev_stop', step: 'armed', run_id: 'owned-run' }),
      );
      return child;
    },
  });
  owner.subscribe((event) => notifications.push(event.type));
  await owner.start({
    descriptorPath: '/fictional/descriptor',
    runId: 'owned-run',
    metadata: { provider: 'codex', model: 'gpt-6.1-sol', effort: 'medium' },
  });
  timing({
    event: 'dev_source',
    step: 'stopping',
    application: 'QuickTime Player',
  });
  timing({ event: 'source_ended', application: 'QuickTime Player' });
  assert.deepEqual(notifications, ['stop-requested', 'session-ended']);
  let settled = false;
  const stopping = owner.stop().then((result) => {
    settled = true;
    return result;
  });
  await Promise.resolve();
  assert.equal(settled, false);
  timing({ event: 'dev_stop', step: 'released', run_id: 'owned-run' });
  assert.deepEqual(await stopping, { released: true });
});
const features = [
  'lab-evaluator',
  'local-whisper',
  'native-audio-spike',
  'timing-log',
];
function fixture() {
  let handler;
  const identity = { pid: 44001, runId: 'owned-run' };
  const launcher = {
    identity,
    subscribe(fn) {
      handler = fn;
      return () => {
        handler = () => {};
      };
    },
  };
  const source = createLabListening({
    launcher,
    commit: 'a'.repeat(40),
    features,
    deadlineMs: 20,
  });
  const emit = (e) => handler(e);
  const armed = () =>
    emit({ event: 'dev_stop', step: 'armed', run_id: 'owned-run' });
  const session = () =>
    emit({
      event: 'session',
      state: 'started',
      session: 1,
      commit: 'a'.repeat(40),
      features,
    });
  const acknowledged = () =>
    emit({
      event: 'dev_source',
      step: 'acknowledged',
      application: 'QuickTime Player',
    });
  const started = () =>
    emit({
      event: 'dev_source',
      step: 'started',
      application: 'QuickTime Player',
    });
  return { source, emit, armed, session, acknowledged, started, identity };
}
test('only bound armed, checked live session and exact application started produce historical evidence', async () => {
  const f = fixture();
  f.armed();
  f.acknowledged();
  f.session();
  const p = f.source.waitListening({ runId: 'owned-run' });
  let settled = false;
  p.then(() => (settled = true));
  await Promise.resolve();
  assert.equal(settled, false);
  f.started();
  assert.deepEqual(await p, {
    runId: 'owned-run',
    listening: true,
    historical: true,
    session: 1,
  });
  f.source.close();
});
for (const event of [
  { event: 'dev_source', step: 'started', application: 'Other' },
  { event: 'session', state: 'ended' },
  { event: 'source_ended' },
  { event: 'dev_stop', step: 'stopping', run_id: 'owned-run' },
  { event: 'dropped' },
  { event: 'observation_closed' },
])
  test(
    'retirement or invalid evidence refuses readiness ' + JSON.stringify(event),
    async () => {
      const f = fixture();
      f.armed();
      f.acknowledged();
      f.session();
      const p = f.source.waitListening({ runId: 'owned-run' });
      f.emit(event);
      f.started();
      await assert.rejects(p);
      f.source.close();
    },
  );
test('missing session, wrong run and changed identity cannot be repaired by a source name', async () => {
  for (const mode of ['no-session', 'wrong-run', 'changed-pid']) {
    const f = fixture();
    f.armed();
    f.acknowledged();
    if (mode !== 'no-session') f.session();
    const p = f.source.waitListening({
      runId: mode === 'wrong-run' ? 'wrong' : 'owned-run',
    });
    if (mode === 'changed-pid') f.identity.pid = 0;
    f.started();
    await assert.rejects(p);
    f.source.close();
  }
});
test('timeout, abort and close settle a pending observation', async () => {
  for (const mode of ['timeout', 'abort', 'close']) {
    const f = fixture(),
      controller = new AbortController();
    const p = f.source.waitListening({
      runId: 'owned-run',
      signal: controller.signal,
    });
    if (mode === 'abort') controller.abort();
    else if (mode === 'close') f.source.close();
    await assert.rejects(p);
    f.source.close();
  }
});

test(
  'actual harmless launcher child forwards only validated private metadata to Listening adapter',
  { skip: process.platform === 'win32' },
  async () => {
    const selection = {
      provider: 'codex',
      model: 'gpt-6.1-sol',
      effort: 'medium',
      maxCalls: 2,
    };
    const launcher = prepareLabFixtureLauncher({
      fixtureCase: 'listening',
      selection,
    });
    const descriptor = join(launcher.directory, 'descriptor.json');
    writeFileSync(descriptor, '{}', { mode: 0o600 });
    const source = createLabListening({
      launcher,
      commit: 'b'.repeat(40),
      features,
      deadlineMs: 500,
    });
    let child;
    const owner = createLabNativeOwner({
      executable: launcher.executable,
      stopAfterS: 120,
      launch(options) {
        child = launcher.launch(options);
        return child;
      },
    });
    try {
      await owner.start({
        descriptorPath: descriptor,
        runId: 'owned-run',
        metadata: selection,
      });
      const observation = await source.waitListening({ runId: 'owned-run' });
      assert.equal(observation.historical, true);
      assert.equal(observation.session, 1);
      assert.equal(launcher.identity.pid, child.pid);
      await owner.stop();
    } finally {
      source.close();
      launcher.close();
      if (child && child.exitCode === null) await once(child, 'exit');
      rmSync(launcher.directory, { recursive: true, force: true });
    }
  },
);
