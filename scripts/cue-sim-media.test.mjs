// Offline tests for the recording's sound track, casting and the optional
// portrait step. The "provider" is a function in this file and the "speech"
// is generated tones; nothing is sent anywhere and no key is real.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { testFolder } from './lab-test-folders.mjs';
import {
  SAMPLE_RATE,
  buildTrack,
  checkTrack,
  decode,
} from './cue-sim-audio.mjs';
import { castFor } from './cue-sim-cast.mjs';
import { loadConversations } from './cue-sim.mjs';
import { IMAGE_MODEL, main, portraitPlan } from './cue-sim-portraits.mjs';

const KEY = 'fictional-key-that-must-never-appear';
const outside = () => realpathSync.native(testFolder('talkqte-media-test-'));
const hasFfmpeg = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
const tone = (file, hertz, seconds) =>
  execFileSync('ffmpeg', [
    '-y',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=${hertz}:duration=${seconds}`,
    // A different rate and format from the track's, as real clips have.
    '-ar',
    '24000',
    file,
  ]);

test(
  'one track is built from the clips at exact places, and the check sees what a listener would',
  { skip: !hasFfmpeg && 'ffmpeg is not installed' },
  async () => {
    const directory = outside();
    const clips = [
      { lineId: 'l1', file: join(directory, 'a.mp3'), startMs: 200 },
      { lineId: 'l2', file: join(directory, 'b.mp3'), startMs: 1_600 },
      { lineId: 'l3', file: join(directory, 'c.mp3'), startMs: 3_000 },
    ];
    tone(clips[0].file, 300, 1.0);
    tone(clips[1].file, 420, 0.8);
    tone(clips[2].file, 540, 0.6);
    const track = join(directory, 'track.wav');
    const placed = await buildTrack(clips, 500, track, { totalMs: 6_000 });

    // Every clip starts on its own sample, at the track's one rate, whole.
    assert.deepEqual(
      placed.map((clip) => clip.start),
      [700, 2_100, 3_500].map((ms) => (ms / 1000) * SAMPLE_RATE),
    );
    const samples = await decode(track);
    assert.ok(samples.length >= 6 * SAMPLE_RATE);
    for (const clip of placed)
      assert.equal(
        clip.length,
        (await decode(clips[placed.indexOf(clip)].file)).length,
      );

    const good = await checkTrack(track, placed);
    assert.equal(good.passed, true);
    assert.deepEqual(
      [good.dropouts, good.clipsCutShort, good.overlaps, good.gapsWithSound],
      [0, 0, 0, 0],
    );
    assert.equal(good.gapsChecked, 2);
    // The space between speakers is a faint room tone, not digital zero.
    const gap = samples.slice(1.9 * SAMPLE_RATE, 2.0 * SAMPLE_RATE);
    assert.ok(gap.some((value) => value !== 0));
    assert.ok(Math.max(...gap.map(Math.abs)) < 400);

    // A hole in the middle of a line is a dropout.
    const header = readFileSync(track).subarray(0, 44);
    const write = (data, name) => {
      const file = join(directory, name);
      writeFileSync(
        file,
        Buffer.concat([
          header,
          Buffer.from(data.buffer, data.byteOffset, data.byteLength),
        ]),
      );
      return file;
    };
    const holed = Int16Array.from(samples);
    holed.fill(
      0,
      placed[0].start + 0.3 * SAMPLE_RATE,
      placed[0].start + 0.5 * SAMPLE_RATE,
    );
    const dropped = await checkTrack(write(holed, 'holed.wav'), placed);
    assert.equal(dropped.passed, false);
    assert.ok(dropped.dropouts >= 3);

    // A line whose ending is missing was cut short.
    const cut = Int16Array.from(samples);
    cut.fill(
      0,
      placed[1].start + placed[1].length - 0.2 * SAMPLE_RATE,
      placed[1].start + placed[1].length,
    );
    const short = await checkTrack(write(cut, 'cut.wav'), placed);
    assert.equal(short.passed, false);
    assert.equal(short.clipsCutShort, 1);

    // Two lines placed over each other are an overlap.
    const over = await buildTrack(
      [clips[0], { ...clips[1], startMs: 700 }],
      0,
      join(directory, 'over.wav'),
    );
    const overlapped = await checkTrack(join(directory, 'over.wav'), over);
    assert.equal(overlapped.passed, false);
    assert.equal(overlapped.overlaps, 1);
  },
);

test('casting gives each invented speaker a preset voice and a description that names no one', async () => {
  for (const conversation of await loadConversations()) {
    const cast = castFor(conversation);
    const people = Object.values(cast);
    assert.deepEqual(
      Object.keys(cast),
      conversation.participants.map((p) => p.name),
      conversation.id,
    );
    // No two people in a call share a voice or a description.
    assert.equal(new Set(people.map((p) => p.voice)).size, people.length);
    assert.equal(new Set(people.map((p) => p.prompt)).size, people.length);
    for (const [name, person] of Object.entries(cast)) {
      assert.match(person.voice, /^[a-z]+$/);
      assert.match(person.prompt, /does not exist/);
      assert.match(person.prompt, /not a real, famous or recognisable person/);
      // Neither the speaker's invented name nor anyone else's is sent.
      for (const other of Object.keys(cast))
        assert.ok(!new RegExp(`\\b${other}\\b`).test(person.prompt), name);
    }
    assert.deepEqual(castFor(conversation), cast);
  }
});

function provider({ status = 200, error } = {}) {
  const calls = [];
  return {
    calls,
    async request(url, options) {
      calls.push({ url, options, body: JSON.parse(options.body) });
      return {
        ok: status === 200,
        status,
        json: async () =>
          status === 200
            ? {
                data: [
                  {
                    b64_json: Buffer.from('fictional image').toString('base64'),
                  },
                ],
              }
            : { error },
      };
    },
  };
}
const run = (args, extra) => {
  const lines = [];
  return main(args, {
    print: (text) => lines.push(text),
    environment: {},
    ...extra,
  }).then((result) => ({ result, text: lines.join('\n') }));
};
const ID = 'recruiter-intake';

test('the portrait step sends nothing without --run, and a run is capped, cached and silent about the key', async () => {
  const cache = outside();
  const service = provider();
  const base = ['--conversations', ID, '--cache', cache];
  const dry = await run(base, { request: service.request });
  assert.equal(service.calls.length, 0);
  assert.match(dry.text, /2 portraits needed, 0 already cached, 2 to make/);
  assert.match(dry.text, /Dry run\. Nothing was sent/);
  assert.match(dry.text, /hosted, separately billed service/);

  for (const [args, message] of [
    [[...base, '--run'], /spending cap/],
    [[...base, '--run', '--max-images', '1'], /cap is 1/],
    [[...base, '--run', '--max-images', '999'], /from 1 to/],
    [[...base, '--run', '--max-images', '2'], /No OPENAI_API_KEY was found/],
    [
      ['--conversations', 'a-real-person', '--cache', cache],
      /Unknown fictional conversation/,
    ],
    [
      [
        '--conversations',
        ID,
        '--cache',
        new URL('..', import.meta.url).pathname,
      ],
      /inside the repository/,
    ],
    [
      [...base, '--prompt', 'a famous person'],
      /Unknown or incomplete argument/,
    ],
  ])
    await assert.rejects(run(args, { request: service.request }), message);
  assert.equal(service.calls.length, 0);

  const args = [...base, '--run', '--max-images', '2'];
  const first = await run(args, {
    request: service.request,
    environment: { OPENAI_API_KEY: KEY },
  });
  assert.equal(first.result.made, 2);
  const [conversation] = (await loadConversations()).filter((c) => c.id === ID);
  const plan = portraitPlan(conversation);
  assert.deepEqual(
    service.calls.map((call) => call.body.prompt),
    Object.values(plan).map((portrait) => portrait.prompt),
  );
  for (const call of service.calls) {
    assert.equal(call.url, 'https://api.openai.com/v1/images/generations');
    assert.equal(call.body.model, IMAGE_MODEL);
    assert.equal(call.body.n, 1);
  }
  const log = readFileSync(join(cache, 'portraits.log.jsonl'), 'utf8');
  assert.ok(!first.text.includes(KEY) && !log.includes(KEY));
  assert.deepEqual(
    readdirSync(cache)
      .filter((name) => name.endsWith('.png'))
      .sort(),
    Object.values(plan)
      .map((portrait) => portrait.file)
      .sort(),
  );
  // A second run buys nothing.
  const again = await run(args, {
    request: service.request,
    environment: { OPENAI_API_KEY: KEY },
  });
  assert.equal(service.calls.length, 2);
  assert.match(
    again.text,
    /Every portrait is already cached\. Nothing was sent/,
  );
});

test('a refused image request ends the run and shows only short identifiers, not the provider words', async () => {
  const cache = outside();
  const service = provider({
    status: 400,
    error: {
      code: 'invalid_value',
      type: 'image_generation_user_error',
      param: 'model',
      message: `A long message that may quote the request or ${KEY}.`,
    },
  });
  await assert.rejects(
    run(
      ['--conversations', ID, '--cache', cache, '--run', '--max-images', '2'],
      {
        request: service.request,
        environment: { OPENAI_API_KEY: KEY },
      },
    ),
    (error) => {
      assert.match(
        error.message,
        /status 400 \(invalid_value, image_generation_user_error, model\) after 0 images/,
      );
      assert.ok(!error.message.includes('long message'));
      assert.ok(!error.message.includes(KEY));
      return true;
    },
  );
  assert.equal(service.calls.length, 1, 'no retry');
  assert.deepEqual(
    readdirSync(cache).filter((name) => name.endsWith('.png')),
    [],
  );
});
