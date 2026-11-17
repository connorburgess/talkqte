// Offline: ffprobe output is recorded, not run. No media is read.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  measureRecordingVisibility,
  summarizeRecordingLuma,
} from './cue-lab-recording-check.mjs';

// RunB07 launch 2, per second: [average luma, change from the previous
// second]. Black (16) whenever the operator's frontmost app was on another
// Space; the visible player's tiles change a little in most seconds.
const B07 = [
  [37, 0.0],
  [16, 20.79],
  [16, 0.0],
  [16, 0.0],
  [16, 0.0],
  [16, 0.0],
  [16, 0.0],
  [16, 0.0],
  [16, 0.0],
  [16, 0.0],
  [37, 20.95],
  [37, 0.46],
  [37, 0.02],
  [37, 0.0],
  [37, 0.01],
  [37, 0.57],
  [37, 0.02],
  [37, 0.01],
  [37, 0.0],
  [37, 0.29],
  [37, 0.17],
  [37, 0.01],
  [37, 0.0],
  [37, 0.01],
  [37, 0.16],
  [37, 0.3],
  [37, 0.02],
  [37, 0.0],
  [37, 0.01],
  [37, 0.28],
  [37, 0.18],
  [37, 0.02],
  [37, 0.01],
  [37, 0.0],
  [37, 0.16],
  [37, 0.02],
  [37, 0.28],
  [37, 0.02],
  [37, 0.01],
  [37, 0.28],
  [37, 0.29],
  [37, 0.01],
  [37, 0.0],
  [37, 0.01],
  [37, 0.28],
  [37, 0.17],
  [37, 0.0],
  [37, 0.44],
  [37, 0.01],
  [37, 0.01],
  [37, 0.29],
  [37, 0.29],
  [37, 0.0],
  [37, 0.0],
  [37, 0.01],
  [16, 21.07],
  [16, 0.0],
  [16, 0.0],
  [16, 0.0],
  [16, 0.0],
  [16, 0.0],
  [16, 0.0],
  [16, 0.0],
  [16, 0.0],
  [37, 20.79],
  [16, 20.79],
  [16, 0.0],
  [16, 0.0],
  [16, 0.0],
  [16, 0.0],
  [16, 0.0],
  [16, 0.0],
  [16, 0.0],
  [16, 0.0],
  [16, 0.0],
  [16, 0.0],
  [16, 0.0],
];
// Measured with the same ffprobe call on synthetic 8 s clips: one test
// pattern frame repeated, a flat grey frame, and a moving test pattern.
const FROZEN = Array.from({ length: 8 }, () => [125.26, 0]);
const UNIFORM = Array.from({ length: 8 }, () => [126, 0]);
const MOVING = [
  [125.42, 0],
  [125.31, 5.302],
  [125.13, 4.931],
  [122.88, 9.632],
  [125.18, 10.869],
  [125.25, 6.711],
  [125.12, 6.517],
  [122.86, 10.518],
];
const ffprobeJson = (rows) =>
  JSON.stringify({
    frames: rows.map(([luma, change], i) => ({
      pts_time: `${i}.000000`,
      tags: {
        'lavfi.signalstats.YAVG': String(luma),
        'lavfi.signalstats.YDIF': String(change),
      },
    })),
  });
const measure = (rows, frames, durationMs) =>
  measureRecordingVisibility({
    probe: '/fictional/ffprobe',
    path: '/fictional/run/recording.mov',
    frames,
    durationMs,
    windowsMissing: false,
    exec: () => ffprobeJson(rows),
  });

test('RunB07 launch 2 fails as mostly black, with the stretches named', () => {
  const calls = [];
  const r = measureRecordingVisibility({
    probe: '/fictional/ffprobe',
    path: '/fictional/run/recording.mov',
    frames: 1991,
    durationMs: 76863,
    windowsMissing: false,
    exec: (command, args, options) => {
      calls.push({ command, args, options });
      return ffprobeJson(B07);
    },
  });
  assert.equal(r.ok, false);
  assert.deepEqual(r.reasons, ['mostly-black']);
  assert.equal(r.visibleFraction, 0.61);
  assert.equal(r.longestBlackS, 12);
  assert.deepEqual(r.blackStretches, [
    { fromS: 1, toS: 10 },
    { fromS: 55, toS: 64 },
    { fromS: 65, toS: 77 },
  ]);
  // Its visible picture did change, at a real frame rate.
  assert.equal(r.changingFraction, 0.795);
  assert.equal(r.framesPerSecond, 25.903);
  assert.equal(calls.length, 1);
  assert.ok(
    calls[0].args.includes(
      'movie=/fictional/run/recording.mov,fps=1,signalstats',
    ),
  );
  assert.equal(calls[0].options.timeout, 60000);
});

test('a frozen frame and a uniform frame fail as not changing, though never black', () => {
  for (const rows of [FROZEN, UNIFORM]) {
    const r = measure(rows, 200, 8000);
    assert.equal(r.visibleFraction, 1);
    assert.deepEqual(r.reasons, ['not-changing']);
    assert.equal(r.ok, false);
  }
});

test('a moving, visible recording passes; too few written frames fails it', () => {
  assert.equal(measure(MOVING, 200, 8000).ok, true);
  const sparse = measure(MOVING, 12, 8000);
  assert.deepEqual(sparse.reasons, ['too-few-frames']);
  assert.equal(sparse.framesPerSecond, 1.5);
});

test('unusable paths, counts or probe output are refused, never guessed', () => {
  for (const path of ['relative.mov', '/a/b c.mov', "/a/b',x.mov", '/a/b;c'])
    assert.throws(() =>
      measureRecordingVisibility({
        probe: '/fictional/ffprobe',
        path,
        frames: 1,
        durationMs: 1000,
        windowsMissing: false,
        exec: () => ffprobeJson(MOVING),
      }),
    );
  assert.throws(() => measure(MOVING, undefined, 8000));
  for (const output of [
    'not json',
    '{"frames":[]}',
    '{"frames":[{"pts_time":"x"}]}',
  ])
    assert.throws(() =>
      measureRecordingVisibility({
        probe: '/fictional/ffprobe',
        path: '/fictional/r.mov',
        frames: 1,
        durationMs: 1000,
        windowsMissing: false,
        exec: () => output,
      }),
    );
  assert.throws(() => summarizeRecordingLuma([{ atS: 0, luma: 37 }]));
});

test('a window closed or gone by the end fails the check, whatever the picture shows', () => {
  const r = measureRecordingVisibility({
    probe: '/fictional/ffprobe',
    path: '/fictional/run/recording.mov',
    frames: 200,
    durationMs: 8000,
    windowsMissing: true,
    exec: () => ffprobeJson(MOVING),
  });
  assert.deepEqual(r.reasons, ['window-missing']);
  assert.equal(r.ok, false);
  // An unknown state (an older helper) is refused rather than assumed.
  assert.throws(() =>
    measureRecordingVisibility({
      probe: '/fictional/ffprobe',
      path: '/fictional/run/recording.mov',
      frames: 200,
      durationMs: 8000,
      exec: () => ffprobeJson(MOVING),
    }),
  );
});
