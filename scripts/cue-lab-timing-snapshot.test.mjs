import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { snapshotLabTiming } from './cue-lab-timing-snapshot.mjs';
import { createLabEvidenceWriter } from './cue-lab-evidence-writer.mjs';
const row = '{"event":"source_ended","run_id":"fictional-snapshot"}\n';
function fixture(t, data = row) {
  const parent = fs.realpathSync(
    fs.mkdtempSync(join(tmpdir(), 'tq-snapshot-test-')),
  );
  const path = join(parent, 'live-native.jsonl');
  fs.writeFileSync(path, data, { mode: 0o600 });
  const s = fs.statSync(path, { bigint: true });
  const options = {
    path,
    parentDirectory: parent,
    runId: 'fictional-snapshot',
    sourceReleased: true,
    recorderFinalized: true,
    expectedIdentity: {
      dev: s.dev.toString(),
      ino: s.ino.toString(),
      runId: 'fictional-snapshot',
    },
  };
  t.after(() => {
    mock.restoreAll();
    syncBuiltinESMExports();
    fs.rmSync(parent, { recursive: true, force: true });
  });
  return { parent, path, options };
}
const snapshotTest = process.platform === 'win32' ? test.skip : test;
snapshotTest(
  'snapshot is closed/hash-bound and explicitly not raw writer seal or full coverage',
  (t) => {
    const f = fixture(t);
    const s = snapshotLabTiming(f.options);
    assert.equal(fs.readFileSync(s.path, 'utf8'), row);
    assert.equal(fs.readFileSync(f.path, 'utf8'), row);
    assert.equal(s.sha256, createHash('sha256').update(row).digest('hex'));
    assert.equal(s.sealed, true);
    assert.equal(s.coverage.nativeWriterMayRemainOpen, true);
    assert.equal(s.coverage.completeRunCoverage, false);
    assert.equal(s.coverage.unknownLateRecords, true);
    assert.equal(s.coverage.trailingPartialBytes, 0);
    assert.equal(s.coverage.rows, 1);
    assert.equal(fs.statSync(s.path).mode & 0o777, 0o600);
    assert.equal(fs.statSync(s.metadataPath).mode & 0o777, 0o600);
    fs.appendFileSync(f.path, row);
    assert.equal(fs.readFileSync(s.path, 'utf8'), row);
  },
);
snapshotTest('a snapshot needs a stated source end and recorder state', (t) => {
  const f = fixture(t);
  assert.throws(() =>
    snapshotLabTiming({ ...f.options, sourceReleased: false }),
  );
  const { recorderFinalized: _r, ...unstated } = f.options;
  assert.throws(() => snapshotLabTiming(unstated));
  assert.throws(() =>
    snapshotLabTiming({ ...f.options, recorderFinalized: 'yes' }),
  );
  // Released and unconfirmed are mutually exclusive.
  assert.throws(() =>
    snapshotLabTiming({ ...f.options, sourceUnconfirmed: true }),
  );
});
snapshotTest(
  'a failed take is snapshotted as unconfirmed, with the recorder state, and the writer and report say so',
  async (t) => {
    const f = fixture(t);
    const { sourceReleased: _released, ...rest } = f.options;
    assert.throws(() =>
      snapshotLabTiming({ ...rest, sourceUnconfirmed: false }),
    );
    assert.throws(() =>
      snapshotLabTiming({
        ...rest,
        sourceUnconfirmed: true,
        nativeEnded: { problem: 'source_gone' },
      }),
    );
    const writer = createLabEvidenceWriter({
      parentDirectory: f.parent,
      runId: 'fictional-snapshot',
      fictional: true,
      contentMode: 'fictional-content',
    });
    writer.addClock({ id: 'node', kind: 'monotonic' });
    const s = snapshotLabTiming({
      ...rest,
      parentDirectory: writer.directory,
      sourceUnconfirmed: true,
      recorderFinalized: false,
    });
    assert.equal(s.coverage.sourceEnd, 'unconfirmed');
    assert.equal(s.coverage.sourceReleaseObserved, false);
    assert.equal(s.coverage.recorderFinalizationObserved, false);
    assert.equal(s.coverage.nativeWriterMayRemainOpen, true);
    assert.equal(s.coverage.completeRunCoverage, false);
    assert.equal(s.coverage.unknownLateRecords, true);
    assert.equal(s.coverage.nativeEndProblem, undefined);
    writer.attach({
      id: 'native',
      kind: 'native-timing',
      path: s.path,
      clockId: 'node',
      sealed: true,
      snapshotCoverage: s.coverage,
    });
    // A coverage claiming release while unconfirmed is refused.
    assert.throws(() =>
      writer.attach({
        id: 'native-2',
        kind: 'native-timing',
        path: s.path,
        clockId: 'node',
        sealed: true,
        snapshotCoverage: { ...s.coverage, sourceReleaseObserved: true },
      }),
    );
    const { manifestPath } = writer.close();
    const { writeEvidenceReport } =
      await import('./cue-lab-evidence-report.mjs');
    const out = join(f.parent, 'report');
    await writeEvidenceReport({ manifestPath, outDir: out });
    const report = JSON.parse(
      fs.readFileSync(join(out, 'report.json'), 'utf8'),
    );
    const coverage = report.evidence.find(
      (a) => a.id === 'native',
    ).snapshotCoverage;
    assert.equal(coverage.sourceEnd, 'unconfirmed');
    assert.equal(coverage.recorderFinalizationObserved, false);
    assert.equal(coverage.completeRunCoverage, false);
    assert.match(
      fs.readFileSync(join(out, 'report.md'), 'utf8'),
      /release not confirmed: the app may still have been writing, so rows after the cutoff are unknown; recorder finalization not observed/,
    );
  },
);
snapshotTest(
  'byte cutoff copies only complete prefix and records trailing/unobserved bytes',
  (t) => {
    const f = fixture(t, row + row);
    const s = snapshotLabTiming({
      ...f.options,
      maxBytes: Buffer.byteLength(row) + 5,
    });
    assert.equal(fs.readFileSync(s.path, 'utf8'), row);
    assert.equal(s.coverage.trailingPartialBytes, 5);
    assert.equal(s.coverage.omittedBytesAtCutoff, 5);
    assert.equal(s.coverage.unobservedBytesAtOpen, Buffer.byteLength(row) - 5);
  },
);
snapshotTest(
  'row cutoff does not relabel uninspected bytes a known partial record',
  (t) => {
    const f = fixture(t, row + row);
    const s = snapshotLabTiming({ ...f.options, maxRows: 1 });
    assert.equal(fs.readFileSync(s.path, 'utf8'), row);
    assert.equal(s.coverage.rowLimitReached, true);
    assert.equal(s.coverage.trailingPartialBytes, null);
    assert.equal(s.coverage.omittedBytesAtCutoff, Buffer.byteLength(row));
  },
);
snapshotTest(
  'append during copy cannot extend the pinned cutoff or mutate original records',
  (t) => {
    const f = fixture(t);
    const read = fs.readSync;
    let grown = false;
    mock.method(fs, 'readSync', (...args) => {
      if (!grown) {
        grown = true;
        fs.appendFileSync(f.path, row);
      }
      return read(...args);
    });
    syncBuiltinESMExports();
    const s = snapshotLabTiming(f.options);
    assert.equal(fs.readFileSync(s.path, 'utf8'), row);
    assert.equal(s.coverage.grewDuringCopy, true);
    assert.equal(s.coverage.observedBytesAtEnd, Buffer.byteLength(row) * 2);
    assert.equal(s.coverage.cutoffBytes, Buffer.byteLength(row));
  },
);
for (const data of [
  '{"run_id":"wrong"}\n',
  '{"event":"a","event":"b"}\n',
  'not-json\n',
  '{"event":"' + 'x'.repeat(200) + '"}\n',
])
  snapshotTest(
    'invalid complete record fails snapshot rather than silently omitting evidence',
    (t) => {
      const f = fixture(t, data);
      assert.throws(() =>
        snapshotLabTiming({ ...f.options, maxFrameBytes: 128 }),
      );
      assert.equal(fs.readFileSync(f.path, 'utf8'), data);
    },
  );
snapshotTest(
  'foreign file identity is refused even at the expected private path',
  (t) => {
    const f = fixture(t);
    assert.throws(() =>
      snapshotLabTiming({
        ...f.options,
        expectedIdentity: { ...f.options.expectedIdentity, ino: '0' },
      }),
    );
  },
);
snapshotTest(
  'truncation during observation fails without promoting a partial copy',
  (t) => {
    const f = fixture(t);
    const read = fs.readSync;
    let changed = false;
    mock.method(fs, 'readSync', (...args) => {
      if (!changed) {
        changed = true;
        fs.truncateSync(f.path, 0);
      }
      return read(...args);
    });
    syncBuiltinESMExports();
    assert.throws(() => snapshotLabTiming(f.options));
  },
);
snapshotTest(
  'completed snapshot, not live original, attaches sealed with explicit cutoff metadata',
  (t) => {
    const f = fixture(t);
    const s = snapshotLabTiming(f.options);
    const writer = createLabEvidenceWriter({
      parentDirectory: f.parent,
      runId: f.options.runId,
      fictional: true,
      contentMode: 'fictional-content',
    });
    t.after(() => writer.close());
    writer.addClock({ id: 'node', kind: 'monotonic' });
    writer.attach({
      id: 'native',
      kind: 'native-timing',
      path: s.path,
      clockId: 'node',
      sealed: s.sealed,
      snapshotCoverage: s.coverage,
    });
    const manifest = JSON.parse(fs.readFileSync(writer.close().manifestPath));
    const a = manifest.artifacts.find((a) => a.id === 'native');
    assert.equal(a.sha256, s.sha256);
    assert.equal(a.snapshotCoverage.sourcePath, f.path);
    assert.equal(a.snapshotCoverage.nativeWriterMayRemainOpen, true);
    assert.equal(a.snapshotCoverage.completeRunCoverage, false);
  },
);
snapshotTest('snapshot coverage cannot be attached to different bytes', (t) => {
  const f = fixture(t);
  const s = snapshotLabTiming(f.options);
  fs.appendFileSync(s.path, row);
  const writer = createLabEvidenceWriter({
    parentDirectory: f.parent,
    runId: f.options.runId,
    fictional: true,
    contentMode: 'fictional-content',
  });
  t.after(() => writer.close());
  writer.addClock({ id: 'node', kind: 'monotonic' });
  assert.throws(() =>
    writer.attach({
      id: 'native',
      kind: 'native-timing',
      path: s.path,
      clockId: 'node',
      sealed: true,
      snapshotCoverage: s.coverage,
    }),
  );
  assert.equal(writer.close().failed, true);
});

for (const tail of [
  'x'.repeat(70000),
  'not-json\n',
  '{"event":"' + 'x'.repeat(70000),
])
  snapshotTest(
    'accepted row cap excludes oversized or malformed tails without inspecting them',
    (t) => {
      const f = fixture(t, row + tail);
      const s = snapshotLabTiming({ ...f.options, maxRows: 1 });
      assert.equal(fs.readFileSync(s.path, 'utf8'), row);
      assert.equal(fs.readFileSync(f.path, 'utf8'), row + tail);
      assert.equal(s.coverage.rowLimitReached, true);
      assert.equal(s.coverage.trailingPartialBytes, null);
      assert.equal(s.coverage.rows, 1);
      assert.equal(s.coverage.omittedBytesAtCutoff, Buffer.byteLength(tail));
      assert.ok(s.coverage.readBytes <= 65536);
    },
  );

snapshotTest(
  'a session native ended itself is snapshotted as native-ended, not released, and the writer and report accept it',
  async (t) => {
    const f = fixture(t);
    const { sourceReleased: _released, ...rest } = f.options;
    // Without a release or a native end there is still no snapshot.
    assert.throws(() => snapshotLabTiming(rest));
    assert.throws(() =>
      snapshotLabTiming({ ...rest, nativeEnded: { problem: 'Source gone!' } }),
    );
    // Released and native-ended are mutually exclusive.
    assert.throws(() =>
      snapshotLabTiming({
        ...f.options,
        nativeEnded: { problem: 'source_gone' },
      }),
    );
    assert.throws(() =>
      snapshotLabTiming({
        ...rest,
        sourceReleased: false,
        nativeEnded: { problem: 'source_gone' },
      }),
    );
    // As the runner does: the snapshot goes inside the evidence directory.
    const writer = createLabEvidenceWriter({
      parentDirectory: f.parent,
      runId: 'fictional-snapshot',
      fictional: true,
      contentMode: 'fictional-content',
    });
    writer.addClock({ id: 'node', kind: 'monotonic' });
    const s = snapshotLabTiming({
      ...rest,
      parentDirectory: writer.directory,
      nativeEnded: { problem: 'source_gone' },
    });
    assert.equal(s.coverage.sourceReleaseObserved, false);
    assert.equal(s.coverage.sourceEnd, 'native-ended');
    assert.equal(s.coverage.nativeEndProblem, 'source_gone');
    writer.attach({
      id: 'native',
      kind: 'native-timing',
      path: s.path,
      clockId: 'node',
      sealed: true,
      snapshotCoverage: s.coverage,
    });
    const { manifestPath } = writer.close();
    const { writeEvidenceReport } =
      await import('./cue-lab-evidence-report.mjs');
    const out = join(f.parent, 'report');
    await writeEvidenceReport({ manifestPath, outDir: out });
    const report = JSON.parse(
      fs.readFileSync(join(out, 'report.json'), 'utf8'),
    );
    const coverage = report.evidence.find(
      (a) => a.id === 'native',
    ).snapshotCoverage;
    assert.equal(coverage.sourceEnd, 'native-ended');
    assert.equal(coverage.sourceReleaseObserved, false);
    assert.match(
      fs.readFileSync(join(out, 'report.md'), 'utf8'),
      /ended by native \(source_gone\), not released by Stop/,
    );
  },
);
