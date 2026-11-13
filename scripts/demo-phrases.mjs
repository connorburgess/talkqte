// Re-times the fictional demo's phrases from the bundled synthetic speech.
//
//   node scripts/demo-phrases.mjs          rewrite src/demo-phrases.json
//   node scripts/demo-phrases.mjs --check  fail if the file would change
//
// The phrase wording in src/demo-phrases.json is authored by hand. This script
// only replaces each phrase's startMs, endMs, boundary and pauseMs. It needs
// ffmpeg on PATH, runs no speech recognition, and reads nothing but the
// bundled clip and the fictional script.
//
// Method: ffmpeg's silencedetect filter lists every stretch quieter than
// NOISE_DB lasting at least MIN_PAUSE_S. Each turn's speech runs from the end
// of the silence before it to the start of the silence after it. Inside a
// turn, each authored phrase break is matched to one detected pause, choosing
// the in-order pairing closest to where the break would fall if speech moved
// at an even pace per letter. A break with no pause to match is placed at
// that even-pace estimate and marked "estimated".
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const NOISE_DB = -35;
const MIN_PAUSE_S = 0.12;
/** How far a turn's recorded start or end may sit from a silence edge. */
const EDGE_SLACK_MS = 150;

const path = (relative) => fileURLToPath(new URL(relative, import.meta.url));
const read = (relative) => JSON.parse(readFileSync(path(relative), 'utf8'));

export function parseSilences(log) {
  const silences = [];
  let start = null;
  for (const line of log.split('\n')) {
    const began = line.match(/silence_start: (-?[\d.]+)/);
    const ended = line.match(/silence_end: (-?[\d.]+)/);
    if (began) start = Math.max(0, Math.round(Number(began[1]) * 1000));
    if (ended && start !== null) {
      silences.push({ startMs: start, endMs: Math.round(ended[1] * 1000) });
      start = null;
    }
  }
  return silences;
}

const letters = (text) => text.replace(/[^\p{L}\p{N}]/gu, '').length;

/** Picks `count` of `pauses`, in order, nearest to the `estimates`. */
function matchPauses(estimates, pauses) {
  const count = estimates.length;
  if (pauses.length < count) return null;
  let best = null;
  const walk = (from, chosen, cost) => {
    if (best && cost >= best.cost) return;
    if (chosen.length === count) {
      best = { cost, chosen };
      return;
    }
    const remaining = count - chosen.length;
    for (let i = from; i <= pauses.length - remaining; i++)
      walk(
        i + 1,
        [...chosen, pauses[i]],
        cost + Math.abs(pauses[i].startMs - estimates[chosen.length]),
      );
  };
  walk(0, [], 0);
  return best.chosen;
}

/** Times one turn's phrases inside its speech, given the clip's silences. */
export function timeTurn(texts, voice, silences) {
  const before = silences.find(
    (s) =>
      s.startMs <= voice.startMs + EDGE_SLACK_MS &&
      s.endMs >= voice.startMs - EDGE_SLACK_MS,
  );
  const after = silences.find(
    (s) =>
      s.startMs <= voice.endMs + EDGE_SLACK_MS &&
      s.endMs >= voice.endMs - EDGE_SLACK_MS,
  );
  const startMs = before ? before.endMs : voice.startMs;
  const endMs = after ? after.startMs : voice.endMs;
  const pauses = silences.filter((s) => s.startMs > startMs && s.endMs < endMs);
  // Where each break would fall at an even pace per letter of voiced time.
  const voicedMs =
    endMs - startMs - pauses.reduce((sum, p) => sum + p.endMs - p.startMs, 0);
  const total = texts.reduce((sum, text) => sum + letters(text), 0);
  const toClock = (voiced) => {
    let clock = startMs + voiced;
    for (const p of pauses) if (p.startMs < clock) clock += p.endMs - p.startMs;
    return clock;
  };
  let spoken = 0;
  const estimates = texts.slice(0, -1).map((text) => {
    spoken += letters(text);
    return Math.round(toClock((voicedMs * spoken) / total));
  });
  const matched = matchPauses(estimates, pauses);
  const timed = [];
  let cursor = startMs;
  texts.forEach((text, i) => {
    const last = i === texts.length - 1;
    const pause = last ? null : matched?.[i];
    const end = last ? endMs : pause ? pause.startMs : estimates[i];
    timed.push({
      text,
      startMs: cursor,
      endMs: end,
      boundary: last ? 'turn' : pause ? 'pause' : 'estimated',
      pauseMs: last
        ? after
          ? after.endMs - after.startMs
          : 0
        : pause
          ? pause.endMs - pause.startMs
          : 0,
      ...(last || !pause ? {} : { estimateOffMs: end - estimates[i] }),
    });
    cursor = last ? end : pause ? pause.endMs : estimates[i];
  });
  return timed;
}

export function retime(phrases, demo, voices, silences) {
  const out = [];
  for (const segment of demo.segments) {
    const mine = phrases.filter((p) => p.segmentId === segment.id);
    if (mine.map((p) => p.text).join(' ') !== segment.text)
      throw new Error(`Phrases of ${segment.id} do not spell out its line.`);
    const voice = voices.segments.find((v) => v.id === segment.id);
    if (!voice) throw new Error(`No recorded voice timing for ${segment.id}.`);
    const timed = timeTurn(
      mine.map((p) => p.text),
      voice,
      silences,
    );
    mine.forEach((phrase, i) =>
      out.push({ id: phrase.id, segmentId: phrase.segmentId, ...timed[i] }),
    );
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = '../src/demo-phrases.json';
  const data = read(file);
  // silencedetect reports on stderr.
  const run = spawnSync(
    'ffmpeg',
    [
      '-hide_banner',
      '-nostats',
      '-i',
      path(`../${data.audio}`),
      '-af',
      `silencedetect=noise=${NOISE_DB}dB:d=${MIN_PAUSE_S}`,
      '-f',
      'null',
      '-',
    ],
    { encoding: 'utf8' },
  );
  if (run.error || run.status !== 0) {
    console.error(
      run.error?.code === 'ENOENT'
        ? 'ffmpeg is needed to re-time the demo phrases.'
        : `ffmpeg could not read the clip: ${run.error ?? run.stderr}`,
    );
    process.exit(2);
  }
  const log = run.stderr;
  const phrases = retime(
    data.phrases,
    read('../src/demo.json'),
    read('../src/demo-voices.json'),
    parseSilences(log),
  );
  const next = `${JSON.stringify({ ...data, phrases }, null, 2)}\n`;
  if (process.argv.includes('--check')) {
    if (next !== readFileSync(path(file), 'utf8')) {
      console.error(
        'src/demo-phrases.json does not match the bundled speech. Run node scripts/demo-phrases.mjs.',
      );
      process.exit(1);
    }
    console.log(`${phrases.length} phrases match the bundled speech.`);
  } else {
    writeFileSync(path(file), next);
    console.log(`Re-timed ${phrases.length} phrases.`);
  }
}
