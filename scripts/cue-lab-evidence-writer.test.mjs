import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  readFileSync,
  statSync,
  writeFileSync,
  symlinkSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createLabEvidenceWriter } from './cue-lab-evidence-writer.mjs';
function fixture(t, options = {}) {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'tq-writer-test-')));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const failures = [];
  const writer = createLabEvidenceWriter({
    parentDirectory: parent,
    runId: 'fictional-take',
    fictional: true,
    onFailure: (e) => failures.push(e.category),
    ...options,
  });
  t.after(() => writer.close());
  writer.addClock({ id: 'node', kind: 'monotonic' });
  return {
    parent,
    writer,
    failures,
    read() {
      const r = writer.close();
      return {
        result: r,
        manifest: JSON.parse(readFileSync(r.manifestPath)),
        events: readFileSync(join(writer.directory, 'events.jsonl'), 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map(JSON.parse),
      };
    },
  };
}
const event = {
  stage: 'run.started',
  outcome: 'observed',
  ids: {},
  timing: { clockId: 'node', atMs: 10, uncertaintyMs: 1, basis: 'receipt' },
};
test('private output hashes actual bounded events and finalization is idempotent', (t) => {
  const f = fixture(t);
  assert.equal(f.writer.emit(event), true);
  const { result, manifest, events } = f.read();
  assert.equal(statSync(f.writer.directory).mode & 0o777, 0o700);
  for (const name of ['manifest.json', 'events.jsonl'])
    assert.equal(statSync(join(f.writer.directory, name)).mode & 0o777, 0o600);
  assert.equal(result, f.writer.close());
  assert.equal(manifest.fictional, true);
  assert.equal(manifest.writer.retentionEnforced, false);
  assert.equal(manifest.clocks[0].anchor, undefined);
  assert.equal(events[0].timing.basis, 'receipt');
  const bytes = readFileSync(join(f.writer.directory, 'events.jsonl'));
  assert.equal(
    manifest.artifacts[0].sha256,
    createHash('sha256').update(bytes).digest('hex'),
  );
  assert.equal(manifest.artifacts[0].bytes, bytes.length);
  assert.equal(f.writer.emit(event), false);
});
test('metadata decider survives while content requires explicit fictional opt-in', (t) => {
  const f = fixture(t);
  assert.equal(
    f.writer.emit({
      stage: 'cue.decided',
      outcome: 'observed',
      ids: { cueId: 'card:1' },
      payload: { decider: 'phrase_rule' },
    }),
    true,
  );
  assert.equal(
    f.writer.emit({
      ...event,
      payload: { transcriptText: 'Fictional statement' },
    }),
    false,
  );
  const { manifest, events } = f.read();
  assert.equal(events[0].payload.decider, 'phrase_rule');
  assert.equal(events[1].stage, 'gap');
  assert.equal(manifest.writer.failed, true);
  assert.equal(manifest.writer.dropped, 1);
  assert.deepEqual(f.failures, ['protocol']);
});
test('fictional content preserves only explicit request and validated response', (t) => {
  const f = fixture(t, { contentMode: 'fictional-content' });
  const payload = {
    request: {
      role: 'cue-evaluator',
      instructions: 'Use only fictional input',
      input: { transcript: 'The fictional handoff moved.' },
    },
    validatedResponse: { action: 'quiet', question: null },
  };
  assert.equal(
    f.writer.emit({ ...event, stage: 'evaluator.returned', payload }),
    true,
  );
  assert.deepEqual(f.read().events[0].payload, payload);
});
for (const key of [
  'api_key',
  'nonce',
  'auth',
  'password',
  'environment',
  'hiddenReasoning',
])
  test(`nested ${key} is refused and never persisted`, (t) => {
    const f = fixture(t, { contentMode: 'fictional-content' });
    assert.equal(
      f.writer.emit({
        ...event,
        payload: {
          validatedResponse: { nested: { [key]: 'forbidden-value' } },
        },
      }),
      false,
    );
    f.read();
    assert.doesNotMatch(
      readFileSync(join(f.writer.directory, 'events.jsonl'), 'utf8'),
      /forbidden-value/,
    );
  });
test('event cap is snapshotted, reports a terminal gap and calls abort once despite callback throw', (t) => {
  const limits = { maxEvents: 3, maxFileBytes: 4096, maxTotalBytes: 4096 };
  let aborts = 0;
  const f = fixture(t, {
    limits,
    onFailure() {
      aborts++;
      throw Error('observer');
    },
  });
  limits.maxEvents = 50000;
  assert.equal(f.writer.emit(event), true);
  assert.equal(f.writer.emit(event), true);
  assert.equal(f.writer.emit(event), false);
  assert.equal(f.writer.emit(event), false);
  const { events, manifest } = f.read();
  assert.equal(events.length, 3);
  assert.equal(events.at(-1).stage, 'gap');
  assert.equal(manifest.limits.maxEvents, 3);
  assert.equal(aborts, 1);
});
test('byte cap does not truncate accepted JSON or persist oversized content', (t) => {
  const f = fixture(t, {
    contentMode: 'fictional-content',
    limits: { maxEvents: 10, maxFileBytes: 4096, maxTotalBytes: 4096 },
  });
  assert.equal(
    f.writer.emit({ ...event, payload: { spokenText: 'x'.repeat(4000) } }),
    false,
  );
  const { events } = f.read();
  assert.equal(events.length, 1);
  assert.equal(events[0].stage, 'gap');
  assert.ok(statSync(join(f.writer.directory, 'events.jsonl')).size <= 4096);
});
test('full u64 strings remain exact and mismatched native clock is terminal', (t) => {
  const f = fixture(t);
  f.writer.addClock({
    id: 'native',
    kind: 'native-session',
    sessionId: '18446744073709551615',
  });
  assert.equal(
    f.writer.emit({
      ...event,
      ids: { sessionId: '18446744073709551615' },
      timing: { ...event.timing, clockId: 'native' },
    }),
    true,
  );
  assert.equal(
    f.writer.emit({
      ...event,
      ids: { sessionId: '1' },
      timing: { ...event.timing, clockId: 'native' },
    }),
    false,
  );
  assert.equal(f.read().events[0].ids.sessionId, '18446744073709551615');
});
for (const timing of [
  undefined,
  { clockId: 'node', atMs: 1, uncertaintyMs: 0, basis: 'receipt' },
])
  test('cue publication/receipt never becomes painted frame evidence', (t) => {
    const f = fixture(t);
    assert.equal(
      f.writer.emit({
        stage: 'video.cue-painted',
        outcome: 'observed',
        ids: { cueId: 'c1' },
        ...(timing ? { timing } : {}),
      }),
      false,
    );
    assert.equal(f.read().events[0].stage, 'gap');
  });
test('explicit observed recording frame is accepted without fabricating other stages', (t) => {
  const f = fixture(t);
  f.writer.addClock({ id: 'video', kind: 'recording' });
  assert.equal(
    f.writer.emit({
      stage: 'video.cue-painted',
      outcome: 'observed',
      ids: { cueId: 'c1' },
      timing: { clockId: 'video', atMs: 50, uncertaintyMs: 20, basis: 'frame' },
    }),
    true,
  );
  assert.deepEqual(
    f.read().events.map((e) => e.stage),
    ['video.cue-painted'],
  );
});
test('sealed fictional native artifact is copied privately, hashed and keeps raw lexical u64', (t) => {
  const f = fixture(t, { contentMode: 'fictional-content' });
  const path = join(f.parent, 'native.jsonl');
  const row =
    '{"event":"segment","session":18446744073709551615,"id":1,"text":"Fictional speech","run_id":"fictional-take"}\n';
  writeFileSync(path, row, { mode: 0o600 });
  const artifact = f.writer.attach({
    id: 'native',
    kind: 'native-timing',
    path,
    clockId: 'node',
    sealed: true,
  });
  assert.equal(
    readFileSync(join(f.writer.directory, artifact.path), 'utf8'),
    row,
  );
  assert.equal(
    statSync(join(f.writer.directory, artifact.path)).mode & 0o777,
    0o600,
  );
  assert.equal(f.read().manifest.writer.nativeRows, 1);
});
for (const row of [
  '{"event":"other","run_id":"wrong"}\n',
  '{"event":"a","event":"b"}\n',
  '{"event":"partial"}',
  '{"auth":"forbidden"}\n',
])
  test('invalid sealed raw input fails closed and removes partial copy', (t) => {
    const f = fixture(t, { contentMode: 'fictional-content' });
    const path = join(f.parent, 'native.jsonl');
    writeFileSync(path, row);
    assert.throws(() =>
      f.writer.attach({
        id: 'native',
        kind: 'native-timing',
        path,
        clockId: 'node',
        sealed: true,
      }),
    );
    assert.equal(f.read().manifest.writer.failed, true);
  });
test('recording copied only after explicit sealed assertion, with independently supplied duration', (t) => {
  const f = fixture(t);
  const path = join(f.parent, 'recording.mov');
  writeFileSync(path, 'fictional placeholder bytes, not real video');
  assert.throws(() =>
    f.writer.attach({ id: 'video', kind: 'recording', path, durationMs: 100 }),
  );
  f.writer.attach({
    id: 'video',
    kind: 'recording',
    path,
    durationMs: 100,
    sealed: true,
  });
  const { manifest } = f.read();
  assert.equal(manifest.recording.durationMs, 100);
  assert.equal(manifest.clocks[0].anchor, undefined);
});
test('canonical repository descendants and symlink aliases cannot be evidence parents', (t) => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  assert.throws(() =>
    createLabEvidenceWriter({
      parentDirectory: root,
      runId: 'fictional',
      fictional: true,
    }),
  );
  const parent = mkdtempSync(join(tmpdir(), 'tq-writer-alias-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const alias = join(parent, 'alias');
  symlinkSync(root, alias);
  assert.throws(() =>
    createLabEvidenceWriter({
      parentDirectory: alias,
      runId: 'fictional',
      fictional: true,
    }),
  );
  const hidden = join(root, '..writer-test-' + process.pid);
  mkdirSync(hidden);
  t.after(() => rmSync(hidden, { recursive: true, force: true }));
  assert.throws(() =>
    createLabEvidenceWriter({
      parentDirectory: hidden,
      runId: 'fictional',
      fictional: true,
    }),
  );
});

test('cloud transcription settings are recorded once, with the app query and never a token', (t) => {
  const f = fixture(t);
  assert.throws(() =>
    f.writer.recordTranscription({
      backend: 'deepgram',
      minuteCap: 5,
      grantTtlS: 900,
      token: 'fictional',
    }),
  );
  assert.throws(() =>
    f.writer.recordTranscription({
      backend: 'deepgram',
      minuteCap: 0,
      grantTtlS: 900,
    }),
  );
  f.writer.recordTranscription({
    backend: 'deepgram',
    minuteCap: 5,
    grantTtlS: 900,
  });
  assert.throws(() =>
    f.writer.recordTranscription({
      backend: 'deepgram',
      minuteCap: 5,
      grantTtlS: 900,
    }),
  );
  assert.equal(f.writer.emit(event), true);
  const { manifest } = f.read();
  assert.deepEqual(Object.keys(manifest.transcription).sort(), [
    'backend',
    'grantTtlS',
    'minuteCap',
    'query',
  ]);
  assert.match(manifest.transcription.query, /(^|&)mip_opt_out=true(&|$)/);
});
