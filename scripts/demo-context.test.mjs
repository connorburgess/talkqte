import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parseSilences, retime, timeTurn } from './demo-phrases.mjs';

const read = (path) =>
  JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const context = read('../src/demo-context.json');
const demo = read('../src/demo.json');
const voices = read('../src/demo-voices.json');
const phrased = read('../src/demo-phrases.json');
const arrival = (phrase) => phrase.endMs + phrased.deliveryDelayMs;
// The longest speech-to-transcript delay measured for local transcription
// with pause-based chunks (docs/local-transcription.md).
const LIVE_MAX_DELAY_MS = 3730;

test('fictional prior notes support every authored cue', () => {
  assert.match(context.purpose, /fictional/i);
  assert.equal(context.notes.length, 2);
  const notes = new Map(context.notes.map((note) => [note.id, note]));
  assert.equal(notes.size, context.notes.length);
  for (const note of context.notes) {
    assert.match(note.title, /fictional demo/i);
    assert.match(note.date, /^\d{4}-\d{2}-\d{2}$/);
  }
  const phrases = new Map(phrased.phrases.map((p) => [p.id, p]));
  assert.equal(context.opportunities.length, 3);
  for (const opportunity of context.opportunities) {
    assert.ok(
      phrases.has(opportunity.phraseId),
      `${opportunity.id} is triggered by a phrase of the script`,
    );
    assert.ok(
      [...opportunity.cue].length <= 60,
      `${opportunity.id} stays glanceable`,
    );
    assert.ok(opportunity.noteIds.length > 0);
    assert.equal(opportunity.support.length, opportunity.noteIds.length);
    opportunity.noteIds.forEach((id, i) => {
      assert.ok(
        notes.get(id)?.text.includes(opportunity.support[i]),
        `${opportunity.id} quotes ${id}`,
      );
    });
  }
});

test('phrases spell out the script and follow the bundled speech', () => {
  assert.match(phrased.purpose, /fictional/i);
  const ids = new Set(phrased.phrases.map((p) => p.id));
  assert.equal(ids.size, phrased.phrases.length);
  for (const segment of demo.segments) {
    const mine = phrased.phrases.filter((p) => p.segmentId === segment.id);
    assert.equal(mine.map((p) => p.text).join(' '), segment.text);
  }
  let previousEnd = 0;
  let previousArrival = 0;
  for (const phrase of phrased.phrases) {
    const voice = voices.segments.find((v) => v.id === phrase.segmentId);
    assert.ok(phrase.startMs >= previousEnd, `${phrase.id} follows the last`);
    assert.ok(phrase.endMs > phrase.startMs);
    // Inside its speaker's recorded turn, allowing for the clip's edges.
    assert.ok(phrase.startMs >= voice.startMs - 150, `${phrase.id} start`);
    assert.ok(phrase.endMs <= voice.endMs + 150, `${phrase.id} end`);
    // Never shown before its last word, and within the live delay measured
    // from the start of a recognized line.
    assert.ok(arrival(phrase) > phrase.endMs);
    assert.ok(
      arrival(phrase) - phrase.startMs <= LIVE_MAX_DELAY_MS,
      `${phrase.id} arrives within the documented live delay`,
    );
    assert.ok(arrival(phrase) > previousArrival);
    assert.ok(arrival(phrase) < demo.durationMs);
    assert.ok(['pause', 'estimated', 'turn'].includes(phrase.boundary));
    previousEnd = phrase.endMs;
    previousArrival = arrival(phrase);
  }
});

test('the stated demo timing shows all three cues in an untouched run', () => {
  const { visibleMs, quietMs } = context.lifecycle;
  const phrases = new Map(phrased.phrases.map((p) => [p.id, p]));
  let quietUntil = 0;
  const shown = [];
  for (const opportunity of context.opportunities) {
    const at = arrival(phrases.get(opportunity.phraseId));
    if (at < quietUntil) continue;
    shown.push(opportunity.id);
    quietUntil = at + visibleMs + quietMs;
  }
  assert.deepEqual(shown, ['draft-offer', 'visitor-date', 'sign-approval']);
  // The first cue is raised before its speaker's turn has ended.
  const first = phrases.get(context.opportunities[0].phraseId);
  const turnEnd = Math.max(
    ...phrased.phrases
      .filter((p) => p.segmentId === first.segmentId)
      .map((p) => p.endMs),
  );
  assert.ok(arrival(first) < turnEnd);
});

test('re-timing matches breaks to pauses and marks the ones it estimates', () => {
  const silences = parseSilences(
    [
      'silence_start: -0.01',
      'silence_end: 0.2 | silence_duration: 0.21',
      'silence_start: 1.2',
      'silence_end: 1.5 | silence_duration: 0.3',
      'silence_start: 3',
      'silence_end: 4 | silence_duration: 1',
    ].join('\n'),
  );
  assert.deepEqual(silences[0], { startMs: 0, endMs: 200 });
  const voice = { startMs: 100, endMs: 3100 };
  const matched = timeTurn(
    ['Hello there,', 'fictional garden.'],
    voice,
    silences,
  );
  assert.deepEqual(
    matched.map((p) => [p.startMs, p.endMs, p.boundary]),
    [
      [200, 1200, 'pause'],
      [1500, 3000, 'turn'],
    ],
  );
  // Three phrases but one pause: nothing is matched, and both breaks say so.
  const guessed = timeTurn(
    ['One two', 'three four', 'five six'],
    voice,
    silences,
  );
  assert.deepEqual(
    guessed.map((p) => p.boundary),
    ['estimated', 'estimated', 'turn'],
  );
  assert.ok(guessed[0].endMs < guessed[1].endMs);
  assert.throws(
    () =>
      retime(
        [{ id: 'a', segmentId: 's1', text: 'Different words.' }],
        demo,
        voices,
        silences,
      ),
    /do not spell out/,
  );
});
