// Fresh fictional scenarios for lab runs: a seeded brief, call-like pacing,
// a check of the rendered mix, and the manifest that describes the media.
//
// A lab run should hear a new fictional meeting each time rather than one
// fixed recording. This module holds the parts that need no model, voice
// engine or media tool, so they can be tested offline:
//
// - sampleBrief(seed) draws a brief from a wide space of invented situations.
//   A brief carries sparks and required structure, not a script. Whether the
//   meeting has a title is part of the brief; a title, when present, may be
//   one the conversation drifts away from. Nothing here or downstream may
//   depend on a title or agenda.
// - scheduleLines() places spoken lines on one timeline with variable gaps
//   and no overlap, inside a duration window.
// - verifyMix() compares a decoded track with the mix that was intended.
// - buildManifest() and validateManifest() define what a lab run is given.
//
// Generating the conversation and rendering voices happen elsewhere. The
// lab's media acceptance is unchanged by this module.
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { DENY_LIST } from './cue-dialogue-briefs.mjs';

export const BRIEF_SCHEMA = 'talkqte.fresh-scenario.brief.v1';
export const MANIFEST_SCHEMA = 'talkqte.fresh-scenario.media.v1';
export const SAMPLE_RATE = 48_000;
/** The lab's player refuses media longer than this today. */
export const LAB_MEDIA_CAP_MS = 105_000;
export const DEFAULT_WINDOW = Object.freeze({ minMs: 90_000, maxMs: 104_000 });
export const TITLE_MODES = ['none', 'on-topic', 'drifted'];
export const BEATS = ['quick', 'normal', 'pause'];

/** Deterministic uniform numbers in [0, 1) for a uint32 seed. */
export function seededRandom(seed) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    between: (lo, hi) => lo + (hi - lo) * next(),
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: (list) => list[Math.floor(next() * list.length)],
    weighted(pairs) {
      const total = pairs.reduce((sum, [, weight]) => sum + weight, 0);
      let x = next() * total;
      for (const [value, weight] of pairs) if ((x -= weight) < 0) return value;
      return pairs.at(-1)[0];
    },
    sample(list, count) {
      const rest = [...list];
      const out = [];
      while (out.length < count)
        out.push(rest.splice(Math.floor(next() * rest.length), 1)[0]);
      return out;
    },
  };
}

/** Sparks and structure a brief is drawn from. Every entry is invented and
 * generic: no organisation, product, place or person. */
export const BRIEF_SPACE = Object.freeze({
  groups: [
    'volunteers who run a neighbourhood tool library',
    'a two-person bakery and the person who delivers their flour',
    'mentors of a school robotics team',
    "siblings organising a parent's house move",
    'producers of a small podcast',
    'the crew of a community theatre show',
    'three flatmates sharing a house',
    'a museum exhibit team',
    'organisers of a weekend cycling club',
    'researchers back from a field trip',
    'members of a wedding band',
    'a tiny independent game studio',
    'shift leads at a food bank',
    'a choir committee',
    'a boat-repair workshop',
    'a support desk at a small software company',
    'two freelance translators who share clients',
    'a landscaping crew',
    "a parents' association at a primary school",
    'a weekend hackathon team',
    'volunteers at a community radio station',
    'the front desk of a busy pet-grooming shop',
    'a bike courier co-op',
    'grant writers at a small charity',
    'a hiking club',
    'a mobile app testing team',
    'a farmers-market stall',
    'an amateur astronomy society',
    'a public library events team',
    'youth football coaches',
    'a quilting guild',
    'a small brewery',
    'dispatchers at a moving company',
    'a remote sales team',
    'editors of a local newsletter',
    "a tenants' association",
    'teachers at a dance studio',
    'a carpool group of four parents',
    'an orchestra librarian and two players',
    'friends planning a camping trip',
    'a family running a holiday rental',
    'a print shop',
    'an allotment committee',
    'a restaurant kitchen before service',
    'a regional chess league',
    'content reviewers for a phrasebook',
    'a high-school yearbook team',
    'a village fete committee',
    'a bookshop and its events host',
    'a recording studio',
  ],
  callKinds: [
    'a regular weekly check-in',
    'an unplanned call someone asked for an hour ago',
    'a planning call',
    'a short debrief after something went wrong',
    'a handover before someone goes away',
    'a quick decision call',
    'a catch-up that turns into planning',
    'a call that was meant to be five minutes',
    'a first call with someone new to the group',
  ],
  objects: [
    'a borrowed ladder',
    'a spreadsheet nobody owns',
    'a delayed delivery',
    'a parking permit',
    'a projector that flickers',
    'the spare keys',
    'a printed banner with a typo',
    'a refund request',
    'a rota with two gaps',
    'a van booking',
    'a cake order',
    'a broken zip on a costume',
    'a shared calendar',
    'a microphone stand',
    'a cheque that bounced',
    'the wifi password',
    "a sponsor's logo",
    'a lost lanyard',
    'a sign-up form',
    'a cracked tile',
    'a stack of flyers',
    'an old laptop',
    'a water leak',
    'a guest speaker',
    'a grant deadline',
    'a mislabelled box',
    'a rain forecast',
    'a supplier price rise',
    'a playlist',
    'a first-aid kit',
    'a raffle',
    'a hired marquee',
    'a new logo draft',
    'a dog that keeps escaping',
    'a tax form',
    'a leaving card',
    'a set of photos',
    'a microwave',
    'a block hotel booking',
    'a trophy',
    'a bus timetable change',
    'a misprinted ticket',
    'a bike lock',
    'a translated menu',
    'a cold room',
    'a puzzle box',
    'a rented drill',
    'a group chat argument',
    'a recipe card',
    'a guest list',
    'a fence repair',
    'a recording that clipped',
    'a late invoice',
    'a shared login',
    'a mural',
    'a visiting inspector',
    'a dent in the delivery van',
    'a scoreboard',
    'a sample batch',
    'a wrong postcode',
    'a trial subscription',
    'a stack of chairs',
    'a fridge alarm',
  ],
  moods: [
    'relaxed',
    'a bit rushed',
    'tired but friendly',
    'upbeat',
    'slightly tense',
    'distracted',
    'warm and chatty',
    'businesslike',
  ],
  ambiguity: [
    'nobody is clearly responsible for a task that has just come up',
    'two different days or times are mentioned for the same thing and nobody notices',
    'a number is said that does not match a number said earlier',
    'someone refers to "the other one" or "the usual place" and it is not clear which',
    'someone uses a term or nickname the listener may not know, without explaining it',
    'someone asks the listener a question and the conversation moves on before it is answered',
    'a decision sounds made, but nobody actually confirms it',
  ],
  resolved: [
    'a question asked and answered by someone within the next two turns',
    'a worry raised and then settled with a clear reason',
    'a speaker corrects their own mistake straight away',
  ],
  quiet: [
    'a stretch of small talk or a joke where nothing needs adding',
    'a routine update where everything is clear',
    'people agreeing on something that is already settled',
  ],
  drift: [
    'drifts onto a tangent and then comes back',
    'drifts onto something else and never returns',
    'switches abruptly after an interruption',
    'slides gradually from one subject to another',
  ],
  names: [
    'Maya',
    'Eli',
    'Nora',
    'Theo',
    'Priya',
    'Sam',
    'Jonah',
    'Lena',
    'Omar',
    'Ruth',
    'Felix',
    'Ada',
    'Kofi',
    'Ines',
    'Marco',
    'Hana',
    'Leo',
    'Zara',
    'Tomas',
    'Mina',
    'Dev',
    'Clara',
    'Ravi',
    'Greta',
    'Abel',
    'Iris',
    'Yusuf',
    'June',
    'Pablo',
    'Esme',
    'Arlo',
    'Nadia',
    'Hugo',
    'Talia',
    'Ben',
    'Freya',
    'Idris',
    'Lucy',
    'Mateo',
    'Wren',
  ],
  /** Preset English voices that ship with macOS and sound like people. */
  voices: [
    { name: 'Samantha', kind: 'feminine' },
    { name: 'Karen', kind: 'feminine' },
    { name: 'Moira', kind: 'feminine' },
    { name: 'Tessa', kind: 'feminine' },
    { name: 'Kathy', kind: 'feminine' },
    { name: 'Tara', kind: 'feminine' },
    { name: 'Daniel', kind: 'masculine' },
    { name: 'Fred', kind: 'masculine' },
    { name: 'Ralph', kind: 'masculine' },
    { name: 'Rishi', kind: 'masculine' },
    { name: 'Aman', kind: 'masculine' },
  ],
});

/** Draws one brief. The same seed always gives the same brief. */
export function sampleBrief(seed) {
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff)
    throw new Error('The seed must be a whole number from 0 to 4294967295.');
  const space = BRIEF_SPACE;
  const random = seededRandom(seed);
  const count = random.weighted([
    [2, 25],
    [3, 45],
    [4, 30],
  ]);
  const names = random.sample(space.names, count);
  const voices = random.sample(space.voices, count);
  const listener = names[random.int(0, count - 1)];
  const participants = names.map((name, i) => ({
    name,
    casting: {
      voice: voices[i].kind,
      age: random.pick(['20-29', '30-39', '40-49', '50-59']),
      portrait: 'Fictional person in a plain head-and-shoulders webcam frame.',
    },
  }));
  const render = Object.fromEntries(
    names.map((name, i) => [
      name,
      { voice: voices[i].name, rateWpm: random.int(172, 198) },
    ]),
  );
  const titleMode = random.weighted([
    ['none', 35],
    ['on-topic', 30],
    ['drifted', 35],
  ]);
  const sparks = {
    group: random.pick(space.groups),
    callKind: random.pick(space.callKinds),
    objects: random.sample(space.objects, 2),
    mood: random.pick(space.moods),
  };
  const structure = {
    topicChanges: random.int(1, 3),
    drift: random.pick(space.drift),
    ambiguity: random.pick(space.ambiguity),
    resolved: random.pick(space.resolved),
    quiet: random.pick(space.quiet),
    listenerTalks: random.pick(['rarely', 'sometimes', 'a fair amount']),
  };
  const shape = {
    minLines: 16,
    maxLines: 28,
    minWords: 200,
    maxWords: 270,
    maxWordsPerLine: 32,
  };
  const core = {
    participants,
    listener,
    titleMode,
    sparks,
    structure,
    shape,
  };
  const briefId =
    'b' +
    createHash('sha256')
      .update(JSON.stringify(core))
      .digest('hex')
      .slice(0, 12);
  return {
    schema: BRIEF_SCHEMA,
    fictional: true,
    seed,
    briefId,
    ...core,
    render,
  };
}

/** Gap before a turn, by its beat, in milliseconds. */
export const BEAT_GAPS_MS = Object.freeze({
  quick: [120, 320],
  normal: [380, 1050],
  pause: [1300, 2600],
});
const SAME_SPEAKER_MIN_GAP_MS = 450;
const GAP_SCALE = [0.6, 2.2];
const MIN_GAP_MS = 100;

/**
 * Places lines on one timeline: a lead-in, each line's speech, a gap drawn
 * from its beat, and a tail. Gaps are scaled together so the total lands
 * inside the window; if that needs scaling outside 0.6-2.2, the schedule is
 * refused, never squeezed. Lines never overlap.
 *
 * lines: [{ speaker, beat, speechMs }]
 */
export function scheduleLines({
  seed,
  lines,
  minMs = DEFAULT_WINDOW.minMs,
  maxMs = DEFAULT_WINDOW.maxMs,
  sampleRate = SAMPLE_RATE,
}) {
  if (
    !Array.isArray(lines) ||
    lines.length < 2 ||
    lines.some(
      (line) =>
        !BEATS.includes(line.beat) ||
        typeof line.speaker !== 'string' ||
        !(line.speechMs > 0),
    )
  )
    throw new Error('Each line needs a speaker, a beat and its speech length.');
  if (!(minMs >= 60_000 && maxMs <= 120_000 && maxMs - minMs >= 8_000))
    throw new Error('The window must lie within 60-120 s and span 8 s.');
  const random = seededRandom((seed ^ 0x5eed) >>> 0);
  const speechMs = lines.reduce((sum, line) => sum + line.speechMs, 0);
  const leadInMs = Math.round(random.between(1200, 2000));
  const tailMs = Math.round(random.between(1500, 2500));
  const gaps = lines.map((line, i) => {
    if (i === 0) return 0;
    const [lo, hi] = BEAT_GAPS_MS[line.beat];
    const gap = random.between(lo, hi);
    return Math.round(
      line.speaker === lines[i - 1].speaker
        ? Math.max(gap, SAME_SPEAKER_MIN_GAP_MS)
        : gap,
    );
  });
  const gapMs = gaps.reduce((a, b) => a + b, 0);
  const naturalMs = speechMs + gapMs + leadInMs + tailMs;
  const targetMs = Math.min(Math.max(naturalMs, minMs + 1500), maxMs - 1500);
  const gapScale = (targetMs - speechMs - leadInMs - tailMs) / gapMs;
  if (!(gapScale >= GAP_SCALE[0] && gapScale <= GAP_SCALE[1]))
    return {
      ok: false,
      reason: gapScale < GAP_SCALE[0] ? 'too-long' : 'too-short',
      speechMs,
      naturalMs,
    };
  let at = leadInMs;
  const rows = lines.map((line, i) => {
    const gapBeforeMs = i
      ? Math.max(MIN_GAP_MS, Math.round(gaps[i] * gapScale))
      : leadInMs;
    if (i) at += gapBeforeMs;
    const startMs = at;
    at += line.speechMs;
    return {
      lineId: `l${i + 1}`,
      speaker: line.speaker,
      beat: line.beat,
      gapBeforeMs,
      startMs: Math.round(startMs),
      endMs: Math.round(at),
      startSample: Math.round((startMs / 1000) * sampleRate),
    };
  });
  return {
    ok: true,
    rows,
    totalMs: Math.round(at + tailMs),
    speechMs: Math.round(speechMs),
    gapScale: Number(gapScale.toFixed(3)),
    leadInMs,
    tailMs,
  };
}

const ONSET_THRESHOLD = 0.004;
function levelDb(pcm, from, to) {
  const lo = Math.max(0, from);
  const hi = Math.min(pcm.length, to);
  let sum = 0;
  for (let i = lo; i < hi; i++) sum += pcm[i] * pcm[i];
  return 10 * Math.log10(sum / Math.max(1, hi - lo) + 1e-20);
}

/**
 * Checks a decoded track against the mix that was meant, line by line:
 * each line is present at its level (within 2 dB) and starts on time
 * (within 60 ms); every gap of 240 ms or more is silent inside (at most
 * -55 dBFS); the container and audio track agree within 100 ms; and the
 * length is inside the window. Mono float PCM at sampleRate.
 */
export function verifyMix({
  expected,
  decoded,
  rows,
  probe,
  window = DEFAULT_WINDOW,
  sampleRate = SAMPLE_RATE,
  videoSize = { width: 1280, height: 800 },
}) {
  const at = (ms) => Math.round((ms / 1000) * sampleRate);
  const lines = rows.map((row) => {
    const from = at(row.startMs);
    const to = at(row.endMs);
    const level = levelDb(decoded, from, to);
    let onset = Math.max(0, from - at(100));
    while (onset < to && Math.abs(decoded[onset]) < ONSET_THRESHOLD) onset++;
    return {
      lineId: row.lineId,
      levelDb: Number(level.toFixed(1)),
      levelChangeDb: Number((level - levelDb(expected, from, to)).toFixed(2)),
      onsetErrorMs: Math.round(((onset - from) / sampleRate) * 1000),
    };
  });
  const gaps = rows.slice(1).map((row, i) => {
    const gapMs = row.startMs - rows[i].endMs;
    return {
      before: row.lineId,
      gapMs,
      interiorDb:
        gapMs >= 240
          ? Number(
              levelDb(
                decoded,
                at(rows[i].endMs + 60),
                at(row.startMs - 60),
              ).toFixed(1),
            )
          : null,
    };
  });
  const failures = [];
  const { video, audio } = probe;
  if (!(
    video?.codec === 'h264' &&
    video.width === videoSize.width &&
    video.height === videoSize.height
  ))
    failures.push('video stream');
  if (!(audio?.codec === 'aac' && audio.sampleRate === sampleRate))
    failures.push('audio stream');
  if (probe.durationMs < window.minMs || probe.durationMs > window.maxMs)
    failures.push('duration outside the window');
  if (Math.abs(probe.durationMs - probe.audioDurationMs) > 100)
    failures.push('audio and container lengths differ');
  for (const line of lines)
    if (
      line.levelDb < -40 ||
      Math.abs(line.levelChangeDb) > 2 ||
      Math.abs(line.onsetErrorMs) > 60
    )
      failures.push(`line ${line.lineId}`);
  for (const gap of gaps)
    if (gap.gapMs <= 0) failures.push(`overlap before ${gap.before}`);
    else if (gap.interiorDb !== null && gap.interiorDb > -55)
      failures.push(`sound in the gap before ${gap.before}`);
  return { passed: failures.length === 0, failures, lines, gaps };
}

const HEX64 = /^[0-9a-f]{64}$/;

/** The manifest a lab run is given with fresh media. Only the media is a
 * runtime input; the title, brief and conversation are not. */
export function buildManifest({
  scenarioId,
  brief,
  title,
  generation,
  media,
  window = DEFAULT_WINDOW,
  schedule,
  verification,
  files,
}) {
  const gaps = schedule.rows.slice(1).map((row) => row.gapBeforeMs);
  const sorted = [...gaps].sort((a, b) => a - b);
  return validateManifest({
    schema: MANIFEST_SCHEMA,
    fictional: true,
    simulated: true,
    labels: ['Simulated meeting', 'Fictional', 'Synthetic voices'],
    scenarioId,
    seed: brief.seed,
    briefId: brief.briefId,
    titleMode: brief.titleMode,
    title,
    generation,
    media,
    window: {
      ...window,
      labCapMs: LAB_MEDIA_CAP_MS,
      withinCurrentLabCap: media.durationMs <= LAB_MEDIA_CAP_MS,
    },
    pacing: {
      lines: schedule.rows.length,
      speechMs: schedule.speechMs,
      gapScale: schedule.gapScale,
      leadInMs: schedule.leadInMs,
      tailMs: schedule.tailMs,
      gapMinMs: sorted[0],
      gapMedianMs: sorted[sorted.length >> 1],
      gapMaxMs: sorted.at(-1),
      overlaps: 0,
    },
    schedule: schedule.rows.map(({ startSample: _, ...row }) => row),
    verification: { passed: verification.passed },
    files,
    runtimeInputs: 'media-only',
  });
}

/** Refuses a manifest that is not complete and self-consistent. */
export function validateManifest(manifest) {
  const m = manifest;
  const fail = (what) => {
    throw new Error(`The scenario manifest is not usable: ${what}.`);
  };
  if (m?.schema !== MANIFEST_SCHEMA) fail('wrong schema');
  if (m.fictional !== true || m.simulated !== true) fail('not fictional');
  if (!/^[a-z0-9][a-z0-9-]{2,79}$/i.test(m.scenarioId ?? ''))
    fail('scenario id');
  if (!Number.isSafeInteger(m.seed) || m.seed < 0 || m.seed > 0xffffffff)
    fail('seed');
  if (!/^b[0-9a-f]{12}$/.test(m.briefId ?? '')) fail('brief id');
  if (!TITLE_MODES.includes(m.titleMode)) fail('title mode');
  if (
    m.titleMode === 'none'
      ? m.title !== null
      : typeof m.title !== 'string' || !m.title.trim() || m.title.length > 80
  )
    fail('title does not match its mode');
  if (
    !['offline-stand-in', 'codex-subscription'].includes(m.generation?.route) ||
    !Number.isSafeInteger(m.generation.dispatches) ||
    m.generation.dispatches < 0 ||
    m.generation.dispatches > 1 ||
    typeof m.generation.inference !== 'boolean'
  )
    fail('generation');
  const media = m.media ?? {};
  if (!isAbsolute(media.path ?? '') || !/\.mp4$/.test(media.path))
    fail('media path');
  if (!HEX64.test(media.sha256 ?? '')) fail('media sha256');
  if (!(media.bytes > 0)) fail('media size');
  const { minMs, maxMs } = m.window ?? {};
  if (!(minMs >= 60_000 && maxMs <= 120_000 && maxMs - minMs >= 8_000))
    fail('window');
  if (!(media.durationMs >= minMs && media.durationMs <= maxMs))
    fail('duration outside the window');
  if (!(Math.abs(media.durationMs - media.audioDurationMs) <= 100))
    fail('audio and container lengths differ');
  if (
    m.window.labCapMs !== LAB_MEDIA_CAP_MS ||
    m.window.withinCurrentLabCap !== media.durationMs <= LAB_MEDIA_CAP_MS
  )
    fail('lab cap');
  const rows = m.schedule;
  if (!Array.isArray(rows) || rows.length < 2) fail('schedule');
  rows.forEach((row, i) => {
    if (
      row.lineId !== `l${i + 1}` ||
      typeof row.speaker !== 'string' ||
      !BEATS.includes(row.beat) ||
      !(row.startMs >= 0 && row.endMs > row.startMs) ||
      row.endMs > media.durationMs ||
      (i > 0 && row.startMs <= rows[i - 1].endMs)
    )
      fail(`schedule row ${i + 1}`);
  });
  if (m.verification?.passed !== true) fail('verification did not pass');
  if (
    !m.files ||
    !Object.values(m.files).length ||
    Object.values(m.files).some((hash) => !HEX64.test(hash))
  )
    fail('file hashes');
  if (m.runtimeInputs !== 'media-only') fail('runtime inputs');
  return Object.freeze(structuredClone(m));
}

/** True when a text names a common real company or product. */
export function namesRealBrand(text) {
  return DENY_LIST.some((name) =>
    new RegExp(`(^|[^A-Za-z])${name}([^A-Za-z]|$)`).test(text),
  );
}
