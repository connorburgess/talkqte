// Builds one sound track for a recording, offline, from one clip per line,
// and checks the finished file against the clips it was made from. Every
// clip is resampled to one rate and placed at an exact sample offset; none
// is cut, stretched or moved. Nothing here needs a network or an account.
import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { promisify } from 'node:util';

const run = promisify(execFile);
export const SAMPLE_RATE = 48_000;
const FADE_MS = 12; // Softens the first and last few milliseconds of a clip.
const ROOM_TONE = 260; // Scales the noise to about -66 dB, far below speech.
const samples = (ms) => Math.round((ms / 1000) * SAMPLE_RATE);

/** Any audio file as mono 16-bit samples at the track's rate. */
export async function decode(file) {
  const { stdout } = await run(
    'ffmpeg',
    [
      '-v',
      'error',
      '-i',
      file,
      '-vn',
      '-f',
      's16le',
      '-ac',
      '1',
      '-ar',
      String(SAMPLE_RATE),
      'pipe:1',
    ],
    { encoding: 'buffer', maxBuffer: 512 * 1024 * 1024 },
  );
  return new Int16Array(
    stdout.buffer,
    stdout.byteOffset,
    Math.floor(stdout.byteLength / 2),
  );
}

/** Writes a WAV file with every clip at its own start, after `offsetMs` of
 * silence. Returns each clip's place in the track, in samples. */
export async function buildTrack(clips, offsetMs, file, { totalMs = 0 } = {}) {
  const placed = [];
  for (const clip of clips) {
    const data = await decode(clip.file);
    placed.push({
      lineId: clip.lineId,
      data,
      start: samples(offsetMs + clip.startMs),
    });
  }
  const length = Math.max(
    samples(totalMs),
    Math.max(...placed.map((clip) => clip.start + clip.data.length)) +
      samples(300),
  );
  const mix = new Float32Array(length);
  // A faint, steady room tone under the whole track. Without it the track
  // falls to digital silence between speakers and each line seems to cut
  // in and out. It is the same quiet noise throughout, far below speech.
  let seed = 0x2f6e2b1;
  let low = 0;
  for (let i = 0; i < length; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    low += 0.02 * ((seed / 0xffffffff) * 2 - 1 - low);
    mix[i] = low * ROOM_TONE;
  }
  const fade = samples(FADE_MS);
  for (const { data, start } of placed)
    for (let i = 0; i < data.length; i++) {
      const edge = Math.min(i, data.length - 1 - i);
      mix[start + i] += data[i] * (edge < fade ? edge / fade : 1);
    }
  const pcm = Buffer.alloc(length * 2);
  for (let i = 0; i < length; i++)
    pcm.writeInt16LE(
      Math.max(-32768, Math.min(32767, Math.round(mix[i]))),
      i * 2,
    );
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  writeFileSync(file, Buffer.concat([header, pcm]));
  return placed.map(({ lineId, data, start }) => ({
    lineId,
    start,
    length: data.length,
    data,
  }));
}

const rms = (data, from, to) => {
  let sum = 0;
  const a = Math.max(0, from);
  const b = Math.min(data.length, to);
  for (let i = a; i < b; i++) sum += data[i] * data[i];
  return b > a ? Math.sqrt(sum / (b - a)) : 0;
};
const decibels = (value) =>
  value > 0 ? Math.round(20 * Math.log10(value / 32768) * 10) / 10 : -120;

/** Measures the finished file against the clips, since nobody can listen
 * to it here. For each clip, in 50-millisecond steps, the level of the
 * file is compared with the level of the clip at the same place: a step
 * where the clip has speech and the file is near silent is a dropout, and
 * the last 150 ms must still be there. Between clips the file must be
 * quiet, which it is not if two clips overlap. */
export async function checkTrack(file, placed) {
  const track = await decode(file);
  const step = samples(50);
  let dropouts = 0;
  let steps = 0;
  let cutShort = 0;
  let worstLevelDb = 0;
  for (const clip of placed) {
    for (let i = 0; i + step <= clip.length; i += step) {
      const source = rms(clip.data, i, i + step);
      if (source < 300) continue; // A pause inside the clip itself.
      steps++;
      const heard = rms(track, clip.start + i, clip.start + i + step);
      if (heard < source * 0.25) dropouts++;
    }
    const tail = samples(150);
    const sourceTail = rms(clip.data, clip.length - tail, clip.length);
    const heardTail = rms(
      track,
      clip.start + clip.length - tail,
      clip.start + clip.length,
    );
    if (sourceTail > 100 && heardTail < sourceTail * 0.25) cutShort++;
    const whole =
      decibels(rms(track, clip.start, clip.start + clip.length)) -
      decibels(rms(clip.data, 0, clip.length));
    if (Math.abs(whole) > Math.abs(worstLevelDb)) worstLevelDb = whole;
  }
  const ordered = [...placed].sort((a, b) => a.start - b.start);
  let overlaps = 0;
  let noisyGaps = 0;
  let gaps = 0;
  for (let i = 1; i < ordered.length; i++) {
    const end = ordered[i - 1].start + ordered[i - 1].length;
    const gap = ordered[i].start - end;
    if (gap < 0) overlaps++;
    else if (gap > samples(120)) {
      gaps++;
      const middle = end + Math.floor(gap / 2);
      // More than the room tone means speech where there should be none.
      if (rms(track, middle - samples(20), middle + samples(20)) > 80)
        noisyGaps++;
    }
  }
  return {
    method:
      'The finished file was decoded and compared with each clip at its place, in 50 ms steps: speech missing from the file, endings missing, level change, overlaps between clips, and sound in the gaps between them.',
    sampleRate: SAMPLE_RATE,
    clips: placed.length,
    stepsCompared: steps,
    dropouts,
    clipsCutShort: cutShort,
    overlaps,
    gapsChecked: gaps,
    gapsWithSound: noisyGaps,
    largestLevelChangeDb: Math.round(worstLevelDb * 10) / 10,
    levelDb: decibels(rms(track, 0, track.length)),
    passed: !dropouts && !cutShort && !overlaps && !noisyGaps,
  };
}
