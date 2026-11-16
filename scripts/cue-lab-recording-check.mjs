// Whether a finished lab recording is watchable: the captured windows are
// visible, the picture changes over time, and the helper wrote frames at a
// real rate. RunB07 launch 2 recorded black whenever the operator's
// frontmost app sat on another Space. A recording the owner cannot watch
// is a failed take, not a quiet success.
//
// Reads one sample per second with the pinned ffprobe (lavfi signalstats):
// the average luma (YAVG) and the change from the previous sample (YDIF).
// No pixels, frames or text leave this function.
import { execFileSync } from 'node:child_process';
import { gateFailure } from './cue-lab-operation-gate.mjs';

// Limited-range black is luma 16; a frame at or below this shows nothing.
export const BLACK_LUMA = 17;
// At least this share of seconds must show the windows.
export const MIN_VISIBLE_FRACTION = 0.95;
// A visible second counts as changing above this mean frame difference.
// RunB07's player (static tiles with speaker highlights) changed in about
// 80% of its visible seconds; a frozen or uniform frame changes in none.
export const CHANGE_YDIF = 0.005;
export const MIN_CHANGING_FRACTION = 0.5;
// The helper's written frames per second of recording, at least.
export const MIN_FRAMES_PER_SECOND = 5;

const required = (ok) => {
  if (!ok) throw gateFailure('protocol');
};
const round = (n) => Math.round(n * 1000) / 1000;

/**
 * Summarises per-second samples ({ atS, luma, change }): visible share,
 * black stretches, the share of compared visible seconds whose picture
 * changed and, when given, the helper's frame rate. `ok` only if every
 * criterion holds; `reasons` names each that does not.
 */
export function summarizeRecordingLuma(
  samples,
  {
    frames,
    durationMs,
    minVisible = MIN_VISIBLE_FRACTION,
    minChanging = MIN_CHANGING_FRACTION,
  } = {},
) {
  required(
    Array.isArray(samples) &&
      samples.length > 0 &&
      samples.length <= 7200 &&
      samples.every(
        (s) =>
          Number.isFinite(s?.atS) &&
          s.atS >= 0 &&
          Number.isFinite(s.luma) &&
          Number.isFinite(s.change) &&
          s.change >= 0,
      ) &&
      (frames === undefined ||
        (Number.isSafeInteger(frames) &&
          frames >= 0 &&
          Number.isFinite(durationMs) &&
          durationMs > 0)),
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
  // Change is measured against the previous sample, so only visible
  // seconds that follow a visible second are compared.
  const compared = samples.filter(
    (_, i) => i > 0 && !black[i] && !black[i - 1],
  );
  const changing = compared.filter((s) => s.change > CHANGE_YDIF).length;
  const changingFraction = compared.length ? changing / compared.length : 0;
  const framesPerSecond =
    frames === undefined ? null : frames / (durationMs / 1000);
  const reasons = [
    ...(visibleFraction < minVisible ? ['mostly-black'] : []),
    ...(changingFraction < minChanging ? ['not-changing'] : []),
    ...(framesPerSecond !== null && framesPerSecond < MIN_FRAMES_PER_SECOND
      ? ['too-few-frames']
      : []),
  ];
  return Object.freeze({
    samples: samples.length,
    visibleSeconds: visible,
    visibleFraction: round(visibleFraction),
    longestBlackS: Math.max(0, ...stretches.map((s) => s.toS - s.fromS)),
    blackStretches: Object.freeze(stretches.map((s) => Object.freeze(s))),
    changingFraction: round(changingFraction),
    framesPerSecond: framesPerSecond === null ? null : round(framesPerSecond),
    reasons: Object.freeze(reasons),
    ok: reasons.length === 0,
  });
}

/**
 * Measures a recording with the pinned ffprobe and judges it with the
 * helper's reported frame count. `path` must be a plain absolute path (the
 * lavfi movie source cannot take arbitrary characters).
 */
export function measureRecordingVisibility({
  probe,
  path,
  frames,
  durationMs,
  region,
  minChanging,
  exec = execFileSync,
  environment,
} = {}) {
  required(
    typeof probe === 'string' &&
      probe.startsWith('/') &&
      typeof path === 'string' &&
      /^\/[A-Za-z0-9/._-]+$/.test(path) &&
      // A whole recording is judged with the helper's frame count; a region
      // of it (the player's captions) by its own picture only.
      (region === undefined
        ? Number.isSafeInteger(frames) && Number.isFinite(durationMs)
        : frames === undefined &&
          ['x', 'y', 'width', 'height'].every(
            (k) => Number.isSafeInteger(region[k]) && region[k] >= 0,
          ) &&
          region.width >= 2 &&
          region.height >= 2),
  );
  const crop = region
    ? `,crop=${region.width}:${region.height}:${region.x}:${region.y}`
    : '';
  const output = exec(
    probe,
    [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      `movie=${path}${crop},fps=1,signalstats`,
      '-show_entries',
      'frame=pts_time:frame_tags=lavfi.signalstats.YAVG,lavfi.signalstats.YDIF',
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
  let probed;
  try {
    probed = JSON.parse(output).frames;
  } catch {
    throw gateFailure('protocol');
  }
  required(Array.isArray(probed));
  return summarizeRecordingLuma(
    probed.map((f) => ({
      atS: Number(f?.pts_time),
      luma: Number(f?.tags?.['lavfi.signalstats.YAVG']),
      change: Number(f?.tags?.['lavfi.signalstats.YDIF']),
    })),
    {
      ...(region ? {} : { frames, durationMs }),
      ...(minChanging === undefined ? {} : { minChanging }),
    },
  );
}

// The owned player shows the scenario's 1280x800 video fitted into its
// 960x540 pt content area, under the window's title bar.
const PLAYER_CONTENT = { width: 960, height: 540 };
const VIDEO = { width: 1280, height: 800 };

/**
 * The rectangle, in recording pixels, of a horizontal band of the player's
 * video (for example the captions at video rows 640-716), from the
 * recorder's geometry. The picture is the two windows' union.
 */
export function playerVideoBand(geometry, { top, bottom }) {
  const em = geometry?.emulator,
    co = geometry?.companion,
    scale = geometry?.picture?.scale;
  required(
    em &&
      co &&
      Number.isFinite(scale) &&
      scale > 0 &&
      em.width === PLAYER_CONTENT.width &&
      em.height >= PLAYER_CONTENT.height &&
      Number.isInteger(top) &&
      Number.isInteger(bottom) &&
      top >= 0 &&
      bottom <= VIDEO.height &&
      bottom - top >= 8,
  );
  const fit = Math.min(
    PLAYER_CONTENT.width / VIDEO.width,
    PLAYER_CONTENT.height / VIDEO.height,
  );
  const left = (PLAYER_CONTENT.width - VIDEO.width * fit) / 2;
  const titleBar = em.height - PLAYER_CONTENT.height;
  const originX = em.x - Math.min(em.x, co.x);
  const originY = em.y - Math.min(em.y, co.y);
  const even = (n) => Math.max(2, Math.floor(n / 2) * 2);
  return Object.freeze({
    x: Math.round((originX + left) * scale),
    y: Math.round((originY + titleBar + top * fit) * scale),
    width: even(VIDEO.width * fit * scale),
    height: even((bottom - top) * fit * scale),
  });
}
