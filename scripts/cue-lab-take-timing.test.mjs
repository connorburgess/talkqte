import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  companionRect,
  detectCuePaint,
  detectSpeech,
  estimateTakeTiming,
  nodeLoggerBridge,
  recordingNodeBridge,
  renderTakeTimingMarkdown,
  writeTakeTimingEstimates,
  PAINT,
} from './cue-lab-take-timing.mjs';
import { importNativeRows } from './cue-lab-evidence-report.mjs';
import { createLabEvidenceWriter } from './cue-lab-evidence-writer.mjs';

// One synthetic take. Clocks: node = logger + 1000 (exactly), recording =
// node − 3000 + 505 (the recorded sound starts in window 50).
const RUN = 'fictional-timing';
const node = (stage, atMs, extra = {}) => ({
  schema: 'talkqte.lab.evidence.event.v1',
  eventId: `events:${stage}`,
  runId: RUN,
  stage,
  outcome: 'observed',
  ids: {},
  timing: { clockId: 'node', atMs, uncertaintyMs: 0, basis: 'receipt' },
  ...extra,
});
const nodeEvents = () => [
  node('run.started', 50),
  node('source.listening', 1100.5, { ids: { sessionId: '1' } }),
  node('recorder.frame-accepted', 2900),
  node('speech.render-start', 3000, {
    timing: { clockId: 'node', atMs: 3000, uncertaintyMs: 0.5, basis: 'event' },
  }),
  node('speech.render-end', 9999),
];
// Recording ms → logger ms for building native rows.
const logger = (rec) => rec + 3000 - 505 - 1000;
const session = (rec) => Math.round(logger(rec) - 50);
const nativeRows = ({ clearAtRec = 8000, extraFinal = false } = {}) => [
  { event: 'dev_stop', mono_ms: 0, run_id: RUN, step: 'armed' },
  {
    event: 'session',
    mono_ms: 50,
    elapsed_ms: 0,
    live: true,
    state: 'started',
    session: 1,
  },
  {
    event: 'dev_source_observation',
    mono_ms: 100,
    run_id: RUN,
    session: '1',
    step: 'listening',
  },
  // Final 1 covers recorded speech 1000–2000; final 2 covers 3000–4000.
  {
    event: 'stt_final',
    mono_ms: Math.round(logger(2100)),
    session: 1,
    seq: 1,
    start_ms: session(1000),
    end_ms: session(1950),
  },
  {
    event: 'segment',
    mono_ms: Math.round(logger(2750)),
    session: 1,
    id: 'c1-1-1',
    at_ms: 1,
    accepted: true,
  },
  {
    event: 'stt_final',
    mono_ms: Math.round(logger(4100)),
    session: 1,
    seq: 2,
    start_ms: session(3000),
    end_ms: session(3900),
  },
  {
    event: 'segment',
    mono_ms: Math.round(logger(4500)),
    session: 1,
    id: 'c1-1-2',
    at_ms: 2,
    accepted: true,
  },
  ...(extraFinal
    ? [
        // A third final inside the second stretch: both become ambiguous.
        {
          event: 'stt_final',
          mono_ms: Math.round(logger(4200)),
          session: 1,
          seq: 3,
          start_ms: session(3600),
          end_ms: session(3700),
        },
        {
          event: 'segment',
          mono_ms: Math.round(logger(4600)),
          session: 1,
          id: 'c1-1-3',
          at_ms: 3,
          accepted: true,
        },
      ]
    : []),
  {
    event: 'evaluation_requested',
    mono_ms: Math.round(logger(4600)),
    session: 1,
    request: 3,
    through_segment: 'c1-1-2',
  },
  {
    event: 'cue_decision',
    mono_ms: Math.round(logger(5000)),
    session: 1,
    request: 3,
    cue: 'cue-a',
    decider: 'model',
    source_id: 'transcript:c1-1-2',
  },
  {
    event: 'cue_published',
    mono_ms: Math.round(logger(5000)),
    session: 1,
    cue: 'cue-a',
  },
  {
    event: 'cue_cleared',
    mono_ms: Math.round(logger(clearAtRec)),
    session: 1,
    cue: 'cue-a',
  },
  { event: 'dev_stop', mono_ms: 9000, run_id: RUN, step: 'latched' },
];
const events = (rows) => [
  ...nodeEvents(),
  ...importNativeRows(rows, {
    runId: RUN,
    artifactId: 'native-timing',
    clockId: 'native-logger',
  }),
];
// Frames every 20 ms: empty, the cue from 5020 ms, a fade at 8020, empty at 8040.
const frames = () => {
  const out = [];
  for (let t = 0; t <= 10000; t += 20)
    out.push([t, t >= 5020 && t < 8020 ? 0.9 : t === 8020 ? 0.3 : 0]);
  return out;
};
// 10 ms windows: digital silence to 500 ms, room tone, speech 1000–2000 and
// 3000–4000 ms.
const levels = () => ({
  windowMs: 10,
  startMs: 0,
  db: Array.from({ length: 1000 }, (_, i) =>
    i < 50 ? -120 : (i >= 100 && i < 200) || (i >= 300 && i < 400) ? -10 : -60,
  ),
});

test('the companion rectangle is placed in the union of both windows at the picture scale', () => {
  assert.deepEqual(
    companionRect({
      emulator: { x: 100, y: 50, width: 400, height: 300 },
      companion: { x: 520, y: 320, width: 160, height: 40 },
      picture: { width: 1160, height: 620, scale: 2 },
    }),
    { x: 840, y: 540, width: 320, height: 80 },
  );
  assert.throws(() =>
    companionRect({
      emulator: { x: 100, y: 50, width: 400, height: 300 },
      companion: { x: 520, y: 320, width: 160, height: 40 },
      picture: { width: 1000, height: 620, scale: 2 },
    }),
  );
  assert.throws(() => companionRect({ emulator: {}, companion: {} }));
});

test('cue paint: first changed frame, fade-out to empty, blips and frame-interval uncertainty', () => {
  const p = detectCuePaint(frames());
  assert.equal(p.episodes.length, 1);
  const [e] = p.episodes;
  // 20 ms frames are closer than one capture interval (50 ms): the
  // capture interval sets the uncertainty.
  assert.equal(e.painted.firstFrameMs, 5020);
  assert.equal(e.painted.previousFrameMs, 5000);
  assert.equal(e.painted.timing.basis, 'frame');
  assert.equal(e.painted.timing.clockId, 'recording');
  assert.equal(e.painted.timing.uncertaintyMs, PAINT.captureLatencyMs / 2);
  assert.equal(e.cleared.firstFrameMs, 8040);
  assert.equal(e.visibleMs.valueMs, 3020);
  // A long gap before the first changed frame widens it.
  const sparse = [
    [0, 0],
    [1000, 0],
    [1400, 0.8],
    [1500, 0],
  ];
  const s = detectCuePaint(sparse).episodes[0].painted;
  assert.equal(s.timing.atMs, 1200);
  assert.equal(s.timing.uncertaintyMs, 200);
  // A change that never reaches a cue is a blip; one still showing at the
  // end has no clear.
  const r = detectCuePaint([
    [0, 0],
    [10, 0.2],
    [20, 0],
    [30, 0.9],
  ]);
  assert.equal(r.blips, 1);
  assert.equal(r.openAtEnd, 1);
  assert.equal(r.episodes[0].cleared, null);
  // The first frame is the empty reference by construction.
  assert.throws(() =>
    detectCuePaint([
      [0, 0.5],
      [10, 0],
    ]),
  );
  assert.throws(() =>
    detectCuePaint([
      [0, 0],
      [0, 0],
    ]),
  );
});

test('recorded speech: onset after digital silence, stretches split by pauses', () => {
  const s = detectSpeech(levels());
  assert.equal(s.onset.atMs, 505);
  assert.ok(s.onset.uncertaintyMs > 5);
  assert.deepEqual(s.spans, [
    { startMs: 1000, endMs: 2000 },
    { startMs: 3000, endMs: 4000 },
  ]);
  // Sound from the first window: the player start is not in the recording.
  const l = levels();
  l.db[0] = -60;
  assert.equal(detectSpeech(l).onset, null);
  assert.match(detectSpeech(l).onsetReason, /starts with sound/);
  // A pause shorter than 150 ms stays inside one stretch.
  const m = levels();
  for (let i = 150; i < 160; i++) m.db[i] = -60;
  assert.equal(detectSpeech(m).spans.length, 2);
  // No contrast, no speech.
  assert.equal(
    detectSpeech({ windowMs: 10, startMs: 0, db: Array(100).fill(-60) }).spans
      .length,
    0,
  );
});

test('clock bridges: causal bracket, calibration preferred, refusals', () => {
  const ev = events(nativeRows());
  const rows = nativeRows();
  const b = nodeLoggerBridge({ events: ev, nativeRows: rows });
  // Upper 1100.5 − 100 + 1, lower 9999 − 9000 − 1.
  assert.equal(b.lowerMs, 998);
  assert.equal(b.upperMs, 1001.5);
  assert.equal(b.offsetMs, 999.75);
  assert.equal(b.uncertaintyMs, 1.75);
  const c = nodeLoggerBridge({
    events: ev,
    nativeRows: rows,
    calibration: {
      nativeMs: 500,
      monotonicMs: 1550.2,
      uncertaintyMs: 0.3,
      sessionId: '1',
    },
  });
  assert.match(c.method, /calibration/);
  assert.equal(c.offsetMs, 1000.2);
  assert.equal(c.uncertaintyMs, 2.3);
  // No media end seen: no lower bound.
  assert.equal(
    nodeLoggerBridge({
      events: ev.filter((e) => e.stage !== 'speech.render-end'),
      nativeRows: rows,
    }).method,
    null,
  );
  // An empty bracket (Stop latched before the media end was seen) is refused.
  const late = ev.map((e) =>
    e.stage === 'speech.render-end'
      ? { ...e, timing: { ...e.timing, atMs: 12000 } }
      : e,
  );
  assert.match(
    nodeLoggerBridge({ events: late, nativeRows: rows }).reason,
    /empty/,
  );
  const wide = ev.map((e) =>
    e.stage === 'speech.render-end'
      ? { ...e, timing: { ...e.timing, atMs: 9500 } }
      : e,
  );
  assert.match(
    nodeLoggerBridge({ events: wide, nativeRows: rows }).reason,
    /wide/,
  );
  const r = recordingNodeBridge({
    events: ev,
    onset: { atMs: 505, uncertaintyMs: 26 },
  });
  assert.equal(r.offsetMs, 2495);
  assert.equal(r.uncertaintyMs, 26.5);
  // An onset earlier than the recording could hold the render start.
  assert.match(
    recordingNodeBridge({ events: ev, onset: { atMs: 10, uncertaintyMs: 1 } })
      .reason,
    /before the render start/,
  );
});

const estimate = (rowsOptions, observations = {}) =>
  estimateTakeTiming({
    runId: RUN,
    recordingDurationMs: 10000,
    events: events(nativeRows(rowsOptions)),
    nativeRows: nativeRows(rowsOptions),
    observations: { frames: frames(), levels: levels(), ...observations },
  });

test('estimates: lines by unique overlap, cues by order, never a budget result', () => {
  const r = estimate();
  assert.equal(r.estimate, true);
  assert.match(r.notEvidenceFor, /budget rows/);
  assert.equal(r.paintJoin.joined, true);
  assert.match(r.paintJoin.method, /not an identity/);
  const [f1, f2] = r.finals;
  assert.equal(f1.segmentId, 'c1-1-1');
  assert.equal(f1.join, 'unique time overlap (estimate)');
  assert.equal(f1.heardEndMs, 2000);
  // Line at 2750 (rounded on the logger clock) less heard end 2000.
  assert.ok(Math.abs(f1.heardEndToLine.valueMs - 750) <= 1);
  assert.ok(f1.heardEndToLine.minMs < f1.heardEndToLine.valueMs);
  // The service's own end is 50 ms before the recorded end; the native
  // figure starts there.
  assert.ok(Math.abs(f1.deepgramEndMinusHeardEndMs + 50) <= 1);
  assert.ok(Math.abs(f1.nativeFinalToLineMs - 800) <= 1);
  assert.equal(f2.heardEndMs, 4000);
  const [cue] = r.cues;
  assert.equal(cue.cueId, 'cue-a');
  assert.equal(cue.episode, 1);
  assert.equal(cue.citedSegment, 'c1-1-2');
  assert.equal(cue.requestThroughSegment, 'c1-1-2');
  // Painted at 4995 ± 25 (first frame 5020), heard end 4000.
  assert.equal(cue.citedHeardEndToPainted.valueMs, 995);
  assert.ok(Math.abs(cue.publishedToPainted.valueMs + 5) <= 2);
  assert.equal(r.summary.heardEndToLine.count, 2);
  assert.equal(r.summary.citedHeardEndToPainted.count, 1);
  // No budget result words: nothing here says within or over.
  const md = renderTakeTimingMarkdown(r);
  assert.match(md, /Estimates, not evidence for the budget rows/);
  assert.match(md, /Final end of speech → transcript line/);
  assert.match(md, /one take confirms no budget/);
  assert.doesNotMatch(md, /\b(within|over)\b/);
});

test('estimates refuse joins they cannot support', () => {
  // A cue the app showed 1 s longer than the recording did: no order join.
  const r = estimate({ clearAtRec: 9000 });
  assert.equal(r.paintJoin.joined, false);
  assert.match(r.paintJoin.reason, /visible durations differ/);
  assert.equal(r.cues[0].episode, null);
  assert.equal(r.cues[0].citedHeardEndToPainted, null);
  // Two finals in one stretch of speech: neither gets a heard end.
  const a = estimate({ extraFinal: true });
  assert.match(a.finals[1].join, /ambiguous/);
  assert.match(a.finals[2].join, /ambiguous/);
  assert.equal(a.finals[0].join, 'unique time overlap (estimate)');
  // More painted episodes than cues: no join.
  const extra = frames().map(([t, s]) => [t, t >= 9000 && t < 9500 ? 0.9 : s]);
  assert.match(
    estimate({}, { frames: extra }).paintJoin.reason,
    /2 painted episodes for 1/,
  );
  // No player start in the recording: no bridge, no line estimates.
  const l = levels();
  l.db.fill(-60, 0, 50);
  const n = estimate({}, { levels: l });
  assert.equal(n.bridges.loggerRecording, null);
  assert.equal(n.finals[0].join, 'no clock bridge');
  assert.equal(n.summary.heardEndToLine.count, 0);
});

const posix = process.platform === 'win32' ? test.skip : test;
posix(
  'writes private estimates beside sealed evidence without touching it',
  async (t) => {
    const parent = fs.realpathSync(
      fs.mkdtempSync(join(tmpdir(), 'tq-take-timing-test-')),
    );
    t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
    fs.chmodSync(parent, 0o700);
    const writer = createLabEvidenceWriter({
      parentDirectory: parent,
      runId: RUN,
      fictional: true,
      contentMode: 'fictional-content',
    });
    writer.addClock({ id: 'node', kind: 'monotonic' });
    writer.addClock({ id: 'native-logger', kind: 'monotonic' });
    for (const e of nodeEvents())
      writer.emit({
        stage: e.stage,
        outcome: e.outcome,
        ids: e.ids,
        timing: e.timing,
      });
    const nativePath = join(parent, 'native.jsonl');
    fs.writeFileSync(
      nativePath,
      nativeRows()
        .map((r) => JSON.stringify(r))
        .join('\n') + '\n',
      { mode: 0o600 },
    );
    writer.attach({
      id: 'native-timing',
      kind: 'native-timing',
      path: nativePath,
      clockId: 'native-logger',
      sealed: true,
    });
    const recordingPath = join(parent, 'fictional.mov');
    fs.writeFileSync(recordingPath, 'not a movie', { mode: 0o600 });
    writer.attach({
      id: 'recording',
      kind: 'recording',
      path: recordingPath,
      durationMs: 10000,
      sealed: true,
    });
    const { manifestPath } = writer.close();
    const outcomePath = join(writer.directory, 'take-outcome.json');
    fs.writeFileSync(
      outcomePath,
      JSON.stringify({
        runId: RUN,
        clockCalibration: null,
        recorder: {
          report: {
            geometry: {
              emulator: { x: 0, y: 0, width: 400, height: 300 },
              companion: { x: 420, y: 260, width: 160, height: 40 },
              picture: { width: 1160, height: 600, scale: 2 },
            },
          },
        },
      }),
      { mode: 0o600 },
    );
    const before = fs.readdirSync(writer.directory).sort();
    let seen;
    const { output, estimates } = await writeTakeTimingEstimates({
      manifestPath,
      outDir: join(writer.directory, 'timing-estimates'),
      observer: {
        observe(path, rect) {
          seen = { path, rect };
          return { frames: frames(), levels: levels() };
        },
      },
    });
    assert.deepEqual(seen.rect, { x: 840, y: 520, width: 320, height: 80 });
    assert.ok(seen.path.endsWith('.mov'));
    assert.equal(estimates.paintJoin.joined, true);
    assert.equal(fs.statSync(output).mode & 0o777, 0o700);
    for (const f of ['estimates.json', 'estimates.md'])
      assert.equal(fs.statSync(join(output, f)).mode & 0o777, 0o600);
    assert.deepEqual(
      fs
        .readdirSync(writer.directory)
        .filter((f) => f !== 'timing-estimates')
        .sort(),
      before,
    );
    // Never overwrites an earlier output.
    await assert.rejects(
      writeTakeTimingEstimates({
        manifestPath,
        outDir: output,
        observer: { observe: () => ({ frames: frames(), levels: levels() }) },
      }),
    );
    // A take outcome for another run is refused.
    fs.chmodSync(outcomePath, 0o600);
    const other = join(parent, 'other-outcome.json');
    fs.writeFileSync(other, JSON.stringify({ runId: 'fictional-other' }), {
      mode: 0o600,
    });
    await assert.rejects(
      writeTakeTimingEstimates({
        manifestPath,
        outcomePath: other,
        outDir: join(parent, 'estimates-other'),
        observer: { observe: () => ({ frames: frames(), levels: levels() }) },
      }),
    );
  },
);
