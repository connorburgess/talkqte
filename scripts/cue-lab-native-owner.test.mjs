import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createLabNativeOwner } from './cue-lab-native-owner.mjs';
const executable = '/fictional/TalkQTE.app/Contents/MacOS/talkqte';
function setup({ armingMs = 100, releaseMs = 100, kill = true } = {}) {
  const child = new EventEmitter();
  Object.assign(child, {
    pid: 4242,
    spawnfile: executable,
    exitCode: null,
    signalCode: null,
  });
  const signals = [],
    events = [];
  let callback, environment;
  child.kill = (signal) => {
    signals.push(signal);
    return kill;
  };
  const owner = createLabNativeOwner({
    executable,
    stopAfterS: 120,
    armingMs,
    releaseMs,
    launch(options) {
      environment = options.environment;
      callback = options.onTiming;
      return child;
    },
  });
  owner.subscribe((event) => events.push(event.type));
  const start = () =>
    owner.start({
      runId: 'fictional-run',
      descriptorPath: '/fictional/private/descriptor.json',
      metadata: { provider: 'codex', model: 'gpt-6.1-sol', effort: 'medium' },
    });
  const timing = (step, extra = {}) =>
    callback({ event: 'dev_stop', step, run_id: 'fictional-run', ...extra });
  return {
    owner,
    child,
    signals,
    events,
    start,
    timing,
    get environment() {
      return environment;
    },
  };
}

test('early Stop waits exact-run armed, signals once, and needs actual released evidence', async () => {
  const f = setup();
  const starting = f.start();
  const stopped = f.owner.stop();
  let done = false;
  stopped.then(() => {
    done = true;
  });
  assert.deepEqual(f.signals, []);
  f.timing('armed');
  await starting;
  assert.deepEqual(f.signals, ['SIGUSR2']);
  f.timing('latched');
  f.timing('stopping');
  await delay(0);
  assert.equal(done, false);
  const again = f.owner.stop();
  assert.equal(again, stopped);
  assert.equal(f.signals.length, 1);
  f.timing('released');
  assert.deepEqual(await stopped, { released: true });
  assert.equal(done, true);
  assert.equal(f.environment.TALKQTE_DEV_STOP_SIGNAL, 'usr2');
  assert.equal(f.environment.TALKQTE_DEV_STOP_AFTER_S, '120');
  assert.equal(f.environment.TALKQTE_DEV_LAB_RUN_ID, 'fictional-run');
  assert.equal(
    f.environment.TALKQTE_DEV_LAB_DESCRIPTOR,
    '/fictional/private/descriptor.json',
  );
  assert.equal(Object.isFrozen(f.environment), true);
});

test('Stop before launch proves never-started and refuses later launch', async () => {
  const f = setup();
  assert.deepEqual(await f.owner.stop(), { released: true });
  await assert.rejects(f.start());
  assert.deepEqual(f.signals, []);
});

for (const variant of [
  'wrong-run',
  'process-exit',
  'identity-change',
  'signal-failure',
  'armed-timeout',
  'release-timeout',
])
  test(`${variant} never turns signal delivery or process termination into release`, async () => {
    const f = setup({
      armingMs: 20,
      releaseMs: 20,
      kill: variant !== 'signal-failure',
    });
    const starting = f.start();
    const checkedStart = starting.catch(() => {});
    const stopping = f.owner.stop();
    const checkedStop = assert.rejects(stopping, { category: 'cleanup' });
    if (variant === 'wrong-run') f.timing('armed', { run_id: 'other-run' });
    else if (variant === 'process-exit') {
      f.child.exitCode = 0;
      f.child.emit('exit', 0);
    } else if (variant === 'identity-change') {
      f.child.pid = 9999;
      f.timing('armed');
    } else if (variant !== 'armed-timeout') f.timing('armed');
    await Promise.all([checkedStart, checkedStop]);
    assert.ok(f.events.includes('failed'));
    assert.equal(
      f.signals.length,
      ['signal-failure', 'release-timeout'].includes(variant) ? 1 : 0,
    );
  });

test('non-control transcript/cue events are ignored without forwarding any text', async () => {
  const f = setup();
  const starting = f.start();
  f.timing('armed');
  await starting;
  f.timing('ignored', { event: 'segment', text: 'fictional speech' });
  f.timing('ignored', { event: 'cue_shown', question: 'fictional card' });
  assert.deepEqual(f.events, []);
  const stopped = f.owner.stop();
  f.timing('released');
  await stopped;
  assert.deepEqual(f.events, ['session-ended']);
});

test('dropped timing evidence fails closed rather than accepting a later apparent release', async () => {
  const f = setup();
  const starting = f.start();
  f.timing('armed');
  await starting;
  f.timing('ignored', { event: 'dropped', count: 1 });
  const stopped = f.owner.stop();
  f.timing('released');
  await assert.rejects(stopped, { category: 'cleanup' });
  assert.deepEqual(f.signals, []);
});

test('the release deadline starts after arming and signal, not at early Stop intent', async () => {
  const f = setup({ armingMs: 100, releaseMs: 10 });
  const starting = f.start();
  const stopping = f.owner.stop();
  await delay(20);
  assert.deepEqual(f.signals, []);
  f.timing('armed');
  await starting;
  assert.deepEqual(f.signals, ['SIGUSR2']);
  f.timing('released');
  assert.deepEqual(await stopping, { released: true });
});

test('a finite ordinary-Stop launch guard is required independently of the signal seam', () => {
  for (const stopAfterS of [undefined, 0, -1, Infinity, NaN, 0.5, '120'])
    assert.throws(() =>
      createLabNativeOwner({ executable, launch: () => {}, stopAfterS }),
    );
});

for (const lost of ['armed', 'released'])
  test(`lost ${lost} evidence remains unconfirmed even when timed Stop and process exit are observed`, async () => {
    const f = setup({ armingMs: 50, releaseMs: 50 });
    const starting = f.start();
    const checkedStart = starting.catch(() => {});
    const stopping = f.owner.stop();
    const checkedStop = assert.rejects(stopping, { category: 'cleanup' });
    if (lost === 'released') {
      f.timing('armed');
      await starting;
      f.timing('latched');
      f.timing('stopping');
    }
    // The guard's Stop request and even normal host/process observations do not
    // recover a missing armed/released frame from a lossy timing channel.
    f.timing('ignored', { event: 'dev_source', step: 'stopping' });
    f.timing('ignored', { event: 'source_ended', recognized_chunks: 1 });
    f.timing('ignored', { event: 'session', state: 'ended' });
    f.child.exitCode = 0;
    f.child.emit('exit', 0);
    await Promise.all([checkedStart, checkedStop]);
    assert.equal(f.environment.TALKQTE_DEV_STOP_AFTER_S, '120');
    assert.equal(f.signals.length, lost === 'armed' ? 0 : 1);
    assert.ok(f.events.includes('failed'));
  });
