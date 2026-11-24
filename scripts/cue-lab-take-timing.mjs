// Labelled timing estimates for one finished take, from what its recording
// shows: when the companion's cue area changed from empty to a cue and back
// (video frames), when the player's speech was heard (the recording's own
// sound), and how those line up with the native timing log.
//
// Everything here is an ESTIMATE. The evidence report's budget rows need
// exact identities (a heard line joined to its transcript line by an
// explicit event, a painted frame carrying its cue's identity) and declared
// clock anchors; this module has neither. It joins painted episodes to cues
// by order and agreeing visible durations, and recorded speech to
// transcription finals by time overlap through measured clock brackets, and
// says so on every figure. Nothing here feeds the report's pass/fail rows.
// See docs/lab-take-timing.md.
//
//   node scripts/cue-lab-take-timing.mjs --manifest <evidence>/manifest.json \
//     --out <evidence>/timing-estimates
//
// It reads the evidence (hash-checked by the report's own loader) and the
// take outcome beside the manifest, builds scripts/lab-recording-observe.swift
// into a private temporary folder, and writes a new mode-0700 folder with
// mode-0600 estimates.json and estimates.md. It deletes no input.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadEvidence,
  parseNativeRow,
  BUDGET_TARGETS,
} from './cue-lab-evidence-report.mjs';
import { isMain } from './is-main.mjs';

export const ESTIMATE_SCHEMA = 'talkqte.lab.take-timing-estimate.v1';
const OBSERVE_SOURCE = fileURLToPath(
  new URL('./lab-recording-observe.swift', import.meta.url),
);
const CHECKOUT = realpathSync(fileURLToPath(new URL('../', import.meta.url)));

// The cue area counts as empty while at most this share of its sampled
// pixels differs from the first recorded frame (the companion's idle
// controls animate a few), and as showing a cue once at least `shownMin`
// differs. Between the two it is changing (a cue sliding in or fading out).
// A change that never reaches `shownMin` is a blip, not a cue.
export const PAINT = Object.freeze({
  emptyMax: 0.05,
  shownMin: 0.5,
  // The recorder asks macOS for at most 30 frames a second per window, and
  // a change reaches a captured frame within one such interval plus one
  // 60 Hz display refresh. Used when frames are closer together than that.
  captureLatencyMs: 1000 / 30 + 1000 / 60,
});
// Recorded sound: digital silence before the player starts, then the
// media's room tone and speech. Speech is any 10 ms window above the
// midpoint (in dB) between the room tone and speech levels; pauses shorter
// than `minPauseMs` stay inside one stretch of speech.
export const SPEECH = Object.freeze({
  silenceDb: -100,
  minLeadingSilenceWindows: 5,
  floorPercentile: 0.1,
  speechPercentile: 0.95,
  minContrastDb: 20,
  minPauseMs: 150,
  minSpanMs: 50,
  // The recording's AAC frame (1024 samples at 48 kHz) can smear the very
  // first sound by up to one frame.
  aacFrameMs: (1024 / 48000) * 1000,
});
// Painted episodes join cues by order only when every visible duration and
// every gap between successive cues agrees within this (fade-in and
// fade-out of the card take about a quarter of a second).
export const PAINT_JOIN_TOLERANCE_MS = 500;
// A causal bracket wider than this is not used as a clock bridge.
export const MAX_BRACKET_MS = 200;

const fail = (message) => {
  throw new Error(message);
};
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const round = (v, digits = 1) =>
  v === null ? null : Math.round(v * 10 ** digits) / 10 ** digits;
const interval = (valueMs, uncertaintyMs) => ({
  valueMs: round(valueMs),
  uncertaintyMs: round(uncertaintyMs),
  minMs: round(valueMs - uncertaintyMs),
  maxMs: round(valueMs + uncertaintyMs),
});

/**
 * The companion window's rectangle in the recorded picture, in output
 * pixels with a top-left origin, from the recorder's geometry in the take
 * outcome (screen points of both windows and the picture's pixel scale).
 * The picture is the union of both windows, as the capture helper draws it.
 */
export function companionRect(geometry) {
  const rect = (r) =>
    object(r) &&
    ['x', 'y', 'width', 'height'].every((k) => finite(r[k])) &&
    r.width > 0 &&
    r.height > 0;
  if (
    !object(geometry) ||
    !rect(geometry.emulator) ||
    !rect(geometry.companion) ||
    !object(geometry.picture) ||
    !['width', 'height', 'scale'].every(
      (k) => finite(geometry.picture[k]) && geometry.picture[k] > 0,
    )
  )
    fail('invalid recorder geometry');
  const { emulator: e, companion: c, picture: p } = geometry;
  const minX = Math.min(e.x, c.x),
    minY = Math.min(e.y, c.y);
  const out = {
    x: Math.round((c.x - minX) * p.scale),
    y: Math.round((c.y - minY) * p.scale),
    width: Math.round(c.width * p.scale),
    height: Math.round(c.height * p.scale),
  };
  if (out.x + out.width > p.width || out.y + out.height > p.height)
    fail('companion outside the recorded picture');
  return out;
}

/**
 * Painted and cleared cue-area episodes from per-frame change shares
 * ([[ms, share], …] on the recording clock, the first frame being the
 * empty reference). Each event is the first frame that shows the change;
 * the change happened no later than that frame and no earlier than the
 * previous frame or one capture interval before it, whichever is earlier.
 */
export function detectCuePaint(frames, options = PAINT) {
  const { emptyMax, shownMin, captureLatencyMs } = options;
  if (
    !Array.isArray(frames) ||
    frames.length < 2 ||
    frames.some(
      (f, i) =>
        !Array.isArray(f) ||
        f.length !== 2 ||
        !finite(f[0]) ||
        !finite(f[1]) ||
        f[1] < 0 ||
        f[1] > 1 ||
        (i > 0 && f[0] <= frames[i - 1][0]),
    ) ||
    frames[0][1] !== 0
  )
    fail('invalid cue-area frames');
  const gaps = frames.slice(1).map((f, i) => f[0] - frames[i][0]);
  const sorted = [...gaps].sort((a, b) => a - b);
  const event = (stage, i, episode) => {
    const first = frames[i][0],
      previous = frames[i - 1][0];
    const widthMs = Math.max(first - previous, captureLatencyMs);
    return {
      stage,
      outcome: 'observed',
      episode,
      timing: {
        clockId: 'recording',
        atMs: round(first - widthMs / 2, 3),
        uncertaintyMs: round(widthMs / 2, 3),
        basis: 'frame',
      },
      firstFrameMs: first,
      previousFrameMs: previous,
    };
  };
  const episodes = [];
  let blips = 0,
    open = null;
  for (let i = 1; i < frames.length; i++) {
    const share = frames[i][1];
    if (!open) {
      if (share > emptyMax) open = { start: i, peak: share };
    } else {
      open.peak = Math.max(open.peak, share);
      if (share <= emptyMax) {
        if (open.peak >= shownMin) {
          const n = episodes.length + 1;
          episodes.push({
            episode: n,
            peakShare: round(open.peak, 3),
            painted: event('video.cue-painted', open.start, n),
            cleared: event('video.cue-cleared', i, n),
          });
        } else blips++;
        open = null;
      }
    }
  }
  let openAtEnd = null;
  if (open && open.peak >= shownMin) {
    const n = episodes.length + 1;
    openAtEnd = n;
    episodes.push({
      episode: n,
      peakShare: round(open.peak, 3),
      painted: event('video.cue-painted', open.start, n),
      cleared: null,
    });
  } else if (open) blips++;
  for (const e of episodes)
    e.visibleMs = e.cleared
      ? interval(
          e.cleared.timing.atMs - e.painted.timing.atMs,
          e.cleared.timing.uncertaintyMs + e.painted.timing.uncertaintyMs,
        )
      : null;
  return {
    thresholds: {
      emptyMax,
      shownMin,
      captureLatencyMs: round(captureLatencyMs, 3),
    },
    frames: frames.length,
    frameIntervalMs: {
      median: round(sorted[Math.floor(sorted.length / 2)], 3),
      max: round(sorted.at(-1), 3),
    },
    episodes,
    blips,
    openAtEnd,
  };
}

const percentile = (sorted, q) =>
  sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];

/**
 * The recorded sound: when the player's sound first appears after digital
 * silence (its render start as captured), and the stretches of speech, all
 * on the recording clock. `levels` is {windowMs, startMs, db: […]}.
 */
export function detectSpeech(levels, options = SPEECH) {
  if (
    !object(levels) ||
    levels.windowMs !== 10 ||
    !finite(levels.startMs) ||
    !Array.isArray(levels.db) ||
    levels.db.length < 10 ||
    levels.db.some((v) => !finite(v))
  )
    fail('invalid audio levels');
  const { windowMs, startMs, db } = levels;
  const at = (i) => startMs + i * windowMs;
  const first = db.findIndex((v) => v > options.silenceDb);
  let onset = null,
    onsetReason = null;
  if (first < 0) onsetReason = 'no sound in the recording';
  else if (first < options.minLeadingSilenceWindows)
    onsetReason =
      'the recording starts with sound, so the player start is not in it';
  else
    onset = {
      atMs: round(at(first) + windowMs / 2, 3),
      uncertaintyMs: round(windowMs / 2 + options.aacFrameMs, 3),
      basis: 'first 10 ms window above digital silence',
    };
  const sound = first < 0 ? [] : db.slice(first).sort((a, b) => a - b);
  const floorDb = sound.length
    ? percentile(sound, options.floorPercentile)
    : null;
  const speechDb = sound.length
    ? percentile(sound, options.speechPercentile)
    : null;
  if (floorDb === null || speechDb - floorDb < options.minContrastDb)
    return {
      onset,
      onsetReason,
      floorDb,
      speechDb,
      thresholdDb: null,
      spans: [],
      reason: 'no speech clearly above the room tone',
    };
  const thresholdDb = round((floorDb + speechDb) / 2);
  const pause = Math.ceil(options.minPauseMs / windowMs);
  const spans = [];
  let current = null,
    quiet = 0;
  for (let i = Math.max(first, 0); i < db.length; i++) {
    if (db[i] > thresholdDb) {
      if (!current) current = { from: i, to: i };
      current.to = i;
      quiet = 0;
    } else if (current && ++quiet >= pause) {
      spans.push(current);
      current = null;
      quiet = 0;
    }
  }
  if (current) spans.push(current);
  return {
    onset,
    onsetReason,
    floorDb,
    speechDb,
    thresholdDb,
    edgeUncertaintyMs: windowMs,
    spans: spans
      .map((s) => ({ startMs: at(s.from), endMs: at(s.to + 1) }))
      .filter((s) => s.endMs - s.startMs >= options.minSpanMs),
  };
}

/**
 * Node clock ↔ native logger clock. Preferred: the broker's clock
 * calibration (Node midpoint ↔ native session elapsed, half the round trip)
 * carried through the session's start row. Otherwise a causal bracket:
 * the runner received native's Listening row after native wrote it, and
 * native latched Stop after the runner had seen the media end. Returns the
 * offset (node − logger) with its uncertainty, or a reason.
 */
export function nodeLoggerBridge({ events, nativeRows, calibration }) {
  const starts = events.filter((e) => e.stage === 'session.started');
  if (calibration !== undefined && calibration !== null) {
    const start = starts.find(
      (e) => e.ids?.sessionId === String(calibration.sessionId),
    );
    if (
      start?.timing &&
      ['nativeMs', 'monotonicMs', 'uncertaintyMs'].every((k) =>
        finite(calibration[k]),
      ) &&
      finite(start.payload?.sessionElapsedMs)
    ) {
      const logger =
        start.timing.atMs +
        (calibration.nativeMs - start.payload.sessionElapsedMs);
      return {
        method: 'broker clock calibration through the session start row',
        offsetMs: round(calibration.monotonicMs - logger, 3),
        uncertaintyMs: round(calibration.uncertaintyMs + 2, 3),
      };
    }
  }
  const one = (stage) => {
    const found = events.filter(
      (e) => e.stage === stage && e.timing?.clockId === 'node',
    );
    return found.length === 1 ? found[0] : null;
  };
  const listening = one('source.listening'),
    renderEnd = one('speech.render-end');
  const listeningRows = nativeRows.filter(
    (r) =>
      r.event === 'dev_source_observation' &&
      r.step === 'listening' &&
      finite(r.mono_ms),
  );
  const latched = nativeRows.filter(
    (r) => r.event === 'dev_stop' && r.step === 'latched' && finite(r.mono_ms),
  );
  if (
    !listening ||
    !renderEnd ||
    listeningRows.length !== 1 ||
    latched.length !== 1
  )
    return {
      method: null,
      reason:
        'no clock calibration recorded, and no single Listening row/receipt and Stop latch after the media end to bracket the clocks',
    };
  // ±1 ms: native logs whole milliseconds.
  const upper = listening.timing.atMs - listeningRows[0].mono_ms + 1;
  const lower = renderEnd.timing.atMs - latched[0].mono_ms - 1;
  if (lower > upper)
    return {
      method: null,
      reason: 'the causal bracket is empty (rows out of the expected order)',
    };
  if (upper - lower > MAX_BRACKET_MS)
    return {
      method: null,
      reason: `the causal bracket is ${round(upper - lower)} ms wide, more than ${MAX_BRACKET_MS} ms`,
    };
  return {
    method:
      'causal bracket: Listening row received after native wrote it; Stop latched after the media end was seen',
    offsetMs: round((upper + lower) / 2, 3),
    uncertaintyMs: round((upper - lower) / 2, 3),
    lowerMs: round(lower, 3),
    upperMs: round(upper, 3),
  };
}

/**
 * Recording clock ↔ node clock: the first recorded sound after digital
 * silence is taken as the player's measured render start. It holds only if
 * that onset could follow the recording's first frame (which the runner
 * saw accepted before the render start).
 */
export function recordingNodeBridge({ events, onset }) {
  const one = (stage) => {
    const found = events.filter(
      (e) => e.stage === stage && e.timing?.clockId === 'node',
    );
    return found.length === 1 ? found[0] : null;
  };
  const start = one('speech.render-start');
  const accepted = one('recorder.frame-accepted');
  if (!onset)
    return { method: null, reason: 'no player start in the recording' };
  if (!start || start.timing.basis !== 'event')
    return { method: null, reason: 'no measured render start' };
  const uncertaintyMs = start.timing.uncertaintyMs + onset.uncertaintyMs;
  if (
    accepted &&
    onset.atMs + uncertaintyMs < start.timing.atMs - accepted.timing.atMs
  )
    return {
      method: null,
      reason:
        'the recorded onset comes before the render start could have been recorded',
    };
  return {
    method:
      'first recorded sound after digital silence taken as the measured render start',
    offsetMs: round(start.timing.atMs - onset.atMs, 3),
    uncertaintyMs: round(uncertaintyMs, 3),
  };
}

const quantile = (values, q) => {
  const s = [...values].sort((a, b) => a - b);
  return q === 0.5
    ? s[Math.floor(s.length / 2)]
    : s[Math.max(0, Math.ceil(q * s.length) - 1)];
};
const stats = (rows, target) => {
  const values = rows.filter(Boolean);
  if (!values.length) return { count: 0 };
  const pick = (field) => (q) =>
    quantile(
      values.map((v) => v[field]),
      q,
    );
  return {
    count: values.length,
    median: interval(pick('valueMs')(0.5), 0),
    p95: {
      valueMs: round(pick('valueMs')(0.95)),
      minMs: round(pick('minMs')(0.95)),
      maxMs: round(pick('maxMs')(0.95)),
    },
    max: {
      valueMs: round(pick('valueMs')(1)),
      minMs: round(pick('minMs')(1)),
      maxMs: round(pick('maxMs')(1)),
    },
    target,
  };
};

/**
 * The estimates for one take. Inputs are the report loader's normalized
 * events, the raw native rows, the take outcome's calibration (if any) and
 * the recording observations ({frames, levels}).
 */
export function estimateTakeTiming({
  runId,
  recordingDurationMs,
  events,
  nativeRows,
  calibration = null,
  observations,
}) {
  const paint = detectCuePaint(observations.frames);
  const speech = detectSpeech(observations.levels);
  const nodeLogger = nodeLoggerBridge({ events, nativeRows, calibration });
  const recordingNode = recordingNodeBridge({ events, onset: speech.onset });
  // logger → recording, when both bridges hold.
  const bridge =
    nodeLogger.method && recordingNode.method
      ? {
          offsetMs: nodeLogger.offsetMs - recordingNode.offsetMs,
          uncertaintyMs: nodeLogger.uncertaintyMs + recordingNode.uncertaintyMs,
        }
      : null;
  const toRecording = (loggerMs) =>
    bridge ? loggerMs + bridge.offsetMs : null;

  // Native cues, in publication order (logger clock).
  const byStage = (stage) =>
    events
      .filter((e) => e.stage === stage && e.timing && e.ids?.cueId)
      .sort((a, b) => a.timing.atMs - b.timing.atMs);
  const published = byStage('cue.published'),
    cleared = byStage('cue.cleared'),
    decided = byStage('cue.decided');
  const cues = published.map((p) => {
    const sameCue = (e) =>
      e.ids.cueId === p.ids.cueId && e.ids.sessionId === p.ids.sessionId;
    const clears = cleared.filter(sameCue),
      decisions = decided.filter(sameCue);
    return {
      cueId: p.ids.cueId,
      sessionId: p.ids.sessionId,
      publishedMs: p.timing.atMs,
      clearedMs: clears.length === 1 ? clears[0].timing.atMs : null,
      decision: decisions.length === 1 ? decisions[0] : null,
    };
  });
  // Order join: same count, every visible duration and every gap between
  // successive cues agreeing within the tolerance. Never an identity.
  const episodes = paint.episodes;
  let paintJoin;
  if (
    published.some(
      (p, i) => published.findIndex((q) => q.ids.cueId === p.ids.cueId) !== i,
    )
  )
    paintJoin = { joined: false, reason: 'a cue was published more than once' };
  else if (episodes.length !== cues.length)
    paintJoin = {
      joined: false,
      reason: `${episodes.length} painted episodes for ${cues.length} published cues`,
    };
  else {
    const problems = [];
    cues.forEach((c, i) => {
      const e = episodes[i];
      if (c.clearedMs !== null && e.cleared) {
        const d =
          e.cleared.firstFrameMs -
          e.painted.firstFrameMs -
          (c.clearedMs - c.publishedMs);
        if (Math.abs(d) > PAINT_JOIN_TOLERANCE_MS)
          problems.push(
            `cue ${i + 1}: visible durations differ by ${round(d)} ms`,
          );
      } else if ((c.clearedMs === null) !== (e.cleared === null))
        problems.push(`cue ${i + 1}: cleared in one and not the other`);
      if (i > 0) {
        const d =
          e.painted.firstFrameMs -
          episodes[i - 1].painted.firstFrameMs -
          (c.publishedMs - cues[i - 1].publishedMs);
        if (Math.abs(d) > PAINT_JOIN_TOLERANCE_MS)
          problems.push(
            `cues ${i} and ${i + 1}: spacing differs by ${round(d)} ms`,
          );
      }
      if (bridge) {
        const lead = e.painted.timing.atMs - toRecording(c.publishedMs);
        if (lead < -(bridge.uncertaintyMs + e.painted.timing.uncertaintyMs))
          problems.push(`cue ${i + 1}: painted before it was published`);
      }
    });
    paintJoin = problems.length
      ? { joined: false, reason: problems.join('; ') }
      : { joined: true, reason: null };
  }
  paintJoin.method =
    'order, with visible durations and spacing agreeing to the tolerance; not an identity';
  paintJoin.toleranceMs = PAINT_JOIN_TOLERANCE_MS;

  // Transcription finals and their transcript lines (exact identity:
  // c{session}-{stream}-{seq}, one match only, as the report does).
  const arrivals = events.filter((e) => e.stage === 'transcript.arrived');
  const finals = events
    .filter((e) => e.stage === 'transcript.finalized')
    .map((f) => {
      const sessionId = f.ids?.sessionId ?? null;
      const seq = f.payload?.sttSeq;
      const pattern = new RegExp(`^c${sessionId}-[0-9]+-${seq}$`);
      const lines = arrivals.filter(
        (a) => a.ids?.sessionId === sessionId && pattern.test(a.ids?.segmentId),
      );
      const start = events.filter(
        (e) => e.stage === 'session.started' && e.ids?.sessionId === sessionId,
      );
      const s = start.length === 1 ? start[0] : null;
      const onLogger = (ms) =>
        s && finite(ms)
          ? s.timing.atMs + (ms - s.payload.sessionElapsedMs)
          : null;
      return {
        seq,
        sessionId,
        segmentId: lines.length === 1 ? lines[0].ids.segmentId : null,
        arrivalMs: lines.length === 1 ? (lines[0].timing?.atMs ?? null) : null,
        speechStartMs: onLogger(f.payload?.startMs),
        speechEndMs: onLogger(f.payload?.endMs),
      };
    })
    .filter((f) => f.speechEndMs !== null);
  const spans = speech.spans;
  const overlapping = (f) => {
    const from = toRecording(f.speechStartMs) - bridge.uncertaintyMs,
      to = toRecording(f.speechEndMs) + bridge.uncertaintyMs;
    return spans.filter((s) => s.startMs < to && s.endMs > from);
  };
  const finalRows = finals.map((f) => {
    const row = {
      seq: f.seq,
      segmentId: f.segmentId,
      nativeFinalToLineMs:
        f.arrivalMs === null ? null : round(f.arrivalMs - f.speechEndMs),
    };
    if (!bridge) return { ...row, join: 'no clock bridge' };
    if (f.arrivalMs === null)
      return { ...row, join: 'no single transcript line' };
    const mine = overlapping(f);
    if (!mine.length) return { ...row, join: 'no recorded speech overlaps it' };
    const last = mine.reduce((a, b) => (b.endMs > a.endMs ? b : a));
    const shared = finals.some((g) => g !== f && overlapping(g).includes(last));
    if (shared)
      return {
        ...row,
        join: 'ambiguous: its last stretch of speech overlaps another final',
      };
    const heardEndMs = last.endMs;
    const heardU = speech.edgeUncertaintyMs;
    const arrivalRec = toRecording(f.arrivalMs);
    return {
      ...row,
      join: 'unique time overlap (estimate)',
      heardEndMs,
      heardEndUncertaintyMs: heardU,
      deepgramEndMinusHeardEndMs: round(
        toRecording(f.speechEndMs) - heardEndMs,
      ),
      heardEndToLine: interval(
        arrivalRec - heardEndMs,
        heardU + bridge.uncertaintyMs + 1,
      ),
    };
  });
  const heardBySegment = new Map(
    finalRows
      .filter((r) => r.heardEndMs !== undefined && r.segmentId)
      .map((r) => [r.segmentId, r]),
  );
  const requests = events.filter((e) => e.stage === 'evaluator.requested');
  const cueRows = cues.map((c, i) => {
    const e = paintJoin.joined ? episodes[i] : null;
    const cited =
      c.decision?.ids?.segmentId?.replace(/^transcript:/, '') ?? null;
    const reqs = c.decision?.ids?.requestId
      ? requests.filter(
          (r) =>
            r.ids.requestId === c.decision.ids.requestId &&
            r.ids.sessionId === c.sessionId,
        )
      : [];
    const through = reqs.length === 1 ? (reqs[0].ids.segmentId ?? null) : null;
    const fromLine = (segmentId) => {
      const r = segmentId ? heardBySegment.get(segmentId) : null;
      if (!e || !r) return null;
      return interval(
        e.painted.timing.atMs - r.heardEndMs,
        e.painted.timing.uncertaintyMs + r.heardEndUncertaintyMs,
      );
    };
    return {
      cueId: c.cueId,
      episode: e ? e.episode : null,
      citedSegment: cited,
      requestThroughSegment: through,
      nativeVisibleMs:
        c.clearedMs === null ? null : round(c.clearedMs - c.publishedMs),
      paintedVisibleMs: e?.visibleMs ?? null,
      publishedToPainted:
        e && bridge
          ? interval(
              e.painted.timing.atMs - toRecording(c.publishedMs),
              e.painted.timing.uncertaintyMs + bridge.uncertaintyMs + 1,
            )
          : null,
      citedHeardEndToPainted: fromLine(cited),
      requestHeardEndToPainted: fromLine(through),
    };
  });
  const t = BUDGET_TARGETS;
  return {
    schema: ESTIMATE_SCHEMA,
    runId,
    estimate: true,
    notEvidenceFor:
      'the evidence report budget rows: no exact heard-line or painted-cue identity, and no declared clock anchor',
    recording: {
      durationMs: recordingDurationMs,
      frames: paint.frames,
      frameIntervalMs: paint.frameIntervalMs,
    },
    paint: {
      thresholds: paint.thresholds,
      events: paint.episodes.flatMap((e) =>
        [e.painted, e.cleared].filter(Boolean),
      ),
      episodes: paint.episodes.map((e) => ({
        episode: e.episode,
        peakShare: e.peakShare,
        visibleMs: e.visibleMs,
      })),
      blips: paint.blips,
      openAtEnd: paint.openAtEnd,
    },
    paintJoin,
    speech: {
      onset: speech.onset,
      onsetReason: speech.onsetReason,
      floorDb: speech.floorDb,
      speechDb: speech.speechDb,
      thresholdDb: speech.thresholdDb,
      spans: speech.spans.length,
      ...(speech.reason ? { reason: speech.reason } : {}),
    },
    bridges: {
      nodeLogger,
      recordingNode,
      loggerRecording: bridge
        ? {
            offsetMs: round(bridge.offsetMs, 3),
            uncertaintyMs: round(bridge.uncertaintyMs, 3),
          }
        : null,
    },
    finals: finalRows,
    cues: cueRows,
    summary: {
      heardEndToLine: stats(
        finalRows.map((r) => r.heardEndToLine),
        t.speechToLine,
      ),
      nativeFinalToLine: stats(
        finalRows
          .filter((r) => r.nativeFinalToLineMs !== null)
          .map((r) => interval(r.nativeFinalToLineMs, 2)),
        t.speechToLine,
      ),
      citedHeardEndToPainted: stats(
        cueRows.map((c) => c.citedHeardEndToPainted),
        { p95Ms: t.lineToVisibleCue.p95Ms, maxMs: t.staleCue.maxMs },
      ),
      requestHeardEndToPainted: stats(
        cueRows.map((c) => c.requestHeardEndToPainted),
        { p95Ms: t.lineToVisibleCue.p95Ms, maxMs: t.staleCue.maxMs },
      ),
    },
    exactWouldNeed: [
      'a heard-end observation per line from the player itself (its render clock at each line end, from a media line schedule) with an explicit line-to-transcript-segment identity event',
      'a recording clock anchor declared from the capture helper (first frame host time mapped to the runner clock) instead of the recorded-sound onset',
      'the companion drawing the cue identity it shows (or a recorded per-cue paint receipt), so painted frames join cues by identity rather than by order',
    ],
  };
}

const ms = (v) => (v === null || v === undefined ? 'unknown' : `${v} ms`);
const range = (i) =>
  i ? `${i.valueMs} ms (${i.minMs} to ${i.maxMs})` : 'unknown';
const line = (s, name) =>
  s.count
    ? `${name}: ${s.count} samples; median ${s.median.valueMs} ms; 95th percentile ${s.p95.valueMs} ms (${s.p95.minMs} to ${s.p95.maxMs}); max ${s.max.valueMs} ms (${s.max.minMs} to ${s.max.maxMs}).`
    : `${name}: no samples.`;

export function renderTakeTimingMarkdown(r) {
  const b = r.bridges;
  return [
    `# Timing estimates for ${r.runId}`,
    '',
    '**Estimates, not evidence for the budget rows.** The evidence report keeps its "Timing targets" rows unmeasured until heard lines and painted cues carry exact identities and the clocks have declared anchors. Every figure here names how it was joined.',
    '',
    '## Clock bridges',
    '',
    `- Node ↔ native logger: ${b.nodeLogger.method ? `${b.nodeLogger.method}; offset ${b.nodeLogger.offsetMs} ms ± ${b.nodeLogger.uncertaintyMs} ms` : `none (${b.nodeLogger.reason})`}.`,
    `- Recording ↔ node: ${b.recordingNode.method ? `${b.recordingNode.method}; offset ${b.recordingNode.offsetMs} ms ± ${b.recordingNode.uncertaintyMs} ms (the capture path's own audio latency is not measured)` : `none (${b.recordingNode.reason})`}.`,
    `- Native logger → recording: ${b.loggerRecording ? `${b.loggerRecording.offsetMs} ms ± ${b.loggerRecording.uncertaintyMs} ms. Cross-check: with this bridge, each joined cue's painted frame should follow its publication by no more than a few frames ("Published → painted" below).` : 'none'}`,
    '',
    '## Cue paint from the recording',
    '',
    `${r.recording.frames} frames; frame interval median ${r.recording.frameIntervalMs.median} ms, max ${r.recording.frameIntervalMs.max} ms. The cue area is empty at ≤ ${r.paint.thresholds.emptyMax} of its sampled pixels changed from the first frame and shows a cue at ≥ ${r.paint.thresholds.shownMin}. Each time is the first frame showing the change, less half of the larger of the frame interval and one capture interval (${r.paint.thresholds.captureLatencyMs} ms), with that half as its uncertainty. Painted means captured on screen, not seen by a person. Cleared is the first frame back at empty, after the card's fade-out.`,
    '',
    `Blips (changes that never reached a cue): ${r.paint.blips}. Visible at recording end: ${r.paint.openAtEnd ?? 'none'}.`,
    '',
    '| Episode | Painted (recording ms) | Cleared (recording ms) | Visible on the recording |',
    '| --- | --- | --- | --- |',
    ...r.paint.episodes.map((e) => {
      const p = r.paint.events.find(
        (x) => x.episode === e.episode && x.stage === 'video.cue-painted',
      );
      const c = r.paint.events.find(
        (x) => x.episode === e.episode && x.stage === 'video.cue-cleared',
      );
      return `| ${e.episode} | ${p.timing.atMs} ± ${p.timing.uncertaintyMs} | ${c ? `${c.timing.atMs} ± ${c.timing.uncertaintyMs}` : 'not cleared'} | ${range(e.visibleMs)} |`;
    }),
    '',
    `Join to cues: ${r.paintJoin.joined ? 'joined' : `not joined (${r.paintJoin.reason})`}. Method: ${r.paintJoin.method}; tolerance ${r.paintJoin.toleranceMs} ms.`,
    '',
    '| Cue | Episode | Native visible | Painted visible | Published → painted (estimate) | Cited line heard end → painted (estimate) | Request line heard end → painted (estimate) |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...r.cues.map(
      (c) =>
        `| ${c.cueId} | ${c.episode ?? 'none'} | ${ms(c.nativeVisibleMs)} | ${range(c.paintedVisibleMs)} | ${range(c.publishedToPainted)} | ${c.citedSegment ?? 'none'}: ${range(c.citedHeardEndToPainted)} | ${c.requestThroughSegment ?? 'none'}: ${range(c.requestHeardEndToPainted)} |`,
    ),
    '',
    '## Heard end → transcript line',
    '',
    `Recorded speech: ${r.speech.spans} stretches above ${r.speech.thresholdDb ?? 'unknown'} dB (room tone ${r.speech.floorDb} dB, speech ${r.speech.speechDb} dB); pauses under ${SPEECH.minPauseMs} ms stay inside a stretch. ${r.speech.onset ? `Player sound starts at ${r.speech.onset.atMs} ± ${r.speech.onset.uncertaintyMs} ms on the recording.` : `Player start: ${r.speech.onsetReason}.`}`,
    '',
    "Heard end is the end of the last stretch of recorded speech that a final overlaps (through the bridges above), when no other final overlaps that stretch. That join is by time, not identity. It differs from the evidence report's \"Final end of speech → transcript line\", which starts from the transcription service's own end-of-speech time on the app's session clock: that figure leaves out how far the service's end of speech is from the end of the sound, which this one includes.",
    '',
    '| Final | Transcript line | Join | Heard end (recording ms) | Service end − heard end | Heard end → line (estimate) | Service end → line (native) |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...r.finals.map(
      (f) =>
        `| ${f.seq} | ${f.segmentId ?? 'none'} | ${f.join} | ${f.heardEndMs ?? 'unknown'} | ${ms(f.deepgramEndMinusHeardEndMs)} | ${range(f.heardEndToLine)} | ${ms(f.nativeFinalToLineMs)} |`,
    ),
    '',
    '## Summary (estimates)',
    '',
    line(
      r.summary.heardEndToLine,
      'Heard end → transcript line (target median 3500 ms, 95th percentile 5000 ms)',
    ),
    line(
      r.summary.nativeFinalToLine,
      'Service end of speech → transcript line (native clock, for comparison)',
    ),
    line(
      r.summary.citedHeardEndToPainted,
      "Cited line's heard end → painted cue (target 95th percentile 5000 ms; stale limit 18000 ms)",
    ),
    line(
      r.summary.requestHeardEndToPainted,
      "Request's newest line's heard end → painted cue",
    ),
    '',
    'None of these is a pass or a fail: one take confirms no budget, and these joins are not identities.',
    '',
    '## What would make these exact',
    '',
    ...r.exactWouldNeed.map((x) => `- ${x}`),
    '',
  ].join('\n');
}

// Builds the observation helper into a private temporary folder.
export function prepareRecordingObserver({ environment = process.env } = {}) {
  const directory = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), 'tq-observe-')),
  );
  chmodSync(directory, 0o700);
  const binary = join(directory, 'lab-recording-observe');
  const cache = join(directory, 'module-cache');
  try {
    execFileSync(
      '/usr/bin/swiftc',
      [
        '-O',
        '-parse-as-library',
        '-swift-version',
        '5',
        '-module-cache-path',
        cache,
        '-o',
        binary,
        OBSERVE_SOURCE,
        '-framework',
        'AVFoundation',
        '-framework',
        'CoreMedia',
        '-framework',
        'CoreVideo',
      ],
      {
        env: {
          PATH: environment.PATH,
          HOME: environment.HOME,
          TMPDIR: environment.TMPDIR,
          CLANG_MODULE_CACHE_PATH: cache,
        },
        stdio: ['ignore', 'ignore', 'ignore'],
        timeout: 300000,
      },
    );
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  const run = (args) =>
    JSON.parse(
      execFileSync(binary, args, {
        env: {},
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 600000,
        maxBuffer: 64 * 1024 * 1024,
      }),
    );
  return Object.freeze({
    observe(path, rect) {
      return {
        frames: run([
          'cue-area',
          path,
          String(rect.x),
          String(rect.y),
          String(rect.width),
          String(rect.height),
        ]).frames,
        levels: run(['audio-level', path]),
      };
    },
    close() {
      rmSync(directory, { recursive: true, force: true });
    },
  });
}

const privateFile = (path, max) => {
  const s = lstatSync(path);
  if (
    !s.isFile() ||
    s.isSymbolicLink() ||
    (s.mode & 0o777) !== 0o600 ||
    s.size > max
  )
    fail('private file check');
  return readFileSync(path);
};

/**
 * Loads the evidence through the report's own checks, observes the
 * recording and writes the estimates into a new private folder.
 * `observer` is injectable for tests; by default the Swift helper is built.
 */
export async function writeTakeTimingEstimates({
  manifestPath,
  outDir,
  outcomePath,
  observer,
}) {
  const { manifest, events, root } = await loadEvidence(manifestPath);
  const recording = manifest.recording
    ? manifest.artifacts.find((a) => a.id === manifest.recording.artifactId)
    : null;
  if (!recording) fail('the evidence has no recording');
  const natives = manifest.artifacts.filter((a) => a.kind === 'native-timing');
  if (natives.length !== 1)
    fail('the evidence needs exactly one native timing log');
  const nativeBytes = privateFile(
    resolve(root, natives[0].path),
    64 * 1024 * 1024,
  );
  if (
    createHash('sha256').update(nativeBytes).digest('hex') !== natives[0].sha256
  )
    fail('native timing changed since the report loader checked it');
  const nativeRows = nativeBytes
    .toString('utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map(parseNativeRow);
  const outcome = JSON.parse(
    privateFile(
      outcomePath ?? join(root, 'take-outcome.json'),
      4 * 1024 * 1024,
    ).toString('utf8'),
  );
  if (outcome.runId !== manifest.runId) fail('take outcome is for another run');
  const rect = companionRect(outcome.recorder?.report?.geometry);
  const own = !observer;
  const o = observer ?? prepareRecordingObserver();
  let observations;
  try {
    observations = o.observe(resolve(root, recording.path), rect);
  } finally {
    if (own) o.close();
  }
  const estimates = estimateTakeTiming({
    runId: manifest.runId,
    recordingDurationMs: manifest.recording.durationMs,
    events,
    nativeRows,
    calibration: outcome.clockCalibration ?? null,
    observations,
  });
  const parent = realpathSync(dirname(resolve(outDir)));
  const output = join(parent, basename(outDir));
  const r = relative(CHECKOUT, output);
  if (!(r === '..' || r.startsWith('..' + sep) || r.startsWith('/')))
    fail('output inside the checkout');
  await mkdir(output, { mode: 0o700 });
  await writeFile(
    join(output, 'estimates.json'),
    JSON.stringify(estimates, null, 2) + '\n',
    { mode: 0o600, flag: 'wx' },
  );
  await writeFile(
    join(output, 'estimates.md'),
    renderTakeTimingMarkdown(estimates),
    {
      mode: 0o600,
      flag: 'wx',
    },
  );
  return { output, estimates };
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--manifest' && args[i + 1]) opts.manifestPath = args[++i];
    else if (args[i] === '--out' && args[i + 1]) opts.outDir = args[++i];
    else if (args[i] === '--outcome' && args[i + 1])
      opts.outcomePath = args[++i];
    else opts.bad = true;
  }
  if (opts.bad || !opts.manifestPath || !opts.outDir) {
    console.error(
      'Usage: node scripts/cue-lab-take-timing.mjs --manifest <evidence>/manifest.json --out <new folder> [--outcome <take-outcome.json>]',
    );
    process.exitCode = 2;
  } else
    try {
      const { output } = await writeTakeTimingEstimates(opts);
      console.log(`Timing estimates written: ${join(output, 'estimates.md')}`);
    } catch {
      console.error(
        'Timing estimates failed their checks; nothing was deleted.',
      );
      process.exitCode = 1;
    }
}
