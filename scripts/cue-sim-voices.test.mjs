// Offline tests for the optional voice step. The "provider" is a function
// in this file; nothing is sent anywhere and no key is real.
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConversations } from './cue-sim.mjs';
import { SPEECH_MODEL, main, voicePlan } from './cue-sim-voices.mjs';

const KEY = 'fictional-key-that-must-never-appear';
const outside = () =>
  realpathSync.native(mkdtempSync(join(tmpdir(), 'talkqte-voices-test-')));
function provider({ failAt } = {}) {
  const calls = [];
  return {
    calls,
    async request(url, options) {
      calls.push({ url, options, body: JSON.parse(options.body) });
      if (calls.length === failAt)
        return {
          ok: false,
          status: 429,
          arrayBuffer: async () => new ArrayBuffer(0),
        };
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () =>
          new TextEncoder().encode('fictional audio').buffer,
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
const ID = 'paper-reading-group';

test('each speaker gets one preset voice, and a line is named by what is said and how', async () => {
  const [conversation] = (await loadConversations()).filter((c) => c.id === ID);
  const plan = voicePlan(conversation);
  // Preset voices only, a different one for each person in the call.
  assert.deepEqual(plan.voices, { Sofia: 'marin', Li: 'cedar', Dev: 'ash' });
  assert.equal(plan.lines.length, conversation.lines.length);
  for (const line of plan.lines) {
    assert.equal(line.voice, plan.voices[line.speaker]);
    assert.match(line.file, /^[a-f0-9]{32}\.mp3$/);
    assert.match(line.instructions, /not a narrator/);
    // No label, name of the listener, or case ID is part of what is sent.
    assert.ok(!line.instructions.includes('listener'));
  }
  // The same words in the same voice share a clip; other words do not.
  assert.deepEqual(voicePlan(conversation), plan);
  assert.equal(
    new Set(plan.lines.map((line) => line.file)).size,
    plan.lines.length,
  );
});

test('without --run nothing is sent, and the plan says what would be', async () => {
  const cache = outside();
  const service = provider();
  const { result, text } = await run(
    ['--conversations', ID, '--cache', cache],
    {
      request: service.request,
    },
  );
  assert.equal(service.calls.length, 0);
  assert.equal(result.made, 0);
  assert.match(text, /Dry run\. Nothing was sent/);
  assert.match(
    text,
    /11 clips needed, 0 already cached, 11 to make: \d+ characters, about \$0\.\d\d/,
  );
  assert.match(text, /hosted, separately billed service/);
  assert.deepEqual(readdirSync(cache), []);
});

test('a run needs a cap, room under it, a key, a bundled conversation and a folder outside the checkout', async () => {
  const cache = outside();
  const service = provider();
  const base = ['--conversations', ID, '--cache', cache, '--run'];
  for (const [args, message] of [
    [base, /spending cap/],
    [[...base, '--max-chars', '10'], /cap is 10/],
    [[...base, '--max-chars', '999999'], /from 1 to/],
    [[...base, '--max-chars', '5000'], /No OPENAI_API_KEY was found/],
    [
      ['--conversations', 'a-real-meeting', '--cache', cache],
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
      ['--conversations', ID, '--cache', cache, '--text', 'anything'],
      /Unknown or incomplete argument/,
    ],
  ])
    await assert.rejects(run(args, { request: service.request }), message);
  assert.equal(service.calls.length, 0);
});

test('a run sends only the fictional lines, caches each clip, and never shows the key', async () => {
  const cache = outside();
  const env = join(outside(), 'voices.env');
  writeFileSync(env, `OTHER=1\nOPENAI_API_KEY="${KEY}"\n`);
  const service = provider();
  const args = [
    '--conversations',
    ID,
    '--cache',
    cache,
    '--run',
    '--max-chars',
    '5000',
    '--env-file',
    env,
  ];
  const first = await run(args, { request: service.request });
  const [conversation] = (await loadConversations()).filter((c) => c.id === ID);
  assert.equal(first.result.made, 11);
  assert.equal(
    first.result.chars,
    conversation.lines.reduce((sum, line) => sum + line.text.length, 0),
  );
  assert.deepEqual(
    service.calls.map((call) => call.body.input),
    conversation.lines.map((line) => line.text),
  );
  for (const call of service.calls) {
    assert.equal(call.url, 'https://api.openai.com/v1/audio/speech');
    assert.equal(call.options.headers.authorization, `Bearer ${KEY}`);
    assert.deepEqual(Object.keys(call.body).sort(), [
      'input',
      'instructions',
      'model',
      'response_format',
      'voice',
    ]);
    assert.equal(call.body.model, SPEECH_MODEL);
    // Labels never leave: only the words, a voice and how to say them.
    assert.ok(!call.options.body.includes('expect'));
    assert.ok(!call.options.body.includes(ID));
  }
  // The key is in no output, log or cached file name.
  const log = readFileSync(join(cache, 'voices.log.jsonl'), 'utf8');
  assert.ok(!first.text.includes(KEY) && !log.includes(KEY));
  assert.equal(log.trim().split('\n').length, 11);
  assert.equal(
    readdirSync(cache).filter((name) => name.endsWith('.mp3')).length,
    11,
  );

  // A second run buys nothing.
  const again = await run(args, { request: service.request });
  assert.equal(service.calls.length, 11);
  assert.equal(again.result.made, 0);
  assert.match(again.text, /Every clip is already cached\. Nothing was sent/);
});

test('the first failed request ends the run with no retry, keeping what was made', async () => {
  const cache = outside();
  const service = provider({ failAt: 3 });
  await assert.rejects(
    run(
      ['--conversations', ID, '--cache', cache, '--run', '--max-chars', '5000'],
      {
        request: service.request,
        environment: { OPENAI_API_KEY: KEY },
      },
    ),
    (error) => {
      assert.match(error.message, /status 429 after 2 clips/);
      assert.ok(!error.message.includes(KEY));
      return true;
    },
  );
  assert.equal(service.calls.length, 3);
  assert.equal(
    readdirSync(cache).filter((name) => name.endsWith('.mp3')).length,
    2,
  );
});
