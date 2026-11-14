// Offline tests for the review written after a take. The takes here are
// small scripted simulations and hand-made manifests; nothing is recorded,
// sent or asked of a model.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runSimulation } from './cue-sim.mjs';
import { reviewMarkdown, reviewTake } from './cue-sim-review.mjs';

const line = (id, atMs, text, label = {}) => ({
  id,
  atMs,
  speaker: 'Maya',
  text,
  ...label,
});
/** Answers by the newest line's ID; anything unlisted is quiet in 1 s. */
function scripted(script, kind = 'model') {
  return {
    id: 'scripted',
    label: 'A scripted evaluator',
    kind,
    hosted: false,
    async open() {
      return { model: null };
    },
    request: () => ({ systemPrompt: null, input: null }),
    async decide(testCase) {
      const [action = 'quiet', elapsedMs = 1_000, cue = null] =
        script[testCase.events.at(-1).id] ?? [];
      return {
        decision: {
          action,
          cue,
          sourceIds: null,
          reason: 'Scripted.',
          observedUse: 'not_observed',
        },
        elapsedMs,
        latency: 'measured',
      };
    },
    async close() {},
  };
}
async function take(lines, script, { options, manifest = {}, stopped } = {}) {
  const conversation = {
    id: 'fictional',
    context: 'test',
    title: 'Fictional',
    setting: 'Fictional.',
    listener: 'Robin',
    participants: [],
    lines,
  };
  const results = await runSimulation({
    source: 'conversations',
    conversations: [conversation],
    evaluator: scripted(script, manifest.kind),
    options: { transcriptDelayMs: 0, minGapMs: 0, ...options },
  });
  if (stopped) results.stopped = stopped;
  const replay = results.conversations[0];
  const shown = replay.timeline.filter((e) => e.type === 'cue-shown');
  return reviewTake(
    {
      simulated: true,
      fictional: true,
      conversation: 'fictional',
      video: 'take.mp4',
      decisions: 'Real model decisions',
      app: { commit: 'a'.repeat(40), uncommittedChanges: false, includes: [] },
      companionStatus: 'Demo running · Scripted',
      cues: shown.map((event) => ({
        expectedAtMs: event.atMs,
        seenAtMs: event.atMs + 120,
        fits: true,
        legibility: {
          atAppearance: { weakestContrast: 5.1, fontPx: 22, bold: true },
          settled: { weakestContrast: 11.2, fontPx: 22, bold: true },
        },
      })),
      audio: {
        endLate: [],
        check: { passed: true, dropouts: 0, clipsCutShort: 0, overlaps: 0 },
      },
      ...manifest.fields,
    },
    results,
    replay,
  );
}
const areas = (review) => review.observations.map((o) => o.area);
const says = (review, pattern) =>
  review.observations.some((o) => pattern.test(o.text));

test('a complete take with short cues that stay long enough is worth drawing conclusions from', async () => {
  const review = await take(
    [
      line('l1', 0, 'Someone needs to book the room.', {
        expect: 'show',
        about: 'The room has no one booking it.',
      }),
      line('l2', 30_000, 'Someone needs to order lunch.', {
        expect: 'show',
        about: 'Lunch has no one ordering it.',
      }),
      line('l3', 60_000, 'Lovely weather.', { expect: 'quiet' }),
    ],
    {
      l1: ['show', 1_000, 'Who will book the room?'],
      l2: ['show', 1_000, 'Who will order lunch?'],
    },
  );
  assert.equal(review.evidence.useful, true);
  assert.ok(review.represents.every((item) => item.ok));
  assert.deepEqual(
    review.cues.map((cue) => [
      cue.words,
      cue.glance,
      cue.readable,
      cue.moment.outcome,
      cue.moment.withinBudget,
      cue.clearedBy,
    ]),
    [
      [5, true, true, 'in-time', true, 'expired'],
      [4, true, true, 'in-time', true, 'expired'],
    ],
  );
  assert.deepEqual(review.observations, []);
  assert.deepEqual(
    [review.counts.inTime, review.counts.late, review.counts.missed],
    [2, 0, 0],
  );
  const page = reviewMarkdown(review);
  assert.match(page, /Worth drawing conclusions from\?\*\* Yes/);
  assert.match(page, /Nothing stood out in the numbers/);
  assert.match(page, /Nothing here says a cue helped a person/);
});

test('a decision thrown away by an acknowledgement, a late long cue and a quick withdrawal are each called out', async () => {
  const long =
    'Who will own booking the larger meeting room that the workshop needs before the visitors arrive on Thursday?';
  const review = await take(
    [
      line('l1', 0, 'Someone needs to book the room.', {
        expect: 'show',
        about: 'The room has no one booking it.',
        until: 'l4',
      }),
      line('l2', 2_000, 'Mm.', { expect: 'quiet' }),
      line('l3', 2_500, 'Yeah.', { expect: 'quiet' }),
      line('l4', 9_000, 'Anyway, the budget.', {
        expect: 'withdraw',
        of: 'l1',
      }),
      line('l5', 12_000, 'Robin, is that right?', {
        expect: 'show',
        about: 'Maya asked Robin whether that is right.',
      }),
    ],
    {
      l1: ['show', 4_000, long],
      l3: ['show', 4_000, long],
      l4: ['withdraw', 2_000],
      l5: ['quiet', 4_500],
    },
    {
      options: { transcriptDelayMs: 3_000 },
      stopped: { afterCalls: 4, category: 'usage-limit' },
    },
  );
  // Not worth drawing conclusions from, and it says why.
  assert.equal(review.evidence.useful, false);
  assert.match(review.evidence.why, /the run stopped early/);
  assert.match(review.evidence.why, /only 1 cue was shown/);
  assert.match(review.evidence.why, /short enough and on screen long enough/);
  const played = review.represents.find((r) =>
    /whole conversation/.test(r.name),
  );
  assert.equal(played.ok, false);
  assert.match(played.detail, /usage-limit/);

  const [cue] = review.cues;
  assert.equal(cue.glance, false);
  assert.equal(cue.readable, false);
  assert.equal(cue.moment.outcome, 'late');
  assert.equal(cue.moment.withinBudget, false);
  assert.equal(cue.clearedBy, 'withdraw');
  assert.deepEqual(
    review.missed.map((m) => m.lineId),
    ['l5'],
  );

  assert.ok(
    says(
      review,
      /cannot be on screen inside the 5\.0 s budget \(7\.0 s at best\)/,
    ),
  );
  assert.ok(
    says(
      review,
      /thrown away because 2 short acknowledgements \("Mm\.", "Yeah\."\)/,
    ),
  );
  assert.ok(says(review, /after the moment it was for had passed/));
  assert.ok(says(review, /is 18 words/));
  assert.ok(says(review, /was cleared \(withdraw\); noticing and reading/));
  assert.ok(says(review, /put to the listener by name got no cue/));
  assert.deepEqual(
    [...new Set(areas(review))],
    ['Timing', 'Card', 'Evaluator', 'Recording'],
  );
  const page = reviewMarkdown(review);
  assert.match(page, /Worth drawing conclusions from\?\*\* No/);
  assert.match(page, /\*\*No\*\* · The whole conversation was played/);
  assert.match(page, /Missed:\n- Line 5: Maya asked Robin/);
});

test('a take that misrepresents the product says so', async () => {
  const lines = [
    line('l1', 0, 'Someone needs to book the room.', { expect: 'show' }),
  ];
  const script = { l1: ['show', 1_000, 'Who will book the room?'] };
  const review = await take(lines, script, {
    manifest: {
      kind: 'fake',
      fields: {
        decisions: 'No model',
        companionStatus: 'Mic on · Local',
        app: { commit: 'b'.repeat(40), uncommittedChanges: true, includes: [] },
        cues: [
          {
            expectedAtMs: 1_000,
            seenAtMs: 2_400,
            fits: false,
            // Small, faint words: below what a glance can read.
            legibility: {
              atAppearance: { weakestContrast: 1.6, fontPx: 14, bold: false },
              settled: { weakestContrast: 3.2, fontPx: 14, bold: false },
            },
          },
        ],
        audio: {
          endLate: [{ lineId: 'l1', endsLateMs: 900 }],
          check: { passed: false, dropouts: 4, clipsCutShort: 1, overlaps: 0 },
        },
      },
    },
  });
  const failed = review.represents.filter((r) => !r.ok).map((r) => r.name);
  assert.deepEqual(failed, [
    'Shows a known version of the app',
    'Does not claim a microphone or a live session',
    'Cues were drawn when the results say',
    'The card fits its window',
    "The cue's words stand out from the card",
    'Sound is intact',
  ]);
  const words = review.represents.find((r) => /stand out/.test(r.name));
  assert.match(words.detail, /14 px.*1\.6:1.*3\.2:1.*asks for 4\.5:1/);
  assert.ok(
    review.observations.some((o) =>
      /faintest word is at 1\.6:1 .* below the 3:1/.test(o.text),
    ),
  );
  assert.match(review.evidence.why, /did not come from a model/);
  assert.equal(
    review.observations.filter((o) => o.area === 'Recording').length,
    failed.length,
  );
  // Large bold text needs 3:1, and the first take's words pass it.
  const fine = await take(lines, script);
  assert.equal(fine.represents.find((r) => /stand out/.test(r.name)).ok, true);
});
