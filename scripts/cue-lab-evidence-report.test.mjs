import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  chmod,
  writeFile,
  readFile,
  stat,
  symlink,
  mkdir,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  EVENT_SCHEMA,
  MANIFEST_SCHEMA,
  buildEvidenceReport,
  importNativeRows,
  parseNativeRow,
  renderEvidenceMarkdown,
  loadEvidence,
  writeEvidenceReport,
} from './cue-lab-evidence-report.mjs';
import { DEEPGRAM_APP_QUERY } from './cue-lab-deepgram.mjs';

const manifest = () => ({
  schema: MANIFEST_SCHEMA,
  runId: 'fictional-cedar',
  fictional: true,
  mode: 'adaptive',
  contentMode: 'metadata',
  createdAt: '2026-01-01T00:00:00Z',
  expiresAt: '2026-02-01T00:00:00Z',
  limits: { maxFileBytes: 1000000, maxTotalBytes: 2000000, maxEvents: 1000 },
  clocks: [
    {
      id: 'audio',
      kind: 'monotonic',
      anchor: {
        clockMs: 1000,
        recordingMs: 0,
        uncertaintyMs: 5,
        validFromMs: 1000,
        validToMs: 20000,
      },
    },
    { id: 'video', kind: 'recording' },
  ],
  artifacts: [],
});
const event = (stage, atMs, identity = {}, options = {}) => ({
  schema: EVENT_SCHEMA,
  runId: 'fictional-cedar',
  eventId: `${stage}:${atMs}`,
  stage,
  outcome: 'observed',
  ids: { sessionId: '18446744073709551615', ...identity },
  timing: {
    clockId: stage.startsWith('video.') ? 'video' : 'audio',
    atMs,
    uncertaintyMs: 2,
    basis: stage.startsWith('video.') ? 'frame' : 'event',
  },
  ...options,
});
const sid = '18446744073709551615';
function take() {
  return [
    event('speech.render-start', 1000, { lineId: 'L1' }),
    event('speech.render-end', 2000, { lineId: 'L1', segmentId: 's1' }),
    event('transcript.arrived', 2200, { segmentId: 's1' }),
    event('evaluator.requested', 2250, {
      requestId: '1',
      segmentId: 's1',
      contextRevision: '1',
    }),
    event('evaluator.admitted', 2300, { requestId: '1' }),
    event('evaluator.dispatched', 2310, { requestId: '1' }),
    event('evaluator.responded', 2700, { requestId: '1' }),
    event('evaluator.returned', 2750, { requestId: '1' }),
    event('evaluator.validated', 2800, { requestId: '1' }),
    event('evaluator.result', 2810, { requestId: '1' }, { outcome: 'show' }),
    event('cue.decided', 2810, { requestId: '1', cueId: 'c1' }),
    event('cue.published', 2850, { cueId: 'c1' }),
    event('video.cue-painted', 1900, { cueId: 'c1' }),
    event('cue.cleared', 4000, { cueId: 'c1' }),
    event('video.cue-cleared', 3100, { cueId: 'c1' }),
  ];
}
test('complete synthetic take joins exact identities and separates timing from human benefit', () => {
  const r = buildEvidenceReport(manifest(), take());
  assert.equal(r.transcription[0].lag.valueMs, 200);
  assert.equal(r.evaluations[0].gateWait.valueMs, 50);
  assert.equal(r.evaluations[0].modelDuration.valueMs, 390);
  assert.equal(r.evaluations[0].returnedAfterDispatch.valueMs, 440);
  assert.equal(r.cues[0].publicationDelay.valueMs, 50);
  assert.equal(r.cues[0].publicationToPaint.valueMs, 50);
  assert.equal(r.cues[0].visibleDuration.valueMs, 1200);
  assert.equal(r.cues[0].endToEnd.valueMs, 900);
  assert.equal(r.cues[0].endToEnd.uncertaintyMs, 9);
  assert.ok(
    r.reviews.every((v) => v.origin === 'unreviewed' && v.labels.length === 0),
  );
  assert.equal(r.mode, 'adaptive');
});
test('timing targets compare worst and best cases and never count an unmeasured sample as passing', () => {
  const r = buildEvidenceReport(manifest(), take());
  assert.deepEqual(r.budgets.speechToLine, {
    samples: 1,
    unmeasured: 0,
    median: {
      targetMs: 3500,
      valueMs: 200,
      minMs: 196,
      maxMs: 204,
      result: 'within',
    },
    p95: {
      targetMs: 5000,
      valueMs: 200,
      minMs: 196,
      maxMs: 204,
      result: 'within',
    },
  });
  assert.equal(r.budgets.lineToVisibleCue.p95.result, 'within');
  assert.equal(r.budgets.staleCue.max.valueMs, 900);
  // Lines 4 s, 4.999 s and 6 s after their heard ends: both the median and
  // the 95th percentile are over their targets.
  const lines = [4000, 4999, 6000].flatMap((lag, i) => [
    event('speech.render-end', 2000 + i * 100, {
      lineId: `L${i}`,
      segmentId: `s${i}`,
    }),
    event('transcript.arrived', 2000 + i * 100 + lag, { segmentId: `s${i}` }),
  ]);
  const slow = buildEvidenceReport(manifest(), lines).budgets;
  assert.equal(slow.speechToLine.samples, 3);
  assert.equal(slow.speechToLine.median.valueMs, 4999);
  assert.equal(slow.speechToLine.median.result, 'over');
  assert.equal(slow.speechToLine.p95.valueMs, 6000);
  assert.equal(slow.speechToLine.p95.result, 'over');
  assert.deepEqual(slow.lineToVisibleCue, {
    samples: 0,
    unmeasured: 0,
    p95: { targetMs: 5000, result: 'unmeasured' },
  });
  // A value whose uncertainty spans the target is neither met nor missed.
  const near = buildEvidenceReport(manifest(), [
    event('speech.render-end', 2000, { lineId: 'L1', segmentId: 's1' }),
    event('transcript.arrived', 5499, { segmentId: 's1' }),
  ]).budgets.speechToLine;
  assert.equal(near.median.result, 'uncertain');
  assert.equal(near.p95.result, 'within');
  // An arrival with no joined heard end is counted, not dropped.
  const unjoined = buildEvidenceReport(manifest(), [
    event('transcript.arrived', 2200, { segmentId: 's1' }),
  ]).budgets.speechToLine;
  assert.deepEqual(
    [unjoined.samples, unjoined.unmeasured, unjoined.median.result],
    [0, 1, 'unmeasured'],
  );
  assert.match(
    renderEvidenceMarkdown(r),
    /### Timing targets[\s\S]*Heard end → transcript line \| 1 \| 0 \| median within: 200 ms, between 196 and 204 ms \(target 3500 ms\)/,
  );
});
test('partial native results cannot imply dispatch, validation or video paint', () => {
  const rows = [
    parseNativeRow(
      '{"event":"evaluation_requested","mono_ms":20,"session":18446744073709551615,"request":9007199254740993,"through_segment":"s1"}',
    ),
    parseNativeRow(
      '{"event":"evaluation_result","mono_ms":70,"session":18446744073709551615,"request":9007199254740993,"outcome":"quiet","latency_ms":50}',
    ),
    parseNativeRow(
      '{"event":"cue_published","mono_ms":75,"session":18446744073709551615,"cue":"c1"}',
    ),
    {
      event: 'audio_received',
      mono_ms: 0,
      session: sid,
      start_ms: 0,
      duration_ms: 100,
    },
  ];
  const m = manifest();
  m.clocks.push({ id: 'logger', kind: 'monotonic' });
  const events = importNativeRows(rows, {
    runId: m.runId,
    artifactId: 'native',
    clockId: 'logger',
  });
  m.artifacts.push({
    id: 'native',
    kind: 'native-timing',
    clockId: 'logger',
    path: 'native.jsonl',
    bytes: 1,
    sha256: 'a'.repeat(64),
  });
  const r = buildEvidenceReport(m, events);
  assert.equal(r.evaluations[0].id, `${sid}/9007199254740993`);
  assert.equal(r.evaluations[0].outcome, 'quiet');
  assert.equal(r.evaluations[0].modelDuration.status, 'unknown');
  assert.equal(r.evaluations[0].gateWait.status, 'unknown');
  assert.equal(r.evaluations[0].nativeReportedLatencyMs, 50);
  assert.equal(r.cues[0].paint, 'unobserved');
  assert.ok(r.timeline.every((e) => e.recording === null));
  assert.ok(!r.timeline.some((e) => e.stage.startsWith('speech.')));
  assert.ok(r.reviews.every((v) => v.labels.length === 0));
});
test('missing bridge preserves same-clock measurements but cross-clock stays unknown', () => {
  const m = manifest();
  delete m.clocks[0].anchor;
  const r = buildEvidenceReport(m, take());
  assert.equal(r.evaluations[0].modelDuration.valueMs, 390);
  assert.equal(r.cues[0].endToEnd.reason, 'missing valid clock bridge');
  assert.equal(r.cues[0].visibleDuration.valueMs, 1200);
});
test('bounded anchor never extrapolates or derives origin from body entry', () => {
  const m = manifest();
  m.clocks[0].anchor.validToMs = 2000;
  const r = buildEvidenceReport(m, take());
  assert.equal(
    r.timeline.find((e) => e.stage === 'cue.published').recording,
    null,
  );
  assert.equal(r.cues[0].publicationToPaint.status, 'unknown');
});
test('scheduled timestamps, reversed order, and uncertainty are explicit', () => {
  const events = take();
  events[1].timing.basis = 'scheduled';
  assert.equal(
    buildEvidenceReport(manifest(), events).transcription[0].lag.reason,
    'missing actual timing',
  );
  const reverse = take();
  reverse[4].timing.atMs = 2200;
  assert.equal(
    buildEvidenceReport(manifest(), reverse).evaluations[0].gateWait.reason,
    'reversed chronology',
  );
  const near = take();
  near[4].timing.atMs = 2251;
  assert.equal(
    buildEvidenceReport(manifest(), near).evaluations[0].gateWait.status,
    'uncertain',
  );
});
test('no fuzzy text or cross-session identity joins', () => {
  const events = take();
  delete events[1].ids.segmentId;
  events[1].payload = events[2].payload = {
    spokenText: 'Which fictional release?',
    transcriptText: 'Which fictional release?',
  };
  assert.equal(
    buildEvidenceReport(manifest(), events).transcription[0].lag.status,
    'unknown',
  );
  const other = take();
  other[1].ids.sessionId = '2';
  assert.equal(
    buildEvidenceReport(manifest(), other).transcription[0].lag.status,
    'unknown',
  );
});
test('duplicate stages and conflicting contexts stay ambiguous instead of picking a winner', () => {
  const events = take();
  events.push(
    event('evaluator.responded', 2801, {
      requestId: '1',
      contextRevision: '2',
    }),
  );
  const r = buildEvidenceReport(manifest(), events);
  assert.equal(r.evaluations[0].ambiguous, true);
  assert.equal(r.evaluations[0].outcome, 'unknown');
  assert.equal(r.cues[0].publicationDelay.status, 'unknown');
  assert.throws(
    () => buildEvidenceReport(manifest(), [...take(), take()[0]]),
    /duplicate/,
  );
});
test('quiet, failed, stale, cancelled and unknown remain separate; dropped evidence retained', () => {
  const events = ['quiet', 'failure', 'stale', 'cancelled', 'unknown'].map(
    (outcome, i) =>
      event(
        'evaluator.result',
        2000 + i,
        { requestId: String(i + 1) },
        { outcome },
      ),
  );
  events.push(event('gap', 2010, {}, { payload: { dropped: 7 } }));
  const r = buildEvidenceReport(manifest(), events);
  for (const o of ['quiet', 'failure', 'stale', 'cancelled', 'unknown'])
    assert.equal(r.counts[o], 1);
  assert.equal(r.gaps[0].dropped, 7);
  assert.equal(r.reviews.length, 5);
});
test('metadata default strips rich payload; content requires two opt-ins and rejects forbidden structures', () => {
  const m = manifest(),
    events = take();
  events[0].payload = {
    spokenText: 'Fictional Cedar launch',
    request: { role: 'listener', input: { lines: ['Cedar'] } },
    validatedResponse: { action: 'quiet' },
    environment: 'NEVER_COPY',
  };
  assert.ok(
    !JSON.stringify(buildEvidenceReport(m, events)).includes(
      'Fictional Cedar launch',
    ),
  );
  assert.throws(
    () => buildEvidenceReport(m, events, { includeContent: true }),
    /explicit fictional/,
  );
  m.contentMode = 'fictional-content';
  const r = buildEvidenceReport(m, events, { includeContent: true });
  assert.equal(
    r.timeline.find((e) => e.stage === 'speech.render-start').payload
      .spokenText,
    'Fictional Cedar launch',
  );
  assert.ok(!JSON.stringify(r).includes('NEVER_COPY'));
  events[0].payload.request.input.secret = 'NEVER_COPY';
  assert.throws(
    () => buildEvidenceReport(m, events, { includeContent: true }),
    /forbidden/,
  );
});
test('human labels retained without copying arbitrary manifest fields; Markdown is inert', () => {
  const m = manifest();
  m.reviews = [
    {
      ids: { sessionId: sid, requestId: '1' },
      labels: ['late'],
      note: '<img src=x> [external](https://example.invalid)',
      nextChange: 'Compare shorter context',
      comparison: 'Same fictional scenario, different build',
      secret: 'NEVER_COPY',
    },
  ];
  const r = buildEvidenceReport(m, take());
  const md = renderEvidenceMarkdown(r, { recordingHref: '../take.mp4' });
  assert.ok(!JSON.stringify(r).includes('NEVER_COPY'));
  assert.ok(md.includes('&#91;external&#93;'));
  assert.ok(md.includes('../take.mp4#t=1.900'));
  assert.ok(md.includes('Same fictional scenario'));
  assert.ok(!md.includes('<img'));
});
test('invalid run/u64/session clock/frame claims are rejected', () => {
  for (const change of [
    (e) => (e.runId = 'other'),
    (e) => (e.ids.requestId = 9007199254740992),
    (e) => (e.ids.sessionId = '18446744073709551616'),
  ]) {
    const e = take()[0];
    change(e);
    assert.throws(() => buildEvidenceReport(manifest(), [e]));
  }
  const paint = take()[12];
  paint.timing.basis = 'receipt';
  assert.throws(() => buildEvidenceReport(manifest(), [paint]), /paint/);
  delete paint.timing;
  assert.throws(() => buildEvidenceReport(manifest(), [paint]), /paint/);
  const m = manifest();
  m.clocks[0] = { id: 'audio', kind: 'native-session', sessionId: '2' };
  assert.throws(() => buildEvidenceReport(m, [take()[0]]), /session clock/);
});
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'fictional-evidence-'));
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  const data =
    take()
      .map((e) => JSON.stringify(e))
      .join('\n') + '\n';
  await writeFile(join(root, 'events.jsonl'), data, { mode: 0o600 });
  const media = Buffer.from(
    'synthetic recording identity stand-in; not playable media',
  );
  await writeFile(join(root, 'take.mp4'), media, { mode: 0o600 });
  const m = manifest();
  m.artifacts = [
    {
      id: 'events',
      kind: 'events',
      path: 'events.jsonl',
      bytes: Buffer.byteLength(data),
      sha256: createHash('sha256').update(data).digest('hex'),
    },
    {
      id: 'video',
      kind: 'recording',
      path: 'take.mp4',
      bytes: media.length,
      sha256: createHash('sha256').update(media).digest('hex'),
    },
  ];
  m.recording = { artifactId: 'video', durationMs: 4000 };
  const path = join(root, 'manifest.json');
  await writeFile(path, JSON.stringify(m), { mode: 0o600 });
  return {
    root,
    m,
    path,
    save: () => writeFile(path, JSON.stringify(m), { mode: 0o600 }),
  };
}
test('private offline end-to-end report pins hashes, preserves originals and writes restrictive files', async (t) => {
  const f = await fixture(t),
    before = await readFile(join(f.root, 'events.jsonl'));
  const result = await writeEvidenceReport({
    manifestPath: f.path,
    outDir: join(f.root, 'report'),
  });
  assert.equal(result.report.cues[0].paint, 'observed');
  assert.equal((await stat(result.output)).mode & 0o777, 0o700);
  assert.equal(
    (await stat(join(result.output, 'report.md'))).mode & 0o777,
    0o600,
  );
  assert.equal(
    (await stat(join(result.output, 'report.json'))).mode & 0o777,
    0o600,
  );
  assert.deepEqual(await readFile(join(f.root, 'events.jsonl')), before);
  assert.ok(
    (await readFile(join(result.output, 'report.md'), 'utf8')).includes(
      '../take.mp4#t=',
    ),
  );
  await assert.rejects(
    writeEvidenceReport({ manifestPath: f.path, outDir: result.output }),
    /EEXIST/,
  );
});
test('tampered artifact, permissive file/root, path escape and symlink fail closed', async (t) => {
  const f = await fixture(t);
  f.m.artifacts[0].sha256 = '0'.repeat(64);
  await f.save();
  await assert.rejects(loadEvidence(f.path), /hash/);
  f.m.artifacts[0].path = '../events.jsonl';
  await f.save();
  await assert.rejects(loadEvidence(f.path), /artifact/);
  f.m.artifacts[0].path = 'alias';
  await symlink(join(f.root, 'events.jsonl'), join(f.root, 'alias'));
  await f.save();
  await assert.rejects(loadEvidence(f.path), /alias/);
  await chmod(f.path, 0o644);
  await assert.rejects(loadEvidence(f.path), /mode/);
  await chmod(f.path, 0o600);
  await chmod(f.root, 0o755);
  await assert.rejects(loadEvidence(f.path), /0700/);
});
test('input event/output bounds are enforced without deleting retained media', async (t) => {
  const f = await fixture(t);
  f.m.limits.maxEvents = 2;
  await f.save();
  await assert.rejects(
    writeEvidenceReport({
      manifestPath: f.path,
      outDir: join(f.root, 'report'),
    }),
    /event limit/,
  );
  assert.ok(await stat(join(f.root, 'take.mp4')));
  const m = manifest();
  m.limits.maxFileBytes = 100000000;
  assert.throws(() => buildEvidenceReport(m, []), /maxFileBytes/);
});

test('failed playback or publication is not successful heard or visible evidence', () => {
  const events = take();
  events[1].outcome = 'cancelled';
  events[11].outcome = 'failure';
  events[12].outcome = 'failure';
  const r = buildEvidenceReport(manifest(), events);
  assert.equal(r.transcription[0].lag.reason, 'unsuccessful endpoint');
  assert.equal(r.cues[0].publication, 'unobserved');
  assert.equal(r.cues[0].paint, 'unobserved');
  assert.equal(r.cues[0].visibleDuration.reason, 'unsuccessful endpoint');
});
test('native recognized rejection remains evidence; no ASR finalization is invented', () => {
  const m = manifest();
  const rows = [
    {
      event: 'segment',
      mono_ms: 2000,
      session: sid,
      id: 's1',
      accepted: false,
      text: 'Fictional rejected line',
    },
  ];
  const events = importNativeRows(rows, {
    runId: m.runId,
    artifactId: 'native',
    clockId: 'audio',
  });
  m.artifacts.push({
    id: 'native',
    kind: 'native-timing',
    path: 'native.jsonl',
    clockId: 'audio',
    bytes: 0,
    sha256: 'a'.repeat(64),
  });
  const r = buildEvidenceReport(m, events);
  assert.equal(r.timeline[0].payload.accepted, false);
  assert.ok(r.missingEvidence.includes('transcript.finalized'));
  assert.ok(!JSON.stringify(r).includes('Fictional rejected line'));
});
test('native loader handles partial real event shape and full numeric u64 without model stages', async (t) => {
  const f = await fixture(t);
  const raw =
    '{"event":"evaluation_result","wall_ms":100,"mono_ms":70,"session":18446744073709551615,"request":9007199254740993,"elapsed_ms":50,"outcome":"stale","latency_ms":30}\n{"event":"dropped","mono_ms":71,"count":4}\n';
  await writeFile(join(f.root, 'native.jsonl'), raw, { mode: 0o600 });
  f.m.artifacts = [
    {
      id: 'native',
      kind: 'native-timing',
      path: 'native.jsonl',
      clockId: 'audio',
      bytes: Buffer.byteLength(raw),
      sha256: createHash('sha256').update(raw).digest('hex'),
    },
  ];
  delete f.m.recording;
  await f.save();
  const { manifest: m, events } = await loadEvidence(f.path);
  const r = buildEvidenceReport(m, events);
  assert.equal(r.evaluations[0].id, `${sid}/9007199254740993`);
  assert.equal(r.evaluations[0].outcome, 'stale');
  assert.equal(r.evaluations[0].modelDuration.status, 'unknown');
  assert.equal(r.gaps[0].dropped, 4);
});
test('event timing arbitrary fields are not copied into the report', () => {
  const events = take();
  events[0].timing.secret = 'NEVER_COPY';
  assert.ok(
    !JSON.stringify(buildEvidenceReport(manifest(), events)).includes(
      'NEVER_COPY',
    ),
  );
});

test('explicit native run identity is checked even on unmapped development rows', () => {
  assert.throws(
    () =>
      importNativeRows(
        [
          {
            event: 'dev_stop',
            run_id: 'different-fictional-run',
            step: 'released',
          },
        ],
        { runId: 'fictional-cedar', artifactId: 'native', clockId: 'audio' },
      ),
    /run identity/,
  );
});
test('partial native import reports unmapped rows instead of silently presenting complete coverage', async (t) => {
  const f = await fixture(t);
  const rows = [
    { event: 'session', session: 1, mono_ms: 0, state: 'started' },
    {
      event: 'audio_received',
      session: 1,
      mono_ms: 1,
      start_ms: 0,
      duration_ms: 20,
    },
    {
      event: 'evaluation_result',
      session: 1,
      request: 1,
      mono_ms: 50,
      outcome: 'quiet',
      latency_ms: 20,
    },
  ];
  const raw = rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
  await writeFile(join(f.root, 'native.jsonl'), raw, { mode: 0o600 });
  f.m.artifacts = [
    {
      id: 'native',
      kind: 'native-timing',
      path: 'native.jsonl',
      clockId: 'audio',
      bytes: Buffer.byteLength(raw),
      sha256: createHash('sha256').update(raw).digest('hex'),
    },
  ];
  delete f.m.recording;
  await f.save();
  const { report } = await writeEvidenceReport({
    manifestPath: f.path,
    outDir: join(f.root, 'report'),
  });
  assert.deepEqual(report.inputSummary, [
    {
      artifactId: 'native',
      rows: 3,
      normalizedEvents: 1,
      unmappedNativeRows: 2,
    },
  ]);
  assert.ok(renderEvidenceMarkdown(report).includes('| native | 3 | 1 | 2 |'));
  assert.equal(report.gaps.length, 0); // Unmapped is distinct from known dropped evidence.
});

for (const decider of ['phrase_rule', 'model']) {
  test(`native ${decider} cue provenance survives metadata-only import and report without evaluator inference`, () => {
    const m = manifest();
    m.artifacts = [
      {
        id: 'native',
        kind: 'native-timing',
        clockId: 'audio',
        path: 'native.jsonl',
        bytes: 0,
        sha256: 'a'.repeat(64),
      },
    ];
    const rows = [
      {
        event: 'cue_decision',
        session: sid,
        cue: 'c1',
        decider,
        source: decider === 'model' ? 'evaluated' : 'phrase',
        kind: 'question',
        mono_ms: 2000,
      },
      { event: 'cue_published', session: sid, cue: 'c1', mono_ms: 2010 },
    ];
    const events = importNativeRows(rows, {
      runId: m.runId,
      artifactId: 'native',
      clockId: 'audio',
    });
    const r = buildEvidenceReport(m, events);
    assert.equal(
      r.timeline.find((e) => e.stage === 'cue.decided').payload.decider,
      decider,
    );
    assert.equal(r.cues[0].decider, decider);
    assert.equal(r.cues[0].paint, 'unobserved');
    assert.ok(renderEvidenceMarkdown(r).includes(`/ ${decider} |`));
  });
}
test('cue decider remains unknown without explicit unambiguous provenance, regardless of evaluator evidence', () => {
  const events = take();
  assert.equal(
    buildEvidenceReport(manifest(), events).cues[0].decider,
    'unknown',
  );
  events[10].payload = { decider: 'model' };
  events.push(
    event(
      'cue.decided',
      2820,
      { cueId: 'c1' },
      { payload: { decider: 'phrase_rule' } },
    ),
  );
  assert.equal(
    buildEvidenceReport(manifest(), events).cues[0].decider,
    'unknown',
  );
});

test('completion receipt is not actual heard-end latency and timeline labels its basis', () => {
  const events = take();
  events[1].timing.basis = 'receipt';
  const r = buildEvidenceReport(manifest(), events);
  assert.equal(r.transcription[0].lag.status, 'unknown');
  assert.equal(
    r.transcription[0].lag.reason,
    'heard end requires actual event timing',
  );
  assert.equal(r.cues[0].endToEnd.status, 'unknown');
  assert.ok(
    renderEvidenceMarkdown(r).includes('receipt only (not event time)'),
  );
  assert.equal(r.evaluations[0].modelDuration.valueMs, 390);
});
test('writer failure declaration survives independently from gap rows without copying arbitrary metadata', () => {
  const m = manifest();
  m.writer = { failed: true, dropped: 1, secret: 'NEVER_COPY' };
  const r = buildEvidenceReport(m, []);
  assert.deepEqual(r.writerStatus, { failed: true, dropped: 1 });
  assert.equal(r.gaps.length, 0);
  assert.ok(!JSON.stringify(r).includes('NEVER_COPY'));
  const md = renderEvidenceMarkdown(r);
  assert.ok(md.includes('failed=true; dropped=1'));
  assert.ok(md.includes('do not add the counts'));
  const withGap = buildEvidenceReport(m, [
    event('gap', 1500, {}, { payload: { dropped: 1 } }),
  ]);
  assert.equal(withGap.writerStatus.dropped, 1);
  assert.equal(withGap.gaps[0].dropped, 1);
  assert.equal(buildEvidenceReport(manifest(), []).writerStatus, null);
});
test('malformed writer failure declaration is rejected', () => {
  for (const writer of [
    { failed: 'false', dropped: 1 },
    { failed: true, dropped: -1 },
    { failed: true, dropped: 1.5 },
    { failed: true, dropped: 1001 },
  ]) {
    const m = manifest();
    m.writer = writer;
    assert.throws(() => buildEvidenceReport(m, []), /writer status/);
  }
});
// Metadata-only snapshots emitted by writer 994a280; creation/expiry normalized.
// Copy to a private external directory so normal loader checks are exercised.
for (const kind of ['receipt-end', 'failed-gap']) {
  test(`crossloads actual synthetic writer v1 ${kind} files without inventing event timing or losing failure`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'fictional-writer-compat-'));
    await chmod(root, 0o700);
    t.after(() => rm(root, { recursive: true, force: true }));
    for (const file of ['manifest.json', 'events.jsonl']) {
      const data = await readFile(
        new URL(
          `./fixtures/lab-evidence-writer-v1/${kind}/${file}`,
          import.meta.url,
        ),
      );
      await writeFile(join(root, file), data, { mode: 0o600 });
    }
    const { report } = await writeEvidenceReport({
      manifestPath: join(root, 'manifest.json'),
      outDir: join(root, 'report'),
    });
    if (kind === 'receipt-end') {
      assert.equal(report.transcription[0].lag.status, 'unknown');
      assert.equal(
        report.transcription[0].lag.reason,
        'heard end requires actual event timing',
      );
      assert.equal(report.timeline[0].timing.basis, 'receipt');
      assert.ok(
        (await readFile(join(root, 'report/report.md'), 'utf8')).includes(
          'receipt only (not event time)',
        ),
      );
      assert.deepEqual(report.writerStatus, { failed: false, dropped: 0 });
    } else {
      assert.deepEqual(report.writerStatus, { failed: true, dropped: 1 });
      assert.equal(report.gaps.length, 0);
      assert.equal(report.timeline.length, 0);
    }
    assert.ok(await stat(join(root, 'manifest.json')));
  });
}

// Snapshot->writer fixture emitted by 745b3d6; path/inode/times fictionalized.
async function snapshotFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'fictional-snapshot-compat-'));
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const file of ['manifest.json', 'events.jsonl', 'native.jsonl']) {
    const data = await readFile(
      new URL(
        `./fixtures/lab-evidence-writer-v1/partial-snapshot/${file}`,
        import.meta.url,
      ),
    );
    await writeFile(join(root, file), data, { mode: 0o600 });
  }
  return { root, manifestPath: join(root, 'manifest.json') };
}
test('actual snapshot to writer to report retains bounded incomplete coverage separately from event gaps', async (t) => {
  const f = await snapshotFixture(t);
  const { report } = await writeEvidenceReport({
    manifestPath: f.manifestPath,
    outDir: join(f.root, 'report'),
  });
  const c = report.evidence.find((a) => a.id === 'native').snapshotCoverage;
  assert.equal(c.completeRunCoverage, false);
  assert.equal(c.unknownLateRecords, true);
  assert.equal(c.nativeWriterMayRemainOpen, true);
  assert.equal(c.rows, 1);
  assert.equal(c.trailingPartialBytes, 5);
  assert.equal(c.omittedBytesAtCutoff, 5);
  assert.ok(c.unobservedBytesAtOpen > 0);
  assert.equal(c.cutoffReceipt.basis, 'receipt');
  assert.equal(c.cutoffReceipt.clockId, 'node');
  assert.equal(report.gaps.length, 0);
  assert.equal(c.sourcePath, undefined);
  assert.equal(c.sourceIdentity, undefined);
  assert.ok(!JSON.stringify(report).includes('/fictional/native-timing.jsonl'));
  const md = await readFile(join(f.root, 'report/report.md'), 'utf8');
  assert.ok(
    md.includes('completeRunCoverage=false and unknownLateRecords=true'),
  );
  assert.ok(md.includes('the timeline is incomplete'));
  assert.ok(md.includes(`5 / ${c.unobservedBytesAtOpen}`));
  assert.equal(
    report.evaluations[0].id,
    '18446744073709551615/9007199254740993',
  );
  assert.equal(report.evaluations[0].modelDuration.status, 'unknown');
  assert.ok(report.timeline.every((e) => e.recording === null));
  assert.ok(await stat(join(f.root, 'native.jsonl')));
});
test('snapshot coverage cannot claim completeness, mismatch its artifact or conceal omitted bytes', async (t) => {
  const f = await snapshotFixture(t);
  const raw = JSON.parse(await readFile(f.manifestPath, 'utf8'));
  for (const mutate of [
    (c) => (c.completeRunCoverage = true),
    (c) => (c.unknownLateRecords = false),
    (c) => c.copiedBytes++,
    (c) => (c.sha256 = '0'.repeat(64)),
    (c) => (c.omittedBytesAtCutoff = 0),
    (c) => (c.cutoffReceipt.basis = 'event'),
  ]) {
    const m = structuredClone(raw);
    mutate(m.artifacts.find((a) => a.id === 'native').snapshotCoverage);
    assert.throws(() => buildEvidenceReport(m, []), /snapshot coverage/);
  }
});
test('snapshot row limit keeps unparsed partial count unknown and row count is checked on file load', async (t) => {
  const f = await snapshotFixture(t);
  const raw = JSON.parse(await readFile(f.manifestPath, 'utf8'));
  const native = raw.artifacts.find((a) => a.id === 'native');
  native.snapshotCoverage.rowLimitReached = true;
  native.snapshotCoverage.trailingPartialBytes = null;
  const r = buildEvidenceReport(raw, []);
  assert.ok(renderEvidenceMarkdown(r).includes('1 / unknown'));
  native.snapshotCoverage.rows = 2;
  await writeFile(f.manifestPath, JSON.stringify(raw), { mode: 0o600 });
  await assert.rejects(loadEvidence(f.manifestPath), /snapshot row count/);
});

function nativeReport(rows) {
  const m = manifest();
  const events = importNativeRows(rows, {
    runId: m.runId,
    artifactId: 'native',
    clockId: 'audio',
  });
  m.artifacts.push({
    id: 'native',
    kind: 'native-timing',
    path: 'native.jsonl',
    clockId: 'audio',
    bytes: 0,
    sha256: 'a'.repeat(64),
  });
  return buildEvidenceReport(m, events);
}
test('an applied lab decision shows how far behind the newest speech it was, per evaluation and per cue', () => {
  const r = nativeReport([
    {
      event: 'evaluation_requested',
      mono_ms: 100,
      session: sid,
      request: 3,
      through_segment: 't1-0-2',
    },
    {
      event: 'evaluation_result',
      mono_ms: 6350,
      session: sid,
      request: 3,
      outcome: 'show',
      latency_ms: 6250,
      through_segment: 't1-0-4',
      lag_lines: 2,
      lag_ms: 6000,
    },
    {
      event: 'cue_decision',
      mono_ms: 6351,
      session: sid,
      request: 3,
      cue: 7,
      decider: 'model',
    },
    {
      event: 'evaluation_result',
      mono_ms: 9000,
      session: sid,
      request: 4,
      outcome: 'stale',
      latency_ms: 7000,
      action: 'quiet',
    },
  ]);
  const applied = r.evaluations.find((e) => e.id.endsWith('3'));
  assert.deepEqual(applied.staleness, {
    throughSegment: 't1-0-4',
    lagLines: 2,
    lagMs: 6000,
  });
  assert.equal(applied.unappliedAction, null);
  const stale = r.evaluations.find((e) => e.id.endsWith('4'));
  assert.equal(stale.staleness, null);
  assert.equal(stale.unappliedAction, 'quiet');
  assert.deepEqual(r.cues[0].staleness, applied.staleness);
  const md = renderEvidenceMarkdown(r);
  assert.ok(md.includes('t1-0-4 / 2 / 6000 ms'));
  assert.ok(md.includes('bounded staleness'));
});
test('malformed lab decision fields are refused, never guessed', () => {
  const base = {
    event: 'evaluation_result',
    mono_ms: 1,
    session: sid,
    request: 1,
    latency_ms: 1,
  };
  for (const row of [
    { ...base, outcome: 'show', through_segment: 't1', lag_lines: 1 },
    {
      ...base,
      outcome: 'show',
      through_segment: 't1',
      lag_lines: 0,
      lag_ms: 5,
    },
    {
      ...base,
      outcome: 'show',
      through_segment: 't1',
      lag_lines: -1,
      lag_ms: 0,
    },
    {
      ...base,
      outcome: 'stale',
      through_segment: 't1',
      lag_lines: 0,
      lag_ms: 0,
    },
    {
      ...base,
      outcome: 'stale',
      action: 'quiet',
      through_segment: 't1',
      lag_lines: 0,
      lag_ms: 0,
    },
    { ...base, outcome: 'stale', action: 'explain' },
  ])
    assert.throws(() =>
      importNativeRows([row], {
        runId: 'fictional-cedar',
        artifactId: 'native',
        clockId: 'audio',
      }),
    );
});
test('an unapplied action is accepted only on stale or timeout results, and segment ids are id-shaped', () => {
  const load = (row) =>
    importNativeRows(
      [
        {
          event: 'evaluation_result',
          mono_ms: 1,
          session: sid,
          request: 1,
          latency_ms: 1,
          ...row,
        },
      ],
      { runId: 'fictional-cedar', artifactId: 'native', clockId: 'audio' },
    );
  assert.equal(
    load({ outcome: 'failed', failure: 'timeout', action: 'show' })[0].payload
      .decisionAction,
    'show',
  );
  for (const row of [
    { outcome: 'show', action: 'show' },
    { outcome: 'cancelled', action: 'quiet' },
    { outcome: 'failed', failure: 'unavailable', action: 'quiet' },
    {
      outcome: 'show',
      through_segment: 'a fictional sentence',
      lag_lines: 0,
      lag_ms: 0,
    },
    { outcome: 'show', through_segment: '', lag_lines: 0, lag_ms: 0 },
  ])
    assert.throws(() => load(row));
});

test('a refused evaluation on the direct API route is its own non-decision outcome', () => {
  const load = (row) =>
    importNativeRows(
      [
        {
          event: 'evaluation_result',
          mono_ms: 1,
          session: sid,
          request: 1,
          latency_ms: 900,
          ...row,
        },
      ],
      { runId: 'fictional-cedar', artifactId: 'native', clockId: 'audio' },
    );
  const [e] = load({ outcome: 'refused' });
  assert.equal(e.outcome, 'refused');
  assert.throws(() => load({ outcome: 'refused', action: 'quiet' }));
  // Native's row for a reply at the output bound, also a non-decision.
  assert.equal(load({ outcome: 'output_limit' })[0].outcome, 'output_limit');
  assert.throws(() => load({ outcome: 'output_limit', action: 'show' }));
  const r = nativeReport([
    {
      event: 'evaluation_result',
      mono_ms: 1,
      session: sid,
      request: 1,
      latency_ms: 900,
      outcome: 'refused',
    },
  ]);
  assert.equal(r.evaluations[0].outcome, 'refused');
  const limited = nativeReport([
    {
      event: 'evaluation_result',
      mono_ms: 1,
      session: sid,
      request: 1,
      latency_ms: 900,
      outcome: 'output_limit',
    },
  ]);
  assert.equal(limited.evaluations[0].outcome, 'output_limit');
});

// Cloud transcription (#344): settings, stream order against the in-app
// review, stop codes, audio against the cap and final → line delay.
const transcriptionSettings = {
  backend: 'deepgram',
  minuteCap: 5,
  grantTtlS: 900,
  query: DEEPGRAM_APP_QUERY,
};
function cloudReport(rows, settings = transcriptionSettings) {
  const m = manifest();
  if (settings) m.transcription = settings;
  const events = importNativeRows(
    rows.map((r) => ({ ...r })),
    {
      runId: m.runId,
      artifactId: 'native',
      clockId: 'audio',
    },
  );
  m.artifacts.push({
    id: 'native',
    kind: 'native-timing',
    path: 'native.jsonl',
    clockId: 'audio',
    bytes: 0,
    sha256: 'a'.repeat(64),
  });
  return buildEvidenceReport(m, events);
}
const cloudRows = ({
  reviewFirst = true,
  stop,
  reviewSession = '2',
  query = DEEPGRAM_APP_QUERY,
} = {}) => {
  const review = {
    event: 'evaluator',
    approval: 'review',
    session: reviewSession,
    state: 'on',
    backend: 'lab-api',
    model: 'claude-opus-5-5',
    effort: 'low',
    elapsed_ms: 400,
    mono_ms: 1400,
  };
  const started = {
    event: 'stt_state',
    session: '2',
    state: 'started',
    audio_ms: 0,
    mono_ms: 1500,
  };
  return [
    {
      event: 'session',
      session: '2',
      live: true,
      state: 'started',
      elapsed_ms: 0,
      mono_ms: 1000,
      commit: 'c',
      features: [],
    },
    ...(reviewFirst ? [review, started] : [started, review]),
    {
      event: 'stt_state',
      session: '2',
      state: 'connected',
      audio_ms: 0,
      query,
      mono_ms: 1600,
    },
    {
      event: 'stt_final',
      session: '2',
      seq: 1,
      start_ms: 2000,
      end_ms: 4200,
      untrusted_speaker: 3,
      mono_ms: 5700,
    },
    {
      event: 'segment',
      session: '2',
      id: 'c2-1-1',
      at_ms: 2000,
      speaker: 'Speaker',
      text: 'A fictional plan for Friday.',
      accepted: true,
      mono_ms: 5701,
    },
    stop ?? {
      event: 'stt_state',
      session: '2',
      state: 'ended',
      audio_ms: 95000,
      mono_ms: 9000,
    },
  ];
};

test('cloud transcription evidence records settings, review order, stop, cap and final delay, and no speaker label', () => {
  const r = cloudReport(cloudRows());
  const c = r.cloudTranscription;
  assert.deepEqual(c.settings, transcriptionSettings);
  assert.equal(c.reviewRowSeen, true);
  assert.deepEqual(c.streams, [
    {
      sessionId: '2',
      starts: 1,
      startedAfterReview: true,
      connected: true,
      reconnects: [],
      query: DEEPGRAM_APP_QUERY,
      queryMatchesExpected: true,
      dropping: false,
      stopState: 'ended',
      stopCode: null,
      audioMs: 95000,
      turnedOff: false,
      turnOff: null,
      failure: null,
    },
  ]);
  // The cap covers the whole launch.
  assert.deepEqual([c.audioMs, c.capMs, c.withinCap], [95000, 300000, true]);
  // Speech ended at session 4200 ms = mono 5200; the line arrived at 5701.
  assert.equal(c.finals[0].segmentId, 'c2-1-1');
  assert.equal(c.finals[0].finalToSegmentMs, 501);
  assert.equal(c.finalToSegment.maxMs, 501);
  assert.equal(JSON.stringify(r).includes('untrusted'), false);
  assert.equal(JSON.stringify(r).includes('Speaker":3'), false);
  const md = renderEvidenceMarkdown(r);
  assert.match(md, /### Cloud transcription/);
  assert.match(md, /mip_opt_out=true/);
  // The native figure says plainly it is not the heard-end target, and the
  // recording-derived estimates stay out of the target rows.
  assert.match(
    md,
    /Final end of speech → transcript line: [\s\S]*This is not the "Heard end → transcript line" target below\. It starts from the transcription service's own end-of-speech time/,
  );
  assert.match(
    md,
    /Recording-derived estimates \(scripts\/cue-lab-take-timing\.mjs\) join by order and time overlap and are kept out of these rows\./,
  );
  assert.equal(r.budgets.speechToLine.samples, 0);
});

test('a stream that started before the review row, and a stop code, are reported as such', () => {
  const r = cloudReport(
    cloudRows({
      reviewFirst: false,
      stop: {
        event: 'stt_state',
        session: '2',
        state: 'stopped',
        code: 'cap_reached',
        audio_ms: 300000,
        mono_ms: 9000,
      },
    }),
  );
  const [s] = r.cloudTranscription.streams;
  assert.equal(s.startedAfterReview, false);
  assert.deepEqual([s.stopState, s.stopCode], ['stopped', 'cap_reached']);
  // A review in another session does not approve this one.
  assert.equal(
    cloudReport(cloudRows({ reviewSession: '7' })).cloudTranscription.streams[0]
      .startedAfterReview,
    false,
  );
});

test('the query the app used is reported, and compared with the expected one', () => {
  const used = DEEPGRAM_APP_QUERY.replace('model=nova-3', 'model=nova-2');
  const [s] = cloudReport(cloudRows({ query: used })).cloudTranscription
    .streams;
  assert.deepEqual([s.query, s.queryMatchesExpected], [used, false]);
  // A query carrying a credential, or a query on another state, is refused.
  assert.throws(() =>
    cloudReport(cloudRows({ query: 'model=nova-3&token=abc' })),
  );
  // Only the app's own parameter names are accepted, so no other parameter,
  // however named, can carry a value into evidence; nor a repeated one.
  for (const query of [
    DEEPGRAM_APP_QUERY + '&session_ref=abcdef0123456789',
    'model=nova-3&model=nova-3',
  ])
    assert.throws(() => cloudReport(cloudRows({ query })));
  assert.throws(() =>
    cloudReport([
      {
        event: 'stt_state',
        session: '2',
        state: 'started',
        audio_ms: 0,
        query: DEEPGRAM_APP_QUERY,
      },
    ]),
  );
});

test('a send-queue overflow is reported apart from the stop, and a lab run end is its own code', () => {
  const rows = cloudRows({
    stop: {
      event: 'stt_state',
      session: '2',
      state: 'stopped',
      code: 'lab_ended',
      audio_ms: 50000,
      mono_ms: 9000,
    },
  });
  rows.splice(rows.length - 1, 0, {
    event: 'stt_state',
    session: '2',
    state: 'dropping',
    audio_ms: 40000,
    mono_ms: 8000,
  });
  const [s] = cloudReport(rows).cloudTranscription.streams;
  assert.deepEqual(
    [s.dropping, s.stopState, s.stopCode, s.audioMs],
    [true, 'stopped', 'lab_ended', 50000],
  );
});

// Processing turned off mid-run (T5), and a provider-failure take.
const offRow = (code = 'lab_ended', audio_ms = 50000, mono_ms = 9000) => ({
  event: 'stt_state',
  session: '2',
  state: 'stopped',
  code,
  audio_ms,
  mono_ms,
});
const latchRow = (mono_ms) => ({
  event: 'dev_stop',
  run_id: 'fictional-cedar',
  step: 'latched',
  mono_ms,
});

const offAsk = (step, mono_ms) => ({
  event: 'dev_off',
  run_id: 'fictional-cedar',
  step,
  mono_ms,
});

test("the take's own turn-off request is placed: asked before the stream closed, done before the lab Stop, later signals counted", () => {
  const r = cloudReport([
    ...cloudRows({ stop: offRow('lab_ended', 50000, 9000) }).flatMap((row) =>
      row === undefined || row.code !== 'lab_ended'
        ? [row]
        : [offAsk('latched', 8990), row, offAsk('done', 9001)],
    ),
    offAsk('repeated', 9050),
    latchRow(9100),
  ]);
  const c = r.cloudTranscription;
  assert.deepEqual(c.turnOffRequest, {
    outcome: 'done',
    beforeStop: true,
    repeats: 1,
  });
  assert.equal(c.streams[0].turnOff.afterAsk, true);
  assert.ok(!r.missingEvidence.includes('run.turn-off'));
  const md = renderEvidenceMarkdown(r);
  assert.match(
    md,
    /Turn-off asked by the take: native outcome \*\*done\*\*; decided before the lab Stop: yes; later signals recorded as no-ops: 1\./,
  );
  assert.match(md, /after the take asked for it: yes\./);
  // Refused after the Stop latch: failed, and placed after it.
  const late = cloudReport([
    ...cloudRows({ stop: offRow('lab_ended', 50000, 9000) }),
    latchRow(9100),
    offAsk('latched', 9200),
    offAsk('failed', 9201),
  ]).cloudTranscription;
  assert.deepEqual(late.turnOffRequest, {
    outcome: 'failed',
    beforeStop: false,
    repeats: 0,
  });
  // The stream closed before the take asked: not its turn-off.
  assert.equal(late.streams[0].turnOff.afterAsk, false);
  // Asked, but no outcome row: neither the outcome nor its order with the
  // Stop is claimed, with or without a latch.
  for (const rows of [[], [latchRow(9100)]]) {
    const unseen = cloudReport([
      ...cloudRows({ stop: offRow('lab_ended', 50000, 9000) }),
      offAsk('latched', 8990),
      ...rows,
    ]);
    assert.deepEqual(unseen.cloudTranscription.turnOffRequest, {
      outcome: null,
      beforeStop: null,
      repeats: 0,
    });
    assert.match(
      renderEvidenceMarkdown(unseen),
      /native outcome \*\*not seen\*\*; decided before the lab Stop: unknown;/,
    );
  }
  assert.throws(() => cloudReport([offAsk('started', 1)]));
});

test('processing turned off mid-run is reported with its code, before the lab Stop, closed without the drain and followed by nothing', () => {
  for (const code of ['lab_ended', 'withdrawn']) {
    const r = cloudReport([
      ...cloudRows({ stop: offRow(code) }),
      latchRow(9100),
    ]);
    const [s] = r.cloudTranscription.streams;
    assert.equal(s.turnedOff, true);
    assert.deepEqual(s.turnOff, {
      code,
      audioMsAtOff: 50000,
      beforeStop: true,
      closedWithoutDrain: true,
      nothingAfter: true,
      afterAsk: null,
    });
    assert.equal(r.cloudTranscription.turnOffRequest, null);
    assert.equal(s.failure, null);
    assert.ok(r.missingEvidence.every((x) => x !== 'run.stop-latched'));
    const md = renderEvidenceMarkdown(r);
    assert.match(
      md,
      new RegExp(
        `processing turned off \\(\`${code}\`\\) at 50000 ms of audio sent; before the lab Stop: yes; stream closed without the Stop drain: yes; nothing sent or transcribed afterwards: yes`,
      ),
    );
  }
});

test('a stream closing after the lab Stop latch is not read as turned off before it', () => {
  const rows = cloudRows({ stop: offRow() });
  rows.splice(rows.length - 1, 0, latchRow(8900));
  const [s] = cloudReport(rows).cloudTranscription.streams;
  assert.equal(s.turnOff.beforeStop, false);
});

test('anything after the off row, a drain, or a lost row is said, never inferred away', () => {
  // A later final or line in the session: something followed.
  const late = [
    ...cloudRows({ stop: offRow() }),
    {
      event: 'stt_final',
      session: '2',
      seq: 2,
      start_ms: 9000,
      end_ms: 9500,
      mono_ms: 9600,
    },
  ];
  assert.equal(
    cloudReport(late).cloudTranscription.streams[0].turnOff.nothingAfter,
    false,
  );
  // A Stop drain (`finished`) after it: not closed without the drain.
  const drained = [
    ...cloudRows({ stop: offRow() }),
    {
      event: 'stt_state',
      session: '2',
      state: 'finished',
      audio_ms: 51000,
      mono_ms: 9500,
    },
  ];
  const [d] = cloudReport(drained).cloudTranscription.streams;
  assert.deepEqual(
    [d.turnOff.closedWithoutDrain, d.turnOff.nothingAfter],
    [false, false],
  );
  // A second source's stream closing the same way is not "something after".
  const twoStarts = cloudRows({ stop: offRow() });
  twoStarts.splice(3, 0, {
    event: 'stt_state',
    session: '2',
    state: 'started',
    audio_ms: 0,
    mono_ms: 1550,
  });
  const one = cloudReport(twoStarts).cloudTranscription.streams[0].turnOff;
  // Only one of the two streams has a stop row: unknown, not yes.
  assert.equal(one.closedWithoutDrain, null);
  assert.equal(one.nothingAfter, true);
  const both = cloudReport([...twoStarts, offRow('lab_ended', 300, 9001)])
    .cloudTranscription.streams[0].turnOff;
  assert.deepEqual([both.closedWithoutDrain, both.nothingAfter], [true, true]);
  // A dropped row anywhere: claims that nothing followed become unknown.
  const lossy = [
    ...cloudRows({ stop: offRow() }),
    { event: 'dropped', count: 1, mono_ms: 9700 },
  ];
  const r = cloudReport(lossy);
  const [l] = r.cloudTranscription.streams;
  assert.deepEqual(
    [
      l.turnOff.closedWithoutDrain,
      l.turnOff.nothingAfter,
      l.turnOff.beforeStop,
    ],
    [null, null, null],
  );
  assert.equal(r.cloudTranscription.rowsMayBeMissing, true);
  assert.match(
    renderEvidenceMarkdown(r),
    /claims that nothing followed are unknown/,
  );
  // No stop row at all: whether it was turned off is unknown.
  const open = cloudRows();
  open.pop();
  assert.equal(cloudReport(open).cloudTranscription.streams[0].turnedOff, null);
});

const probeSettings = {
  backend: 'deepgram',
  minuteCap: 5,
  failureProbe: 'refused-token',
  query: DEEPGRAM_APP_QUERY,
};
const probeRows = (extra = []) => {
  const rows = cloudRows({ stop: offRow('auth', 0, 1700) });
  // The refused text never connects; no line can follow.
  return [
    ...rows.filter(
      (r) =>
        !['connected'].includes(r.state) &&
        r.event !== 'stt_final' &&
        r.event !== 'segment',
    ),
    ...extra,
  ];
};

test('a provider-failure take names its probe, the code seen, and that nothing fell back', () => {
  const r = cloudReport(probeRows(), probeSettings);
  const c = r.cloudTranscription;
  assert.deepEqual(c.failureProbe, {
    probe: 'refused-token',
    expectedCode: 'auth',
    result: 'refused-as-expected',
  });
  assert.deepEqual(c.streams[0].failure, { code: 'auth', nothingAfter: true });
  assert.equal(c.streams[0].turnedOff, false);
  const md = renderEvidenceMarkdown(r);
  assert.match(md, /\*\*provider-failure take\*\* \(refused-token probe/);
  assert.match(md, /result \*\*refused as expected/);
  assert.match(
    md,
    /Stopped by failure `auth`; nothing transcribed afterwards, so nothing fell back to another service: yes/,
  );
  assert.doesNotMatch(md, /grant TTL/);
});

test('a failure take that connected, saw another code, transcribed afterwards or lost rows is never a pass', () => {
  const connected = cloudReport(
    cloudRows({ stop: offRow('auth', 0, 9000) }),
    probeSettings,
  ).cloudTranscription.failureProbe.result;
  assert.equal(connected, 'connected');
  const other = probeRows();
  other[other.length - 1] = offRow('settings', 0, 1700);
  assert.equal(
    cloudReport(other, probeSettings).cloudTranscription.failureProbe.result,
    'other-code',
  );
  const after = probeRows([
    {
      event: 'segment',
      session: '2',
      id: 'c2-1-1',
      at_ms: 2000,
      speaker: 'Speaker',
      text: 'A fictional line from somewhere else.',
      accepted: true,
      mono_ms: 5701,
    },
  ]);
  assert.equal(
    cloudReport(after, probeSettings).cloudTranscription.failureProbe.result,
    'transcribed-after',
  );
  const lossy = probeRows([{ event: 'dropped', count: 1, mono_ms: 1800 }]);
  assert.equal(
    cloudReport(lossy, probeSettings).cloudTranscription.failureProbe.result,
    'unknown',
  );
  const noStop = probeRows();
  noStop.pop();
  assert.equal(
    cloudReport(noStop, probeSettings).cloudTranscription.failureProbe.result,
    'unknown',
  );
  // The probe and a grant TTL never appear together, and only the one probe.
  for (const settings of [
    { ...probeSettings, grantTtlS: 900 },
    { ...probeSettings, failureProbe: 'unusable' },
  ])
    assert.throws(() => cloudReport(probeRows(), settings));
});

// A stalled stream replaced once (#357): the reconnecting row, then the
// new stream's connected row with the same query.
const reconnected = (query = DEEPGRAM_APP_QUERY) => {
  const rows = cloudRows();
  rows.splice(
    rows.length - 1,
    0,
    ...[
      {
        event: 'stt_state',
        session: '2',
        state: 'reconnecting',
        code: 'stalled',
        gap_ms: 2400,
        audio_ms: 40000,
        mono_ms: 7000,
      },
      {
        event: 'stt_state',
        session: '2',
        state: 'connected',
        audio_ms: 40000,
        query,
        mono_ms: 7400,
      },
    ],
  );
  return rows;
};

test('a replaced stream is reported with its code and lost speech, still connected and still running', () => {
  const [s] = cloudReport(reconnected()).cloudTranscription.streams;
  assert.deepEqual(
    [s.connected, s.reconnects, s.queryMatchesExpected, s.stopState],
    [true, [{ code: 'stalled', gapMs: 2400 }], true, 'ended'],
  );
  // A replacement that connected with a different query is not trusted.
  const [d] = cloudReport(
    reconnected(
      DEEPGRAM_APP_QUERY.replace('endpointing=600', 'endpointing=10'),
    ),
  ).cloudTranscription.streams;
  assert.equal(d.query, null);
});

test('reconnect rows without their code and lost speech, or lost speech on another row, are refused', () => {
  for (const change of [
    (r) => delete r.gap_ms,
    (r) => delete r.code,
    (r) => (r.gap_ms = -1),
  ]) {
    const rows = reconnected();
    change(rows.find((r) => r.state === 'reconnecting'));
    assert.throws(() => cloudReport(rows));
  }
  const rows = cloudRows();
  rows.at(-1).gap_ms = 10;
  assert.throws(() => cloudReport(rows));
});

test("the app's liveness stop is reported as a stalled stream", () => {
  const [s] = cloudReport(
    cloudRows({
      stop: {
        event: 'stt_state',
        session: '2',
        state: 'stopped',
        code: 'stalled',
        audio_ms: 41000,
        mono_ms: 9000,
      },
    }),
  ).cloudTranscription.streams;
  assert.deepEqual([s.stopState, s.stopCode], ['stopped', 'stalled']);
});

test("the app's name setting row is imported as a boolean, never a name", () => {
  const rows = cloudRows();
  rows.splice(1, 0, {
    event: 'user_name_set',
    session: '2',
    set: true,
    name: 'Fictional Freya',
    mono_ms: 1001,
  });
  const events = importNativeRows(rows, {
    runId: manifest().runId,
    artifactId: 'native',
    clockId: 'audio',
  });
  const named = events.filter((e) => e.stage === 'settings.user-name');
  assert.deepEqual(
    named.map((e) => e.payload),
    [{ userNameSet: true }],
  );
  assert.equal(JSON.stringify(events).includes('Fictional Freya'), false);
  assert.equal(
    JSON.stringify(cloudReport(rows)).includes('Fictional Freya'),
    false,
  );
  const bad = cloudRows();
  bad.splice(1, 0, { event: 'user_name_set', session: '2', set: 'yes' });
  assert.throws(() => cloudReport(bad));
});

test('malformed transcription rows and settings are refused, never guessed', () => {
  for (const row of [
    { event: 'stt_state', session: '2', state: 'paused', audio_ms: 0 },
    { event: 'stt_state', session: '2', state: 'stopped', audio_ms: 0 },
    {
      event: 'stt_state',
      session: '2',
      state: 'stopped',
      code: 'provider said no',
      audio_ms: 0,
    },
    { event: 'stt_final', session: '2', seq: 1, start_ms: 5, end_ms: 4 },
    {
      event: 'evaluator',
      session: '9',
      approval: 'implicit',
      state: 'on',
      backend: 'lab-api',
    },
  ])
    assert.throws(() => cloudReport([row]));
  for (const settings of [
    { ...transcriptionSettings, query: 'model=nova-3' },
    { ...transcriptionSettings, minuteCap: 61 },
    { ...transcriptionSettings, token: 'x' },
  ])
    assert.throws(() => cloudReport(cloudRows(), settings), {
      message: /transcription settings/,
    });
});

test('source problems and identity-check transitions are reported, with ScreenCaptureKit and TalkQTE causes told apart', () => {
  const report = (rows) => {
    const m = manifest();
    const events = importNativeRows(rows, {
      runId: m.runId,
      artifactId: 'native',
      clockId: 'audio',
    });
    m.artifacts.push({
      id: 'native',
      kind: 'native-timing',
      path: 'native.jsonl',
      clockId: 'audio',
      bytes: 0,
      sha256: 'a'.repeat(64),
    });
    return buildEvidenceReport(m, events);
  };
  // A transient blip during an app switch that recovered: the source held.
  const held = report([
    {
      event: 'lab_source_check',
      state: 'failing',
      check: 'running_application',
      after_ms: 0,
      mono_ms: 10,
    },
    {
      event: 'lab_source_check',
      state: 'recovered',
      check: 'running_application',
      after_ms: 340,
      mono_ms: 11,
    },
  ]).sourceHealth;
  assert.equal(held.held, true);
  // A check that went failing and never recovered did not hold.
  const unrecovered = report([
    {
      event: 'lab_source_check',
      state: 'failing',
      check: 'running_application',
      after_ms: 0,
      mono_ms: 10,
    },
  ]).sourceHealth;
  assert.equal(unrecovered.held, false);
  assert.deepEqual(unrecovered.unrecovered, ['running_application']);
  assert.deepEqual(
    held.checks.map((c) => [c.state, c.check, c.afterMs]),
    [
      ['failing', 'running_application', 0],
      ['recovered', 'running_application', 340],
    ],
  );
  // RunB07's ending, as the new build labels it, and ScreenCaptureKit's own.
  const lost = report([
    {
      event: 'lab_source_check',
      state: 'ended',
      check: 'running_application',
      after_ms: 2000,
      mono_ms: 10,
    },
    {
      event: 'source_problem',
      problem: 'lab_source_lost',
      mono_ms: 11,
      detail: 'never reported',
    },
    {
      event: 'source_problem',
      problem: 'source_gone',
      os_code: -3815,
      mono_ms: 12,
    },
  ]);
  assert.equal(lost.sourceHealth.held, false);
  assert.deepEqual(
    lost.sourceHealth.problems.map((p) => [p.problem, p.osCode]),
    [
      ['lab_source_lost', null],
      ['source_gone', -3815],
    ],
  );
  assert.equal(JSON.stringify(lost).includes('never reported'), false);
  assert.match(
    renderEvidenceMarkdown(lost),
    /lab_source_lost, source_gone \(-3815\)/,
  );
  for (const row of [
    { event: 'lab_source_check', state: 'paused', check: 'pid', after_ms: 0 },
    {
      event: 'lab_source_check',
      state: 'failing',
      check: 'Process Gone',
      after_ms: 0,
    },
    { event: 'source_problem', problem: 'Source gone' },
  ])
    assert.throws(() => report([row]));
});
