// Offline checks for fresh fictional scenarios: briefs, pacing, the mix
// check and the manifest. Tones stand in for speech; nothing is spoken,
// encoded or sent.
import assert from 'node:assert/strict';
import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { isLabMedia, loadLabMediaManifest } from './cue-lab-media.mjs';
import { fictionalTestMedia } from './fixtures/lab-test-media.mjs';
import { test } from 'node:test';
import { DENY_LIST } from './cue-dialogue-briefs.mjs';
import { VOICE_KINDS } from './lab-playable.mjs';
import {
  BRIEF_SPACE,
  LAB_MEDIA_CAP_MS,
  SAMPLE_RATE,
  buildManifest,
  contentProblems,
  generatedContentProblems,
  namesRealBrand,
  sampleBrief,
  scheduleLines,
  validateManifest,
  verifyMix,
} from './lab-fresh-scenario.mjs';

const standIn = JSON.parse(
  readFileSync(
    new URL('./fixtures/lab-fresh-scenario-standin.json', import.meta.url),
    'utf8',
  ),
);
const SEEDS = Array.from({ length: 400 }, (_, i) => i);

// About 330 ms a word plus a breath, like a preset voice near 185 wpm.
function standInLines(names) {
  return standIn.lines.map((line) => ({
    speaker: names[line.speaker],
    beat: line.beat,
    speechMs: line.text.split(/\s+/).length * 330 + 250,
  }));
}

test('the same seed gives the same brief, and seeds give different meetings', () => {
  assert.deepEqual(sampleBrief(7), sampleBrief(7));
  const ids = new Set(SEEDS.map((seed) => sampleBrief(seed).briefId));
  assert.ok(ids.size >= SEEDS.length - 2, `only ${ids.size} distinct briefs`);
  const groups = new Set(SEEDS.map((seed) => sampleBrief(seed).sparks.group));
  assert.ok(groups.size >= 40, `only ${groups.size} different groups`);
  assert.throws(() => sampleBrief(-1));
  assert.throws(() => sampleBrief(2 ** 32));
  assert.throws(() => sampleBrief(1.5));
});

test('briefs vary speakers, topic changes and whether there is a title', () => {
  const briefs = SEEDS.map(sampleBrief);
  assert.deepEqual(
    [...new Set(briefs.map((b) => b.participants.length))].sort(),
    [2, 3, 4],
  );
  assert.deepEqual(
    [...new Set(briefs.map((b) => b.structure.topicChanges))].sort(),
    [1, 2, 3],
  );
  assert.deepEqual([...new Set(briefs.map((b) => b.titleMode))].sort(), [
    'drifted',
    'none',
    'on-topic',
  ]);
  for (const brief of briefs) {
    // A brief never carries a title or an agenda, only whether to have one.
    assert.equal('title' in brief, false);
    assert.equal('agenda' in brief, false);
    const names = brief.participants.map((p) => p.name);
    assert.equal(new Set(names).size, names.length);
    assert.ok(names.includes(brief.listener));
    const voices = names.map((name) => brief.render[name].voice);
    assert.equal(new Set(voices).size, voices.length);
    for (const person of brief.participants)
      assert.ok(VOICE_KINDS.includes(person.casting.voice));
    assert.notEqual(brief.sparks.objects[0], brief.sparks.objects[1]);
  }
});

test('the brief space names no real company or product', () => {
  const text = JSON.stringify(BRIEF_SPACE);
  assert.equal(namesRealBrand(text), false);
  assert.equal(namesRealBrand('We moved the call to Zoom.'), true);
  assert.ok(DENY_LIST.length > 10);
});

test('a schedule fits the window with call-like gaps and no overlap', () => {
  const names = sampleBrief(6).participants.map((p) => p.name);
  const plan = scheduleLines({ seed: 6, lines: standInLines(names) });
  assert.equal(plan.ok, true);
  assert.ok(plan.totalMs >= 90_000 && plan.totalMs <= 104_000, plan.totalMs);
  plan.rows.forEach((row, i) => {
    assert.ok(row.endMs > row.startMs);
    if (i) {
      assert.ok(
        row.startMs > plan.rows[i - 1].endMs,
        `overlap at ${row.lineId}`,
      );
      assert.equal(row.startMs - plan.rows[i - 1].endMs, row.gapBeforeMs);
    }
  });
  const median = (beat) => {
    const gaps = plan.rows
      .slice(1)
      .filter((row) => row.beat === beat)
      .map((row) => row.gapBeforeMs)
      .sort((a, b) => a - b);
    return gaps[gaps.length >> 1];
  };
  assert.ok(median('quick') < median('normal'));
  assert.ok(median('normal') < median('pause'));
  // Not the old fixed spacing: gaps differ from each other.
  assert.ok(new Set(plan.rows.map((row) => row.gapBeforeMs)).size > 15);
  assert.deepEqual(
    scheduleLines({ seed: 6, lines: standInLines(names) }),
    plan,
  );
});

test('speech that cannot fit is refused rather than squeezed or padded', () => {
  const names = ['A', 'B', 'C'];
  const long = standInLines(names).map((l) => ({
    ...l,
    speechMs: l.speechMs * 1.6,
  }));
  assert.deepEqual(
    { ...scheduleLines({ seed: 1, lines: long }), speechMs: 0, naturalMs: 0 },
    { ok: false, reason: 'too-long', speechMs: 0, naturalMs: 0 },
  );
  const short = standInLines(names).map((l) => ({
    ...l,
    speechMs: l.speechMs * 0.5,
  }));
  assert.equal(scheduleLines({ seed: 1, lines: short }).reason, 'too-short');
  assert.throws(() =>
    scheduleLines({
      seed: 1,
      lines: [{ speaker: 'A', beat: 'slow', speechMs: 1 }],
    }),
  );
  assert.throws(() =>
    scheduleLines({ seed: 1, lines: standInLines(names), maxMs: 130_000 }),
  );
});

// A tone for each line at its place, silence elsewhere.
function toneMix(rows, totalMs) {
  const pcm = new Float32Array(Math.round((totalMs / 1000) * SAMPLE_RATE));
  for (const row of rows) {
    const from = Math.round((row.startMs / 1000) * SAMPLE_RATE);
    const to = Math.round((row.endMs / 1000) * SAMPLE_RATE);
    for (let i = from; i < to; i++)
      pcm[i] = 0.2 * Math.sin((2 * Math.PI * 220 * (i - from)) / SAMPLE_RATE);
  }
  return pcm;
}

function scenario() {
  const brief = sampleBrief(6);
  const plan = scheduleLines({
    seed: 6,
    lines: standInLines(brief.participants.map((p) => p.name)),
  });
  const expected = toneMix(plan.rows, plan.totalMs);
  const probe = {
    durationMs: plan.totalMs,
    audioDurationMs: plan.totalMs - 19,
    video: { codec: 'h264', width: 1280, height: 800 },
    audio: { codec: 'aac', sampleRate: SAMPLE_RATE },
  };
  return { brief, plan, expected, probe };
}

test('a faithful track passes the mix check', () => {
  const { plan, expected, probe } = scenario();
  const result = verifyMix({
    expected,
    decoded: expected.slice(),
    rows: plan.rows,
    probe,
  });
  assert.deepEqual(result.failures, []);
  assert.ok(result.gaps.filter((gap) => gap.interiorDb !== null).length > 10);
});

test('the mix check finds sound in a gap, a missing line, a level change and a late line', () => {
  const { plan, expected, probe } = scenario();
  const rows = plan.rows;
  const at = (ms) => Math.round((ms / 1000) * SAMPLE_RATE);
  const check = (decoded, p = probe) =>
    verifyMix({ expected, decoded, rows, probe: p }).failures;

  const wide = rows.findIndex((row, i) => i && row.gapBeforeMs >= 400);
  const noisy = expected.slice();
  for (
    let i = at(rows[wide - 1].endMs + 80);
    // Stop short of the next line so only the gap, not its start, is wrong.
    i < at(rows[wide].startMs - 150);
    i++
  )
    noisy[i] = 0.01 * Math.sin(i);
  assert.deepEqual(check(noisy), [
    `sound in the gap before ${rows[wide].lineId}`,
  ]);

  const missing = expected.slice();
  missing.fill(0, at(rows[3].startMs), at(rows[3].endMs));
  assert.ok(check(missing).includes('line l4'));

  const quiet = expected.slice();
  for (let i = at(rows[5].startMs); i < at(rows[5].endMs); i++) quiet[i] *= 0.5;
  assert.deepEqual(check(quiet), ['line l6']);

  const late = expected.slice();
  const from = at(rows[8].startMs);
  late.fill(0, from, from + at(90));
  assert.deepEqual(check(late), ['line l9']);

  assert.deepEqual(
    check(expected.slice(), {
      ...probe,
      durationMs: 120_000,
      audioDurationMs: 120_000,
    }),
    ['duration outside the window'],
  );
  assert.deepEqual(
    check(expected.slice(), {
      ...probe,
      audioDurationMs: probe.durationMs - 400,
    }),
    ['audio and container lengths differ'],
  );
  assert.deepEqual(
    check(expected.slice(), {
      ...probe,
      audio: { codec: 'aac', sampleRate: 44_100 },
    }),
    ['audio stream'],
  );
});

function manifestFor({ brief, plan, probe }, overrides = {}) {
  return buildManifest({
    scenarioId: 'fs-test-s6',
    brief,
    title: brief.titleMode === 'none' ? null : 'Stall rota for Saturday',
    generation: { route: 'offline-stand-in', dispatches: 0, inference: false },
    media: {
      path: '/fictional/fresh-scenarios/fs-test-s6/fs-test-s6.mp4',
      sha256: 'a'.repeat(64),
      bytes: 1_290_419,
      durationMs: probe.durationMs,
      audioDurationMs: probe.audioDurationMs,
      video: { ...probe.video, fps: 25 },
      audio: { ...probe.audio, channels: 1 },
    },
    schedule: plan,
    verification: { passed: true },
    files: {
      'brief.json': 'b'.repeat(64),
      'conversation.json': 'c'.repeat(64),
    },
    ...overrides,
  });
}

test('a manifest describes the media only and records whether it fits the lab cap', () => {
  const s = scenario();
  const manifest = manifestFor(s);
  assert.equal(manifest.runtimeInputs, 'media-only');
  assert.equal(manifest.window.labCapMs, LAB_MEDIA_CAP_MS);
  assert.equal(manifest.window.withinCurrentLabCap, true);
  assert.equal(manifest.schedule.length, s.plan.rows.length);
  assert.equal('startSample' in manifest.schedule[0], false);
  assert.equal(manifest.pacing.overlaps, 0);
  assert.ok(Object.isFrozen(manifest));
  assert.deepEqual(
    validateManifest(JSON.parse(JSON.stringify(manifest))),
    manifest,
  );
});

test('a manifest with a title its mode forbids, bad media or a failed check is refused', () => {
  const s = scenario();
  const good = JSON.parse(JSON.stringify(manifestFor(s)));
  const refuse = (change, message) =>
    assert.throws(
      () => validateManifest(change(structuredClone(good))),
      message,
    );
  refuse((m) => ({ ...m, titleMode: 'none' }), /title does not match/);
  refuse(
    (m) => ({ ...m, titleMode: 'drifted', title: null }),
    /title does not match/,
  );
  refuse((m) => ({ ...m, fictional: false }), /not fictional/);
  refuse(
    (m) => ({ ...m, media: { ...m.media, sha256: 'xyz' } }),
    /media sha256/,
  );
  refuse(
    (m) => ({ ...m, media: { ...m.media, path: 'relative/file.mp4' } }),
    /media path/,
  );
  refuse(
    (m) => ({
      ...m,
      media: { ...m.media, durationMs: 80_000, audioDurationMs: 80_000 },
    }),
    /duration outside/,
  );
  refuse((m) => ({ ...m, verification: { passed: false } }), /verification/);
  refuse(
    (m) => ({ ...m, generation: { ...m.generation, dispatches: 2 } }),
    /generation/,
  );
  refuse((m) => ({ ...m, runtimeInputs: 'media-and-title' }), /runtime inputs/);
  refuse((m) => {
    m.schedule[4].startMs = m.schedule[3].endMs - 10;
    return m;
  }, /schedule row 5/);
  refuse(
    (m) => ({ ...m, window: { ...m.window, withinCurrentLabCap: false } }),
    /lab cap/,
  );
  refuse(
    (m) => {
      m.schedule.at(-1).endMs = m.media.durationMs + 1;
      return m;
    },
    new RegExp(`schedule row ${good.schedule.length}`),
  );
  refuse(
    (m) => ({ ...m, media: { ...m.media, bytes: 1_290_419.5 } }),
    /media size/,
  );
  refuse(
    (m) => ({
      ...m,
      media: { ...m.media, durationMs: m.media.durationMs + 0.4 },
    }),
    /whole milliseconds/,
  );
  refuse(
    (m) => ({
      ...m,
      media: { ...m.media, video: { ...m.media.video, codec: 'hevc' } },
    }),
    /video stream/,
  );
  refuse((m) => {
    delete m.media.video;
    return m;
  }, /video stream/);
  refuse(
    (m) => ({
      ...m,
      media: { ...m.media, audio: { ...m.media.audio, sampleRate: 44_100 } },
    }),
    /audio stream/,
  );
  refuse(
    (m) => ({
      ...m,
      media: { ...m.media, audio: { ...m.media.audio, sampleRate: '48000' } },
    }),
    /audio stream/,
  );
  refuse((m) => ({ ...m, title: 'Zoom rota check' }), /real brand or contact/);
  refuse(
    (m) => ({ ...m, title: 'Call ana@example.test back' }),
    /real brand or contact/,
  );
});

test('a manifest carries the verified streams in the shape the lab loader reads', () => {
  const s = scenario();
  const manifest = manifestFor(s, {
    media: {
      path: '/fictional/fresh-scenarios/fs-test-s6/fs-test-s6.mp4',
      sha256: 'a'.repeat(64),
      bytes: 1_290_419.4,
      durationMs: s.probe.durationMs + 0.4,
      audioDurationMs: s.probe.audioDurationMs - 0.3,
      video: { codec: 'h264', width: 1280, height: 800, fps: 25 },
      audio: { codec: 'aac', sampleRate: 48_000, channels: 1 },
    },
  });
  // Whole numbers, as the loader requires, rounded rather than refused.
  assert.equal(manifest.media.bytes, 1_290_419);
  assert.ok(Number.isSafeInteger(manifest.media.durationMs));
  assert.ok(Number.isSafeInteger(manifest.media.audioDurationMs));
  assert.equal(manifest.media.video.codec, 'h264');
  assert.equal(manifest.media.audio.codec, 'aac');
  assert.equal(manifest.media.audio.sampleRate, 48_000);
});

test('media longer than the lab cap is described as not fitting it', () => {
  const s = scenario();
  assert.equal(LAB_MEDIA_CAP_MS, 104_000);
  const lengths = s.plan.rows.map((row) => row.endMs);
  assert.ok(Math.max(...lengths) < 104_000);
  const manifest = manifestFor(s, {
    window: { minMs: 90_000, maxMs: 110_000 },
    media: {
      path: '/fictional/fresh-scenarios/fs-test-s6/fs-test-s6.mp4',
      sha256: 'a'.repeat(64),
      bytes: 1_400_000,
      durationMs: 104_001,
      audioDurationMs: 104_000,
      video: { codec: 'h264', width: 1280, height: 800, fps: 25 },
      audio: { codec: 'aac', sampleRate: 48_000, channels: 1 },
    },
  });
  assert.equal(manifest.window.withinCurrentLabCap, false);
});

test('generated text naming a real brand or contact detail is found, line by line', () => {
  assert.deepEqual(contentProblems('Saturday at seven, then.'), []);
  assert.deepEqual(contentProblems('Ping me on Slack.'), ['real-brand']);
  assert.deepEqual(contentProblems('Call 555-201-3344 first.'), [
    'contact-detail',
  ]);
  // A brand inside a longer word is not a match.
  assert.deepEqual(contentProblems('A metal sign.'), []);
  assert.deepEqual(
    generatedContentProblems({
      title: null,
      lines: [
        { text: 'Okay, everyone here?' },
        { text: 'It is on www.example.test now.' },
        { text: 'Put it in Dropbox.' },
      ],
    }),
    [
      { where: 'l2', problem: 'contact-detail' },
      { where: 'l3', problem: 'real-brand' },
    ],
  );
  assert.deepEqual(
    generatedContentProblems({ title: 'Google sync', lines: [] }),
    [{ where: 'title', problem: 'real-brand' }],
  );
  // List entries are matched literally, never as patterns.
  assert.equal(namesRealBrand('We write C++ daily.', ['C++']), true);
  assert.equal(namesRealBrand('We write C daily.', ['C++']), false);
});

test('a manifest may record the text route, voice renderer and voices, never a credential', () => {
  const s = scenario();
  const speakers = [...new Set(s.plan.rows.map((row) => row.speaker))];
  const renderer = {
    engine: 'deepgram',
    model: 'aura-2',
    requests: 22,
    billedChars: 1093,
    costUsd: 0.0328,
    query: {
      encoding: 'linear16',
      container: 'wav',
      sample_rate: '48000',
      mip_opt_out: 'true',
    },
  };
  const voices = Object.fromEntries(
    speakers.map((name, i) => [name, { voice: `aura-2-voice${i}-en` }]),
  );
  const manifest = manifestFor(s, {
    generation: {
      route: 'anthropic-api',
      model: 'claude-opus-5-5',
      dispatches: 1,
      inference: true,
      costUsd: 0.0628,
    },
    renderer,
    voices,
  });
  assert.equal(manifest.generation.route, 'anthropic-api');
  assert.deepEqual(manifest.renderer, renderer);
  assert.deepEqual(manifest.voices, voices);
  // Both blocks stay optional.
  assert.equal('renderer' in manifestFor(s), false);

  const good = JSON.parse(JSON.stringify(manifest));
  const refuse = (change, message) =>
    assert.throws(
      () => validateManifest(change(structuredClone(good))),
      message,
    );
  refuse(
    (m) => ({ ...m, generation: { ...m.generation, route: 'other-api' } }),
    /generation/,
  );
  refuse(
    (m) => ({ ...m, generation: { ...m.generation, costUsd: -1 } }),
    /generation/,
  );
  refuse(
    (m) => ({ ...m, generation: { ...m.generation, apiKey: 'x' } }),
    /generation/,
  );
  refuse(
    (m) => ({ ...m, renderer: { ...m.renderer, engine: 'other' } }),
    /renderer engine/,
  );
  for (const field of ['key', 'apiKey', 'authorization', 'token', 'secret'])
    refuse(
      (m) => ({ ...m, renderer: { ...m.renderer, [field]: 'x' } }),
      /renderer credential-like field/,
    );
  refuse(
    (m) => ({
      ...m,
      renderer: { ...m.renderer, query: { ...m.renderer.query, token: 'x' } },
    }),
    /renderer credential-like field/,
  );
  refuse(
    (m) => ({
      ...m,
      renderer: {
        ...m.renderer,
        query: { ...m.renderer.query, callback: 'x' },
      },
    }),
    /renderer query/,
  );
  refuse(
    (m) => ({
      ...m,
      renderer: {
        ...m.renderer,
        query: { ...m.renderer.query, model: 'a b/c' },
      },
    }),
    /renderer query/,
  );
  refuse(
    (m) => ({ ...m, voices: { ...m.voices, Stranger: { voice: 'v' } } }),
    /voices/,
  );
  refuse(
    (m) => ({
      ...m,
      voices: { ...m.voices, [speakers[0]]: { voice: 'has space' } },
    }),
    /voices/,
  );
});

test('a manifest may name the listener, as one of the speakers', () => {
  const s = scenario();
  const speaker = s.plan.rows[0].speaker;
  const manifest = manifestFor(s, { listener: { firstName: speaker } });
  assert.deepEqual(manifest.listener, { firstName: speaker });
  assert.equal('listener' in manifestFor(s), false);
  const good = JSON.parse(JSON.stringify(manifest));
  const refuse = (listener) =>
    assert.throws(
      () => validateManifest({ ...structuredClone(good), listener }),
      /listener/,
    );
  refuse({ firstName: 'Stranger' });
  refuse({ firstName: speaker.toLowerCase() });
  refuse({ firstName: `${speaker} Smith` });
  refuse({ firstName: speaker, lastName: 'x' });
  refuse({ firstName: '' });
  refuse(null);
  refuse(speaker);
});

test('authored manifest joins the real media loader without widening approval or duration bounds', () => {
  const s = scenario();
  // Existing placeholder bytes only: no media encoding, decoding or playback.
  const placeholder = fictionalTestMedia({ durationMs: s.plan.totalMs });
  const media = {
    ...placeholder,
    bytes: lstatSync(placeholder.path).size,
    audioDurationMs: placeholder.durationMs,
    video: { codec: 'h264', width: 1280, height: 800, fps: 25 },
    audio: { codec: 'aac', sampleRate: 48000, channels: 1 },
  };
  const listener = { firstName: s.plan.rows[0].speaker };
  const manifest = manifestFor(s, { media, listener });
  const path = join(dirname(placeholder.path), 'authored-manifest.json');
  const write = (value) => {
    const bytes = JSON.stringify(value);
    writeFileSync(path, bytes, { mode: 0o600 });
    return createHash('sha256').update(bytes).digest('hex');
  };
  const sha256 = write(manifest);
  const approved = loadLabMediaManifest(path, { sha256 });
  assert.ok(isLabMedia(approved));
  assert.equal(approved.path, placeholder.path);
  assert.equal(approved.listenerFirstName, listener.firstName);
  assert.equal(isLabMedia({ ...approved }), false);
  assert.throws(() => loadLabMediaManifest(path, { sha256: '0'.repeat(64) }));
  const tooLong = manifestFor(s, {
    media: { ...media, durationMs: 104001, audioDurationMs: 104000 },
    window: { minMs: 90000, maxMs: 110000 },
  });
  assert.equal(tooLong.window.withinCurrentLabCap, false);
  assert.throws(() => loadLabMediaManifest(path, { sha256: write(tooLong) }));
});
