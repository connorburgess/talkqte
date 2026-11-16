// Offline: ffprobe output is recorded, not run. No media is read.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  measureRecordingVisibility,
  summarizeRecordingLuma,
} from './cue-lab-recording-check.mjs';

// The per-second luma of RunB07 launch 2's recording (16 = black): the
// windows vanished whenever the operator's frontmost app was on another
// Space.
const B07 = [
  37, 16, 16, 16, 16, 16, 16, 16, 16, 16, 37, 37, 37, 37, 37, 37, 37, 37, 37,
  37, 37, 37, 37, 37, 37, 37, 37, 37, 37, 37, 37, 37, 37, 37, 37, 37, 37, 37,
  37, 37, 37, 37, 37, 37, 37, 37, 37, 37, 37, 37, 37, 37, 37, 37, 37, 16, 16,
  16, 16, 16, 16, 16, 16, 16, 37, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16,
  16,
];
const ffprobeJson = (lumas) =>
  JSON.stringify({
    frames: lumas.map((luma, i) => ({
      pts_time: `${i}.000000`,
      tags: { 'lavfi.signalstats.YAVG': String(luma) },
    })),
  });

test('a recording that is black for long stretches fails, with the stretches named', () => {
  const calls = [];
  const r = measureRecordingVisibility({
    probe: '/fictional/ffprobe',
    path: '/fictional/run/recording.mov',
    exec: (command, args, options) => {
      calls.push({ command, args, options });
      return ffprobeJson(B07);
    },
  });
  assert.equal(r.ok, false);
  assert.equal(r.samples, 77);
  assert.equal(r.visibleSeconds, 47);
  assert.equal(r.visibleFraction, 0.61);
  assert.equal(r.longestBlackS, 12);
  assert.deepEqual(r.blackStretches, [
    { fromS: 1, toS: 10 },
    { fromS: 55, toS: 64 },
    { fromS: 65, toS: 77 },
  ]);
  // One bounded probe call: lavfi signalstats at one sample per second.
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, '/fictional/ffprobe');
  assert.ok(
    calls[0].args.includes(
      'movie=/fictional/run/recording.mov,fps=1,signalstats',
    ),
  );
  assert.equal(calls[0].options.timeout, 60000);
});

test('a recording that shows the windows throughout passes', () => {
  const r = summarizeRecordingLuma(
    Array.from({ length: 96 }, (_, i) => ({ atS: i, luma: i === 0 ? 16 : 37 })),
  );
  assert.equal(r.ok, true);
  assert.equal(r.visibleFraction, 0.99);
  assert.deepEqual(r.blackStretches, [{ fromS: 0, toS: 1 }]);
});

test('unusable paths or probe output are refused, never guessed', () => {
  for (const path of ['relative.mov', '/a/b c.mov', "/a/b',x.mov", '/a/b;c'])
    assert.throws(() =>
      measureRecordingVisibility({
        probe: '/fictional/ffprobe',
        path,
        exec: () => ffprobeJson(B07),
      }),
    );
  for (const output of [
    'not json',
    '{"frames":[]}',
    '{"frames":[{"pts_time":"x"}]}',
  ])
    assert.throws(() =>
      measureRecordingVisibility({
        probe: '/fictional/ffprobe',
        path: '/fictional/r.mov',
        exec: () => output,
      }),
    );
});
