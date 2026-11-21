import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeTranscriptionCoverage } from './cue-lab-transcription-coverage.mjs';

// A fictional session: native session starts at mono 100, the stream at
// elapsed 10,000, playback of 60 s media ends at elapsed 75,000. The lab's
// monotonic clock runs 5,000 ms ahead of session-elapsed time.
const calibration = { nativeMs: 20000, monotonicMs: 25000 };
const mediaEndMonotonicMs = 80000; // elapsed 75,000
const at = (elapsed) => ({ mono_ms: 100 + elapsed });
const session = (extra = []) => [
  { event: 'session', session: 1, state: 'started', ...at(0) },
  {
    event: 'stt_state',
    session: 1,
    state: 'started',
    audio_ms: 0,
    ...at(10000),
  },
  {
    event: 'stt_state',
    session: 1,
    state: 'connected',
    audio_ms: 900,
    ...at(11000),
  },
  ...extra,
];
const final = (seq, endMs) => ({
  event: 'stt_final',
  session: 1,
  seq,
  start_ms: endMs - 2000,
  end_ms: endMs,
  ...at(endMs + 1500),
});
const ended = (elapsed, audioMs, extra = {}) => ({
  event: 'stt_state',
  session: 1,
  state: 'ended',
  audio_ms: audioMs,
  ...at(elapsed),
  ...extra,
});
const summarize = (rows, options = {}) =>
  summarizeTranscriptionCoverage({
    rows,
    session: '1',
    clockCalibration: calibration,
    mediaEndMonotonicMs,
    ...options,
  });

test('a stream that hears the meeting to its end covers the media', () => {
  const c = summarize(
    session([final(1, 20000), final(2, 72500), ended(76000, 66000)]),
  );
  assert.equal(c.ok, true);
  assert.deepEqual(c.reasons, []);
  assert.equal(c.mediaEndMs, 75000);
  assert.equal(c.finalGapMs, 2500);
  assert.equal(c.expectedAudioMs, 65000);
});

test('a stall like RunB09 fails on dropped audio, early finals and short audio', () => {
  const c = summarize(
    session([
      final(1, 20000),
      final(2, 41000),
      {
        event: 'stt_state',
        session: 1,
        state: 'dropping',
        audio_ms: 40000,
        ...at(51000),
      },
      ended(76000, 44000),
    ]),
  );
  assert.equal(c.ok, false);
  assert.deepEqual(c.reasons, ['dropping', 'finals-end-early', 'audio-short']);
  assert.equal(c.finalGapMs, 34000);
});

test("the app's stalled stop before the media ends is an early stop", () => {
  const c = summarize(
    session([
      final(1, 50000),
      ended(62000, 52000, { state: 'stopped', code: 'stalled' }),
    ]),
  );
  assert.deepEqual(c.reasons, [
    'stopped-early',
    'finals-end-early',
    'audio-short',
  ]);
  assert.deepEqual([c.stopState, c.stopCode], ['stopped', 'stalled']);
});

test('a stream that never started, or gave no finals, does not cover the media', () => {
  assert.deepEqual(
    summarize([{ event: 'session', session: 1, state: 'started', ...at(0) }])
      .reasons,
    ['no-stream', 'finals-end-early'],
  );
  assert.deepEqual(summarize(session([ended(76000, 66000)])).reasons, [
    'finals-end-early',
  ]);
});

test("another session's rows are not counted", () => {
  const c = summarize(
    session([
      { ...final(9, 74000), session: 2 },
      final(1, 30000),
      ended(76000, 66000),
    ]),
  );
  assert.equal(c.lastFinalEndMs, 30000);
  assert.deepEqual(c.reasons, ['finals-end-early']);
});

test('malformed inputs are refused, never guessed', () => {
  for (const options of [
    { rows: null },
    { clockCalibration: { nativeMs: 1 } },
    { mediaEndMonotonicMs: 'end' },
    { toleranceMs: -1 },
    { rows: session().slice(1) },
    { rows: session([{ ...final(1, 5000), end_ms: 'late' }]) },
    {
      rows: session([
        { event: 'stt_state', session: 1, state: 'ended', ...at(76000) },
      ]),
    },
  ])
    assert.throws(() => summarize(options.rows ?? session(), options), {
      category: 'protocol',
    });
});
