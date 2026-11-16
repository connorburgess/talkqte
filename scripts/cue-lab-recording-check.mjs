// How much of a finished lab recording actually shows the captured windows.
// RunB07 launch 2 recorded black whenever the operator's frontmost app sat
// on another Space: the capture composites only on-screen windows. A
// recording the owner cannot watch is a failed take, not a quiet success.
//
// Reads one luma sample per second with the pinned ffprobe (lavfi
// signalstats). No pixels, frames or text leave this function.
import { execFileSync } from 'node:child_process';
import { gateFailure } from './cue-lab-operation-gate.mjs';

// Limited-range black is luma 16; a frame at or below this shows nothing.
export const BLACK_LUMA = 17;
// A run passes only if at least this share of its seconds show the windows.
export const MIN_VISIBLE_FRACTION = 0.95;

const required = (ok) => {
  if (!ok) throw gateFailure('protocol');
};

/** Summarises per-second luma samples: visible share and black stretches. */
export function summarizeRecordingLuma(samples) {
  required(
    Array.isArray(samples) &&
      samples.length > 0 &&
      samples.length <= 7200 &&
      samples.every(
        (s) => Number.isFinite(s?.atS) && s.atS >= 0 && Number.isFinite(s.luma),
      ),
  );
  const black = samples.map((s) => s.luma <= BLACK_LUMA);
  const stretches = [];
  for (let i = 0; i < samples.length; i++) {
    if (!black[i]) continue;
    const start = samples[i].atS;
    while (i + 1 < samples.length && black[i + 1]) i++;
    stretches.push({ fromS: start, toS: samples[i].atS + 1 });
  }
  const visible = black.filter((b) => !b).length;
  const visibleFraction = visible / samples.length;
  return Object.freeze({
    samples: samples.length,
    visibleSeconds: visible,
    visibleFraction: Math.round(visibleFraction * 1000) / 1000,
    longestBlackS: Math.max(0, ...stretches.map((s) => s.toS - s.fromS)),
    blackStretches: Object.freeze(stretches.map((s) => Object.freeze(s))),
    ok: visibleFraction >= MIN_VISIBLE_FRACTION,
  });
}

/**
 * Measures a recording with the pinned ffprobe. `path` must be a plain
 * absolute path (the lavfi movie source cannot take arbitrary characters).
 */
export function measureRecordingVisibility({
  probe,
  path,
  exec = execFileSync,
  environment,
} = {}) {
  required(
    typeof probe === 'string' &&
      probe.startsWith('/') &&
      typeof path === 'string' &&
      /^\/[A-Za-z0-9/._-]+$/.test(path),
  );
  const output = exec(
    probe,
    [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      `movie=${path},fps=1,signalstats`,
      '-show_entries',
      'frame=pts_time:frame_tags=lavfi.signalstats.YAVG',
      '-of',
      'json',
    ],
    {
      env: environment,
      encoding: 'utf8',
      timeout: 60000,
      killSignal: 'SIGKILL',
      maxBuffer: 1024 * 1024,
    },
  );
  let frames;
  try {
    frames = JSON.parse(output).frames;
  } catch {
    throw gateFailure('protocol');
  }
  required(Array.isArray(frames));
  return summarizeRecordingLuma(
    frames.map((f) => ({
      atS: Number(f?.pts_time),
      luma: Number(f?.tags?.['lavfi.signalstats.YAVG']),
    })),
  );
}
