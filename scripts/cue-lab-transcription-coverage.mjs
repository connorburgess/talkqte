// Whether cloud transcription covered the whole played media. In RunB09
// the stream to Deepgram stalled 71 s into a 103 s meeting: the send queue
// overflowed (`dropping`), the last final ended there, and the rest of the
// meeting was never transcribed, yet the take completed. A run whose
// transcript stops early cannot show whether cues would have come, so it
// is not a pass.
//
// Works on the native timing rows of one session, the take's clock
// calibration (session-elapsed ms against the lab's monotonic ms) and the
// player's audio-completion receipt on the lab's monotonic clock. Only
// times, counts and fixed codes are read; no transcript text.
import { gateFailure } from './cue-lab-operation-gate.mjs';

// How far before the media end the last final may end, and how much less
// audio than the media's span the stream may have sent. The player's
// completion is a receipt, so it lands slightly after the true end.
export const COVERAGE_TOLERANCE_MS = 5000;

const TERMINAL = new Set(['finished', 'ended', 'stopped']);

const required = (ok) => {
  if (!ok) throw gateFailure('protocol');
};
const finite = (n) => Number.isFinite(n);

/**
 * Summarises one session's transcription coverage of the media. `ok` only
 * if a stream started, never dropped audio, did not end before the media
 * did, sent audio for (nearly) the whole span from its start to the media
 * end, and produced finals until within `toleranceMs` of the media end.
 * `reasons` names each criterion that fails.
 */
export function summarizeTranscriptionCoverage({
  rows,
  session,
  clockCalibration,
  mediaEndMonotonicMs,
  toleranceMs = COVERAGE_TOLERANCE_MS,
} = {}) {
  required(
    Array.isArray(rows) &&
      rows.length <= 100000 &&
      (typeof session === 'string' || Number.isSafeInteger(session)) &&
      finite(clockCalibration?.nativeMs) &&
      finite(clockCalibration?.monotonicMs) &&
      finite(mediaEndMonotonicMs) &&
      Number.isSafeInteger(toleranceMs) &&
      toleranceMs >= 0,
  );
  const own = rows.filter(
    (r) =>
      r &&
      ['session', 'stt_state', 'stt_final'].includes(r.event) &&
      String(r.session) === String(session),
  );
  const starts = own.filter(
    (r) => r.event === 'session' && r.state === 'started',
  );
  // Session-elapsed ms of a row, from its native monotonic time.
  required(starts.length === 1 && finite(starts[0].mono_ms));
  const sessionMono = starts[0].mono_ms;
  const elapsed = (r) => {
    required(finite(r.mono_ms));
    return r.mono_ms - sessionMono;
  };
  const mediaEndMs = Math.round(
    mediaEndMonotonicMs -
      (clockCalibration.monotonicMs - clockCalibration.nativeMs),
  );
  const states = own.filter((r) => r.event === 'stt_state');
  for (const r of states) required(Number.isSafeInteger(r.audio_ms));
  const started = states.filter((r) => r.state === 'started');
  const terminal = states.filter((r) => TERMINAL.has(r.state));
  const finals = own.filter((r) => r.event === 'stt_final');
  for (const f of finals) required(Number.isSafeInteger(f.end_ms));
  const streamStartMs = started.length ? elapsed(started[0]) : null;
  const firstEnd = terminal.length ? terminal[0] : null;
  const streamEndMs = firstEnd ? elapsed(firstEnd) : null;
  const lastFinalEndMs = finals.length
    ? Math.max(...finals.map((f) => f.end_ms))
    : null;
  const audioMs = Math.max(0, ...states.map((r) => r.audio_ms));
  const expectedAudioMs =
    streamStartMs === null ? null : Math.max(0, mediaEndMs - streamStartMs);
  const dropping = states.some((r) => r.state === 'dropping');
  const reasons = [
    ...(started.length === 0 ? ['no-stream'] : []),
    ...(dropping ? ['dropping'] : []),
    ...(streamEndMs !== null && streamEndMs < mediaEndMs - toleranceMs
      ? ['stopped-early']
      : []),
    ...(lastFinalEndMs === null || lastFinalEndMs < mediaEndMs - toleranceMs
      ? ['finals-end-early']
      : []),
    ...(expectedAudioMs !== null && audioMs < expectedAudioMs - toleranceMs
      ? ['audio-short']
      : []),
  ];
  return Object.freeze({
    mediaEndMs,
    streamStartMs,
    streamEndMs,
    stopState: firstEnd?.state ?? null,
    stopCode: firstEnd?.code ?? null,
    dropping,
    finals: finals.length,
    lastFinalEndMs,
    finalGapMs: lastFinalEndMs === null ? null : mediaEndMs - lastFinalEndMs,
    audioMs,
    expectedAudioMs,
    toleranceMs,
    reasons: Object.freeze(reasons),
    ok: reasons.length === 0,
  });
}
