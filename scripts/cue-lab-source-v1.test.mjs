import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLabSourceV1 } from './cue-lab-source-v1.mjs';
import { watchLabTiming } from './cue-lab-timing-reader.mjs';
const features = [
  'cloud-transcription',
  'lab-evaluator',
  'native-audio-spike',
  'timing-log',
];
const commit = 'a'.repeat(40);
function fixture(application = 'QuickTime Player') {
  let handler;
  const identity = {
    pid: 44001,
    executable: '/fictional/talkqte',
    runId: 'fictional-run',
  };
  const launcher = {
    identity,
    subscribe(fn) {
      handler = fn;
      return () => (handler = () => {});
    },
  };
  const source = createLabSourceV1({
    launcher,
    commit,
    features,
    deadlineMs: 50,
    application,
  });
  const emit = (e) => handler(e);
  const bootstrap = () => {
    emit({ event: 'dev_stop', run_id: identity.runId, step: 'armed' });
    emit({
      event: 'dev_source',
      application,
      step: 'acknowledged',
    });
    emit({
      event: 'session',
      state: 'started',
      session: '18446744073709551615',
      commit,
      features,
    });
  };
  const tuple = {
    event: 'dev_source_observation',
    version: 1,
    run_id: identity.runId,
    application,
    step: 'listening',
    host_operation: 'b'.repeat(32),
    live_operation: 'c'.repeat(64),
    session: '18446744073709551615',
  };
  return { source, emit, bootstrap, tuple, identity };
}
test('v1 full-u64 source identity resolves only exact tuple and stays terminal-observed after readiness', async () => {
  const f = fixture();
  const events = [];
  f.source.subscribe((e) => events.push(e));
  f.bootstrap();
  const p = f.source.waitListening({ runId: f.identity.runId });
  f.emit({
    event: 'dev_source',
    step: 'started',
    application: 'QuickTime Player',
  });
  let resolved = false;
  p.then(() => (resolved = true));
  await Promise.resolve();
  assert.equal(resolved, false);
  f.emit(f.tuple);
  const value = await p;
  assert.equal(value.sessionId, '18446744073709551615');
  assert.deepEqual(value.source, f.tuple);
  f.emit({ ...f.tuple, step: 'retired' });
  assert.equal(events.length, 1);
  f.source.close();
  assert.equal(events.length, 1);
});
for (const variant of [
  'wrong-session',
  'wrong-run',
  'wrong-host',
  'retired-first',
  'duplicate',
  'replacement',
  'stop',
  'closed',
]) {
  test(`v1 rejects ${variant} and notifies terminal observer`, async () => {
    const f = fixture();
    const events = [];
    f.source.subscribe((e) => events.push(e));
    f.bootstrap();
    const p = f.source.waitListening({ runId: f.identity.runId });
    if (['duplicate', 'replacement', 'stop', 'closed'].includes(variant)) {
      f.emit(f.tuple);
      await p;
    } else p.catch(() => {});
    if (variant === 'wrong-session') f.emit({ ...f.tuple, session: '1' });
    if (variant === 'wrong-run') f.emit({ ...f.tuple, run_id: 'other' });
    if (variant === 'wrong-host') f.emit({ ...f.tuple, host_operation: 'bad' });
    if (variant === 'retired-first') f.emit({ ...f.tuple, step: 'retired' });
    if (variant === 'duplicate') f.emit(f.tuple);
    if (variant === 'replacement')
      f.emit({
        event: 'session',
        state: 'started',
        session: '2',
        commit,
        features,
      });
    if (variant === 'stop')
      f.emit({ event: 'dev_stop', run_id: f.identity.runId, step: 'latched' });
    if (variant === 'closed') f.emit({ event: 'observation_closed' });
    assert.equal(events.length, 1);
    if (
      ['wrong-session', 'wrong-run', 'wrong-host', 'retired-first'].includes(
        variant,
      )
    )
      await assert.rejects(p);
    f.source.close();
  });
}
for (const lexical of [
  '18446744073709551615',
  '9007199254740993',
  '1e2',
  '0',
  '01',
  '18446744073709551616',
]) {
  test(`strict timing session preserves or rejects lexical ${lexical}`, () => {
    const directory = mkdtempSync(join(tmpdir(), 'tq-v1-test-'));
    const path = join(directory, 'timing.jsonl');
    writeFileSync(path, '', { mode: 0o600 });
    const events = [];
    const reader = watchLabTiming({
      path,
      runId: 'fictional-run',
      expectedApplication: 'QuickTime Player',
      sourceObservation: 'v1',
      onEvent: (e) => events.push(e),
    });
    try {
      appendFileSync(
        path,
        `{"event":"session","state":"started","live":true,"session":${lexical}}\n`,
      );
      reader.poll();
      if (['18446744073709551615', '9007199254740993'].includes(lexical))
        assert.equal(events[0].session, lexical);
      else assert.equal(events[0].event, 'dropped');
    } finally {
      reader.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
test('strict timing validates v1 source identity and refuses duplicate session keys', () => {
  const directory = mkdtempSync(join(tmpdir(), 'tq-v1-test-'));
  const path = join(directory, 'timing.jsonl');
  writeFileSync(path, '', { mode: 0o600 });
  const events = [];
  const reader = watchLabTiming({
    path,
    runId: 'fictional-run',
    expectedApplication: 'QuickTime Player',
    sourceObservation: 'v1',
    onEvent: (e) => events.push(e),
  });
  const f = fixture();
  try {
    appendFileSync(path, JSON.stringify(f.tuple) + '\n');
    reader.poll();
    assert.deepEqual(events[0], f.tuple);
    appendFileSync(
      path,
      '{"event":"session","state":"started","live":true,"session":1,"session":2}\n',
    );
    reader.poll();
    assert.equal(events[1].event, 'dropped');
  } finally {
    reader.close();
    f.source.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('throwing and reentrant observers cannot suppress exactly-once root Stop after retirement', async () => {
  const f = fixture();
  let rootStops = 0,
    notifications = 0,
    removeRoot;
  f.source.subscribe(() => {
    notifications++;
    removeRoot();
    f.source.close();
    throw Error('fictional observer failure');
  });
  removeRoot = f.source.subscribe(() => rootStops++);
  f.bootstrap();
  const ready = f.source.waitListening({ runId: f.identity.runId });
  f.emit(f.tuple);
  await ready;
  assert.doesNotThrow(() => f.emit({ ...f.tuple, step: 'retired' }));
  f.emit({ ...f.tuple, step: 'retired' });
  f.source.close();
  assert.equal(rootStops, 1);
  assert.equal(notifications, 1);
  await assert.rejects(f.source.waitListening({ runId: f.identity.runId }));
});

test('fixed owned-player source kind retains exact same tuple/session guard', async () => {
  const f = fixture('TalkQTE Lab Player');
  f.bootstrap();
  const ready = f.source.waitListening({ runId: f.identity.runId });
  f.emit(f.tuple);
  const result = await ready;
  assert.equal(result.source.application, 'TalkQTE Lab Player');
  f.source.close();
});
